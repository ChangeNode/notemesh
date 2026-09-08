import { db } from "../db";
import { runGit } from "../sync/git-exec";

/**
 * When a file was last changed, in the sense a person means.
 *
 * The filesystem mtime is what a checkout sets, so on the git backend every
 * pulled file looks as though it was written the moment the server pulled it.
 * Git itself remembers the author time of the commit that last touched each
 * path, and that is the number a person expects to see. This module holds
 * that number per vault-relative path, fed by one `git log` pass at start and
 * after each pull, and falls back to the mtime for anything git has no
 * opinion on: an Obsidian-synced vault, where sync preserves the mtime and it
 * is already right, or a file a tool wrote a moment ago that is not committed
 * yet.
 *
 * Both readers of a file's time go through modifiedFor — the indexer when it
 * stores a row and the directory walk when it lists — so a listing and the
 * index never disagree about the same file.
 */
const times = new Map<string, number>(); // vault-relative path -> epoch ms
// The first commit that added each path: git's answer to "created". Git is
// the only source that survives a clone, so it is authoritative when present.
const born = new Map<string, number>();

export function modifiedFor(relPath: string, mtimeMs: number): number {
  return times.get(relPath) ?? Math.round(mtimeMs);
}

/**
 * When the file came into being. Git's first commit for the path when there
 * is one; otherwise the filesystem's birthtime, which a tool's own create
 * sets correctly and a checkout sets to the checkout. Never later than the
 * modified time: a copy made with its mtime preserved is born after it was
 * last changed, and a person reading created > modified would assume a bug.
 */
export function createdFor(relPath: string, st: { birthtimeMs: number; mtimeMs: number }): number {
  const modified = modifiedFor(relPath, st.mtimeMs);
  const candidate = born.get(relPath) ?? (st.birthtimeMs > 0 ? Math.round(st.birthtimeMs) : modified);
  return Math.min(candidate, modified);
}

/**
 * A tool wrote this path just now. On the git backend its commit lands on the
 * next cycle carrying this moment, and the next log pass agrees; until then
 * this is the answer, and it beats the older commit time git still has for
 * the path.
 */
export function recordLocalModification(relPath: string, at = Date.now()) {
  times.set(relPath, at);
}

export function forgetModification(relPath: string) {
  times.delete(relPath);
  born.delete(relPath);
}

/** Test seam: the module is a singleton, so a suite starts from nothing. */
export function resetModifiedTimes() {
  times.clear();
  born.clear();
}

export interface GitHistory {
  /** Newest commit touching each path. */
  modified: Map<string, number>;
  /** Oldest commit touching each path. */
  created: Map<string, number>;
}

/**
 * Parses `git log --format=%x00%at --name-only`. The log is newest first, so
 * the first time seen for a path is the commit that last touched it. Each
 * commit's header is a NUL followed by epoch seconds; NUL cannot appear in a
 * path, so a file named with digits alone is never mistaken for a header.
 */
export function parseGitHistory(text: string): GitHistory {
  const modified = new Map<string, number>();
  const created = new Map<string, number>();
  let current: number | null = null;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    if (line.startsWith("\0")) {
      const secs = Number(line.slice(1));
      current = Number.isFinite(secs) ? secs * 1000 : null;
      continue;
    }
    if (current === null) continue;
    if (!modified.has(line)) modified.set(line, current);
    // Every later mention is an older commit, so the last one seen is the first commit.
    created.set(line, current);
  }
  return { modified, created };
}

export function parseGitLog(text: string): Map<string, number> {
  return parseGitHistory(text).modified;
}

export async function loadGitHistory(dir: string): Promise<GitHistory | null> {
  // quotePath=false so a non-ASCII filename comes back as itself rather than
  // octal-escaped and quoted, which would never match the walk's path.
  const res = await runGit(
    ["-c", "core.quotePath=false", "log", "--format=%x00%at", "--name-only"],
    { cwd: dir, timeoutMs: 60_000 },
  );
  if (!res.ok) return null;
  return parseGitHistory(res.stdout);
}

/**
 * Merge git's times in and push them into the index in one transaction.
 * Merge, not replace: a path a tool wrote after the log was read holds a
 * newer local time, and git's older commit time must not win over it.
 * Returns the number of index rows updated.
 */
export function applyGitTimes(map: Map<string, number>): number {
  return applyGitHistory({ modified: map, created: new Map() });
}

export function applyGitHistory(history: GitHistory): number {
  for (const [p, t] of history.modified) {
    const have = times.get(p);
    if (have === undefined || have < t) times.set(p, t);
  }
  for (const [p, t] of history.created) born.set(p, t);
  const d = db();
  const notes = d.prepare("UPDATE notes SET modified = ? WHERE path = ? AND modified IS NOT ?");
  const atts = d.prepare("UPDATE attachments SET modified = ? WHERE path = ? AND modified IS NOT ?");
  const notesBorn = d.prepare("UPDATE notes SET created = ? WHERE path = ? AND created IS NOT ?");
  const attsBorn = d.prepare("UPDATE attachments SET created = ? WHERE path = ? AND created IS NOT ?");
  let n = 0;
  d.transaction(() => {
    for (const p of history.modified.keys()) {
      const t = times.get(p)!;
      n += notes.run(t, p, t).changes + atts.run(t, p, t).changes;
    }
    for (const [p, t] of history.created) {
      n += notesBorn.run(t, p, t).changes + attsBorn.run(t, p, t).changes;
    }
  })();
  return n;
}

/** The pass the git backend runs at start and after every pull. Null when git could not be read. */
export async function refreshGitTimes(dir: string): Promise<number | null> {
  const history = await loadGitHistory(dir);
  if (!history) return null;
  return applyGitHistory(history);
}

// ---- Presentation --------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * An ISO 8601 timestamp with the wall-clock time and offset of the given zone:
 * "2026-09-05T14:03:12-07:00". The instant is exact either way; the zone is so
 * a person reading it sees their own clock, the same one daily_note uses.
 */
export function isoInZone(ms: number, timeZone: string): string {
  const f = formatterFor(timeZone);
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(ms)) p[part.type] = part.value;
  // "GMT-07:00", or bare "GMT" at zero offset.
  const off = p.timeZoneName === "GMT" ? "+00:00" : p.timeZoneName.replace(/^GMT/, "");
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off}`;
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "longOffset",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The zone's offset from UTC at that instant, in ms (Auckland in January: +13h). */
export function zoneOffsetMs(ms: number, timeZone: string): number {
  const name = formatterFor(timeZone).formatToParts(ms).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 3_600_000 + Number(m[3]) * 60_000);
}

/**
 * The instant at which the zone's clocks read this wall-clock time. Solved by
 * guessing the same digits in UTC and correcting by the offset there, then
 * once more in case the correction crossed a daylight-saving change.
 */
export function wallClockInZone(
  parts: { year: number; month: number; day: number; hour?: number; minute?: number; second?: number },
  timeZone: string,
): number {
  const guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0);
  const first = zoneOffsetMs(guess, timeZone);
  const ms = guess - first;
  const second = zoneOffsetMs(ms, timeZone);
  return second === first ? ms : guess - second;
}
