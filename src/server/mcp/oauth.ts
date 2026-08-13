import { mcpHandler } from "@better-auth/oauth-provider";
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
 * 401 for a token whose client is gone.
 *
 * The route turns any 401 from this handler into its own challenge response, so
 * the client is told to authenticate again rather than left guessing — which,
 * after a revoke, is exactly what it should do.
 */
function revoked(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32001, message: "This connector's access has been revoked." },
      id: null,
    }),
    { status: 401, headers: { "Content-Type": "application/json" } },
  );
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
          // Deliberately the same two values as validAudiences in auth.ts, and
          // both name this endpoint: this is the only resource server, so a
          // token issued for either is equally valid here. Keep the two lists in
          // step — see the security note beside validAudiences and issue #10.
          audience: [env.baseUrl, `${env.baseUrl}/api/mcp`],
        },
      },
      async (req, jwt) => {
        // Signature, issuer and audience are all this handler checked, which is
        // what a JWT is for — and it meant a revoked connector kept working
        // until its token expired an hour later, because nothing asked whether
        // the client was still there. The admin UI said access had ended; the
        // endpoint disagreed.
        //
        // Which claim carries the client id depends on where you look, so both
        // are accepted. Decoding a real access token shows `azp` and no
        // `client_id`; the payload this callback receives has `client_id`,
        // because the provider's handler puts it there. Today only the first
        // branch is ever taken — verified by removing the fallback, which
        // changes nothing — and the second is kept because the raw token says
        // `azp` and a provider release could reasonably pass that through
        // instead.
        //
        // A token carrying neither is refused rather than given the benefit of
        // a claim it does not have. If a future provider renames both, every
        // request fails closed and the revocation test says so immediately,
        // which is the right way round for this to break.
        const clientId = (jwt as any).client_id ?? (jwt as any).azp;
        if (typeof clientId !== "string" || !oauthClientExists(clientId)) {
          return revoked();
        }

        const scopes = scopesFromJwt(jwt);
        const label = `oauth:${clientId}`;
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
