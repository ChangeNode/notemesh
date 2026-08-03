// The contract every sync backend satisfies. The vault is just a directory of
// files as far as the indexer and the MCP tools are concerned — they import
// nothing from here — so how those files arrive is entirely a backend concern.

export type SyncKind = "obsidian" | "git";

export type SyncState =
  | "stopped"
  | "running"
  | "backoff" // failed, waiting to retry
  | "needs-reauth" // credentials rejected; won't retry until re-authenticated
  | "conflict"; // git only: local work parked on a branch, needs a human

export interface LogLine {
  ts: number;
  line: string;
  // Set only for lines this app injects itself. Output from an external sync
  // client has no severity channel, so those lines are classified by content
  // when they're rendered.
  level?: "error" | "warn";
}

export interface SyncActivity {
  downloaded: number;
  uploaded: number;
  deleted: number;
  startedAt: number | null;
  lastEventAt: number | null;
}

export interface SyncStatus {
  state: SyncState;
  startedAt: number | null;
  lastActivityAt: number | null;
  restartCount: number;
  activity: SyncActivity & { active: boolean };
  /** git only: conflicts that were resolved by the configured strategy. */
  conflicts?: ConflictRecord[];
}

// A conflict that the configured strategy handled. Which fields are populated
// depends on the strategy: a branch name for "branch", the conflict copies
// written for "file", neither for "inline".
export interface ConflictRecord {
  at: number;
  strategy: "file" | "branch" | "inline";
  paths: string[];
  branch?: string;
  copies?: string[];
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
export class LogRing {
  private lines: LogLine[] = [];

  push(chunk: string, level?: "error" | "warn"): void {
    for (const raw of chunk.split("\n")) {
      // Cap each stored line so a single newline-free blob can't grow the
      // buffer without bound.
      const line = raw.trimEnd().slice(0, 2000);
      if (!line) continue;
      this.lines.push({ ts: Date.now(), line, level });
    }
    if (this.lines.length > MAX_LOG_LINES) {
      this.lines = this.lines.slice(-MAX_LOG_LINES);
    }
  }

  all(): LogLine[] {
    return [...this.lines];
  }
}
