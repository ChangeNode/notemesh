import fs from "node:fs";
import path from "node:path";
import { env } from "../env";
import { getSetting } from "../db";
import { resolveNotePath, toVaultRelative, VaultPathError } from "./paths";
import { createNote, appendToNote, prependToNote, readNoteRange, noteExists } from "./notes";

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
  try {
    const raw = fs.readFileSync(path.join(env.vaultDir, ".obsidian", "daily-notes.json"), "utf8");
    const cfg = JSON.parse(raw);
    return {
      folder: typeof cfg.folder === "string" ? cfg.folder : undefined,
      format: typeof cfg.format === "string" && cfg.format ? cfg.format : undefined,
      template: typeof cfg.template === "string" ? cfg.template : undefined,
    };
  } catch {
    // Absent, unreadable or not JSON — all mean "no vault config to use".
    return null;
  }
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

// "Today" has to be resolved in the user's timezone, not the server's. A
// container runs in UTC, so an evening in the Americas is already tomorrow as
// far as the process is concerned and the daily note lands on the wrong day.
export const DEFAULT_TIMEZONE = "UTC";

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function configuredTimeZone(): string {
  const tz = getSetting("timezone");
  return tz && isValidTimeZone(tz) ? tz : DEFAULT_TIMEZONE;
}

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

export function dailyNotePath(date?: string): string {
  // Constrain to YYYY-MM-DD so the value is a safe, predictable input (it never
  // reaches the filesystem — only numeric components do — but validate anyway).
  if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new VaultPathError(`Invalid date: ${date} (expected YYYY-MM-DD)`);
  }
  const d = date ? partsFromISO(date) : todayInZone(new Date(), configuredTimeZone());
  if (!Number.isFinite(d.year) || !Number.isFinite(d.month) || !Number.isFinite(d.day)) {
    throw new VaultPathError(`Invalid date: ${date} (expected YYYY-MM-DD)`);
  }
  const cfg = dailyConfig();
  const name = formatDate(d, cfg.format);
  const rel = cfg.folder ? `${cfg.folder.replace(/\/$/, "")}/${name}.md` : `${name}.md`;
  return toVaultRelative(resolveNotePath(rel));
}

function ensureDailyNote(date?: string): string {
  const rel = dailyNotePath(date);
  if (!noteExists(rel)) {
    createNote(rel, "");
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
