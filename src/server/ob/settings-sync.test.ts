import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The one call that turns on Obsidian's settings sync, made by the link step
// for a new vault and by the supervisor once per boot for every vault.
// Driven through a fake `ob` on OB_BIN, as cli.test.ts drives the CLI.

let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "notemesh-settings-sync-")));
  fs.mkdirSync(path.join(root, "vault"), { recursive: true });
  process.env.DATA_DIR = root;
  process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 13).toString("base64");
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.OB_BIN;
});

/** A stand-in `ob` that records its arguments, prints `stdout`, and exits with `code`. */
function fakeOb(stdout: string, code = 0) {
  const script = path.join(root, "fake-ob");
  const argsFile = path.join(root, "ob-args");
  fs.writeFileSync(script, `#!/bin/sh\necho "$@" >> "${argsFile}"\ncat <<'OBEOF'\n${stdout}\nOBEOF\nexit ${code}\n`);
  fs.chmodSync(script, 0o755);
  process.env.OB_BIN = script;
  return () => (fs.existsSync(argsFile) ? fs.readFileSync(argsFile, "utf8") : "");
}

describe("enableSettingsSync", () => {
  it("asks the daemon for the core plugin and app settings, and says the files arrive on the next sync", async () => {
    const args = fakeOb("Config sync enabled");
    const { enableSettingsSync } = await import("./settings-sync");
    const res = await enableSettingsSync();
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/next sync/);
    expect(args()).toMatch(/sync-config --path \S+\/vault --configs core-plugin-data,app/);
    const { syncBackend } = await import("../sync");
    expect(syncBackend().getLogs().some((l) => /settings sync is on/.test(l.line))).toBe(true);
  });

  it("reports the daemon's own words when it refuses, and logs a warning", async () => {
    fakeOb("error: not signed in", 1);
    const { enableSettingsSync } = await import("./settings-sync");
    const res = await enableSettingsSync();
    expect(res).toEqual({ ok: false, message: "error: not signed in" });
    const { syncBackend } = await import("../sync");
    expect(syncBackend().getLogs().some((l) => l.level === "warn" && /Could not turn on/.test(l.line))).toBe(true);
  });

  it("refuses for a git-backed vault without running anything", async () => {
    const args = fakeOb("should not run");
    const { setSetting } = await import("../db");
    setSetting("sync_backend", "git");
    const { enableSettingsSync } = await import("./settings-sync");
    const res = await enableSettingsSync();
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/git-backed vault/);
    expect(args()).toBe("");
  });
});
