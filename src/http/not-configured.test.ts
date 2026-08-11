import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimAdmin, createApiKey, startServer, type Server } from "./harness";

/**
 * What the MCP endpoint says before the setup wizard has been finished.
 *
 * The readiness check used to be the first thing the route did, so an
 * unauthenticated client got 503 and never the 401 that carries the discovery
 * hint. A connector added before setup therefore offered no authorize button
 * and no reason why — the same symptom as a broken OAuth implementation, and
 * indistinguishable from one without reading the server's source.
 *
 * Authentication is now resolved first. 503 stays for callers that got that
 * far, because it is the accurate answer: the endpoint exists and will work
 * shortly. RFC 6750 has no error for "not ready" — its codes are 400
 * invalid_request, 401 invalid_token, 403 insufficient_scope, all about the
 * token — so this is plain HTTP semantics rather than an OAuth concern.
 */

let server: Server;
let apiKey: string;

beforeAll(async () => {
  // Deliberately not markConfigured(): this whole file is about that state.
  // An admin and a key are still reachable — claiming the instance is step one
  // of the wizard, so a real credential can exist before the vault is linked.
  server = await startServer();
  const cookie = await claimAdmin(server);
  apiKey = await createApiKey(server, cookie);
}, 60_000);

afterAll(async () => {
  await server.stop();
});

const rpcBody = JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 });

describe("a client that has not authenticated yet", () => {
  it.each(["POST", "GET", "DELETE"])(
    "gets the auth challenge from %s, not the readiness answer",
    async (method) => {
      const res = await fetch(`${server.url}/api/mcp`, {
        method,
        ...(method === "POST"
          ? { headers: { "Content-Type": "application/json" }, body: rpcBody }
          : {}),
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
    },
  );

  it("can follow that challenge to metadata, so a connector can still be set up", async () => {
    const res = await fetch(`${server.url}/api/mcp`, { method: "GET" });
    const url = /resource_metadata="([^"]+)"/.exec(res.headers.get("www-authenticate") ?? "")?.[1];
    const meta = await fetch(url!);
    expect(meta.status).toBe(200);
    expect((await meta.json()).authorization_servers).toHaveLength(1);
  });
});

describe("a client holding a real credential", () => {
  const authed = () =>
    fetch(`${server.url}/api/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: rpcBody,
    });

  it("is told the server is not ready, and when to come back", async () => {
    const res = await authed();
    expect(res.status).toBe(503);
    // Without this a client has no reason to try again rather than give up.
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect((await res.json()).error.message).toMatch(/setup wizard/i);
  });

  it("is not told 404, which would send them hunting for a wrong URL", async () => {
    expect((await authed()).status).not.toBe(404);
  });
});

describe("a credential that is simply wrong", () => {
  it("still hears about the token rather than the wizard", async () => {
    // Readiness is the answer for callers who got in, not a blanket reply.
    const res = await fetch(`${server.url}/api/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer nonsense" },
      body: rpcBody,
    });
    expect(res.status).toBe(401);
  });
});
