import type { APIEvent } from "@solidjs/start/server";
import { serveMcp } from "~/server/mcp/http";
import { accessFromApiKey, accessFromOpaqueOAuth, bearerToken, looksLikeJwt } from "~/server/mcp/auth";
import { getSetting } from "~/server/db";
import { runAuthMigrations } from "~/server/auth";
import { env } from "~/server/env";
import { handleMcpWithOAuth } from "~/server/mcp/oauth";

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
        "WWW-Authenticate": `Bearer resource_metadata="${env.baseUrl}/.well-known/oauth-protected-resource"`,
      },
    },
  );
}

// Cap the JSON-RPC request body so a client can't exhaust memory with a huge
// payload. MCP tool calls are small; 4 MiB is generous (note content is
// written via args, but the 10 MiB note cap is the real ceiling).
const MAX_BODY_BYTES = 4 * 1024 * 1024;

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

  // Dispatch on credential shape so each token type takes exactly one path
  // (and an OAuth token is never run through API-key validation, which logs
  // a spurious error for every request).
  const bearer = bearerToken(event.request);

  // 1) OAuth JWT (clients that send an RFC 8707 `resource`): verify via JWKS.
  if (bearer && looksLikeJwt(bearer)) {
    const oauthResponse = await handleMcpWithOAuth(event.request);
    if (oauthResponse) return oauthResponse;
    return unauthorized();
  }

  // 2) OAuth opaque token (clients that omit `resource`, e.g. Claude Code):
  // validate locally against our own token table.
  if (bearer) {
    const opaque = accessFromOpaqueOAuth(bearer);
    if (opaque) return serveMcp(event.request, opaque);
  }

  // 3) API key (Authorization: Bearer <key> or x-api-key).
  const keyAccess = await accessFromApiKey(event.request);
  if (keyAccess) return serveMcp(event.request, keyAccess);

  return unauthorized();
}

// Stateless mode: no SSE stream to resume and no session to delete.
export function GET() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}

export function DELETE() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
