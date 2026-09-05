import { syncBackend } from "../sync";
import type { SyncStatus } from "../sync/types";
import { getSetting } from "../db";
import { extraAdminAccounts } from "../claim";
import { obsidianAccountState } from "../ob/credentials";
import { env, detectInsecureBaseUrl, detectOriginMismatch } from "../env";
import { indexerStatus } from "../vault/indexer";
import { lastDiskLevel, type DiskLevel } from "../vault/disk";
import { takeNotices } from "../notices";

/**
 * What the server tells the assistant about itself.
 *
 * The failures that matter most are silent: the volume filling, the sync
 * daemon stopped on rejected credentials, the index failing to rebuild. The
 * operator finds out by opening the dashboard, which is exactly what they do
 * not do for weeks, while the assistant talks to the server every day. So the
 * assistant is told, as extra text blocks after every tool result.
 *
 * Three rules, each the answer to a way this could go wrong.
 *
 * Outside the fence. Vault content is always inside the boundary markers. An
 * alert is the server speaking, not a note, so it is a separate block after
 * the payload, never merged into it — and that is what makes it trustworthy:
 * an unfenced block beginning "NoteMesh:" is the server by construction,
 * because nothing lifted from a note ever arrives unfenced. The boundary
 * explanation says so.
 *
 * A state, not an event. An alert answers "is the server healthy right now?",
 * and that answer does not change between call 1 and call 40 of a session.
 * So it is present on every response while the condition holds and absent
 * the moment it does not. Deduplicating — once an hour, say — would make it
 * appear once and vanish, which reads as the condition resolving, the one
 * thing it must never imply. Absence is the resolution. Against that, a
 * one-line block per call is a trivial cost.
 *
 * Stable, not rare. Fixed wording per condition, no timestamps, no counters
 * that tick, numbers coarse: anything that makes each response unique makes
 * a model re-mention it. 92%, 93%, 94% are three alerts to a model; "under
 * 100 MB" is one.
 *
 * Factual, never instructional. Text a server hopes a model will relay has
 * the same shape as a prompt-injection payload. It is acceptable because it
 * is first-party and descriptive, and stops being acceptable the moment it
 * tells the model what to say.
 */

export const ALERT_PREFIX = "NoteMesh:";
/** At most this many blocks per result; the last says how many more there are. */
export const MAX_ALERT_BLOCKS = 3;
/** Backoff this long is a failure, not a blip. */
export const BACKOFF_ERROR_MS = 15 * 60_000;

export interface Alert {
  level: "warn" | "error";
  text: string;
}

/** What a request carries that an alert can depend on. */
export interface RequestInfo {
  host?: string | null;
  forwardedProto?: string | null;
}

/**
 * Everything the alerts are computed from, gathered once per call. Every
 * source is in memory or cached — sync and indexer state, the disk watcher's
 * last reading — so this costs nothing a tool call would notice.
 */
export interface AlertSnapshot {
  sync: Pick<SyncStatus, "kind" | "state" | "restartCount"> & { stateSince?: number | null };
  vaultConfigured: boolean;
  /** Admin accounts beyond the one there should be. */
  extraAdmins: number;
  credentialsUnreadable: boolean;
  index: { ready: boolean; lastRebuildError: string | null; unindexedNotes: number };
  disk: DiskLevel | null;
  originMismatch: { configured: string; reachedAt: string } | null;
  insecureBaseUrl: boolean;
  now: number;
}

export function snapshot(req: RequestInfo = {}): AlertSnapshot {
  const sync = syncBackend().status();
  let vaultConfigured = true;
  let extraAdmins = 0;
  let credentialsUnreadable = false;
  try {
    vaultConfigured = getSetting("vault_configured") === "true";
    extraAdmins = extraAdminAccounts();
    if (sync.kind === "obsidian") credentialsUnreadable = obsidianAccountState().state === "unreadable";
  } catch {
    // The database is not ready; say nothing rather than something wrong.
  }
  const idx = indexerStatus();
  return {
    sync,
    vaultConfigured,
    extraAdmins,
    credentialsUnreadable,
    index: { ready: idx.ready, lastRebuildError: idx.lastRebuildError, unindexedNotes: idx.unindexedNotes },
    disk: lastDiskLevel(),
    originMismatch: detectOriginMismatch(env.baseUrl, req.host),
    insecureBaseUrl: detectInsecureBaseUrl(env.baseUrl, req.forwardedProto) !== null,
    now: Date.now(),
  };
}

const P = ALERT_PREFIX;

/**
 * The alerts a snapshot warrants, errors first, then warnings, each in a
 * fixed order. Pure, so every condition and the ordering can be tested
 * without standing up a backend.
 */
export function alertsFrom(s: AlertSnapshot): Alert[] {
  const out: Alert[] = [];
  const which = s.sync.kind === "git" ? "git" : "Obsidian";

  if (s.sync.state === "needs-reauth") {
    out.push({
      level: "error",
      text:
        `${P} sync has stopped: the ${which} credentials were rejected. Re-authenticate on the Status tab. ` +
        `Notes written here will not reach other devices until then.`,
    });
  }
  if (s.credentialsUnreadable) {
    out.push({
      level: "error",
      text: `${P} the stored sync credentials cannot be decrypted; the encryption key has changed. Re-enter them on the Status tab.`,
    });
  }
  if (s.sync.state === "backoff") {
    const since = s.sync.stateSince ?? null;
    const forMs = since === null ? 0 : Math.max(0, s.now - since);
    if (forMs >= BACKOFF_ERROR_MS) {
      const minutes = Math.floor(forMs / BACKOFF_ERROR_MS) * 15;
      out.push({
        level: "error",
        text: `${P} sync has been failing for over ${minutes} minutes. Check the log on the Status tab. Notes written here are durable but not syncing.`,
      });
    } else {
      const attempts = Math.max(5, Math.round(s.sync.restartCount / 5) * 5);
      out.push({
        level: "warn",
        text: `${P} sync is failing and retrying (about ${attempts} attempts). Notes written here are durable but not yet syncing.`,
      });
    }
  }
  if (s.sync.state === "needs-setup" || !s.vaultConfigured) {
    out.push({ level: "error", text: `${P} no vault is linked. Finish setup on the dashboard before writing.` });
  }
  if (s.extraAdmins > 0) {
    out.push({
      level: "error",
      text: `${P} this server has ${s.extraAdmins + 1} admin accounts and should have exactly one. Remove the extra accounts; see SECURITY.md.`,
    });
  }
  if (s.disk === "critical") {
    out.push({
      level: "error",
      text: `${P} the data volume has under 50 MB free; writes that would not leave room for the index are refused. Grow the Railway volume now, while the resize is still live.`,
    });
  } else if (s.disk === "warn") {
    out.push({
      level: "warn",
      text: `${P} the data volume has under 100 MB free. Grow the Railway volume before it fills: the resize is live now and forces a restart at 100%.`,
    });
  }
  if (s.index.lastRebuildError !== null) {
    out.push({
      level: "error",
      text: `${P} the search index failed to rebuild; search, tasks and tags may be incomplete. Try Rebuild Index on the Status tab.`,
    });
  }
  // A failed rebuild leaves the index not ready as well; that is the error
  // above, and saying "rebuilding" beside it would imply it will finish.
  if (!s.index.ready && s.index.lastRebuildError === null) {
    out.push({
      level: "warn",
      text: `${P} the search index is rebuilding; search, tasks, tags and links are incomplete for the moment.`,
    });
  }
  if (s.index.unindexedNotes > 0) {
    out.push({
      level: "warn",
      text: `${P} ${s.index.unindexedNotes} note(s) exceed the index size limit and are listed but not searchable.`,
    });
  }
  if (s.originMismatch) {
    out.push({
      level: "warn",
      text: `${P} this server is configured as ${s.originMismatch.configured} but reached at ${s.originMismatch.reachedAt}; the OAuth issuer and endpoint URL are wrong until it restarts.`,
    });
  }
  if (s.insecureBaseUrl) {
    out.push({ level: "warn", text: `${P} BASE_URL is http:// but the server is served over HTTPS; set BASE_URL to https://.` });
  }
  return [...out.filter((a) => a.level === "error"), ...out.filter((a) => a.level === "warn")];
}

/** Keep to the cap; the last block says what was left out. */
export function capBlocks(blocks: string[]): string[] {
  if (blocks.length <= MAX_ALERT_BLOCKS) return blocks;
  const kept = MAX_ALERT_BLOCKS - 1;
  return [...blocks.slice(0, kept), `${P} and ${blocks.length - kept} more on the Status tab.`];
}

/**
 * The blocks to append to one tool result for one connector: its undelivered
 * notices first (they are one-shot, and would otherwise be lost to the cap),
 * then the alerts. Never throws — an alert that broke a tool result would be
 * the failure it was meant to report.
 */
export function alertBlocks(label: string, req: RequestInfo = {}): string[] {
  try {
    const notices = takeNotices(label, MAX_ALERT_BLOCKS - 1).map((t) => `${P} ${t}`);
    const alerts = alertsFrom(snapshot(req)).map((a) => a.text);
    return capBlocks([...notices, ...alerts]);
  } catch (e) {
    console.error("[alerts] failed to compute alerts:", e);
    return [];
  }
}
