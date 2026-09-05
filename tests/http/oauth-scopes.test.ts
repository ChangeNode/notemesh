import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type Server } from "./harness";

/**
 * What the authorization server says it supports, against what it actually
 * grants a client that registers.
 *
 * These were two separate lists and they disagreed: `profile` and `email` were
 * advertised in the metadata but withheld at registration unless a client asked
 * for them by name. ChatGPT does not ask — it reads `scopes_supported`,
 * registers with no scope field, then requests what it was told exists and gets
 * `invalid_scope` back at its own authorization step. The only way through was
 * for the operator to find OIDC in an advanced panel and turn it off.
 *
 * Nothing checked the two lists against each other, which is why they could
 * drift. That is what this file is for.
 */

let server: Server;

beforeAll(async () => {
  server = await startServer();
}, 60_000);

afterAll(async () => {
  await server.stop();
});

/** Register the way an MCP client does: no scope field, public client, PKCE. */
async function register(): Promise<{ client_id: string; scope: string }> {
  const res = await fetch(`${server.url}/api/auth/oauth2/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "scope-test",
      redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  // 201 Created, as RFC 7591 §3.2.1 says; the 1.6 line answered 200.
  expect(res.status).toBe(201);
  return res.json();
}

async function advertisedScopes(): Promise<string[]> {
  const res = await fetch(`${server.url}/.well-known/oauth-authorization-server`);
  return (await res.json()).scopes_supported;
}

describe("advertised scopes and granted scopes", () => {
  it("grants a self-registering client everything the metadata advertises", async () => {
    const advertised = await advertisedScopes();
    const granted = (await register()).scope.split(" ");
    // Set comparison: order is not part of the contract, coverage is.
    expect([...granted].sort()).toEqual([...advertised].sort());
  });

  it("advertises the OIDC scopes ChatGPT asks for when OIDC is left on", async () => {
    const advertised = await advertisedScopes();
    for (const scope of ["openid", "profile", "email"]) {
      expect(advertised).toContain(scope);
    }
  });
});

describe("authorizing with the scopes a client was promised", () => {
  /**
   * Where the authorize endpoint sends this request, without following it.
   *
   * Better Auth answers in one of two shapes depending on the caller: a browser
   * navigation gets a 302 with a Location header, and anything else gets a 200
   * whose body is `{ redirect: true, url }`. curl sees the first, this test
   * client the second. Reading only the header made three assertions here pass
   * against a destination that was never parsed — `searchParams.get("error")`
   * on `new URL(null, base)` is null, which looks exactly like success.
   */
  async function authorize(scope: string): Promise<URL> {
    const { client_id } = await register();
    const params = new URLSearchParams({
      response_type: "code",
      client_id,
      redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      state: "test",
      scope,
    });
    const res = await fetch(`${server.url}/api/auth/oauth2/authorize?${params}`, {
      redirect: "manual",
    });

    const header = res.headers.get("location");
    if (header) return new URL(header, server.url);

    const body = (await res.json()) as { redirect?: boolean; url?: string };
    expect(body.url, `no redirect in either shape (status ${res.status})`).toBeTruthy();
    return new URL(body.url!, server.url);
  }

  it("accepts the full set ChatGPT requests with OIDC enabled", async () => {
    // The exact scope string that failed in production, verbatim.
    const location = await authorize("openid profile email offline_access vault:read vault:write");
    expect(location.searchParams.get("error")).toBeNull();
    // Not signed in, so the destination is the login page rather than a code.
    expect(location.pathname).toBe("/login");
  });

  it.each([
    "vault:read vault:write",
    "openid vault:read vault:write",
    "openid profile email vault:read vault:write",
  ])("accepts %s", async (scope) => {
    const location = await authorize(scope);
    expect(location.searchParams.get("error")).toBeNull();
  });

  it("still refuses a scope that was never advertised", async () => {
    // The guard is meant to widen, not disappear.
    const location = await authorize("vault:read vault:admin");
    expect(location.searchParams.get("error")).toBe("invalid_scope");
  });
});
