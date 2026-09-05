import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { createAuthMiddleware, APIError } from "better-auth/api";
import { apiKey } from "@better-auth/api-key";
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";

/**
 * Every scope this authorization server both advertises and grants.
 *
 * `openid`, `profile` and `email` are here for OIDC clients: ChatGPT uses them
 * to identify the signed-in user. Nothing in the vault is gated on them — that
 * is what `vault:read` and `vault:write` are for — so granting them costs
 * nothing on a single-user server, and withholding them costs the connector.
 */
export const OAUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "vault:read",
  "vault:write",
] as const;
import crypto from "node:crypto";
import { db } from "./db";
import { env } from "./env";
import { authLog } from "./auth-logger";
import { userCount, withinClaimWindow, CLAIM_WINDOW_MINUTES, installSingleAdminGuard, extraAdminAccounts } from "./claim";
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

        // Only the counting is inside the try, and the refusal is outside it.
        // Both used to be in, which meant the catch needed
        // `if (e instanceof APIError) throw e` to let the deliberate rejection
        // back out of its own safety net. That worked, and it put the one
        // control on this endpoint one edit away from being silently swallowed:
        // anything that stopped the refusal matching that instanceof — a
        // wrapped error, a subclass, a careless refactor — would have removed
        // the cap with nothing failing.
        //
        // null means the count could not be established. Registration then
        // proceeds, deliberately: a bookkeeping failure must not lock out a
        // legitimate connector.
        let count: number | null = null;
        try {
          d.prepare(
            `DELETE FROM "oauthClient"
             WHERE createdAt < ?
               AND clientId NOT IN (SELECT clientId FROM "oauthAccessToken")
               AND clientId NOT IN (SELECT clientId FROM "oauthRefreshToken")
               AND clientId NOT IN (SELECT clientId FROM "oauthConsent")`,
          ).run(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
          count = (d.prepare('SELECT COUNT(*) AS n FROM "oauthClient"').get() as { n: number }).n;
        } catch (e) {
          console.error("[auth] client-cap check failed:", e);
        }

        if (count !== null && count >= MAX_OAUTH_CLIENTS) {
          audit("oauth.register.rejected", { reason: "client_cap", count });
          throw new APIError("TOO_MANY_REQUESTS", {
            message: "Too many registered OAuth clients on this instance.",
          });
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
      // Advertised and granted are the same list, deliberately. They used to
      // differ — profile and email were advertised but only grantable if a
      // client asked for them at registration — and ChatGPT does not ask. It
      // reads scopes_supported, registers without a scope field, then requests
      // what the metadata promised and is refused its own authorization with
      // "The following scopes are invalid: profile, email". The only way out
      // was for the operator to find OIDC in an advanced settings panel and
      // switch it off.
      //
      // A client cannot be expected to know that a scope it was told about is
      // not one it may have. One constant, used twice, so the two cannot drift
      // apart again; server/oauth-scopes.test.ts pins them together.
      scopes: [...OAUTH_SCOPES],
      clientRegistrationDefaultScopes: [...OAUTH_SCOPES],
      // The protected resources this server issues tokens for: its own MCP
      // endpoint, under the two names a client may send as the RFC 8707
      // resource indicator (the endpoint URL, which the MCP spec prescribes,
      // and the bare origin, which some clients send). Both are this one
      // resource server, and mcp/oauth.ts accepts either audience. Since the
      // 1.7 line a token's audience is bound to the resource named at
      // authorization and can be narrowed but not widened at the token
      // endpoint, which is what closed GHSA-p2fr-6hmx-4528 (#55).
      resources: [
        { identifier: `${env.baseUrl}/api/mcp`, allowedScopes: [...OAUTH_SCOPES] },
        { identifier: env.baseUrl, allowedScopes: [...OAUTH_SCOPES] },
      ],
      // 1.7 also links each client to the resources it may request, and
      // refuses `resource` for any it is not linked to. New registrations get
      // linked below, but a connector registered under 1.6 — every existing
      // deployment's — has no link and would be refused its next
      // authorization. With one resource server there is nothing per-client
      // linking can tell apart, so it is off; what closed the advisory is the
      // grant-bound audience above, which stays on.
      enforcePerClientResources: false,
      clientRegistrationDefaultResources: [`${env.baseUrl}/api/mcp`, env.baseUrl],
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
// Better Auth 1.7 added `issuer` to the account table: NOT NULL, no default.
// Its migrator refuses to add such a column to a populated table rather than
// invent a value, so a deployment upgraded from 1.6 — one admin row — would
// throw here on every boot and never sign in again. This server knows the
// value: every account it creates is an email-and-password one, which 1.7
// records as "local:credential". Added with that backfill before the
// migrator runs, so it finds the column present and only adds its index.
// Reproduced and pinned against a 1.6-shaped populated table in
// auth-upgrade.test.ts.
function backfillAccountIssuer(): void {
  const d = db();
  const table = d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'account'").get();
  if (!table) return;
  const columns = d.prepare("PRAGMA table_info(account)").all() as { name: string }[];
  if (columns.some((c) => c.name === "issuer")) return;
  d.exec("ALTER TABLE account ADD COLUMN issuer TEXT NOT NULL DEFAULT 'local:credential'");
  console.log("[auth] account table: added issuer for the Better Auth 1.7 upgrade");
}

export async function runAuthMigrations() {
  if (migrated) return;
  backfillAccountIssuer();
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  // The guard on the user table can only be created once Better Auth has
  // created the table, so it lives here rather than with our own schema. And
  // a database that already breaks the invariant — claimed before the guard
  // existed, by more than one racer — is reported loudly rather than guessed
  // about; the alert channel carries it too. Recovery is in SECURITY.md.
  installSingleAdminGuard();
  const extra = extraAdminAccounts();
  if (extra > 0) {
    console.error(
      `[auth] this server has ${extra + 1} admin accounts and should have exactly one. ` +
        `See SECURITY.md, "More than one admin account".`,
    );
  }
  migrated = true;
}
