import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A seeded server for the browser tests.
 *
 * Same shape as the HTTP harness, and the same deliberate choice about the
 * environment: an explicit minimal one rather than the runner's. Inheriting it
 * made the server under test behave differently from the deployed one — vitest
 * sets NODE_ENV=test, under which Better Auth relaxes its Origin check — and a
 * browser suite is even more sensitive to that, because the browser *does* send
 * an Origin on every request.
 */

export const PORT = 3999;
export const BASE_URL = `http://127.0.0.1:${PORT}`;
export const ADMIN_EMAIL = "admin@example.com";
export const ADMIN_PASSWORD = "correct-horse-battery-staple";

const BUILD = ".output/server/index.mjs";
const STATE = path.join(os.tmpdir(), "notemesh-e2e-state.json");

async function assertPortFree(port: number): Promise<void> {
  const net = await import("node:net");
  await new Promise<void>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", (e: NodeJS.ErrnoException) => {
      reject(
        e.code === "EADDRINUSE"
          ? new Error(
              `Port ${port} is already in use — most likely a server left behind by an ` +
                `earlier run. Stop it (lsof -ti tcp:${port} | xargs kill) and try again.`,
            )
          : e,
      );
    });
    probe.once("listening", () => probe.close(() => resolve()));
    probe.listen(port, "127.0.0.1");
  });
}

export interface Started {
  dataDir: string;
  pid: number;
}

/** Boot the built server, claim the admin, and mark the wizard finished. */
export async function startSeeded(extraEnv: Record<string, string> = {}): Promise<Started> {
  if (!fs.existsSync(BUILD)) {
    throw new Error(`${BUILD} not found. Run \`pnpm build\` before the browser tests.`);
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "notemesh-e2e-"));

  // A vault with real content, so the pages have something to render rather
  // than only exercising their empty states.
  const vault = path.join(dataDir, "vault");
  fs.mkdirSync(path.join(vault, "Projects"), { recursive: true });
  fs.writeFileSync(
    path.join(vault, "Welcome.md"),
    "---\ntitle: Welcome\ntags: [demo]\n---\n\n# Welcome\n\nLinks to [[Projects/Ideas]].\n\n- [ ] a task\n",
  );
  fs.writeFileSync(path.join(vault, "Projects", "Ideas.md"), "# Ideas\n\nBack to [[Welcome]]. #demo\n");

  // A server left behind by a failed run would answer the health check below
  // while this run seeded a different data directory — which is exactly what
  // happened: setup claimed an admin on the stale server, then opened a fresh
  // empty database and failed on a missing table. Fail here instead, where the
  // cause is obvious.
  await assertPortFree(PORT);

  const child: ChildProcess = spawn(process.execPath, [BUILD], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      NODE_ENV: "production",
      DATA_DIR: dataDir,
      BASE_URL,
      PORT: String(PORT),
      ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let log = "";
  child.stdout?.on("data", (d) => (log += d.toString()));
  child.stderr?.on("data", (d) => (log += d.toString()));

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited (${child.exitCode}):\n${log}`);
    try {
      if ((await fetch(`${BASE_URL}/api/health`)).ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 150));
  }

  const res = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: "POST",
    // Origin is required: under NODE_ENV=production Better Auth refuses a
    // request without one (MISSING_OR_NULL_ORIGIN), which is exactly the
    // protection the browser tests want in place.
    headers: { "Content-Type": "application/json", Origin: BASE_URL },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, name: "Admin" }),
  });
  if (!res.ok) throw new Error(`could not claim admin (${res.status}): ${await res.text()}`);

  const { default: Database } = await import("better-sqlite3");
  const db = new Database(path.join(dataDir, "app.sqlite"));
  const set = db.prepare(
    "INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  );
  for (const [k, v] of Object.entries({
    sync_backend: "obsidian",
    obsidian_logged_in: "true",
    vault_configured: "true",
    timezone: "UTC",
    notifications_acknowledged: "true",
    vault_name: "E2E Vault",
  })) {
    set.run(k, v);
  }
  db.close();

  const started: Started = { dataDir, pid: child.pid! };
  fs.writeFileSync(STATE, JSON.stringify(started));
  return started;
}

export async function stopSeeded() {
  if (!fs.existsSync(STATE)) return;
  const { dataDir, pid } = JSON.parse(fs.readFileSync(STATE, "utf8")) as Started;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
  await new Promise((r) => setTimeout(r, 300));
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // expected once it has exited
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(STATE, { force: true });
}
