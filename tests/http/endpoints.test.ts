import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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
  "getToolsPage",
  "getSyncActivity",
  "createApiKey",
  "deleteApiKey",
  "revokeOAuthClient",
  "setGitTiming",
  "setTimezone",
  "setDeleteEnabled",
  "relinkVault",
  "acknowledgeNotifications",
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

  it("reports deleting as on for an instance that never set it", async () => {
    // The default changed, and it is the kind of thing that reads as correct
    // either way at a glance. Deletions are recoverable from both backends'
    // history, so the tool ships on; the switch has to agree with the tool
    // surface, which registers delete_note on the same absent-means-on rule.
    const res = await rpc(server, "getSettingsPage", [], cookie);
    expect((res.body.result as any).deleteEnabled).toBe(true);
    const tools = (await rpc(server, "getToolsPage", [], cookie)).body.result as any;
    expect(tools.tools.map((t: any) => t.name)).toContain("delete_note");
  });

  it("getToolsPage describes the live tool surface", async () => {
    const res = await rpc(server, "getToolsPage", [], cookie);
    expect(res.status).toBe(200);
    const r = res.body.result as any;
    expect(r.tools.length).toBe(r.readCount + r.writeCount);
    expect(r.readCount).toBeGreaterThan(0);
    expect(r.writeCount).toBeGreaterThan(0);
    // Read tools every deployment has, and a write tool, on the right sides.
    const byName = Object.fromEntries(r.tools.map((t: any) => [t.name, t]));
    expect(byName.read_note.write).toBe(false);
    expect(byName.create_note.write).toBe(true);
    expect(r.endpoint).toBe(`${server.url}/api/mcp`);
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

  it("advertises only the scopes this resource actually gates on", async () => {
    // The MCP spec: a protected resource SHOULD NOT list offline_access, since a
    // refresh token is a client concern rather than a resource requirement. It
    // matters in practice because Codex prefers server-advertised scopes over
    // its own config, so whatever is here is what the user is asked to approve.
    const pr = await (await fetch(`${server.url}/.well-known/oauth-protected-resource`)).json();
    expect(pr.scopes_supported).toEqual(["vault:read", "vault:write"]);
    expect(pr.scopes_supported).not.toContain("offline_access");
    expect(pr.scopes_supported).not.toContain("openid");
  });
});

describe("the Origin header on the MCP endpoint", () => {
  // The transport spec: "Servers MUST validate the Origin header on all
  // incoming connections to prevent DNS rebinding attacks. If the Origin header
  // is present and invalid, servers MUST respond with HTTP 403 Forbidden."
  const call = (init: RequestInit = {}) =>
    fetch(`${server.url}/api/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });

  it("refuses a request claiming another origin", async () => {
    const res = await call({ headers: { Origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toMatch(/origin/i);
  });

  it("refuses an unparseable one rather than giving it the benefit", async () => {
    expect((await call({ headers: { Origin: "not a url" } })).status).toBe(403);
  });

  it("allows a request with no Origin at all", async () => {
    // The one that matters most. Every connector reaches this server from
    // Anthropic's or OpenAI's infrastructure, and none of them sends an Origin.
    // Refusing these would disconnect every real client while stopping nothing:
    // the attack is a web page making requests, and a web page cannot omit it.
    expect((await call()).status).not.toBe(403);
  });

  it("allows the dashboard's own origin", async () => {
    expect((await call({ headers: { Origin: server.url } })).status).not.toBe(403);
  });

  it.each(["GET", "DELETE"])("checks %s too, not only POST", async (method) => {
    const res = await fetch(`${server.url}/api/mcp`, {
      method,
      headers: { Origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });
});

describe("the unauthenticated MCP challenge", () => {
  it("points at the metadata and names the scopes it needs", async () => {
    // Both halves matter: resource_metadata is how a client finds the
    // authorization server at all, and scope is what the spec has it prefer
    // over the metadata document when deciding what to request.
    const res = await fetch(`${server.url}/api/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    expect(res.status).toBe(401);

    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain(
      `resource_metadata="${server.url}/.well-known/oauth-protected-resource"`,
    );
    expect(challenge).toContain('scope="vault:read vault:write"');
  });

  it.each(["GET", "DELETE"])(
    "answers an unauthenticated %s with the same challenge, not a bare 405",
    async (method) => {
      // A client that probes with GET before anything else — Codex does — used
      // to get a 405 with no WWW-Authenticate, and reported the server as
      // offering no authentication it understood. The method genuinely is not
      // supported in stateless mode, but that is the second thing to say.
      const res = await fetch(`${server.url}/api/mcp`, { method });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
      expect(res.headers.get("www-authenticate")).toContain('scope="vault:read vault:write"');
    },
  );

  it("still reports 405 for those methods once a credential is presented", async () => {
    const res = await fetch(`${server.url}/api/mcp`, {
      method: "GET",
      headers: { Authorization: "Bearer whatever" },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("offers a challenge a client can actually follow to the metadata", async () => {
    const res = await fetch(`${server.url}/api/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    const url = /resource_metadata="([^"]+)"/.exec(res.headers.get("www-authenticate") ?? "")?.[1];
    expect(url).toBeTruthy();

    // Walking the advertised URL has to reach JSON, not the SPA shell.
    const meta = await fetch(url!);
    expect(meta.status).toBe(200);
    expect(meta.headers.get("content-type")).toContain("json");
    expect((await meta.json()).authorization_servers).toEqual([`${server.url}/api/auth`]);
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
  const routeSource = () =>
    readFileSync("src/routes/api/rpc/[fn].ts", "utf8");

  /** The names the dispatch map actually publishes. */
  function mappedNames(): string[] {
    const src = routeSource();
    const block = src.slice(src.indexOf("const HANDLERS"), src.indexOf("export const HANDLER_NAMES"));
    return [...block.matchAll(/^\s{2}(\w+): async \(\)/gm)].map((m) => m[1]);
  }

  /** Every function the three server modules export. */
  function exportedNames(): string[] {
    const out: string[] = [];
    for (const f of ["admin", "setup", "reset-actions"]) {
      const src = readFileSync(`src/server/${f}.ts`, "utf8");
      out.push(...[...src.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]));
    }
    return out;
  }

  it("classifies every published procedure as public or protected", () => {
    // Guards the two lists above against drift: a procedure in neither is
    // untested, and one in PUBLIC by mistake is unguarded.
    const listed = new Set([...PUBLIC_RPC, ...PROTECTED_RPC]);
    const mapped = mappedNames();
    expect(mapped.length).toBeGreaterThan(20);
    expect(mapped.filter((h) => !listed.has(h))).toEqual([]);
    expect(mapped.length).toBe(listed.size);
  });

  it("publishes only names the server modules actually export", () => {
    // A typo in the map is otherwise a 500 at call time rather than a build
    // error, since the entries are dynamic imports.
    const exported = new Set(exportedNames());
    expect(mappedNames().filter((n) => !exported.has(n))).toEqual([]);
  });

  it("does not publish a server export merely because it exists", async () => {
    // The property that changed: dispatch used to look the name up on the
    // module, so exporting a helper from admin.ts published it as an endpoint.
    // Anything exported but not mapped must now be unreachable.
    const mapped = new Set(mappedNames());
    const unmapped = exportedNames().filter((n) => !mapped.has(n));
    for (const name of unmapped) {
      const res = await rpc(server, name, [], cookie);
      expect(res.status, `${name} is exported but not published, so it must 404`).toBe(404);
    }
    // And the check itself is not vacuous — a name that exists elsewhere in the
    // server but was never a procedure is refused the same way.
    for (const name of ["audit", "requireAdmin", "syncBackend"]) {
      expect((await rpc(server, name, [], cookie)).status).toBe(404);
    }
  });
});

// Icons are the classic thing that silently stops working: nothing fails, a
// browser just shows a blank square. Worth asserting because /favicon.ico is
// requested whether or not it is declared, and before these files existed it
// fell through to the SPA catch-all and answered with HTML under a 200.
describe("icons and manifest", () => {
  it.each([
    ["/favicon.svg", "image/svg+xml"],
    ["/favicon.ico", "image/"],
    ["/apple-touch-icon.png", "image/png"],
    ["/icon-192.png", "image/png"],
    ["/icon-512.png", "image/png"],
    ["/site.webmanifest", "json"],
  ])("serves %s as %s", async (path, type) => {
    const res = await fetch(`${server.url}${path}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain(type);
  });

  it("does not answer an icon request with HTML", async () => {
    // The failure this replaces: a browser asking for an icon and being handed
    // the application shell, which it renders as a broken image forever.
    for (const path of ["/favicon.ico", "/favicon.svg", "/apple-touch-icon.png"]) {
      const res = await fetch(`${server.url}${path}`);
      expect(res.headers.get("content-type")).not.toContain("text/html");
    }
  });

  it("declares them in the page the browser actually loads", async () => {
    const html = await (await fetch(`${server.url}/login`)).text();
    expect(html).toContain('rel="icon"');
    expect(html).toContain("/favicon.svg");
    expect(html).toContain("apple-touch-icon");
    expect(html).toContain("site.webmanifest");
  });

  it("ships an ico containing the three sizes a browser picks between", async () => {
    const buf = Buffer.from(await (await fetch(`${server.url}/favicon.ico`)).arrayBuffer());
    expect(buf.readUInt16LE(0)).toBe(0); // reserved
    expect(buf.readUInt16LE(2)).toBe(1); // type: icon
    expect(buf.readUInt16LE(4)).toBe(3); // 16, 32, 48
    const widths = [0, 1, 2].map((i) => buf.readUInt8(6 + i * 16));
    expect(widths).toEqual([16, 32, 48]);
  });

  it("manifest points only at files that exist", async () => {
    const manifest = await (await fetch(`${server.url}/site.webmanifest`)).json();
    expect(manifest.icons.length).toBeGreaterThan(0);
    for (const icon of manifest.icons) {
      const res = await fetch(`${server.url}${icon.src}`);
      expect(res.status, `${icon.src} is listed in the manifest`).toBe(200);
    }
  });
});

// The theme is pinned in the document shell rather than left to the visitor's
// system preference. Asserted at the HTML level because that is where it has to
// be: with ssr disabled the component tree renders in the browser, so anything
// that sets the theme from inside the app would land after first paint.
describe("theme", () => {
  it("pins dark on the served shell", async () => {
    const html = await (await fetch(`${server.url}/login`)).text();
    expect(html).toContain('data-theme="dark"');
    // Without this the browser paints its own white background before the CSS
    // lands, and draws form controls light regardless of what Pico says.
    expect(html).toContain('name="color-scheme" content="dark"');
  });
});
