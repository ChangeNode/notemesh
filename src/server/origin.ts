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
 * Compared against the request's own Host as well as the configured base URL,
 * so an instance reached at a domain it was not configured with still works
 * rather than locking the operator out of their own dashboard.
 */
export function originAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;

  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false; // Unparseable Origin: not something to give the benefit of.
  }

  const requestHost = request.headers.get("host");
  if (requestHost && host === requestHost) return true;

  try {
    return host === new URL(process.env.BASE_URL ?? "").host;
  } catch {
    return false;
  }
}
