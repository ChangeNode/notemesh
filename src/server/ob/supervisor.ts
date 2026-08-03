import { execa, type ResultPromise } from "execa";
import fs from "node:fs";
import path from "node:path";
import { env } from "../env";
import { getSetting } from "../db";
import { obIsAuthenticated } from "./cli";

export type SyncState =
  | "stopped"
  | "running"
  | "backoff" // crashed, waiting to restart
  | "needs-reauth"; // Obsidian session invalid; won't restart until re-auth

export interface LogLine {
  ts: number;
  line: string;
  // Set only for lines this app injects itself. Output from the sync client
  // has no severity channel, so those lines are classified by content when
  // they're rendered.
  level?: "error" | "warn";
}

export interface SyncActivity {
  downloaded: number;
  uploaded: number;
  deleted: number;
  startedAt: number | null;
  lastEventAt: number | null;
}

export const MAX_LOG_LINES = 500;
// A new file event after this much quiet starts a fresh activity burst.
const BURST_GAP_MS = 15_000;
// Activity counts as "in progress" if an event landed this recently.
const ACTIVE_WINDOW_MS = 5_000;

class SyncSupervisor {
  state: SyncState = "stopped";
  lastActivityAt: number | null = null;
  startedAt: number | null = null;
  restartCount = 0;
  activity: SyncActivity = { downloaded: 0, uploaded: 0, deleted: 0, startedAt: null, lastEventAt: null };
  private child: ResultPromise | null = null;
  private logs: LogLine[] = [];
  private backoffMs = 2_000;
  private stopping = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  // Parse daemon output lines into a running tally of the current sync burst.
  private trackActivity(rawLine: string) {
    const line = rawLine.replace(/^\[[^\]]*\]\s*/, "");
    const now = Date.now();
    const isEvent = /^(Starting sync|Download(ing|ed)|Upload(ing|ed)|Accepted|Merging|Merged|Delet(ing|ed)|Remov(ing|ed))\b/.test(line);
    if (!isEvent) return;
    const a = this.activity;
    if (/^Starting sync/.test(line) || (a.lastEventAt && now - a.lastEventAt > BURST_GAP_MS)) {
      a.downloaded = 0;
      a.uploaded = 0;
      a.deleted = 0;
      a.startedAt = now;
    }
    if (a.startedAt === null) a.startedAt = now;
    if (/^Downloaded\b/.test(line)) a.downloaded += 1;
    else if (/^Uploaded\b/.test(line)) a.uploaded += 1;
    else if (/^(Deleted|Removed)\b/.test(line)) a.deleted += 1;
    a.lastEventAt = now;
  }

  private obBin(): string {
    if (process.env.OB_BIN) return process.env.OB_BIN;
    const local = path.resolve("node_modules/.bin/ob");
    if (fs.existsSync(local)) return local;
    return "ob";
  }

  private log(line: string, level?: "error" | "warn") {
    for (const l of line.split("\n")) {
      // Cap each stored line so a single newline-free blob from ob can't grow
      // the buffer unbounded.
      const t = l.trimEnd().slice(0, 2000);
      if (!t) continue;
      this.logs.push({ ts: Date.now(), line: t, level });
      this.lastActivityAt = Date.now();
      this.trackActivity(t);
    }
    if (this.logs.length > MAX_LOG_LINES) {
      this.logs = this.logs.slice(-MAX_LOG_LINES);
    }
  }

  getLogs(): LogLine[] {
    return [...this.logs];
  }

  // Push a message from outside the child process into the same buffer, so a
  // one-off admin action reports itself in the log the operator is already
  // watching. Deliberately does not touch lastActivityAt or the activity
  // counters — those describe the sync daemon, not us.
  note(line: string, level?: "error" | "warn") {
    const t = line.trimEnd().slice(0, 2000);
    if (!t) return;
    this.logs.push({ ts: Date.now(), line: t, level });
    if (this.logs.length > MAX_LOG_LINES) {
      this.logs = this.logs.slice(-MAX_LOG_LINES);
    }
  }

  start() {
    if (this.child || this.state === "running") return;
    this.stopping = false;
    this.state = "running";
    this.startedAt = Date.now();
    this.log(`[supervisor] starting ob sync --continuous`);

    const child = execa(this.obBin(), ["sync", "--continuous", "--path", env.vaultDir], {
      env: { HOME: env.obHomeDir },
      cwd: env.dataDir,
      stdin: "ignore",
      reject: false,
      buffer: false,
    });
    this.child = child;

    child.stdout?.on("data", (d: Buffer) => this.log(d.toString()));
    child.stderr?.on("data", (d: Buffer) => this.log(d.toString()));

    void child.then(async (result) => {
      this.child = null;
      if (this.stopping) {
        this.state = "stopped";
        this.log(`[supervisor] stopped`);
        return;
      }
      // Decide "needs re-auth" from an actual auth-requiring ob command, not by
      // scraping the sync log — an attacker who controls a synced filename
      // (e.g. a file named "session expired.md") could otherwise force this
      // latch and deny sync. (ob exit codes are unreliable — it returns 0 even
      // when logged out — so obIsAuthenticated inspects command output.)
      const authed = await obIsAuthenticated().catch(() => true);
      if (!authed) {
        this.state = "needs-reauth";
        this.log(
          `[supervisor] not authenticated with Obsidian — re-authentication required`,
          "error",
        );
        return;
      }
      this.state = "backoff";
      this.restartCount += 1;
      this.log(
        `[supervisor] sync exited (code ${result.exitCode}); restarting in ${Math.round(this.backoffMs / 1000)}s`,
        "warn",
      );
      this.restartTimer = setTimeout(() => {
        this.backoffMs = Math.min(this.backoffMs * 2, 300_000);
        this.start();
      }, this.backoffMs);
    });
  }

  stop() {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.child) {
      this.child.kill("SIGTERM");
    } else {
      this.state = "stopped";
    }
  }

  // Called after a successful re-login.
  resetAndStart() {
    this.backoffMs = 2_000;
    this.restartCount = 0;
    if (this.state === "needs-reauth") this.state = "stopped";
    this.start();
  }

  status() {
    const a = this.activity ?? { downloaded: 0, uploaded: 0, deleted: 0, startedAt: null, lastEventAt: null };
    return {
      state: this.state,
      startedAt: this.startedAt,
      lastActivityAt: this.lastActivityAt,
      restartCount: this.restartCount,
      activity: {
        ...a,
        active: a.lastEventAt !== null && Date.now() - a.lastEventAt < ACTIVE_WINDOW_MS,
      },
    };
  }
}

// Module-level singleton; survives across requests within one server process.
const globalKey = "__obSyncSupervisor";
export function supervisor(): SyncSupervisor {
  const g = globalThis as any;
  if (!g[globalKey]) g[globalKey] = new SyncSupervisor();
  const inst = g[globalKey] as SyncSupervisor;
  // Dev HMR keeps the old instance (and its running child) but reloads this
  // module: rebind the prototype so new methods exist, and backfill fields.
  if (Object.getPrototypeOf(inst) !== SyncSupervisor.prototype) {
    Object.setPrototypeOf(inst, SyncSupervisor.prototype);
  }
  inst.activity ??= { downloaded: 0, uploaded: 0, deleted: 0, startedAt: null, lastEventAt: null };
  return inst;
}

// Kill the daemon when the server process exits — otherwise dev-server
// restarts and container stops leave an orphaned `ob sync` running.
const exitKey = "__obSyncExitHook";
if (!(globalThis as any)[exitKey]) {
  (globalThis as any)[exitKey] = true;
  const shutdown = () => {
    try {
      supervisor().stop();
    } catch {
      // Best effort — the process is going down regardless.
    }
  };
  process.on("exit", shutdown);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      shutdown();
      process.exit(0);
    });
  }
}

// Idempotent boot hook: starts the daemon if setup has completed.
let bootChecked = false;
export function ensureSyncStarted() {
  if (bootChecked) return;
  bootChecked = true;
  try {
    if (getSetting("vault_configured") === "true") {
      supervisor().start();
    }
  } catch {
    // DB not ready yet — first boot before setup; nothing to start.
  }
}
