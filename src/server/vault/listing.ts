import { VaultPathError } from "./paths";
import { wallClockInZone } from "./modified";

/**
 * Ordering and narrowing for the list tools, applied to the whole listing
 * before it is paged, so `total` and `hasMore` describe the narrowed list
 * and page two follows page one under the same order.
 */
export type SortKey = "name" | "modified" | "created" | "size";
export type SortOrder = "asc" | "desc";

export interface ListOptions {
  sort?: SortKey;
  order?: SortOrder;
  /** Keep only entries modified strictly after this instant; see parseInstant for the forms. */
  modifiedAfter?: string;
  /** Keep only entries whose filename matches; see nameMatcher for the forms. */
  name?: string;
}

interface Listed {
  path: string;
  /** The filename, when the entry carries one; otherwise the last segment of path. */
  name?: string;
  modified: string;
  created: string;
  size: number;
}

/**
 * What a person types to find a file by name. With * or ? it is a glob over
 * the whole filename, so 2026-08* is that month's daily notes and *.png the
 * images; without either it is a fragment matched anywhere, so "meeting"
 * finds Meeting notes.md. Case-insensitive either way, since a person rarely
 * remembers the case of a filename and Obsidian's own switcher ignores it.
 */
export const MAX_NAME_PATTERN_CHARS = 200;

export function nameMatcher(pattern: string): (name: string) => boolean {
  if (pattern.length > MAX_NAME_PATTERN_CHARS) {
    throw new VaultPathError(`name is longer than ${MAX_NAME_PATTERN_CHARS} characters`);
  }
  const p = pattern.toLowerCase();
  if (!/[*?]/.test(p)) return (name) => name.toLowerCase().includes(p);
  return (name) => globMatch(p, name.toLowerCase());
}

/**
 * * and ? over the whole name, without a regular expression: a pattern like
 * *a*a*a*a* made a backtracking regex take seconds against an ordinary
 * filename. This is the two-pointer wildcard match, which on a mismatch
 * retreats to the last * and advances the name by one, so its work is at
 * most the product of the two lengths, never exponential.
 */
export function globMatch(pattern: string, name: string): boolean {
  let p = 0;
  let n = 0;
  let star = -1;
  let starName = 0;
  while (n < name.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === name[n])) {
      p++;
      n++;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      starName = n;
    } else if (star !== -1) {
      p = star + 1;
      n = ++starName;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ZONELESS = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * An instant from what a person types. A bare date is midnight in the
 * configured zone, and a timestamp without an offset is read on that zone's
 * clock too, so "2026-09-05" from Auckland means Auckland's midnight, not the
 * container's. Anything carrying its own offset or Z is taken as written.
 */
export function parseInstant(input: string, timeZone: string): number {
  const text = input.trim();
  const date = DATE.exec(text) ?? ZONELESS.exec(text);
  if (date) {
    const [year, month, day] = [Number(date[1]), Number(date[2]), Number(date[3])];
    const hour = Number(date[4] ?? 0);
    const minute = Number(date[5] ?? 0);
    const second = Number(date[6] ?? 0);
    const check = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    const real =
      check.getUTCFullYear() === year &&
      check.getUTCMonth() === month - 1 &&
      check.getUTCDate() === day &&
      check.getUTCHours() === hour &&
      check.getUTCMinutes() === minute &&
      check.getUTCSeconds() === second;
    if (!real) throw new VaultPathError(`modifiedAfter is not a real date or time: ${JSON.stringify(input)}`);
    return wallClockInZone({ year, month, day, hour, minute, second }, timeZone);
  }
  const ms = Date.parse(text);
  if (!Number.isFinite(ms) || !/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    throw new VaultPathError(
      `modifiedAfter must be an ISO 8601 timestamp (2026-09-05T14:00:00Z, 2026-09-05T14:00:00-07:00) ` +
        `or a date (2026-09-05), not ${JSON.stringify(input)}`,
    );
  }
  return ms;
}

export function arrange<T extends Listed>(items: T[], opts: ListOptions, timeZone: string): T[] {
  const after = opts.modifiedAfter === undefined ? null : parseInstant(opts.modifiedAfter, timeZone);
  const sort = opts.sort ?? "name";
  // Newest and largest first are what someone sorting by those wants; by
  // name, alphabetical.
  const order = opts.order ?? (sort === "name" ? "asc" : "desc");
  const dir = order === "asc" ? 1 : -1;

  const byName = opts.name === undefined ? null : nameMatcher(opts.name);
  const decorated = items
    .map((item) => ({ item, at: Date.parse(item.modified), born: Date.parse(item.created) }))
    .filter((d) => after === null || d.at > after)
    .filter((d) => byName === null || byName(d.item.name ?? d.item.path.slice(d.item.path.lastIndexOf("/") + 1)));
  const key =
    sort === "modified"
      ? (a: (typeof decorated)[number], b: (typeof decorated)[number]) => a.at - b.at
      : sort === "created"
        ? (a: (typeof decorated)[number], b: (typeof decorated)[number]) => a.born - b.born
        : sort === "size"
        ? (a: (typeof decorated)[number], b: (typeof decorated)[number]) => a.item.size - b.item.size
        : (a: (typeof decorated)[number], b: (typeof decorated)[number]) => a.item.path.localeCompare(b.item.path);
  // Ties fall back to the path, ascending whichever way the key runs, so a
  // page boundary between two notes saved in the same second is stable.
  decorated.sort((a, b) => dir * key(a, b) || a.item.path.localeCompare(b.item.path));
  return decorated.map((d) => d.item);
}
