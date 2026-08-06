import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import { claimAdmin, createApiKey, markConfigured, rpc, startServer, type Server } from "./harness";

/**
 * Regressions from the endpoint audit.
 *
 * Each case here is a finding that was reproduced against a running server
 * before it was fixed, so each one fails on the code as it was. They live apart
 * from endpoints.test.ts because that file asks "is every door locked" and this
 * one asks "does a specific key that should not work, not work".
 */

let server: Server;
let cookie: string;
let apiKey: string;

beforeAll(async () => {
  server = await startServer();
  cookie = await claimAdmin(server);
  await markConfigured(server);
  apiKey = await createApiKey(server, cookie, "security-tests");
}, 60_000);

afterAll(async () => {
  await server?.stop();
});

/**
 * Issue an OAuth access token directly, with exactly the scopes given.
 *
 * Writing the row rather than driving the authorization flow is deliberate: the
 * point is to test what the resource server does with a token it is handed, and
 * a token with no scopes is precisely what the flow is not supposed to produce.
 */
function issueToken(scopes: string[], id: string): string {
  const db = new Database(path.join(server.dataDir, "app.sqlite"));
  const now = new Date().toISOString();
  const userId = (db.prepare('SELECT id FROM "user" LIMIT 1').get() as { id: string }).id;

  const clientCols = db.prepare('PRAGMA table_info("oauthClient")').all() as { name: string }[];
  const client: Record<string, unknown> = {
    id: `c-${id}`,
    clientId: `client-${id}`,
    name: `Client ${id}`,
    userId,
    redirectUris: JSON.stringify(["https://example.com/cb"]),
    scopes: JSON.stringify(scopes),
    grantTypes: JSON.stringify(["authorization_code"]),
    responseTypes: JSON.stringify(["code"]),
    contacts: JSON.stringify([]),
    postLogoutRedirectUris: JSON.stringify([]),
    type: "public",
    disabled: 0,
    createdAt: now,
    updatedAt: now,
  };
  const cn = clientCols.map((c) => c.name).filter((n) => n in client);
  db.prepare(
    `INSERT OR REPLACE INTO "oauthClient" (${cn.map((n) => `"${n}"`).join(",")}) VALUES (${cn.map(() => "?").join(",")})`,
  ).run(...cn.map((n) => client[n]));

  const token = `test-token-${id}`;
  const tokenCols = db.prepare('PRAGMA table_info("oauthAccessToken")').all() as { name: string }[];
  const row: Record<string, unknown> = {
    id: `t-${id}`,
    // The provider stores base64(sha256(token)), never the token itself.
    token: crypto.createHash("sha256").update(token).digest().toString("base64"),
    clientId: `client-${id}`,
    userId,
    scopes: JSON.stringify(scopes),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    createdAt: now,
    updatedAt: now,
  };
  const tn = tokenCols.map((c) => c.name).filter((n) => n in row);
  db.prepare(
    `INSERT OR REPLACE INTO "oauthAccessToken" (${tn.map((n) => `"${n}"`).join(",")}) VALUES (${tn.map(() => "?").join(",")})`,
  ).run(...tn.map((n) => row[n]));
  db.close();
  return token;
}

async function toolsList(token: string) {
  const res = await fetch(`${server.url}/api/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const text = await res.text();
  let names: string[] = [];
  const match = text.match(/\{.*\}/s);
  if (match) {
    try {
      names = (JSON.parse(match[0]).result?.tools ?? []).map((t: { name: string }) => t.name);
    } catch {
      names = [];
    }
  }
  return { status: res.status, names, text };
}

// The audit's headline finding: `read` was computed from the token's scopes and
// then never consulted, so a token carrying no scopes at all was served every
// read tool and could list and open notes.
describe("MCP: the read scope is enforced", () => {
  it("refuses a token that carries neither vault scope", async () => {
    const token = issueToken([], "noscope");
    const { status, names } = await toolsList(token);
    expect(status).toBe(403);
    expect(names).toEqual([]);
  });

  it("refuses that token a tool call, not just the listing", async () => {
    const token = issueToken([], "noscope2");
    const res = await fetch(`${server.url}/api/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_notes", arguments: {} },
      }),
    });
    expect(res.status).toBe(403);
    // Nothing about the vault leaks in the refusal.
    expect(await res.text()).not.toMatch(/\.md/);
  });

  it("refuses a token scoped to something unrelated", async () => {
    const token = issueToken(["openid", "profile", "email"], "oidconly");
    expect((await toolsList(token)).status).toBe(403);
  });

  it("serves read tools, and only those, for vault:read", async () => {
    const token = issueToken(["vault:read"], "readonly");
    const { status, names } = await toolsList(token);
    expect(status).toBe(200);
    expect(names).toContain("read_note");
    expect(names).toContain("search_vault");
    for (const w of ["create_note", "update_note", "delete_note", "move_note"]) {
      expect(names, `${w} must not be offered to a read-only token`).not.toContain(w);
    }
  });

  it("serves write tools for vault:write", async () => {
    const token = issueToken(["vault:read", "vault:write"], "readwrite");
    const { status, names } = await toolsList(token);
    expect(status).toBe(200);
    expect(names).toContain("create_note");
    expect(names).toContain("read_note");
  });

  it("still serves an API key, which is read+write by definition", async () => {
    const { status, names } = await toolsList(apiKey);
    expect(status).toBe(200);
    expect(names).toContain("read_note");
    expect(names).toContain("create_note");
  });
});

// Same class on the MCP route: the 4MB cap was read off content-length, which a
// chunked upload simply omits, and the backstop ran only after the whole body
// had been buffered.
describe("MCP: request bodies are bounded while reading", () => {
  it("rejects an oversized body sent without a content-length", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"pad":"'));
        for (let i = 0; i < 48; i++) {
          controller.enqueue(new TextEncoder().encode("A".repeat(128 * 1024)));
        }
        controller.enqueue(new TextEncoder().encode('"}}'));
        controller.close();
      },
    });
    const res = await fetch(`${server.url}/api/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${apiKey}`,
      },
      body: stream,
      // @ts-expect-error — undici requires this for a streaming request body.
      duplex: "half",
    });
    expect(res.status).toBe(413);
  }, 30_000);

  it("still serves a normal-sized call", async () => {
    const { status } = await toolsList(apiKey);
    expect(status).toBe(200);
  });
});
