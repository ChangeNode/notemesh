import fs from "node:fs";
import path from "node:path";
import { env } from "../env";
import { getSetting } from "../db";
import { resolveNotePath, toVaultRelative } from "./paths";
import { createNote, appendToNote, prependToNote, readNote, noteExists } from "./notes";

interface DailyConfig {
  folder: string;
  format: string; // moment-style format from Obsidian's daily-notes.json
  template?: string;
}

// Resolution order: admin-configured settings (the ob daemon doesn't sync the
// .obsidian config folder by default, so this is the reliable path), then the
// vault's own daily-notes.json if present, then Obsidian's default of
// YYYY-MM-DD at the vault root.
function dailyConfig(): DailyConfig {
  const folderSetting = getSetting("daily_folder");
  const formatSetting = getSetting("daily_format");
  if (folderSetting !== undefined || formatSetting) {
    return {
      folder: folderSetting ?? "",
      format: formatSetting || "YYYY-MM-DD",
    };
  }
  try {
    const raw = fs.readFileSync(path.join(env.vaultDir, ".obsidian", "daily-notes.json"), "utf8");
    const cfg = JSON.parse(raw);
    return {
      folder: typeof cfg.folder === "string" ? cfg.folder : "",
      format: typeof cfg.format === "string" && cfg.format ? cfg.format : "YYYY-MM-DD",
      template: typeof cfg.template === "string" ? cfg.template : undefined,
    };
  } catch {
    return { folder: "", format: "YYYY-MM-DD" };
  }
}

// Minimal moment-format subset covering common daily note formats.
function formatDate(date: Date, format: string): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const replacements: Record<string, string> = {
    YYYY: String(date.getFullYear()),
    YY: String(date.getFullYear()).slice(-2),
    MMMM: months[date.getMonth()],
    MMM: months[date.getMonth()].slice(0, 3),
    MM: pad(date.getMonth() + 1),
    M: String(date.getMonth() + 1),
    DDDD: days[date.getDay()],
    dddd: days[date.getDay()],
    ddd: days[date.getDay()].slice(0, 3),
    DD: pad(date.getDate()),
    D: String(date.getDate()),
  };
  // Replace longest tokens first to avoid partial matches.
  return format.replace(/YYYY|YY|MMMM|MMM|MM|M|dddd|ddd|DDDD|DD|D/g, (t) => replacements[t] ?? t);
}

export function dailyNotePath(date?: string): string {
  const d = date ? new Date(date + "T00:00:00") : new Date();
  if (isNaN(d.getTime())) throw new Error(`Invalid date: ${date} (expected YYYY-MM-DD)`);
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

export function dailyRead(date?: string): { path: string; content: string } {
  return readNote(dailyNotePath(date));
}

export function dailyAppend(content: string, date?: string): string {
  return appendToNote(ensureDailyNote(date), content);
}

export function dailyPrepend(content: string, date?: string): string {
  return prependToNote(ensureDailyNote(date), content);
}
