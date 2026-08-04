// Which OAuth discovery document a request is asking for, if any.
//
// These live under /.well-known/, which SolidStart's file router does not serve,
// so middleware.ts dispatches them by path. The matching is pulled out here
// because the path list is the fragile part: a client that asks for a variant
// we don't list gets the SPA shell instead of JSON, and the failure surfaces
// client-side as an unreadable parse error rather than a 404.
//
// It also stands in for a warning we deliberately silenced. The oauth-provider
// plugin warns on every boot that the path-inserted variant may not exist,
// because it only knows about routes it registered itself and cannot see this
// middleware. Silencing that warning removes the only thing watching these
// paths, so the tests against this function take over the job.
export type DiscoveryEndpoint = "auth-server" | "openid" | "protected-resource" | null;

// The issuer is <base>/api/auth, i.e. it has a path component. RFC 8414 says the
// metadata URL for such an issuer inserts that path *after* the well-known
// segment, so compliant clients request
// /.well-known/oauth-authorization-server/api/auth. Some clients ask for the
// bare form instead, and OIDC clients additionally probe the legacy
// issuer-prefixed /api/auth/.well-known/openid-configuration — all are served.
const AUTH_SERVER = [
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/api/auth",
];

const OPENID = [
  "/.well-known/openid-configuration",
  "/.well-known/openid-configuration/api/auth",
  "/api/auth/.well-known/openid-configuration",
];

const PROTECTED_RESOURCE = ["/.well-known/oauth-protected-resource"];

export function discoveryEndpoint(pathname: string): DiscoveryEndpoint {
  if (AUTH_SERVER.includes(pathname)) return "auth-server";
  if (OPENID.includes(pathname)) return "openid";
  if (PROTECTED_RESOURCE.includes(pathname)) return "protected-resource";
  return null;
}
