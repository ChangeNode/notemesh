import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import type { JWTPayload } from "jose";
import { env } from "../env";
import { serveMcp } from "./http";
import { accessFromScopes, bearerToken, oauthClientExists } from "./auth";

function scopesFromJwt(jwt: JWTPayload): string[] {
  if (typeof jwt.scope === "string") return jwt.scope.split(" ").filter(Boolean);
  if (Array.isArray((jwt as any).scopes)) return (jwt as any).scopes as string[];
  return [];
}

/**
 * 401 for a token this endpoint will not honour. The route turns any 401 from
 * here into its own challenge response, so the client is told to authenticate
 * again rather than left guessing — which, after a revoke, is exactly what it
 * should do.
 */
function refused(message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }),
    { status: 401, headers: { "Content-Type": "application/json" } },
  );
}

// The provider's resource-server client, verifying locally against our own
// JWKS: same-origin authorization and resource server. It replaced the 1.6
// line's mcpHandler in 1.7 (#55). The audience list names this one endpoint
// twice — the two identifiers declared as resources in auth.ts — and is kept
// in step with that list.
const { verifyBearerToken } = oauthProviderResourceClient().getActions();

async function verify(token: string): Promise<JWTPayload | null> {
  try {
    return await verifyBearerToken(token, {
      jwksUrl: `${env.baseUrl}/api/auth/jwks`,
      verifyOptions: {
        // Matches the oauth-provider's issuer: baseURL + basePath.
        issuer: `${env.baseUrl}/api/auth`,
        audience: [env.baseUrl, `${env.baseUrl}/api/mcp`],
      },
    });
  } catch {
    return null;
  }
}

// Returns a Response when the request carries a bearer token (valid → MCP
// response; invalid → 401), or null when there is no token at all so the
// caller can fall through.
export async function handleMcpWithOAuth(request: Request): Promise<Response | null> {
  const token = bearerToken(request);
  if (!token) return null;
  const jwt = await verify(token);
  if (!jwt) return refused("Unauthorized");

  // Signature, issuer and audience are what the verifier checked, which is
  // what a JWT is for — and it meant a revoked connector kept working until
  // its token expired an hour later, because nothing asked whether the client
  // was still there. The admin UI said access had ended; the endpoint
  // disagreed. So the client is looked up on every call.
  //
  // Which claim carries the client id depends on where you look, so both are
  // accepted: a decoded access token shows `azp`, and the 1.6 handler used to
  // put `client_id` in the payload it handed on. A token carrying neither is
  // refused rather than given the benefit of a claim it does not have; if a
  // provider release renames both, every request fails closed and the
  // revocation test says so immediately, which is the right way round.
  const clientId = (jwt as any).client_id ?? (jwt as any).azp;
  if (typeof clientId !== "string" || !oauthClientExists(clientId)) {
    return refused("This connector's access has been revoked.");
  }

  return serveMcp(request, accessFromScopes(scopesFromJwt(jwt), `oauth:${clientId}`));
}
