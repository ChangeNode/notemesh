import { createMiddleware } from "@solidjs/start/middleware";
import { ensureSyncStarted } from "./server/ob/supervisor";

// Pages that require a signed-in admin. Everything else (login, setup, the
// OAuth consent page, API routes) handles its own access rules.
const PROTECTED_PAGES = new Set(["/"]);

function redirectTo(path: string): Response {
  return new Response(null, { status: 302, headers: { Location: path } });
}

// Codex 0.146.0 requires the RFC 9207 `iss` authorization-response parameter
// whenever the AS metadata advertises support for it, but then fails to read
// the `iss` it is sent (verified: even a callback with `iss` present is
// rejected as "missing required issuer"). We DO send `iss` on every response;
// dropping the advertised flag makes compliant clients stop requiring it,
// working around the Codex bug without weakening anything for our single-AS,
// single-user model. Remove once Codex fixes its iss parsing.
async function stripIssParamSupport(res: Response): Promise<Response> {
  try {
    const data = await res.json();
    delete (data as Record<string, unknown>).authorization_response_iss_parameter_supported;
    return new Response(JSON.stringify(data), {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return res;
  }
}

export default createMiddleware({
  onRequest: [
    async (event) => {
      // Idempotent: restarts the sync daemon after a server (re)boot.
      ensureSyncStarted();

      const url = new URL(event.request.url);

      // Gate authenticated pages here rather than inside the page's data
      // loader: a redirect thrown from within createResource is swallowed by
      // Solid and surfaces as a 500 instead of a redirect. The server
      // functions still call requireAdmin() themselves — this is the
      // navigation-level guard, not the security boundary.
      if (PROTECTED_PAGES.has(url.pathname)) {
        const { auth, isSetupComplete, runAuthMigrations } = await import("./server/auth");
        await runAuthMigrations();
        if (!(await isSetupComplete())) return redirectTo("/setup");
        const session = await auth.api.getSession({ headers: event.request.headers });
        if (!session) return redirectTo("/login");
      }

      // OAuth discovery endpoints live under /.well-known/, which the file
      // router doesn't serve — handle them here.
      // RFC 8414 path-inserted variants: issuer is <base>/api/auth, so clients
      // may request /.well-known/oauth-authorization-server/api/auth.
      if (
        url.pathname === "/.well-known/oauth-authorization-server" ||
        url.pathname === "/.well-known/oauth-authorization-server/api/auth"
      ) {
        const { oauthProviderAuthServerMetadata } = await import("@better-auth/oauth-provider");
        const { auth, runAuthMigrations } = await import("./server/auth");
        await runAuthMigrations();
        return stripIssParamSupport(await oauthProviderAuthServerMetadata(auth)(event.request));
      }
      if (
        url.pathname === "/.well-known/openid-configuration" ||
        url.pathname === "/.well-known/openid-configuration/api/auth" ||
        url.pathname === "/api/auth/.well-known/openid-configuration"
      ) {
        const { oauthProviderOpenIdConfigMetadata } = await import("@better-auth/oauth-provider");
        const { auth, runAuthMigrations } = await import("./server/auth");
        await runAuthMigrations();
        return stripIssParamSupport(await oauthProviderOpenIdConfigMetadata(auth)(event.request));
      }
      if (url.pathname === "/.well-known/oauth-protected-resource") {
        const { env } = await import("./server/env");
        return new Response(
          JSON.stringify({
            resource: `${env.baseUrl}/api/mcp`,
            authorization_servers: [`${env.baseUrl}/api/auth`],
            scopes_supported: ["vault:read", "vault:write", "openid", "offline_access"],
            bearer_methods_supported: ["header"],
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
    },
  ],
});
