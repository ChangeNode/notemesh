import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimAdmin, createApiKey, markConfigured, mcp, rpc, startServer, type Server } from "./harness";

// Every endpoint this server exposes, over real HTTP, against the built output.
//
// The module tests cover what functions return. These cover what the *server*
// returns, which is where the middleware, the auth gate and the route wiring
// live — and where most of the bugs that reached a user actually were. Until
// now this layer was checked by hand with curl whenever it changed.
//
// Each area gets both directions: the call that should work, and the call that
// should be refused. Auth negatives matter most, because a wrong answer there
// is silent — nothing looks broken when a door that should be locked is open.

let server: Server;
let cookie: string;
let apiKey: string;

beforeAll(async () => {
  server = await startServer();
  cookie = await claimAdmin(server);
  await markConfigured(server);
  apiKey = await createApiKey(server, cookie, "http-tests");
}, 60_000);

afterAll(async () => {
  await server?.stop();
});

// Kept in step with the PUBLIC set in routes/api/rpc/[fn].ts by the
// exhaustiveness test at the bottom, which fails if a handler appears in
// neither list.
const PUBLIC_RPC = [
  "getSetupStage",
  "getSetupProgress",
  "getClaimState",
  "setupChooseBackend",
  "setupGitRepo",
  "setupObsidianLogin",
  "setupListVaults",
  "setupConfigureVault",
  "getResetState",
  "submitAdminReset",
];

const PROTECTED_RPC = [
  "getSetupPage",
  "getKeysPage",
  "getStatusPage",
  "getSettingsPage",
  "getSecurityPage",
  "getSyncActivity",
  "createApiKey",
  "deleteApiKey",
  "revokeOAuthClient",
  "setGitTiming",
  "setGitConflictStrategy",
  "setTimezone",
  "setDeleteEnabled",
  "setDailyConfig",
  "relinkVault",
  "syncNow",
  "stopSync",
  "restartSync",
  "rebuildIndex",
  "reauth",
];

describe("health", () => {
  it("answers without a session", async () => {
    const res = await fetch(`${server.url}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, configured: true });
  });
});

describe("RPC: auth", () => {
  it.each(PROTECTED_RPC)("refuses %s without a session", async (fn) => {
    const res = await rpc(server, fn);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it.each(PROTECTED_RPC)("refuses %s with a forged session cookie", async (fn) => {
    const res = await rpc(server, fn, [], "better-auth.session_token=not-a-real-token");
    expect(res.status).toBe(401);
  });

  it.each(PUBLIC_RPC)("allows %s without a session", async (fn) => {
    // Called with no arguments: the point is that the gate lets it through, not
    // that it succeeds, so anything other than 401 passes.
    const res = await rpc(server, fn);
    expect(res.status).not.toBe(401);
  });

  it("rejects an unknown procedure rather than guessing", async () => {
    const res = await rpc(server, "definitelyNotAHandler", [], cookie);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("rejects a procedure name that is not an identifier", async () => {
    // Path traversal or property access through the dispatch name.
    for (const bad of ["__proto__", "constructor", "toString"]) {
      const res = await rpc(server, bad, [], cookie);
      expect([400, 404]).toContain(res.status);
    }
  });

  it("rejects a body that is not a JSON array", async () => {
    const res = await fetch(`${server.url}/api/rpc/getStatusPage`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ not: "an array" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a GET, since every procedure is a POST", async () => {
    const res = await fetch(`${server.url}/api/rpc/getStatusPage`, { headers: { Cookie: cookie } });
    expect(res.status).not.toBe(200);
  });
});

describe("RPC: the dashboard loaders return real data", () => {
  it("getSetupPage carries the endpoint the UI shows", async () => {
    const res = await rpc(server, "getSetupPage", [], cookie);
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ baseUrl: server.url });
  });

  it("getStatusPage carries vault and sync state", async () => {
    const res = await rpc(server, "getStatusPage", [], cookie);
    expect(res.status).toBe(200);
    const r = res.body.result as any;
    expect(r.vault).toBeDefined();
    expect(r.sync).toBeDefined();
    expect(Array.isArray(r.logs)).toBe(true);
  });

  it("getSecurityPage reports posture, not secrets", async () => {
    const res = await rpc(server, "getSecurityPage", [], cookie);
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body.result);
    expect(body).not.toMatch(/ENCRYPTION_KEY|password|secret_key/i);
  });

  it("getSettingsPage round-trips a setting change", async () => {
    expect((await rpc(server, "setTimezone", ["Asia/Tokyo"], cookie)).status).toBe(200);
    const res = await rpc(server, "getSettingsPage", [], cookie);
    expect((res.body.result as any).timezone).toBe("Asia/Tokyo");
  });

  it("refuses a timezone the server does not recognise", async () => {
    const res = await rpc(server, "setTimezone", ["Mars/Olympus_Mons"], cookie);
    expect(res.status).toBe(200); // handled, not thrown
    expect((res.body.result as any).ok).toBe(false);
  });
});

describe("MCP endpoint", () => {
  it("refuses a request with no credentials", async () => {
    const res = await mcp(server, "tools/list", {});
    expect(res.status).toBe(401);
  });

  it.each([
    ["a made-up key", "Bearer not-a-real-key"],
    ["an empty bearer", "Bearer "],
    ["a malformed header", "NotBearer abc"],
    ["a JWT-shaped string", "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.signature"],
  ])("refuses %s", async (_label, header) => {
    const res = await mcp(server, "tools/list", {}, header);
    expect(res.status).toBe(401);
  });

  it("serves the tool list with a valid API key", async () => {
    const res = await mcp(server, "tools/list", {}, `Bearer ${apiKey}`);
    expect(res.status).toBe(200);
    const names = (res.json?.result?.tools ?? []).map((t: any) => t.name);
    expect(names).toContain("read_note");
    expect(names).toContain("list_attachments");
  });

  it("performs a real tool call", async () => {
    const res = await mcp(
      server,
      "tools/call",
      { name: "get_vault_info", arguments: {} },
      `Bearer ${apiKey}`,
    );
    expect(res.status).toBe(200);
    expect(res.json?.result?.content?.[0]?.text).toContain("vaultName");
  });

  it("stops accepting a key once it is revoked", async () => {
    const doomed = await createApiKey(server, cookie, "doomed");
    expect((await mcp(server, "tools/list", {}, `Bearer ${doomed}`)).status).toBe(200);

    const keys = (await rpc(server, "getKeysPage", [], cookie)).body.result as any;
    const id = keys.apiKeys.find((k: any) => k.name === "doomed").id;
    expect((await rpc(server, "deleteApiKey", [id], cookie)).status).toBe(200);

    expect((await mcp(server, "tools/list", {}, `Bearer ${doomed}`)).status).toBe(401);
  });

  it("does not accept a session cookie in place of a key", async () => {
    // The dashboard's session must not be a credential for the tool surface.
    const res = await fetch(`${server.url}/api/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Cookie: cookie,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("Better Auth endpoints", () => {
  it("signs in with the right password", async () => {
    const res = await fetch(`${server.url}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: server.url },
      body: JSON.stringify({ email: "admin@example.com", password: "correct-horse-battery-staple" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeTruthy();
  });

  it("refuses the wrong password", async () => {
    const res = await fetch(`${server.url}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: server.url },
      body: JSON.stringify({ email: "admin@example.com", password: "wrong-password-entirely" }),
    });
    expect(res.status).toBe(401);
  });

  it("refuses a request whose Origin is not this server", async () => {
    // Sent with node:http rather than fetch: Origin is a forbidden header name,
    // so undici drops it silently and the request arrives with none at all —
    // which is legitimately allowed, since non-browser clients send no Origin.
    // Asserting through fetch would have passed while testing nothing.
    const res = await rawPost(
      server.url,
      "/api/auth/sign-in/email",
      { email: "admin@example.com", password: "correct-horse-battery-staple" },
      { Origin: "https://evil.example.com" },
    );
    expect(res.status).toBe(403);
    expect(res.body).toContain("INVALID_ORIGIN");
    expect(res.setCookie).toBeUndefined();
  });

  it("refuses a second sign-up once the server is claimed", async () => {
    const res = await fetch(`${server.url}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: server.url },
      body: JSON.stringify({ email: "second@example.com", password: "another-long-password", name: "Two" }),
    });
    expect(res.status).toBe(403);
  });

  it("serves JWKS for token verification", async () => {
    const res = await fetch(`${server.url}/api/auth/jwks`);
    expect(res.status).toBe(200);
    expect((await res.json()).keys).toBeInstanceOf(Array);
  });
});

describe("OAuth discovery", () => {
  it.each([
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/api/auth",
    "/.well-known/openid-configuration",
    "/api/auth/.well-known/openid-configuration",
    "/.well-known/oauth-protected-resource",
  ])("serves %s without a session", async (path) => {
    const res = await fetch(`${server.url}${path}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("json");
  });

  it("advertises this server as the issuer and resource", async () => {
    const as = await (await fetch(`${server.url}/.well-known/oauth-authorization-server`)).json();
    expect(as.issuer).toBe(`${server.url}/api/auth`);
    const pr = await (await fetch(`${server.url}/.well-known/oauth-protected-resource`)).json();
    expect(pr.resource).toBe(`${server.url}/api/mcp`);
  });

  it("does not advertise the iss parameter Codex mishandles", async () => {
    const as = await (await fetch(`${server.url}/.well-known/oauth-authorization-server`)).json();
    expect(as.authorization_response_iss_parameter_supported).toBeUndefined();
  });
});

describe("page routes and the navigation guard", () => {
  it.each(["/", "/status", "/keys", "/settings", "/security"])(
    "redirects %s when signed out",
    async (path) => {
      const res = await fetch(`${server.url}${path}`, { redirect: "manual" });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("/login");
    },
  );

  it("serves a protected page once signed in", async () => {
    const res = await fetch(`${server.url}/`, { headers: { Cookie: cookie }, redirect: "manual" });
    expect(res.status).toBe(200);
  });

  it.each(["/login", "/setup", "/reset"])("serves %s without a session", async (path) => {
    const res = await fetch(`${server.url}${path}`, { redirect: "manual" });
    expect(res.status).toBe(200);
  });

  it("protects a route nobody has written yet", async () => {
    // pages.ts defaults to closed; this is that decision observed end to end.
    const res = await fetch(`${server.url}/some-future-admin-page`, { redirect: "manual" });
    expect(res.status).toBe(302);
  });

  it("returns JSON, not the SPA shell, for an unknown API path", async () => {
    const res = await fetch(`${server.url}/api/nope`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("json");
  });
});

// fetch cannot set Origin — see above. This can.
async function rawPost(
  base: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; body: string; setCookie?: string }> {
  const http = await import("node:http");
  const url = new URL(base);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: text,
            setCookie: res.headers["set-cookie"]?.[0],
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

describe("the RPC surface is fully accounted for", () => {
  it("classifies every handler as public or protected", async () => {
    // Guards the two lists above against drift: a handler added to neither is
    // untested, and a handler added to PUBLIC by mistake is unguarded.
    const { readFileSync } = await import("node:fs");
    const listed = new Set([...PUBLIC_RPC, ...PROTECTED_RPC]);
    const handlers: string[] = [];
    for (const f of ["admin", "setup", "reset-actions"]) {
      const src = readFileSync(`src/server/${f}.ts`, "utf8");
      handlers.push(...[...src.matchAll(/^export async function (\w+)/gm)].map((m) => m[1]));
    }
    const unlisted = handlers.filter((h) => !listed.has(h));
    expect(unlisted).toEqual([]);
    expect(handlers.length).toBe(listed.size);
  });
});
