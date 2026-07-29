import { createAuthClient } from "better-auth/solid";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";

// The oauthProviderClient fetch plugin forwards the signed OAuth query
// (present on /login and /oauth/consent during an authorization flow) with
// sign-in and consent requests so the server can resume the flow.
export const authClient = createAuthClient({
  plugins: [oauthProviderClient()],
});
