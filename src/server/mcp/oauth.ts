import { mcpHandler } from "@better-auth/oauth-provider";
import type { JWTPayload } from "jose";
import { env } from "../env";
import { serveMcp } from "./http";
import { accessFromScopes, bearerToken } from "./auth";

function scopesFromJwt(jwt: JWTPayload): string[] {
  if (typeof jwt.scope === "string") return jwt.scope.split(" ").filter(Boolean);
  if (Array.isArray((jwt as any).scopes)) return (jwt as any).scopes as string[];
  return [];
}

let handler: ((req: Request) => Promise<Response>) | null = null;

function getHandler() {
  if (!handler) {
    handler = mcpHandler(
      {
        // Same-origin AS and RS: verify locally against our own JWKS.
        jwksUrl: `${env.baseUrl}/api/auth/jwks`,
        verifyOptions: {
          // Matches the oauth-provider's issuer: baseURL + basePath.
          issuer: `${env.baseUrl}/api/auth`,
          audience: [env.baseUrl, `${env.baseUrl}/api/mcp`],
        },
      },
      async (req, jwt) => {
        const scopes = scopesFromJwt(jwt);
        const label = `oauth:${(jwt as any).client_id ?? jwt.sub ?? "unknown"}`;
        return serveMcp(req, accessFromScopes(scopes, label));
      },
    );
  }
  return handler;
}

// Returns a Response when the request carries a bearer token (valid → MCP
// response; invalid → 401 with WWW-Authenticate), or null when there is no
// token at all so the caller can fall through.
export async function handleMcpWithOAuth(request: Request): Promise<Response | null> {
  if (!bearerToken(request)) return null;
  return getHandler()(request);
}
