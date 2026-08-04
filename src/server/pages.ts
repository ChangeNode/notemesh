/**
 * Who may reach a given path.
 *
 * Default closed: a path that renders a page requires a signed-in admin unless
 * it is explicitly listed as public. The previous shape was the other way round
 * — an allow-list of protected pages — which meant every new admin route was
 * reachable by anyone until someone remembered to add it. That is not a
 * hypothetical: the Keys tab shipped and had to have its route added to the
 * guard as a separate step, and nothing would have failed if it hadn't been.
 * Getting it wrong now means a page 302s to the login form, which is noticed
 * immediately; getting it wrong before meant a page served to strangers, which
 * is noticed by nobody.
 *
 * This is the navigation-level guard, not the security boundary. Server
 * functions call requireAdmin() themselves and MCP requests carry their own
 * credentials — that is what actually protects data. This decides what a
 * browser is allowed to render.
 */
export type PageAccess = "public" | "protected" | "not-a-page";

// Reachable without signing in, and each is deliberate: the login form itself,
// the setup wizard (which must be usable before any account exists), and the
// OAuth consent screen (reached mid-flow, and which checks its own session).
const PUBLIC_PAGES = new Set(["/login", "/setup", "/oauth/consent"]);

// Not pages at all. These carry their own access rules and must never be
// redirected — sending /_server to the login form would break every server
// function, including the one that signs you in.
const NON_PAGE_PREFIXES = [
  "/api/", // Better Auth, health, the MCP endpoint
  "/.well-known/", // OAuth discovery documents, public by specification
  "/_server", // server-function RPC; each handler calls requireAdmin itself
  "/_build/", // client bundle (served before middleware in practice)
];

export function pageAccess(pathname: string): PageAccess {
  if (NON_PAGE_PREFIXES.some((p) => pathname.startsWith(p))) return "not-a-page";
  // A final segment containing a dot is a file request — favicon.ico,
  // robots.txt — never one of our routes, which are all extensionless.
  if (pathname.slice(pathname.lastIndexOf("/") + 1).includes(".")) return "not-a-page";
  if (PUBLIC_PAGES.has(pathname)) return "public";
  return "protected";
}
