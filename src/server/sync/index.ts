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
//
// The latch is set only once something has actually been started. Setting it on
// the first request regardless meant a request that arrived before the vault
// was configured — or while the database was briefly unreadable — used up the
// one attempt this process gets, and sync then stayed down until someone
// restarted the server or pressed Restart Sync. Nothing reported it, because
// from the hook's point of view it had already done its job.
//
// Not latching until then is safe: start() is itself idempotent, and once it
// has run the latch keeps this from overriding an operator who pressed Stop
// Sync.
let bootChecked = false;
export function ensureSyncStarted() {
  if (bootChecked) return;
  try {
    if (getSetting("vault_configured") !== "true") return;
    syncBackend().start();
    bootChecked = true;
  } catch {
    // DB not ready yet — try again on the next request rather than giving up.
  }
}
