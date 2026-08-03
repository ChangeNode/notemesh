import { getSetting } from "../db";
import { supervisor } from "../ob/supervisor";
import { gitBackend } from "./git";
import type { SyncBackend, SyncKind } from "./types";

export * from "./types";

// Which backend this instance was set up with. Defaults to Obsidian so an
// instance configured before git support existed keeps working untouched.
export function syncKind(): SyncKind {
  return getSetting("sync_backend") === "git" ? "git" : "obsidian";
}

export function syncBackend(): SyncBackend {
  return syncKind() === "git" ? gitBackend() : supervisor();
}

// Idempotent boot hook: starts whichever backend this instance uses, once
// setup has completed.
let bootChecked = false;
export function ensureSyncStarted() {
  if (bootChecked) return;
  bootChecked = true;
  try {
    if (getSetting("vault_configured") === "true") {
      syncBackend().start();
    }
  } catch {
    // DB not ready yet — first boot before setup; nothing to start.
  }
}
