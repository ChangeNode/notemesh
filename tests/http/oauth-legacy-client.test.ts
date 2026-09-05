import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { claimAdmin, markConfigured, startServer, type Server } from "./harness";

/**
 * A connector registered under the 1.6 line has no oauthClientResource row —
 * that table did not exist. On 1.7, which refuses a `resource` a client is
 * not linked to, its next authorization would fail with invalid_target and
 * every upgraded deployment's connectors would break at token expiry. This
 * builds that client, by deleting the links 1.7 makes at registration, and
 * authorizes with the resource the MCP specification says to send.
 */

let server: Server;
let cookie: string;

beforeAll(async () => {
  server = await startServer();
  cookie = await claimAdmin(server);
  await markConfigured(server);
}, 60_000);

afterAll(async () => {
  await server?.stop();
});

describe("a connector registered before 1.7", () => {
  it("can still authorize for the MCP endpoint", async () => {
    const reg = await (
      await fetch(`${server.url}/api/auth/oauth2/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: server.url },
        body: JSON.stringify({
          client_name: "legacy",
          redirect_uris: ["https://example.com/cb"],
          grant_types: ["authorization_code"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      })
    ).json();

    // Unlink it, as 1.6 left it.
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(path.join(server.dataDir, "app.sqlite"));
    const removed = db.prepare('DELETE FROM "oauthClientResource" WHERE clientId = ?').run(reg.client_id);
    db.close();
    expect(removed.changes, "registration should have linked the client; the test removes that").toBeGreaterThan(0);

    const params = new URLSearchParams({
      response_type: "code",
      client_id: reg.client_id,
      redirect_uri: "https://example.com/cb",
      scope: "vault:read vault:write",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      state: "s",
      resource: `${server.url}/api/mcp`,
    });
    const authorize = await fetch(`${server.url}/api/auth/oauth2/authorize?${params}`, {
      headers: { cookie },
      redirect: "manual",
    });
    const destination = authorize.headers.get("location") ?? ((await authorize.json()) as { url: string }).url;
    expect(destination).toContain("/oauth/consent");
    expect(destination).not.toContain("invalid_target");
  }, 30_000);
});

describe("a command-line connector's registration", () => {
  it("is accepted as a native client without having to say so", async () => {
    // What the MCP SDK sends: a loopback redirect and no application_type.
    // The 1.7 provider reads a typeless registration as a web client and
    // refuses loopback redirects for those; the auth route fills the type in.
    const res = await fetch(`${server.url}/api/auth/oauth2/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: server.url },
      body: JSON.stringify({
        client_name: "Claude Code",
        redirect_uris: ["http://localhost:53821/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.application_type).toBe("native");
    expect(body.redirect_uris).toEqual(["http://localhost:53821/callback"]);
  });
});
