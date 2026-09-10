import { resolveNotePath, toVaultRelative, VaultPathError } from "./paths";
import { createNote, appendToNote, prependToNote, readNote, readNoteRange, noteExists } from "./notes";
import { readObsidianConfig, configString } from "./obsidian-config";
import { DEFAULT_TIMEZONE, configuredTimeZone, isValidTimeZone } from "./timezone";

interface DailyConfig {
  folder: string;
  format: string; // moment-style format from Obsidian's daily-notes.json
  template?: string;
}

// Obsidian Sync does not send the .obsidian folder unless asked, so a synced
// vault used to arrive without one and every instance fell back to the default
// — which is why this once had a manual override beside it. Setup asks for the
// core-plugin-data category now (see obSyncConfigs), so the vault brings its
// real daily note folder and format with it.
export const DEFAULT_DAILY_FORMAT = "YYYY-MM-DD";

/** Where a resolved value came from, so the UI can say. */
export type DailySource = "vault" | "default";

export interface DailyResolution extends DailyConfig {
  folderSource: DailySource;
  formatSource: DailySource;
  /** Whether the vault's own daily-notes.json was found and parsed. */
  vaultConfigFound: boolean;
}

// The vault's own Daily Notes settings, if Obsidian Sync sent them.
function vaultDailyConfig(): { folder?: string; format?: string; template?: string } | null {
  const cfg = readObsidianConfig("daily-notes");
  if (!cfg) return null;
  return {
    folder: configString(cfg, "folder"),
    format: configString(cfg, "format") || undefined,
    template: configString(cfg, "template"),
  };
}

/**
 * Where the daily note goes: the vault's own Daily Notes settings, or
 * Obsidian's defaults when the vault has none.
 *
 * There is deliberately no override here. There used to be a folder and format
 * pair on the Settings tab, which existed only because the config folder was
 * never synced — the resolver looked for daily-notes.json and never found one,
 * so the answer had to be typed in. Setup asks for those files now, so the
 * vault carries its own answer and a second place to state it could only ever
 * disagree with the first.
 */
export function resolveDailyConfig(): DailyResolution {
  const vault = vaultDailyConfig();
  return {
    folder: vault?.folder ?? "",
    format: vault?.format || DEFAULT_DAILY_FORMAT,
    template: vault?.template,
    folderSource: vault?.folder !== undefined ? "vault" : "default",
    formatSource: vault?.format ? "vault" : "default",
    vaultConfigFound: vault !== null,
  };
}

function dailyConfig(): DailyConfig {
  const r = resolveDailyConfig();
  return { folder: r.folder, format: r.format, template: r.template };
}

// The timezone helpers live in timezone.ts (notes.ts needs them too, and
// this module imports notes.ts); re-exported so existing callers stand.
export { DEFAULT_TIMEZONE, isValidTimeZone, configuredTimeZone };

/** Calendar date, decoupled from any instant so no zone can shift it again. */
export interface DateParts {
  year: number;
  month: number; // 1-12
  day: number;
  weekday: number; // 0 = Sunday
}

function weekdayOf(year: number, month: number, day: number): number {
  // Computed in UTC purely as arithmetic on a fixed calendar date.
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** What day it is right now, where the user is. */
export function todayInZone(now: Date, timeZone: string): DateParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(now)) p[part.type] = part.value;
  const year = Number(p.year);
  const month = Number(p.month);
  const day = Number(p.day);
  return { year, month, day, weekday: weekdayOf(year, month, day) };
}

/**
 * `YYYYMMDDHHmm` for the given instant, read in the given zone.
 *
 * Zettelkasten-style unique notes are named after the minute they were created,
 * so they need the wall clock and not just the calendar date that DateParts
 * carries. Lives here rather than at the call site because this module owns
 * every "what time is it where the user is" decision — the alternative, each
 * caller reaching for `new Date()` and its local getters, is what left
 * unique_note stamping UTC after daily notes had already been fixed.
 *
 * hourCycle "h23" rather than hour12:false: the latter is permitted to render
 * midnight as 24, which would name a note for a day that has not started.
 */
export function timestampInZone(now: Date, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(now)) p[part.type] = part.value;
  return `${p.year}${p.month}${p.day}${p.hour}${p.minute}`;
}

/** An explicit YYYY-MM-DD is taken at face value — never re-interpreted. */
export function partsFromISO(iso: string): DateParts {
  const [year, month, day] = iso.split("-").map(Number);
  return { year, month, day, weekday: weekdayOf(year, month, day) };
}

// Minimal moment-format subset covering common daily note formats.
/**
 * Date and time tokens together, the way a filename format such as
 * "YYYY-MM-DD HHmm" needs them, in one pass so a month's M is never read
 * again as a minute. Text in square brackets is literal, as in moment.
 */
export function formatMoment(d: DateParts, t: { hour: number; minute: number; second: number }, format: string): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const h12 = t.hour % 12 === 0 ? 12 : t.hour % 12;
  const tokens: Record<string, string> = {
    YYYY: String(d.year),
    YY: String(d.year).slice(-2),
    MMMM: months[d.month - 1],
    MMM: months[d.month - 1].slice(0, 3),
    MM: pad(d.month),
    M: String(d.month),
    DDDD: days[d.weekday],
    dddd: days[d.weekday],
    ddd: days[d.weekday].slice(0, 3),
    DD: pad(d.day),
    D: String(d.day),
    HH: pad(t.hour),
    H: String(t.hour),
    hh: pad(h12),
    h: String(h12),
    mm: pad(t.minute),
    m: String(t.minute),
    ss: pad(t.second),
    s: String(t.second),
    A: t.hour < 12 ? "AM" : "PM",
    a: t.hour < 12 ? "am" : "pm",
  };
  return format.replace(
    /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|dddd|ddd|DDDD|DD|D|HH|H|hh|h|mm|m|ss|s|A|a/g,
    (tok, literal?: string) => (literal !== undefined ? literal : tokens[tok] ?? tok),
  );
}

export function formatDate(d: DateParts, format: string): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const replacements: Record<string, string> = {
    YYYY: String(d.year),
    YY: String(d.year).slice(-2),
    MMMM: months[d.month - 1],
    MMM: months[d.month - 1].slice(0, 3),
    MM: pad(d.month),
    M: String(d.month),
    DDDD: days[d.weekday],
    dddd: days[d.weekday],
    ddd: days[d.weekday].slice(0, 3),
    DD: pad(d.day),
    D: String(d.day),
  };
  // Replace longest tokens first to avoid partial matches.
  return format.replace(/YYYY|YY|MMMM|MMM|MM|M|dddd|ddd|DDDD|DD|D/g, (t) => replacements[t] ?? t);
}

function dailyParts(date?: string): DateParts {
  // Constrain to YYYY-MM-DD so the value is a safe, predictable input (it never
  // reaches the filesystem — only numeric components do — but validate anyway).
  if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new VaultPathError(`Invalid date: ${date} (expected YYYY-MM-DD)`);
  }
  const d = date ? partsFromISO(date) : todayInZone(new Date(), configuredTimeZone());
  if (!Number.isFinite(d.year) || !Number.isFinite(d.month) || !Number.isFinite(d.day)) {
    throw new VaultPathError(`Invalid date: ${date} (expected YYYY-MM-DD)`);
  }
  return d;
}

export function dailyNotePath(date?: string): string {
  const d = dailyParts(date);
  const cfg = dailyConfig();
  const name = formatDate(d, cfg.format);
  const rel = cfg.folder ? `${cfg.folder.replace(/\/$/, "")}/${name}.md` : `${name}.md`;
  return toVaultRelative(resolveNotePath(rel));
}

/** The wall clock in a zone, for {{time}}. */
export function timeInZone(now: Date, timeZone: string): { hour: number; minute: number; second: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(now)) p[part.type] = part.value;
  return { hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second) };
}

/** The moment-style time tokens Obsidian's templates use; the date tokens are formatDate's. */
export function formatTime(t: { hour: number; minute: number; second: number }, format: string): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const h12 = t.hour % 12 === 0 ? 12 : t.hour % 12;
  const replacements: Record<string, string> = {
    HH: pad(t.hour),
    H: String(t.hour),
    hh: pad(h12),
    h: String(h12),
    mm: pad(t.minute),
    m: String(t.minute),
    ss: pad(t.second),
    s: String(t.second),
    A: t.hour < 12 ? "AM" : "PM",
    a: t.hour < 12 ? "am" : "pm",
  };
  return format.replace(/HH|H|hh|h|mm|m|ss|s|A|a/g, (k) => replacements[k] ?? k);
}

/**
 * The template, filled the way Obsidian's Daily Notes plugin fills it:
 * {{title}} is the note's name, {{date}} the note's day and {{time}} the
 * current time in the configured zone, the last two taking a moment-style
 * format after a colon ({{date:dddd, MMMM D}}). {{date}} alone uses the daily
 * note's own date format. A template that is missing or unreadable gives an
 * empty note, as before, rather than a refusal: the person asked for a daily
 * note, not for the template.
 */
export function fillDailyTemplate(
  raw: string,
  title: string,
  d: DateParts,
  dateFormat: string,
  now = new Date(),
  timeFormat = "HH:mm",
): string {
  const t = timeInZone(now, configuredTimeZone());
  return raw.replace(/\{\{\s*(title|date|time)(?::([^}]*))?\s*\}\}/g, (_m, key: string, fmt?: string) => {
    if (key === "title") return title;
    if (key === "date") return formatDate(d, fmt ?? dateFormat);
    return formatTime(t, fmt ?? timeFormat);
  });
}

function dailyTemplateContent(rel: string, d: DateParts, cfg: DailyConfig): string {
  if (!cfg.template) return "";
  let raw: string;
  try {
    raw = readNote(cfg.template).content;
  } catch {
    return "";
  }
  const title = rel.slice(rel.lastIndexOf("/") + 1).replace(/\.md$/, "");
  return fillDailyTemplate(raw, title, d, cfg.format);
}

function ensureDailyNote(date?: string): string {
  const rel = dailyNotePath(date);
  if (!noteExists(rel)) {
    createNote(rel, dailyTemplateContent(rel, dailyParts(date), dailyConfig()));
  }
  return rel;
}

export function dailyRead(date?: string) {
  return readNoteRange(dailyNotePath(date));
}

export function dailyAppend(content: string, date?: string): string {
  return appendToNote(ensureDailyNote(date), content);
}

export function dailyPrepend(content: string, date?: string): string {
  return prependToNote(ensureDailyNote(date), content);
}
