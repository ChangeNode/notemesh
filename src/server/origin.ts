import { env } from "./env";

/**
 * Is this request allowed to come from the origin it claims?
 *
 * Shared by the RPC route and the MCP endpoint, which want it for different
 * reasons that happen to have the same answer.
 *
 * For `/api/rpc` it is CSRF defence in depth. The session cookie is
 * SameSite=Lax, which already stops a browser sending it on a cross-site POST —
 * but one control is not a spare, and Chrome's Lax+POST grace period leaves a
 * couple of minutes after sign-in where the cookie does travel.
 *
 * For `/api/mcp` it is a requirement. The MCP Streamable HTTP transport, in
 * the 2025-11-25 revision this server implements and unchanged in the draft:
 *
 * > Servers **MUST** validate the `Origin` header on all incoming connections
 * > to prevent DNS rebinding attacks. If the `Origin` header is present and
 * > invalid, servers **MUST** respond with HTTP 403 Forbidden.
 *
 * A missing Origin is allowed, and that is the part worth being careful about.
 * Every browser sends one on a cross-origin request, so its absence means the
 * caller is not a browser being tricked — it is curl, a script, a test, or
 * Anthropic's and OpenAI's infrastructure, which is how every connector reaches
 * this server. Refusing a request with no Origin would disconnect every client
 * this product exists to serve, while stopping nothing: the attack being
 * prevented is a web page making requests, and a web page cannot omit it.
 *
 * The comparison is against an explicit allowlist built from the configured
 * base URL — the whole origin, scheme and port included — and nothing else.
 * It used to accept any Origin whose host matched the request's own Host
 * header, meant as leniency for a dashboard reached at a domain the server
 * was not configured with. Under DNS rebinding both headers carry the
 * attacker's name, so that comparison established nothing (NM-SEC-003, #51).
 * The leniency was also hollow: Better Auth refuses sign-in from an origin it
 * was not configured with, so a dashboard at the wrong domain never got past
 * the login page. The origin-mismatch notice on the dashboard and in the
 * alert channel is how an operator learns to fix BASE_URL.
 *
 * Host is not validated on its own. The rebinding attack needs a browser,
 * which always sends Origin on the POSTs these endpoints accept, so Origin is
 * the header that decides; a Host allowlist would refuse platform health
 * checks and internal routing, which arrive under other names and no Origin.
 */

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/**
 * The origins a browser may send. The configured base URL's origin, and —
 * only when that is itself a loopback address, which is local development —
 * the same port under each loopback name, since a developer reaches the same
 * server as localhost and 127.0.0.1 interchangeably. A deployment configured
 * with a real hostname gets exactly that hostname.
 */
export function allowedOrigins(baseUrl: string = env.baseUrl): Set<string> {
  const out = new Set<string>();
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return out;
  }
  out.add(base.origin);
  const host = base.hostname === "::1" ? "[::1]" : base.hostname;
  if (LOOPBACK_HOSTS.includes(host)) {
    const port = base.port ? `:${base.port}` : "";
    for (const h of LOOPBACK_HOSTS) out.add(`${base.protocol}//${h}${port}`);
  }
  return out;
}

export function originAllowed(request: Request, allowed: Set<string> = allowedOrigins()): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  // "null" is what a browser sends from a sandboxed frame or a file: URL —
  // an opaque origin, which is not this server's.
  if (origin === "null") return false;
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false; // Unparseable Origin: not something to give the benefit of.
  }
  if (o.protocol !== "http:" && o.protocol !== "https:") return false;
  // URL.origin normalises: lowercase host, default ports dropped.
  return allowed.has(o.origin);
}
