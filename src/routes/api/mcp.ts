import type { APIEvent } from "@solidjs/start/server";
import { serveMcp } from "~/server/mcp/http";
import { accessFromApiKey, accessFromOpaqueOAuth, bearerToken, looksLikeJwt } from "~/server/mcp/auth";
import { getSetting } from "~/server/db";
import { runAuthMigrations } from "~/server/auth";
import { env } from "~/server/env";
import { originAllowed } from "~/server/origin";
import { handleMcpWithOAuth } from "~/server/mcp/oauth";
import { clientIp, authFailureBlock, noteAuthFailure, clearAuthFailures } from "~/server/mcp/ratelimit";

function tooManyRequests(retryAfterSeconds: number): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32003, message: "Too many failed authentication attempts" },
      id: null,
    }),
    {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": String(retryAfterSeconds) },
    },
  );
}

/**
 * Authenticated, but the wizard has not been finished.
 *
 * Checked *after* authentication, not before. It used to be the first thing
 * this route did, which meant an unauthenticated client got 503 and never the
 * 401 that carries the discovery hint — so a connector added before setup
 * offered no authorize button and no reason why, which is a confusing hour for
 * whoever hits it.
 *
 * 503 is the right status and stays. RFC 6750 defines resource-server errors
 * only for token problems — 400 invalid_request, 401 invalid_token, 403
 * insufficient_scope — and none of them describes a server that is simply not
 * ready. Plain HTTP does: 503 means the endpoint exists and will work later,
 * which is exactly true here and is what a client should hear. 404 would say
 * the opposite, and send whoever reads it hunting for a typo in their URL.
 *
 * Retry-After is what was missing. It is how a well-behaved client is told to
 * come back rather than give up, and the wizard takes minutes, not hours.
 */
function notConfigured(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32002, message: "Server not configured yet — finish the setup wizard first." },
      id: null,
    }),
    {
      status: 503,
      headers: { "Content-Type": "application/json", "Retry-After": "120" },
    },
  );
}

/** Has the wizard been finished? */
function configured(): boolean {
  return getSetting("vault_configured") === "true";
}

function unauthorized(): Response {
  // Per the MCP auth spec, point unauthenticated clients at the
  // protected-resource metadata so they can discover the OAuth server.
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        // scope= as well as resource_metadata: the spec has clients prefer the
        // challenge over scopes_supported when choosing what to request, and
        // says servers SHOULD provide it. Without it a client falls back to the
        // metadata document and asks for whatever is listed there.
        "WWW-Authenticate":
          `Bearer resource_metadata="${env.baseUrl}/.well-known/oauth-protected-resource", ` +
          `scope="vault:read vault:write"`,
      },
    },
  );
}

// Cap the JSON-RPC request body so a client can't exhaust memory with a huge
// payload. MCP tool calls are small; 4 MB is generous (note content is
// written via args, but the write cap in vault/notes.ts is the real ceiling).
const MAX_BODY_BYTES = 4 * 1000 * 1000;

export async function POST(event: APIEvent) {
  // First, before the body is read or a credential is looked at. A DNS
  // rebinding attack is a web page talking to this endpoint from an origin it
  // has no business using, and the cheapest place to end that is immediately.
  if (!originAllowed(event.request)) return forbiddenOrigin();

  await runAuthMigrations();

  const lenHeader = event.request.headers.get("content-length");
  if (lenHeader && Number(lenHeader) > MAX_BODY_BYTES) {
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32600, message: "Request too large" }, id: null }),
      { status: 413, headers: { "Content-Type": "application/json" } },
    );
  }

  // Throttling applies ONLY to requests that fail to authenticate. We
  // deliberately authenticate first and never gate on the bucket beforehand: a
  // valid credential must always be served, even while an anonymous prober is
  // being throttled from the same apparent address (they share a bucket
  // whenever no per-client IP is resolvable).
  const ip = clientIp(event.request);
  const authFailed = (): Response => {
    noteAuthFailure(ip);
    const b = authFailureBlock(ip);
    return b.blocked ? tooManyRequests(b.retryAfterSeconds) : unauthorized();
  };

  // Dispatch on credential shape so each token type takes exactly one path
  // (and an OAuth token is never run through API-key validation, which logs
  // a spurious error for every request).
  const bearer = bearerToken(event.request);

  // 1) OAuth JWT (clients that send an RFC 8707 `resource`): verify via JWKS.
  if (bearer && looksLikeJwt(bearer)) {
    // Readiness before token validation on this path only, so an unconfigured
    // server never runs a tool call it has no vault for. The cost is that an
    // invalid token here hears "not configured" rather than "bad token" — which
    // is the more useful of the two anyway, since a server without a finished
    // wizard has issued no valid tokens at all. A request with no credential
    // never reaches this branch; it falls through and gets the 401.
    if (!configured()) return notConfigured();
    const oauthResponse = await handleMcpWithOAuth(event.request);
    if (oauthResponse) {
      if (oauthResponse.status === 401) return authFailed();
      clearAuthFailures(ip);
      return oauthResponse;
    }
    return authFailed();
  }

  // 2) OAuth opaque token (clients that omit `resource`, e.g. Claude Code):
  // validate locally against our own token table.
  if (bearer) {
    const opaque = accessFromOpaqueOAuth(bearer);
    if (opaque) {
      clearAuthFailures(ip);
      return configured() ? serveMcp(event.request, opaque) : notConfigured();
    }
  }

  // 3) API key (Authorization: Bearer <key> or x-api-key).
  const keyAccess = await accessFromApiKey(event.request);
  if (keyAccess) {
    clearAuthFailures(ip);
    return configured() ? serveMcp(event.request, keyAccess) : notConfigured();
  }

  return authFailed();
}

/**
 * Stateless mode: there is no SSE stream to resume and no session to delete, so
 * GET and DELETE have nothing to do — but an *unauthenticated* one still has to
 * be answered as unauthenticated.
 *
 * These used to return a bare 405 with no WWW-Authenticate. The transport spec
 * does allow 405 for a GET a server will not upgrade to a stream, so that read
 * correctly in isolation; the authorization spec is what it missed, since a
 * request carrying no valid token gets 401 whatever method it used. The two
 * only conflict if you check the method first, which is what this did.
 *
 * The cost was not theoretical. A client that probes with GET before anything
 * else — Codex does, and it is the only signal it has to go on — saw a 405 with
 * no challenge, concluded the server offered no authentication it understood,
 * and reported "Auth: Unsupported" with no authorization button anywhere. The
 * 401 on POST was correct the whole time and nothing ever asked for it.
 *
 * So: authenticate first, answer 405 second.
 */
/**
 * 403 for a request whose Origin is present and not ours.
 *
 * The transport spec's wording: the body **MAY** comprise a JSON-RPC error
 * response that has no `id`. It has none because there is no request to answer
 * — nothing has been parsed at the point this fires.
 */
function forbiddenOrigin(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32600, message: "Origin not allowed." },
      id: null,
    }),
    { status: 403, headers: { "Content-Type": "application/json" } },
  );
}

function guarded(event: APIEvent): Response {
  if (!originAllowed(event.request)) return forbiddenOrigin();
  // Presence of a credential, deliberately not its validity. These methods do
  // nothing in stateless mode, so there is nothing to protect and no reason for
  // a second validation path that could drift from the real one in POST. The
  // only thing that has to be right is that a request arriving with no
  // credential at all is told authentication exists and where to find it.
  const presented =
    Boolean(bearerToken(event.request)) || Boolean(event.request.headers.get("x-api-key"));
  return presented
    ? new Response(null, { status: 405, headers: { Allow: "POST" } })
    : unauthorized();
}

export const GET = guarded;
export const DELETE = guarded;
