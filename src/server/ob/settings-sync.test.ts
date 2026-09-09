import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The one call the wizard's link step makes to turn on settings sync, on its
// own, for a vault linked before that step existed. Driven through a fake
// `ob` on OB_BIN, as cli.test.ts drives the CLI.

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

describe("runSettingsSync", () => {
  it("asks the daemon for the core plugin settings and says the file arrives on the next sync", async () => {
    const args = fakeOb("Config sync enabled");
    const { runSettingsSync } = await import("./settings-sync");
    const res = await runSettingsSync();
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/next sync/);
    expect(args()).toMatch(/sync-config --path \S+\/vault --configs core-plugin-data/);
    const { syncBackend } = await import("../sync");
    expect(syncBackend().getLogs().some((l) => /Syncing your vault's core plugin settings/.test(l.line))).toBe(true);
  });

  it("reports the daemon's own words when it refuses, and logs a warning", async () => {
    fakeOb("error: not signed in", 1);
    const { runSettingsSync } = await import("./settings-sync");
    const res = await runSettingsSync();
    expect(res).toEqual({ ok: false, message: "error: not signed in" });
    const { syncBackend } = await import("../sync");
    expect(syncBackend().getLogs().some((l) => l.level === "warn" && /Could not enable settings sync/.test(l.line))).toBe(true);
  });

  it("refuses for a git-backed vault without running anything", async () => {
    const args = fakeOb("should not run");
    const { setSetting } = await import("../db");
    setSetting("sync_backend", "git");
    const { runSettingsSync } = await import("./settings-sync");
    const res = await runSettingsSync();
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/git-backed vault/);
    expect(args()).toBe("");
  });
});
