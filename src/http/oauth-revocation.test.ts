import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimAdmin, markConfigured, rpc, startServer, type Server } from "./harness";

/**
 * Revoking a connector has to end its access, including the access it already
 * holds.
 *
 * Reported from a live server: a connector was revoked from the admin UI and
 * kept working. Revocation itself was thorough — it deletes the access tokens,
 * refresh tokens, consent and the client row — but there are two ways a token
 * reaches this server and only one consulted the database. An opaque token is
 * looked up, so its deletion ends access at once. A JWT was verified against
 * our own JWKS: signature, issuer, audience, and nothing else. Nothing asked
 * whether the client still existed, so a token already issued stayed good for
 * the rest of its hour while the dashboard reported the connector gone.
 *
 * This drives the whole authorization-code flow to get a real signed JWT,
 * because that is the only way to test the thing that was broken. It is also
 * the only end-to-end coverage of that flow in the suite.
 */

let server: Server;
let cookie: string;

beforeAll(async () => {
  server = await startServer();
  cookie = await claimAdmin(server);
  await markConfigured(server);
}, 60_000);

afterAll(async () => {
  await server.stop();
});

const REDIRECT = "http://localhost:9999/cb";
// The RFC 7636 worked example, so the challenge and verifier are known-good.
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

/** Register, authorize, consent, exchange — a real connector's whole handshake. */
async function connectAsClient(): Promise<{ clientId: string; accessToken: string }> {
  const headers = { "Content-Type": "application/json", Origin: server.url };

  const reg = await (
    await fetch(`${server.url}/api/auth/oauth2/register`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        client_name: "revocation-test",
        redirect_uris: [REDIRECT],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    })
  ).json();

  const params = new URLSearchParams({
    response_type: "code",
    client_id: reg.client_id,
    redirect_uri: REDIRECT,
    scope: "vault:read vault:write",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: "test",
    // The RFC 8707 resource indicator is what makes the provider issue a JWT
    // rather than an opaque token — so this parameter is the whole point of the
    // test, not incidental setup.
    resource: `${server.url}/api/mcp`,
  });
  const authorize = await fetch(`${server.url}/api/auth/oauth2/authorize?${params}`, {
    headers: { cookie },
    redirect: "manual",
  });
  // Answers with a Location for a browser navigation and a JSON body otherwise.
  const destination = authorize.headers.get("location")
    ? authorize.headers.get("location")!
    : ((await authorize.json()) as { url: string }).url;
  expect(destination, "authorize should send us to the consent screen").toContain("/oauth/consent");

  const consent = (await (
    await fetch(`${server.url}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: { ...headers, cookie },
      // oauth_query is how the endpoint knows which pending authorization this
      // consent answers.
      body: JSON.stringify({ accept: true, oauth_query: destination.split("?")[1] }),
    })
  ).json()) as { redirectURI?: string; url?: string };

  const code = new URL(consent.redirectURI ?? consent.url!).searchParams.get("code");
  expect(code, "consent should hand back an authorization code").toBeTruthy();

  const token = (await (
    await fetch(`${server.url}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: REDIRECT,
        client_id: reg.client_id,
        code_verifier: VERIFIER,
        resource: `${server.url}/api/mcp`,
      }),
    })
  ).json()) as { access_token?: string };

  expect(token.access_token, "token exchange should succeed").toBeTruthy();
  return { clientId: reg.client_id, accessToken: token.access_token! };
}

function toolsList(accessToken: string) {
  return fetch(`${server.url}/api/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
  });
}

describe("revoking a connector that holds a JWT", () => {
  it("ends its access immediately, not when the token expires", async () => {
    const { clientId, accessToken } = await connectAsClient();

    // A JWT, not an opaque token — three dot-separated segments. If this ever
    // stops holding, the test has quietly moved to the other code path and is
    // no longer covering the bug it exists for.
    expect(accessToken.split(".")).toHaveLength(3);

    expect((await toolsList(accessToken)).status).toBe(200);

    const revoked = await rpc(server, "revokeOAuthClient", [clientId], cookie);
    expect(revoked.status).toBe(200);

    // Same token, same signature, still well inside its hour.
    const after = await toolsList(accessToken);
    expect(after.status).toBe(401);
  }, 60_000);

  it("leaves a different connector alone", async () => {
    // Revocation is per client. Taking out every JWT would be a different bug.
    const keep = await connectAsClient();
    const drop = await connectAsClient();

    await rpc(server, "revokeOAuthClient", [drop.clientId], cookie);

    expect((await toolsList(drop.accessToken)).status).toBe(401);
    expect((await toolsList(keep.accessToken)).status).toBe(200);
  }, 60_000);
});
