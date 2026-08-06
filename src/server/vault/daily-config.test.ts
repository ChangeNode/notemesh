import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Where the daily note goes now comes from the vault alone. These pin that it
// really is read from the vault's file, that a missing or broken file falls
// back to Obsidian's own defaults rather than throwing, and that the result
// says which of the two happened — the Settings tab shows that distinction, and
// it is the difference between "your config is being used" and "it never
// arrived".

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "notemesh-daily-"));
  fs.mkdirSync(path.join(root, "vault"), { recursive: true });
  process.env.DATA_DIR = root;
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

function writeVaultConfig(cfg: unknown) {
  const dir = path.join(root, "vault", ".obsidian");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "daily-notes.json"), JSON.stringify(cfg));
}

async function resolve() {
  const { resolveDailyConfig } = await import("./daily");
  return resolveDailyConfig();
}

describe("resolveDailyConfig", () => {
  it("uses Obsidian's defaults when the vault sent no config", async () => {
    expect(await resolve()).toMatchObject({
      folder: "",
      format: "YYYY-MM-DD",
      folderSource: "default",
      formatSource: "default",
      vaultConfigFound: false,
    });
  });

  it("follows the vault's folder and format", async () => {
    writeVaultConfig({ folder: "Journal/Daily", format: "YYYY/MM/YYYY-MM-DD" });
    expect(await resolve()).toMatchObject({
      folder: "Journal/Daily",
      format: "YYYY/MM/YYYY-MM-DD",
      folderSource: "vault",
      formatSource: "vault",
      vaultConfigFound: true,
    });
  });

  it("fills in only what the vault left out", async () => {
    // Obsidian omits keys that are still at their default, so a partial file is
    // the normal case rather than a corrupt one.
    writeVaultConfig({ folder: "Daily" });
    const r = await resolve();
    expect(r.folder).toBe("Daily");
    expect(r.folderSource).toBe("vault");
    expect(r.format).toBe("YYYY-MM-DD");
    expect(r.formatSource).toBe("default");
    // The file was there, even though one value came from the default.
    expect(r.vaultConfigFound).toBe(true);
  });

  it("treats an empty folder as the vault root, not as missing", async () => {
    writeVaultConfig({ folder: "", format: "YYYY-MM-DD" });
    const r = await resolve();
    expect(r.folder).toBe("");
    expect(r.folderSource).toBe("vault");
  });

  it("carries the template path through when the vault names one", async () => {
    writeVaultConfig({ folder: "Daily", template: "Templates/Daily.md" });
    expect((await resolve()).template).toBe("Templates/Daily.md");
  });

  it("falls back rather than throwing on an unreadable file", async () => {
    const dir = path.join(root, "vault", ".obsidian");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "daily-notes.json"), "{ not json");
    expect(await resolve()).toMatchObject({
      folder: "",
      format: "YYYY-MM-DD",
      vaultConfigFound: false,
    });
  });

  it("ignores values of the wrong type", async () => {
    // Hand-edited or written by something other than Obsidian.
    writeVaultConfig({ folder: 42, format: [], template: null });
    const r = await resolve();
    expect(r.folder).toBe("");
    expect(r.format).toBe("YYYY-MM-DD");
    expect(r.template).toBeUndefined();
  });

  it("no longer consults the retired override settings", async () => {
    // An instance configured before the override was removed still has these
    // rows. They must not come back to life and quietly win over the vault.
    const { setSetting } = await import("../db");
    setSetting("daily_folder", "Stale");
    setSetting("daily_format", "YYYY");
    writeVaultConfig({ folder: "Journal", format: "YYYY-MM-DD" });
    expect(await resolve()).toMatchObject({ folder: "Journal", format: "YYYY-MM-DD" });
  });
});
