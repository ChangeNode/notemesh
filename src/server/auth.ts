import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { createAuthMiddleware, APIError } from "better-auth/api";
import { apiKey } from "@better-auth/api-key";
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import crypto from "node:crypto";
import { db } from "./db";
import { env } from "./env";

// Session-signing secret derived from (not equal to) the credential
// encryption key, so one secret in the Railway template covers both.
function authSecret(): string {
  return crypto
    .createHash("sha256")
    .update(env.encryptionKey)
    .update("better-auth-secret")
    .digest("base64");
}

// Constant-time string compare that also hides length via hashing, so the
// SETUP_TOKEN gate leaks neither the token's bytes nor its length via timing.
function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Minimal structured audit log for security-relevant events (no secrets).
export function audit(event: string, detail: Record<string, unknown> = {}) {
  try {
    console.log(JSON.stringify({ audit: event, ts: new Date().toISOString(), ...detail }));
  } catch {
    console.log(`audit ${event}`);
  }
}

// Ceiling on dynamically-registered OAuth clients (see the /oauth2/register
// hook below). Well above what real use produces — testing accumulated a
// handful — but bounded so anonymous registration can't grow the DB forever.
const MAX_OAUTH_CLIENTS = 50;

function userCount(): number {
  try {
    const row = db()
      .prepare('SELECT COUNT(*) AS n FROM "user"')
      .get() as { n: number };
    return row.n;
  } catch {
    // Table doesn't exist yet (first boot, before migrations run).
    return 0;
  }
}

export const auth = betterAuth({
  baseURL: env.baseUrl,
  secret: authSecret(),
  database: db(),
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
      // Guessing SETUP_TOKEN to claim an unconfigured instance.
      "/sign-up/email": { window: 3600, max: 10 },
      // Unauthenticated dynamic client registration.
      "/oauth2/register": { window: 3600, max: 20 },
    },
  },
  advanced: {
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
    // setup wizard. The first (and only) sign-up must present the SETUP_TOKEN.
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/sign-up/email") {
        if (userCount() > 0) {
          audit("signup.rejected", { reason: "already_claimed" });
          throw new APIError("FORBIDDEN", {
            message: "This instance is already claimed.",
          });
        }
        const token = ctx.headers?.get("x-setup-token") ?? "";
        if (!safeEqual(token, env.setupToken)) {
          audit("signup.rejected", { reason: "bad_setup_token" });
          throw new APIError("FORBIDDEN", {
            message: "Invalid setup token.",
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
      validAudiences: [env.baseUrl, `${env.baseUrl}/api/mcp`],
    }),
  ],
});

export async function isSetupComplete(): Promise<boolean> {
  return userCount() > 0;
}

let migrated = false;

// Creates/updates Better Auth's own tables (user, session, account,
// apikey, OAuth client/token tables) inside app.sqlite. Runs once per boot.
export async function runAuthMigrations() {
  if (migrated) return;
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  migrated = true;
}
