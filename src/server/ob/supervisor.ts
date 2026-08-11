import { execa, type ResultPromise } from "execa";
import fs from "node:fs";
import path from "node:path";
import { env } from "../env";
import { obIsAuthenticated, obSyncConfigured, obSyncOnce } from "./cli";
import {
  MAX_LOG_LINES,
  appendLogLine,
  logLinesOf,
  type LogLine,
  type SyncActivity,
  type SyncBackend,
  type SyncState,
  type SyncStatus,
} from "../sync/types";

export { MAX_LOG_LINES };
export type { LogLine, SyncActivity, SyncState };
// A new file event after this much quiet starts a fresh activity burst.
const BURST_GAP_MS = 15_000;

// How often a suspicious log line may trigger the out-of-band auth check. The
// daemon retries roughly every 30s, so this probes on every other failure.
const AUTH_PROBE_INTERVAL_MS = 60_000;

/**
 * Does this daemon output line look like an authentication failure?
 *
 * A *trigger*, never a verdict. The daemon prints "Failed to authenticate: Not
 * logged in" and keeps running, retrying forever, so nothing else would notice
 * — but the log is also full of filenames, and a vault can contain a note
 * called "Not logged in.md". Acting on the text directly would let anyone who
 * can write a file into the vault switch off sync.
 *
 * So a match here only causes `obIsAuthenticated()` to run, and that answer —
 * an actual authenticated command against Obsidian — decides. The worst an
 * attacker gets is an extra `ob sync-list-remote` every 60 seconds.
 */
export function looksLikeAuthFailure(line: string): boolean {
  return /failed to authenticate|not logged in|no account logged in|log ?in first/i.test(line);
}
// Activity counts as "in progress" if an event landed this recently.
const ACTIVE_WINDOW_MS = 5_000;

// Fold one line of daemon output into the running activity tally. Pulled out of
// the class so it can be tested directly — the parsing is the part that breaks
// when ob changes its wording, and it is otherwise only reachable by spawning a
// child process and waiting on timers.
// What ob calls each thing, read from obsidian-headless 0.0.14's own log calls
// rather than guessed. It is not consistent: a download completes as
// "Downloaded", but an upload completes as "Upload complete" and a deletion is
// only ever announced in progressive tense. Counting the past tense across the
// board — as this did — left uploaded and deleted permanently zero while
// downloaded worked, because downloads are the one case where the guess was
// right. Each pattern below must fire exactly once per file.
const COUNTS: [RegExp, keyof Pick<SyncActivity, "downloaded" | "uploaded" | "deleted">][] = [
  [/^Downloaded\b/, "downloaded"],
  [/^Upload complete\b/, "uploaded"],
  // Folder-level variants ("Deleting remote folder", "Removing local-only
  // folder") are deliberately excluded, so the tally counts files.
  [/^(Deleting remote file|Removing local-only file)\b/, "deleted"],
];

// Lines that mean the daemon is doing transfer work, whether or not they are
// counted. These drive burst detection and the "active" flag, so progressive
// forms belong here — a long upload should read as active while it runs.
const EVENT =
  /^(Starting sync|Download(ing|ed)|Upload(ing|ed)|Upload complete|Accepted|Merging|Merged|Delet(ing|ed)|Remov(ing|ed))\b/;

export function applyActivityLine(a: SyncActivity, rawLine: string, now: number): void {
  // Drop a leading "[2026-08-03T…]" timestamp if ob prefixed one.
  const line = rawLine.replace(/^\[[^\]]*\]\s*/, "");
  if (!EVENT.test(line)) return;
  // A fresh burst either announces itself or follows a long enough silence.
  if (/^Starting sync/.test(line) || (a.lastEventAt && now - a.lastEventAt > BURST_GAP_MS)) {
    a.downloaded = 0;
    a.uploaded = 0;
    a.deleted = 0;
    a.startedAt = now;
  }
  if (a.startedAt === null) a.startedAt = now;
  for (const [re, key] of COUNTS) {
    if (re.test(line)) {
      a[key] += 1;
      break;
    }
  }
  a.lastEventAt = now;
}

// Exported for tests: the singleton below is what production uses, but the
// re-auth wiring has to be exercised against a fresh instance with a stub child.
export class SyncSupervisor implements SyncBackend {
  readonly kind = "obsidian" as const;

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
  private authProbeAt = 0;
  private authProbing = false;

  // Parse daemon output lines into a running tally of the current sync burst.
  private trackActivity(rawLine: string) {
    applyActivityLine(this.activity, rawLine, Date.now());
  }

  private obBin(): string {
    if (process.env.OB_BIN) return process.env.OB_BIN;
    const local = path.resolve("node_modules/.bin/ob");
    if (fs.existsSync(local)) return local;
    return "ob";
  }

  private log(line: string, level?: "error" | "warn") {
    for (const t of logLinesOf(line)) {
      // Collapsed if identical to the line before it — see appendLogLine. The
      // activity tally below still counts every occurrence; only the stored
      // representation is deduplicated.
      appendLogLine(this.logs, t, level);
      this.lastActivityAt = Date.now();
      this.trackActivity(t);
      if (looksLikeAuthFailure(t)) void this.probeAuthAfterSuspiciousLine();
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
    appendLogLine(this.logs, t, level);
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
      // A vault that was never linked will fail identically forever: `ob sync`
      // prints "Run 'ob sync-setup' first" and exits, and no amount of backoff
      // changes that. Retrying it produced a log of nothing but the same three
      // lines at 2, 4, 8, 16, 32 seconds, with the dashboard reporting
      // "Retrying after an error" and never saying which error or that a human
      // was needed. Checked by running sync-status rather than reading the
      // daemon's output, for the same reason as the authentication check.
      const configured = await obSyncConfigured().catch(() => true);
      if (!configured) {
        this.state = "needs-setup";
        this.log(
          `[supervisor] this vault has no Obsidian Sync configuration — link it again from Setup`,
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

  /**
   * Confirm, out of band, whether the daemon is actually locked out.
   *
   * The existing re-auth path hangs off the child exiting, which is right for
   * every failure that ends the process. Revoking the Obsidian session does
   * not: the daemon stays up and reconnects every 30 seconds, each attempt
   * failing to authenticate, so the exit handler never runs and the dashboard
   * goes on reporting a healthy sync over a daemon that has not moved a byte
   * since the credentials were pulled.
   *
   * On a confirmed failure this only kills the child. It deliberately does not
   * set the state itself — the exit handler already knows how to latch
   * needs-reauth, and one decision site is easier to keep correct than two.
   */
  private async probeAuthAfterSuspiciousLine(): Promise<void> {
    if (this.stopping || this.authProbing || this.state !== "running") return;
    const now = Date.now();
    if (now - this.authProbeAt < AUTH_PROBE_INTERVAL_MS) return;
    this.authProbeAt = now;
    this.authProbing = true;
    try {
      // Unreachable Obsidian looks the same as bad credentials from here, so on
      // an error assume authenticated and let the next failure ask again.
      const authed = await obIsAuthenticated().catch(() => true);
      if (authed || this.stopping || !this.child) return;
      this.note(
        "[supervisor] the sync daemon cannot authenticate — stopping it to re-authenticate",
        "error",
      );
      this.child.kill("SIGTERM");
    } finally {
      this.authProbing = false;
    }
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
    if (this.state === "needs-reauth" || this.state === "needs-setup") this.state = "stopped";
    this.start();
  }

  // One-shot sync, reported into the same log the operator is watching rather
  // than back through the button that triggered it.
  async syncNow(): Promise<{ ok: boolean; output: string }> {
    // `ob sync` takes a lock on the vault, so a one-shot run started while the
    // continuous daemon holds it fails with "Another sync instance is already
    // running for this vault" — an error for doing something that was never
    // possible, and which the daemon was already doing anyway. The Status tab
    // hides the button in this state; this covers a page that loaded before the
    // daemon started, and anything calling the procedure directly.
    if (this.child) {
      const message = "Continuous sync is already running — it picks up changes on its own.";
      this.note(`[admin] ${message}`);
      return { ok: true, output: message };
    }
    const res = await obSyncOnce();
    const tail = res.combined.split("\n").filter(Boolean).slice(-5).join("\n");
    if (res.ok) {
      this.note("[admin] Manual sync finished.");
    } else {
      this.note("[admin] Error: manual sync failed.", "error");
      for (const line of tail.split("\n").filter(Boolean)) {
        this.note(`[admin] ${line}`, "error");
      }
    }
    return { ok: res.ok, output: tail };
  }

  status(): SyncStatus {
    const a = this.activity ?? { downloaded: 0, uploaded: 0, deleted: 0, startedAt: null, lastEventAt: null };
    return {
      kind: this.kind,
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
const globalKey = "__notemeshSupervisor";
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
