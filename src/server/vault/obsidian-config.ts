import fs from "node:fs";
import path from "node:path";
import { env } from "../env";

/**
 * Obsidian's own settings, read from the vault's .obsidian folder when
 * settings sync has delivered them (see ob/settings-sync.ts). Each reader
 * answers null for a file that is absent, unreadable or not a JSON object —
 * all of which mean "no vault setting to use" — and never throws: a broken
 * settings file must not stop a note being created.
 *
 * The folder is unreachable from every tool; only these readers look inside.
 */
export function readObsidianConfig(name: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(path.join(env.vaultDir, ".obsidian", `${name}.json`), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A string setting, or undefined when absent or not a string. */
export function configString(cfg: Record<string, unknown> | null, key: string): string | undefined {
  const v = cfg?.[key];
  return typeof v === "string" ? v : undefined;
}

export interface NewNoteLocation {
  /** The folder a note with no folder of its own goes to; "" is the vault root. */
  folder: string;
  /** Whether the vault's app.json set it. */
  source: "vault" | "default";
}

/**
 * Obsidian's "Default location for new notes" (app.json newFileLocation:
 * root, current, or folder with newFileFolderPath). "current" means the
 * folder of the note open in Obsidian, which the server cannot know, so it
 * is the root here.
 */
export function resolveNewNoteLocation(): NewNoteLocation {
  const cfg = readObsidianConfig("app");
  const where = configString(cfg, "newFileLocation");
  const folder = configString(cfg, "newFileFolderPath")?.replace(/^\/+|\/+$/g, "") ?? "";
  if (where === "folder" && folder) return { folder, source: "vault" };
  return { folder: "", source: cfg && where ? "vault" : "default" };
}

/**
 * Where create_note puts a bare filename: Obsidian's default location for
 * new notes when the vault sets one, else the vault root. A path that names
 * a folder is left alone; the caller said where it goes.
 */
export function placeNewNote(notePath: string): string {
  const p = notePath.trim();
  if (p.includes("/") || p.includes("\\")) return notePath;
  const { folder } = resolveNewNoteLocation();
  return folder ? `${folder}/${p}` : notePath;
}
