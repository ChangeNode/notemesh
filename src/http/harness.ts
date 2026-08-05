import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * A real server, on a real port, over real HTTP.
 *
 * Everything else in the suite tests modules directly. That leaves the layer
 * where most of the failures actually happened: middleware ordering, the
 * auth gate, what a route returns rather than what a function returns. Those
 * were verified by hand with curl every time they changed, which is exactly
 * the kind of check that stops happening.
 *
 * Runs the built output rather than a dev server, so what is tested is what
 * ships — including the middleware, the RPC dispatch route, and the client
 * bundle being served.
 */

export interface Server {
  url: string;
  dataDir: string;
  stop(): Promise<void>;
  log(): string;
}

const BUILD = ".output/server/index.mjs";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

export async function startServer(env: Record<string, string> = {}): Promise<Server> {
  if (!fs.existsSync(BUILD)) {
    // Loud rather than skipped: a silently skipped integration suite is one
    // nobody notices has stopped running.
    throw new Error(`${BUILD} not found. Run \`pnpm build\` before the HTTP tests.`);
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "notemesh-http-"));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;

  const child: ChildProcess = spawn(process.execPath, [BUILD], {
    // A deliberately minimal environment rather than ...process.env. Inheriting
    // the runner's environment makes the server under test behave differently
    // from the deployed one — vitest sets NODE_ENV=test, and Better Auth
    // relaxes its Origin check outside production, so a CSRF assertion passed
    // while proving nothing. Measured: an Origin of https://evil.example.com is
    // refused with 403 under production and accepted with 200 under test. It
    // also means these tests do not quietly depend on whatever the developer
    // happens to have exported.
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      NODE_ENV: "production",
      DATA_DIR: dataDir,
      // Better Auth validates Origin against this, so it has to match the port.
      BASE_URL: url,
      PORT: String(port),
      ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout?.on("data", (d) => (output += d.toString()));
  child.stderr?.on("data", (d) => (output += d.toString()));

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited with ${child.exitCode}:\n${output}`);
    }
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`server did not start in 30s:\n${output}`);
    await new Promise((r) => setTimeout(r, 150));
  }

  return {
    url,
    dataDir,
    log: () => output,
    async stop() {
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 300));
      if (child.exitCode === null) child.kill("SIGKILL");
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Claim the admin account and return the session cookie. */
export async function claimAdmin(
  s: Server,
  email = "admin@example.com",
  password = "correct-horse-battery-staple",
): Promise<string> {
  const res = await fetch(`${s.url}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: s.url },
    body: JSON.stringify({ email, password, name: "Admin" }),
  });
  if (!res.ok) throw new Error(`claim failed (${res.status}): ${await res.text()}`);
  const cookie = res.headers.get("set-cookie");
  if (!cookie) throw new Error("no session cookie returned");
  return cookie.split(";")[0];
}

/** Mark the wizard finished, so the dashboard's own gates are satisfied. */
export async function markConfigured(s: Server, extra: Record<string, string> = {}) {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(path.join(s.dataDir, "app.sqlite"));
  const set = db.prepare(
    "INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  );
  const rows = {
    sync_backend: "obsidian",
    obsidian_logged_in: "true",
    vault_configured: "true",
    timezone: "UTC",
    vault_name: "Test Vault",
    ...extra,
  };
  for (const [k, v] of Object.entries(rows)) set.run(k, v);
  db.close();
}

export interface RpcResult {
  status: number;
  body: { result?: unknown; error?: string; message?: string };
}

export async function rpc(
  s: Server,
  fn: string,
  args: unknown[] = [],
  cookie?: string,
): Promise<RpcResult> {
  const res = await fetch(`${s.url}/api/rpc/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(args),
  });
  let body = {};
  try {
    body = await res.json();
  } catch {
    // non-JSON responses are a failure the caller should see as such
  }
  return { status: res.status, body };
}

/** One MCP JSON-RPC call. Returns the parsed SSE payload. */
export async function mcp(
  s: Server,
  method: string,
  params: unknown,
  auth?: string,
): Promise<{ status: number; text: string; json: any }> {
  const res = await fetch(`${s.url}/api/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(auth ? { Authorization: auth } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  // The transport answers as SSE; the payload is the first `data:` line.
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  let json: any = null;
  try {
    json = line ? JSON.parse(line.slice(6)) : JSON.parse(text);
  } catch {
    // leave null; assertions report on status/text
  }
  return { status: res.status, text, json };
}

/** Create an API key through the RPC surface, as the UI does. */
export async function createApiKey(s: Server, cookie: string, name = "test"): Promise<string> {
  const res = await rpc(s, "createApiKey", [name], cookie);
  const key = (res.body.result as { key?: string })?.key;
  if (!key) throw new Error(`could not create API key: ${JSON.stringify(res)}`);
  return key;
}
