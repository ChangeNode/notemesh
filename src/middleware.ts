import { createMiddleware } from "@solidjs/start/middleware";
import { ensureSyncStarted } from "./server/ob/supervisor";

export default createMiddleware({
  onRequest: [
    async (event) => {
      // Idempotent: restarts the sync daemon after a server (re)boot.
      ensureSyncStarted();

      // OAuth discovery endpoints live under /.well-known/, which the file
      // router doesn't serve — handle them here.
      const url = new URL(event.request.url);
      // RFC 8414 path-inserted variants: issuer is <base>/api/auth, so clients
      // may request /.well-known/oauth-authorization-server/api/auth.
      if (
        url.pathname === "/.well-known/oauth-authorization-server" ||
        url.pathname === "/.well-known/oauth-authorization-server/api/auth"
      ) {
        const { oauthProviderAuthServerMetadata } = await import("@better-auth/oauth-provider");
        const { auth, runAuthMigrations } = await import("./server/auth");
        await runAuthMigrations();
        return oauthProviderAuthServerMetadata(auth)(event.request);
      }
      if (
        url.pathname === "/.well-known/openid-configuration" ||
        url.pathname === "/.well-known/openid-configuration/api/auth" ||
        url.pathname === "/api/auth/.well-known/openid-configuration"
      ) {
        const { oauthProviderOpenIdConfigMetadata } = await import("@better-auth/oauth-provider");
        const { auth, runAuthMigrations } = await import("./server/auth");
        await runAuthMigrations();
        return oauthProviderOpenIdConfigMetadata(auth)(event.request);
      }
      if (url.pathname === "/.well-known/oauth-protected-resource") {
        const { env } = await import("./server/env");
        return new Response(
          JSON.stringify({
            resource: `${env.baseUrl}/api/mcp`,
            authorization_servers: [`${env.baseUrl}/api/auth`],
            scopes_supported: ["vault:read", "vault:write", "openid", "offline_access"],
            bearer_methods_supported: ["header"],
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
    },
  ],
});
