import type { APIEvent } from "@solidjs/start/server";
import { serveMcp } from "~/server/mcp/http";
import { accessFromApiKey, accessFromOpaqueOAuth, bearerToken, looksLikeJwt } from "~/server/mcp/auth";
import { getSetting } from "~/server/db";
import { runAuthMigrations } from "~/server/auth";
import { env } from "~/server/env";
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
// written via args, but the 10 MB note cap is the real ceiling).
const MAX_BODY_BYTES = 4 * 1000 * 1000;

export async function POST(event: APIEvent) {
  await runAuthMigrations();

  const lenHeader = event.request.headers.get("content-length");
  if (lenHeader && Number(lenHeader) > MAX_BODY_BYTES) {
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32600, message: "Request too large" }, id: null }),
      { status: 413, headers: { "Content-Type": "application/json" } },
    );
  }

  if (getSetting("vault_configured") !== "true") {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32002, message: "Server not configured yet — finish the setup wizard first." },
        id: null,
      }),
      { status: 503, headers: { "Content-Type": "application/json" } },
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
      return serveMcp(event.request, opaque);
    }
  }

  // 3) API key (Authorization: Bearer <key> or x-api-key).
  const keyAccess = await accessFromApiKey(event.request);
  if (keyAccess) {
    clearAuthFailures(ip);
    return serveMcp(event.request, keyAccess);
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
function guarded(event: APIEvent): Response {
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
