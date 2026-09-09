import { obSyncConfigs } from "./cli";
import { syncBackend, syncKind } from "../sync";

/**
 * Turn on Obsidian's settings sync for this vault, on its own.
 *
 * The link step in the wizard runs this, but a vault linked before that step
 * existed never had it, and the daemon then reports "config syncing
 * disabled": daily-notes.json stays on the person's machine and daily_note
 * falls back to Obsidian's defaults. Re-linking would run it, at the cost of
 * the wizard and the vault password again; this is the one call by itself.
 * The files arrive on the daemon's next sync, not at the end of this call.
 */
export interface SettingsSyncResult {
  ok: boolean;
  message: string;
}

const NOT_OBSIDIAN =
  "Settings sync is for a vault synced by Obsidian Sync. A git-backed vault carries its .obsidian folder in its commits.";

export async function runSettingsSync(): Promise<SettingsSyncResult> {
  if (syncKind() !== "obsidian") return { ok: false, message: NOT_OBSIDIAN };
  const res = await obSyncConfigs(["core-plugin-data"]);
  if (res.ok) {
    syncBackend().note("[admin] Syncing your vault's core plugin settings (daily notes, etc).");
    return {
      ok: true,
      message: "Settings sync is on. daily-notes.json arrives on the next sync; this page shows it once it has.",
    };
  }
  const detail = res.combined.trim().split("\n").slice(-3).join("\n") || "sync-config failed.";
  syncBackend().note(`[admin] Could not enable settings sync: ${detail}`, "warn");
  return { ok: false, message: detail };
}
