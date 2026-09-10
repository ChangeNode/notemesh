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

describe("a daily note created from the template", () => {
  function template(content: string) {
    const dir = path.join(root, "vault", "Templates");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "Daily.md"), content);
  }
  const read = (rel: string) => fs.readFileSync(path.join(root, "vault", rel), "utf8");

  it("fills title, date and time the way Obsidian does, and the template path needs no .md", async () => {
    writeVaultConfig({ folder: "Daily", format: "YYYY-MM-DD", template: "Templates/Daily" });
    template("# {{title}}\n\n{{date:dddd, MMMM D}} at {{ time }}, {{date}} {{time:h A}}\n\n## Log\n");
    const { dailyAppend } = await import("./daily");
    dailyAppend("- first", "2026-09-08");
    const note = read("Daily/2026-09-08.md");
    expect(note).toMatch(/^# 2026-09-08\n\nTuesday, September 8 at \d\d:\d\d, 2026-09-08 \d{1,2} (AM|PM)\n\n## Log\n\n- first\n$/);
  });

  it("creates an empty note when the template is missing or unreadable, rather than refusing", async () => {
    writeVaultConfig({ folder: "Daily", template: "Templates/Nope" });
    const { dailyAppend } = await import("./daily");
    dailyAppend("- x", "2026-09-08");
    expect(read("Daily/2026-09-08.md")).toBe("- x\n");
  });

  it("does not touch a daily note that already exists", async () => {
    writeVaultConfig({ folder: "Daily", template: "Templates/Daily" });
    template("# {{title}}\n");
    fs.mkdirSync(path.join(root, "vault", "Daily"), { recursive: true });
    fs.writeFileSync(path.join(root, "vault", "Daily", "2026-09-08.md"), "existing\n");
    const { dailyAppend } = await import("./daily");
    dailyAppend("- more", "2026-09-08");
    expect(read("Daily/2026-09-08.md")).toBe("existing\n\n- more\n");
  });

  it("without a template setting the note starts empty, as before", async () => {
    writeVaultConfig({ folder: "Daily" });
    const { dailyAppend } = await import("./daily");
    dailyAppend("- x", "2026-09-08");
    expect(read("Daily/2026-09-08.md")).toBe("- x\n");
  });
});

describe("formatTime", () => {
  it("covers the moment tokens a template uses", async () => {
    const { formatTime } = await import("./daily");
    expect(formatTime({ hour: 0, minute: 5, second: 9 }, "HH:mm:ss h A a H m s hh")).toBe("00:05:09 12 AM am 0 5 9 12");
    expect(formatTime({ hour: 13, minute: 30, second: 0 }, "h:mm a")).toBe("1:30 pm");
  });
});

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
