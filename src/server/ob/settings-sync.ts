import { obSyncConfigs, type ObConfigCategory } from "./cli";
import { syncBackend, syncKind } from "../sync";

/**
 * Turn on Obsidian's settings sync for this vault.
 *
 * Off by default in Obsidian Sync, so a vault arrives with no .obsidian
 * folder: daily-notes.json stays on the person's machine, daily_note falls
 * back to Obsidian's defaults, and the daemon reports "config syncing
 * disabled". The link step turns it on for a new vault; the supervisor turns
 * it on once per boot for every vault, which is how one linked before that
 * step existed gets it. Best effort, idempotent, one line in the sync log
 * either way. The files arrive with the daemon's next sync, not at the end
 * of this call.
 *
 * Two categories. core-plugin-data is the core plugins' own settings, where
 * daily-notes.json lives. app is app.json and types.json: where new notes
 * and attachments go, how links are written, the property types — settings
 * the server does not read yet, present for when it does. Nothing under
 * .obsidian is reachable from any tool.
 */
export const SETTINGS_SYNC_CATEGORIES: ObConfigCategory[] = ["core-plugin-data", "app"];

export interface SettingsSyncResult {
  ok: boolean;
  message: string;
}

const NOT_OBSIDIAN =
  "Settings sync is for a vault synced by Obsidian Sync. A git-backed vault carries its .obsidian folder in its commits.";

export async function enableSettingsSync(): Promise<SettingsSyncResult> {
  if (syncKind() !== "obsidian") return { ok: false, message: NOT_OBSIDIAN };
  const res = await obSyncConfigs(SETTINGS_SYNC_CATEGORIES);
  if (res.ok) {
    syncBackend().note("[sync] Obsidian settings sync is on: core plugin settings (daily notes, etc) arrive with the next sync.");
    return { ok: true, message: "Settings sync is on. daily-notes.json arrives on the next sync." };
  }
  const detail = res.combined.trim().split("\n").slice(-3).join("\n") || "sync-config failed.";
  syncBackend().note(`[sync] Could not turn on Obsidian settings sync: ${detail}`, "warn");
  return { ok: false, message: detail };
}
