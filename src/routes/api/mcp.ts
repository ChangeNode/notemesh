import type { APIEvent } from "@solidjs/start/server";
import { serveMcp } from "~/server/mcp/http";
import { accessFromApiKey } from "~/server/mcp/auth";
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

export async function POST(event: APIEvent) {
  await runAuthMigrations();
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

  // 1) API key (simple bearer or x-api-key)
  const keyAccess = await accessFromApiKey(event.request);
  if (keyAccess) return serveMcp(event.request, keyAccess);

  // 2) OAuth access token (JWT issued by the built-in OAuth provider)
  const oauthResponse = await handleMcpWithOAuth(event.request);
  if (oauthResponse) return oauthResponse;

  return unauthorized();
}

// Stateless mode: no SSE stream to resume and no session to delete.
export function GET() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}

export function DELETE() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
