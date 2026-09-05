// The contract every sync backend satisfies. The vault is just a directory of
// files as far as the indexer and the MCP tools are concerned — they import
// nothing from here — so how those files arrive is entirely a backend concern.

export type SyncKind = "obsidian" | "git";

export type SyncState =
  | "stopped"
  | "running"
  | "backoff" // failed, waiting to retry
  | "needs-reauth" // credentials rejected; won't retry until re-authenticated
  | "needs-setup"; // the vault was never linked, or its link is gone

export interface LogLine {
  ts: number;
  line: string;
  // Set only for lines this app injects itself. Output from an external sync
  // client has no severity channel, so those lines are classified by content
  // when they're rendered.
  level?: "error" | "warn";
  // How many consecutive times this identical line arrived. Absent means once.
  // `ts` tracks the most recent occurrence, so it still answers "when did this
  // last happen".
  repeat?: number;
}

export interface SyncActivity {
  downloaded: number;
  uploaded: number;
  deleted: number;
  startedAt: number | null;
  lastEventAt: number | null;
}

export interface SyncStatus {
  /**
   * Which backend produced this. The two do not behave alike — an Obsidian
   * daemon holds a lock on the vault while it runs, a git backend is a pair of
   * timers — so a UI showing controls for "sync" has to know which it is
   * looking at.
   */
  kind: SyncKind;
  state: SyncState;
  /** When the current state began; the backoff-duration alert reads it. */
  stateSince?: number | null;
  startedAt: number | null;
  lastActivityAt: number | null;
  restartCount: number;
  activity: SyncActivity & { active: boolean };
  /** git only: the most recent conflicts, each handled by writing a conflicted copy. */
  conflicts?: ConflictRecord[];
}

// A conflict handled by writing a conflicted copy beside each note involved.
// Information, not state: the copy is in the vault and on its way to every
// device, and there is nothing further the server is waiting on.
export interface ConflictRecord {
  at: number;
  paths: string[];
  /** Aligned with `paths`; null where our side had nothing to save. */
  copies?: (string | null)[];
}

export const MAX_LOG_LINES = 500;

export interface SyncBackend {
  readonly kind: SyncKind;
  start(): void;
  stop(): void;
  /** Clear backoff/error latches and start again — used after re-auth. */
  resetAndStart(): void;
  status(): SyncStatus;
  getLogs(): LogLine[];
  /** Inject a line into the same log the operator is already watching. */
  note(line: string, level?: "error" | "warn"): void;
  /** Force a sync cycle now. Resolves when it has finished, or failed. */
  syncNow(): Promise<{ ok: boolean; output: string }>;
  /**
   * Called after an MCP tool writes to the vault. Obsidian Sync notices on its
   * own via its own watcher, so it ignores this; git has to be told, because
   * publishing a change is an explicit commit and push.
   */
  notifyLocalChange?(change: { tool: string; path: string }): void;
}

// Shared bounded log buffer. Both backends keep the last N lines in memory and
// nothing on disk — see the Settings tab for what actually gets persisted.
/**
 * Append one already-trimmed line, collapsing it into the previous entry when
 * it is identical.
 *
 * The sync clients emit heartbeats: `ob sync --continuous` logs "Fully synced"
 * at the end of every polling pass, roughly twice a minute, forever. Stored
 * verbatim those fill the entire buffer within a few hours, so the window an
 * operator can actually see contains nothing but heartbeat and any real event
 * has long since scrolled out. Collapsing keeps the liveness signal — the count
 * and the refreshed timestamp — without spending the buffer on it.
 *
 * Replaces the last entry rather than mutating it, because getLogs() hands out
 * shallow copies whose elements callers may still be holding.
 */
export function appendLogLine(lines: LogLine[], line: string, level?: "error" | "warn"): void {
  const last = lines[lines.length - 1];
  if (last && last.line === line && last.level === level) {
    lines[lines.length - 1] = { ...last, ts: Date.now(), repeat: (last.repeat ?? 1) + 1 };
    return;
  }
  lines.push({ ts: Date.now(), line, level });
  if (lines.length > MAX_LOG_LINES) lines.splice(0, lines.length - MAX_LOG_LINES);
}

// Split a raw chunk into storable lines: blank lines dropped, each capped so a
// single newline-free blob can't grow the buffer without bound.
export function logLinesOf(chunk: string): string[] {
  return chunk
    .split("\n")
    .map((raw) => raw.trimEnd().slice(0, 2000))
    .filter(Boolean);
}

export class LogRing {
  private lines: LogLine[] = [];

  push(chunk: string, level?: "error" | "warn"): void {
    for (const line of logLinesOf(chunk)) appendLogLine(this.lines, line, level);
  }

  all(): LogLine[] {
    return [...this.lines];
  }
}
