import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { createAuthMiddleware, APIError } from "better-auth/api";
import { apiKey } from "@better-auth/api-key";
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import crypto from "node:crypto";
import { db } from "./db";
import { env } from "./env";
import { authLog } from "./auth-logger";
import { userCount, withinClaimWindow, CLAIM_WINDOW_MINUTES } from "./claim";
import { audit } from "./audit";

// Both used to live here, and auth is where the rest of the app reaches for
// them, so keep them importable from this module.
export { audit } from "./audit";
export { userCount, isSetupComplete, type UserCount } from "./claim";

// Session-signing secret derived from (not equal to) the credential
// encryption key, so one secret in the Railway template covers both.
function authSecret(): string {
  return crypto
    .createHash("sha256")
    .update(env.encryptionKey)
    .update("better-auth-secret")
    .digest("base64");
}

// Ceiling on dynamically-registered OAuth clients (see the /oauth2/register
// hook below). Well above what real use produces — testing accumulated a
// handful — but bounded so anonymous registration can't grow the DB forever.
export const MAX_OAUTH_CLIENTS = 50;

export const auth = betterAuth({
  baseURL: env.baseUrl,
  secret: authSecret(),
  database: db(),
  // Filters one warning Better Auth emits about its own SQLite migration
  // output on every boot — see auth-logger.ts. Everything else passes through.
  logger: { log: authLog },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 10,
  },
  // Only the anonymous entry points are throttled. Authenticated dashboard
  // traffic keeps a high ceiling: the concern is a stranger probing, not the
  // single operator using their own server.
  rateLimit: {
    enabled: true,
    window: 60,
    max: 600,
    customRules: {
      // Password guessing. Generous enough to survive a few fat-fingered
      // attempts, and the window is short so a mistake isn't a long lockout.
      "/sign-in/email": { window: 60, max: 10 },
      // Racing to claim an unconfigured instance while its window is open.
      "/sign-up/email": { window: 3600, max: 10 },
      // Unauthenticated dynamic client registration.
      "/oauth2/register": { window: 3600, max: 20 },
    },
  },
  // Both of these were previously left to Better Auth to infer, and it infers
  // exactly this — so nothing changes behaviourally. They are stated because
  // "the session cookie is Secure" and "which origins may post here" are things
  // a reader should be able to check in this file rather than derive from a
  // dependency's defaults.
  //
  // Secure is deliberately tied to the scheme rather than pinned on. A browser
  // will not store a Secure cookie on a plain-http origin unless it is loopback
  // — measured — so pinning it would stop anyone self-hosting at
  // http://192.168.x.x from signing in at all. When BASE_URL says http but the
  // deployment is actually served over https, that is a misconfiguration, and
  // detectInsecureBaseUrl reports it on the Security tab instead.
  trustedOrigins: [env.baseUrl],
  advanced: {
    useSecureCookies: env.baseUrl.startsWith("https://"),
    ipAddress: {
      // Trust forwarding headers only where a proxy actually sets them.
      // Elsewhere a client could supply x-forwarded-for itself and get a fresh
      // bucket per request, which would make every limit above decorative.
      ipAddressHeaders:
        process.env.RAILWAY_PUBLIC_DOMAIN || process.env.TRUST_PROXY_HEADERS
          ? ["x-forwarded-for", "x-real-ip"]
          : [],
    },
  },
  hooks: {
    // This instance is single-user: exactly one admin account, created by the
    // setup wizard. Sign-up is open only while the instance is unclaimed AND
    // still inside the post-start claim window — see server/claim.ts.
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/sign-up/email") {
        const users = userCount();
        if (!users.known) {
          // Never create an account on a guess. A database we cannot read is
          // not a database we know to be empty.
          audit("signup.rejected", { reason: "user_count_unavailable" });
          throw new APIError("SERVICE_UNAVAILABLE", {
            message:
              "Could not verify whether this instance is already claimed, so sign-up is " +
              "refused. Check the server logs and try again.",
          });
        }
        if (users.count > 0) {
          audit("signup.rejected", { reason: "already_claimed" });
          throw new APIError("FORBIDDEN", {
            message: "This instance is already claimed.",
          });
        }
        if (!withinClaimWindow()) {
          audit("signup.rejected", { reason: "claim_window_closed" });
          throw new APIError("FORBIDDEN", {
            message:
              `This server is locked down: it was not claimed within ` +
              `${CLAIM_WINDOW_MINUTES} minutes of starting. Restart it, then create ` +
              `the admin account.`,
          });
        }
        audit("signup.accepted", {});
      }

      // Anonymous dynamic client registration is the one open write endpoint,
      // so bound how many rows a stranger can create. Evict clients that were
      // registered but never used before refusing, since MCP clients routinely
      // create throwaway registrations (a failed login leaves one behind).
      if (ctx.path === "/oauth2/register") {
        const d = db();
        try {
          d.prepare(
            `DELETE FROM "oauthClient"
             WHERE createdAt < ?
               AND clientId NOT IN (SELECT clientId FROM "oauthAccessToken")
               AND clientId NOT IN (SELECT clientId FROM "oauthRefreshToken")
               AND clientId NOT IN (SELECT clientId FROM "oauthConsent")`,
          ).run(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
          const { n } = d.prepare('SELECT COUNT(*) AS n FROM "oauthClient"').get() as { n: number };
          if (n >= MAX_OAUTH_CLIENTS) {
            audit("oauth.register.rejected", { reason: "client_cap", count: n });
            throw new APIError("TOO_MANY_REQUESTS", {
              message: "Too many registered OAuth clients on this instance.",
            });
          }
        } catch (e) {
          if (e instanceof APIError) throw e;
          // A bookkeeping failure must not block legitimate registration.
          console.error("[auth] client-cap check failed:", e);
        }
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      // Audit sign-in outcomes (no credentials in the log).
      if (ctx.path === "/sign-in/email") {
        const ok = !!(ctx.context as any)?.newSession || !!(ctx.context as any)?.session;
        audit("signin", { ok });
      }
    }),
  },
  plugins: [
    // Single-user personal server: the default per-key rate limit (~10/day)
    // would break any real MCP session.
    apiKey({ rateLimit: { enabled: false } }),
    // The OAuth provider signs JWT access tokens; the jwt plugin supplies the
    // signing keys (JWKS persisted in the database).
    jwt(),
    oauthProvider({
      loginPage: "/login",
      consentPage: "/oauth/consent",
      // MCP clients (Claude.ai, Claude Code, MCP Inspector) self-register via
      // unauthenticated dynamic client registration, then use the PKCE flow.
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      scopes: ["openid", "profile", "email", "offline_access", "vault:read", "vault:write"],
      // Scopes a client GETS by default when it registers without asking.
      clientRegistrationDefaultScopes: ["openid", "offline_access", "vault:read", "vault:write"],
      // Scopes a client MAY additionally request at registration. The allowed
      // set is the union of these with the defaults; without this, OIDC clients
      // like Codex that request `profile`/`email` are rejected (invalid_scope).
      clientRegistrationAllowedScopes: ["profile", "email"],
      // MCP clients pass the endpoint URL as the RFC 8707 resource indicator.
      //
      // SECURITY: every entry here must name the SAME resource server. On the
      // 1.6.x line this plugin lets a client pick its token's audience from
      // this list at the token endpoint, unbound to what the user actually
      // authorised (GHSA-p2fr-6hmx-4528). That is harmless today only because
      // both entries below are this server's own MCP endpoint, which accepts
      // either — so choosing between them changes nothing, and privilege comes
      // from scopes rather than `aud`. Adding a genuinely distinct resource
      // server to this list, before the 1.7.0 upgrade lands, turns that into a
      // real cross-audience escalation. See issue #10.
      validAudiences: [env.baseUrl, `${env.baseUrl}/api/mcp`],
      silenceWarnings: {
        // The plugin warns on every boot that
        // /.well-known/oauth-authorization-server/api/auth may not exist. It
        // checks for a route it registered itself, and ours is served from
        // middleware.ts, which it cannot see. Measured against the built
        // server: that path returns 200, as do the other three discovery
        // documents. Left unsilenced the warning appears in every deployed
        // instance's logs and gets reported as a bug. server/discovery.test.ts
        // takes over guarding the path list.
        oauthAuthServerConfig: true,
      },
    }),
  ],
});

let migrated = false;

// Creates/updates Better Auth's own tables (user, session, account,
// apikey, OAuth client/token tables) inside app.sqlite. Runs once per boot.
export async function runAuthMigrations() {
  if (migrated) return;
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  migrated = true;
}
