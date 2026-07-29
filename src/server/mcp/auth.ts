import { auth } from "../auth";
import type { McpAccess } from "./server";

// Resolve MCP request credentials: an API key (Authorization: Bearer or
// x-api-key header) or an OAuth access token (JWT from the oauth-provider
// plugin, validated in the route via mcpHandler).
export async function accessFromApiKey(request: Request): Promise<McpAccess | null> {
  const headerKey =
    request.headers.get("x-api-key") ??
    bearerToken(request);
  if (!headerKey) return null;
  try {
    const res = await auth.api.verifyApiKey({ body: { key: headerKey } });
    if (res.valid && res.key) {
      return { read: true, write: true, label: `api-key:${res.key.name ?? res.key.id}` };
    }
  } catch {
    // fall through — not a valid API key; may be an OAuth JWT instead
  }
  return null;
}

export function bearerToken(request: Request): string | null {
  const h = request.headers.get("authorization");
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export function accessFromScopes(scopes: string[], label: string): McpAccess {
  return {
    read: scopes.includes("vault:read") || scopes.includes("vault:write"),
    write: scopes.includes("vault:write"),
    label,
  };
}
