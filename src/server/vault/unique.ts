import crypto from "node:crypto";
import fs from "node:fs";
import { createNote, readNote } from "./notes";
import { resolveNotePath, toVaultRelative } from "./paths";
import { fillDailyTemplate, formatMoment, timeInZone, todayInZone } from "./daily";
import { configuredTimeZone } from "./timezone";
import { readObsidianConfig, configString } from "./obsidian-config";

/**
 * unique_note, following Obsidian's Unique Note Creator settings the way
 * daily_note follows Daily Notes: the folder, the filename format and the
 * template come from the vault's own zk-prefixer.json when settings sync has
 * delivered it, and from Obsidian's defaults otherwise. {{date}} and {{time}}
 * in the template use the Templates plugin's own formats (templates.json)
 * when set, as Obsidian does.
 */
export const DEFAULT_UNIQUE_FORMAT = "YYYYMMDDHHmm";

export interface UniqueResolution {
  folder: string;
  format: string;
  template?: string;
  vaultConfigFound: boolean;
}

export function resolveUniqueConfig(): UniqueResolution {
  const cfg = readObsidianConfig("zk-prefixer");
  return {
    folder: configString(cfg, "folder")?.replace(/^\/+|\/+$/g, "") ?? "",
    format: configString(cfg, "format") || DEFAULT_UNIQUE_FORMAT,
    template: configString(cfg, "template") || undefined,
    vaultConfigFound: cfg !== null,
  };
}

function templateFormats(): { dateFormat: string; timeFormat: string } {
  const cfg = readObsidianConfig("templates");
  return {
    dateFormat: configString(cfg, "dateFormat") || "YYYY-MM-DD",
    timeFormat: configString(cfg, "timeFormat") || "HH:mm",
  };
}

export function uniqueNote(content?: string): string {
  const cfg = resolveUniqueConfig();
  // Stamped in the configured zone, not the server's: the container runs on
  // UTC, and Date's local getters named every evening note in the Americas
  // after tomorrow.
  const now = new Date();
  const zone = configuredTimeZone();
  const d = todayInZone(now, zone);
  const t = timeInZone(now, zone);
  const stamp = formatMoment(d, t, cfg.format);
  let name = `${stamp}.md`;
  const place = (n: string) => (cfg.folder ? `${cfg.folder}/${n}` : n);
  if (fs.existsSync(resolveNotePath(place(name)))) {
    name = `${stamp}-${crypto.randomBytes(2).toString("hex")}.md`;
  }
  const rel = toVaultRelative(resolveNotePath(place(name)));

  // The template first, then whatever the caller brought, as its own block.
  let body = "";
  if (cfg.template) {
    try {
      const { dateFormat, timeFormat } = templateFormats();
      body = fillDailyTemplate(readNote(cfg.template).content, stamp, d, dateFormat, now, timeFormat);
    } catch {
      body = ""; // a missing template is not a reason to refuse the note
    }
  }
  if (content) {
    body = body ? `${body.replace(/\n*$/, "")}\n\n${content}` : content;
  }
  return createNote(rel, body);
}
