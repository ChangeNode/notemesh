/**
 * Fill in what a native client's registration leaves unsaid.
 *
 * Better Auth 1.7 validates redirect URIs by application type, and a
 * registration that does not state one is a web client — which may not use
 * a loopback redirect at all. Every command-line connector registers exactly
 * that way: a plain-HTTP redirect on localhost or 127.0.0.1, no
 * `application_type` (the MCP SDK's client metadata has no field for it),
 * and `token_endpoint_auth_method: "none"`. Under RFC 8252 that is the
 * definition of a native client, so that is what it is recorded as. A
 * registration that states a type, or whose redirects are not all loopback,
 * is passed through untouched, and the provider's rules apply in full
 * (#55).
 */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isHttpLoopback(uri: unknown): boolean {
  if (typeof uri !== "string") return false;
  try {
    const u = new URL(uri);
    return u.protocol === "http:" && LOOPBACK.has(u.hostname === "::1" ? "[::1]" : u.hostname);
  } catch {
    return false;
  }
}

/** The registration body with `application_type` inferred where it can be. */
export function normalizeClientRegistration(body: unknown): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return body;
  const b = body as Record<string, unknown>;
  if (b.application_type !== undefined) return body;
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || !uris.every(isHttpLoopback)) return body;
  return { ...b, application_type: "native" };
}
