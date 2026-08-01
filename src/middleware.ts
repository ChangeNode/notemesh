import { createMiddleware } from "@solidjs/start/middleware";
import { ensureSyncStarted } from "./server/ob/supervisor";
import { ensureIndexerStarted } from "./server/vault/indexer";

// Pages that require a signed-in admin. Everything else (login, setup, the
// OAuth consent page, API routes) handles its own access rules.
const PROTECTED_PAGES = new Set(["/"]);

function redirectTo(path: string): Response {
  return new Response(null, { status: 302, headers: { Location: path } });
}

// Routes that legitimately exist under /api. Anything else under /api — and
// any JSON-shaped request to an unknown path — must fail loudly.
const API_PREFIXES = ["/api/health", "/api/mcp", "/api/auth/"];

function isKnownApiPath(pathname: string): boolean {
  return API_PREFIXES.some((p) => (p.endsWith("/") ? pathname.startsWith(p) : pathname === p));
}

// SolidStart's catch-all serves the SPA shell for unmatched routes, so a client
// that POSTs to a slightly wrong URL (/mcp instead of /api/mcp, say) previously
// got 200 + HTML and had to guess why its JSON parse failed. Return an explicit
// 404 JSON instead, so a misconfigured endpoint is obvious rather than
// surfacing as mangled client-side errors.
function notFoundJson(pathname: string): Response {
  return new Response(
    JSON.stringify({
      error: "not_found",
      message: `No API endpoint at ${pathname}. The MCP endpoint is /api/mcp.`,
    }),
    { status: 404, headers: { "Content-Type": "application/json" } },
  );
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
      // Idempotent: restarts the sync daemon after a server (re)boot, and warms
      // the vault index in the background so the first MCP call doesn't pay for
      // a full-vault scan.
      ensureSyncStarted();
      ensureIndexerStarted();

      const url = new URL(event.request.url);

      // Unknown /api/* path, or a JSON-shaped request to a non-page path.
      if (url.pathname.startsWith("/api/") && !isKnownApiPath(url.pathname)) {
        return notFoundJson(url.pathname);
      }
      if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/.well-known/")) {
        const accept = event.request.headers.get("accept") ?? "";
        const ctype = event.request.headers.get("content-type") ?? "";
        const wantsJson = ctype.includes("application/json") || accept.includes("application/json");
        const isPageRoute = ["/", "/login", "/setup", "/oauth/consent"].includes(url.pathname);
        if (wantsJson && !isPageRoute && event.request.method !== "GET") {
          return notFoundJson(url.pathname);
        }
      }

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
