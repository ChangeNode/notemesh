import { execa, type ResultPromise } from "execa";
import fs from "node:fs";
import path from "node:path";
import { env } from "../env";
import { getSetting } from "../db";
import { looksLikeAuthFailure } from "./cli";

export type SyncState =
  | "stopped"
  | "running"
  | "backoff" // crashed, waiting to restart
  | "needs-reauth"; // Obsidian session invalid; won't restart until re-auth

interface LogLine {
  ts: number;
  line: string;
}

const MAX_LOG_LINES = 500;

class SyncSupervisor {
  state: SyncState = "stopped";
  lastActivityAt: number | null = null;
  startedAt: number | null = null;
  restartCount = 0;
  private child: ResultPromise | null = null;
  private logs: LogLine[] = [];
  private backoffMs = 2_000;
  private stopping = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  private obBin(): string {
    if (process.env.OB_BIN) return process.env.OB_BIN;
    const local = path.resolve("node_modules/.bin/ob");
    if (fs.existsSync(local)) return local;
    return "ob";
  }

  private log(line: string) {
    for (const l of line.split("\n")) {
      const t = l.trimEnd();
      if (!t) continue;
      this.logs.push({ ts: Date.now(), line: t });
      this.lastActivityAt = Date.now();
    }
    if (this.logs.length > MAX_LOG_LINES) {
      this.logs = this.logs.slice(-MAX_LOG_LINES);
    }
  }

  getLogs(): LogLine[] {
    return [...this.logs];
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

    void child.then((result) => {
      this.child = null;
      if (this.stopping) {
        this.state = "stopped";
        this.log(`[supervisor] stopped`);
        return;
      }
      const recent = this.logs.slice(-30).map((l) => l.line).join("\n");
      if (looksLikeAuthFailure(recent)) {
        this.state = "needs-reauth";
        this.log(`[supervisor] sync exited with an auth error — re-authentication required`);
        return;
      }
      this.state = "backoff";
      this.restartCount += 1;
      this.log(
        `[supervisor] sync exited (code ${result.exitCode}); restarting in ${Math.round(this.backoffMs / 1000)}s`,
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
    return {
      state: this.state,
      startedAt: this.startedAt,
      lastActivityAt: this.lastActivityAt,
      restartCount: this.restartCount,
    };
  }
}

// Module-level singleton; survives across requests within one server process.
const globalKey = "__obSyncSupervisor";
export function supervisor(): SyncSupervisor {
  const g = globalThis as any;
  if (!g[globalKey]) g[globalKey] = new SyncSupervisor();
  return g[globalKey];
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
