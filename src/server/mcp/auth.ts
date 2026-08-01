import crypto from "node:crypto";
import { auth } from "../auth";
import { db } from "../db";
import type { McpAccess } from "./server";

// A JWT has exactly two dots and three base64url segments.
export function looksLikeJwt(token: string): boolean {
  const parts = token.split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

// Clients that send an RFC 8707 `resource` parameter (Codex, MCP Inspector) get
// an audience-bound JWT we can verify against our own JWKS. Clients that omit
// it (Claude Code) get an OPAQUE access token instead — there's no audience to
// bind, so the provider issues a random string. We are the authorization
// server, so validate those locally against the token table, which stores
// base64(sha256(token)).
export function accessFromOpaqueOAuth(token: string): McpAccess | null {
  const digest = crypto.createHash("sha256").update(token).digest();
  // Try both base64 alphabets/paddings the provider might use.
  const candidates = [
    digest.toString("base64"),
    digest.toString("base64").replace(/=+$/, ""),
    digest.toString("base64url"),
    digest.toString("base64url").replace(/=+$/, ""),
  ];
  const placeholders = candidates.map(() => "?").join(",");
  const row = db()
    .prepare(
      `SELECT clientId, scopes, expiresAt FROM "oauthAccessToken" WHERE token IN (${placeholders}) LIMIT 1`,
    )
    .get(...candidates) as { clientId: string; scopes: string; expiresAt: string | number } | undefined;
  if (!row) return null;

  const expiresAt =
    typeof row.expiresAt === "number" ? row.expiresAt : new Date(row.expiresAt).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;

  let scopes: string[] = [];
  try {
    const parsed = JSON.parse(row.scopes);
    if (Array.isArray(parsed)) scopes = parsed.filter((s) => typeof s === "string");
  } catch {
    scopes = String(row.scopes).split(/[\s,]+/).filter(Boolean);
  }
  return accessFromScopes(scopes, `oauth:${row.clientId}`);
}

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
