import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// unique_note and create_note follow the vault's own Obsidian settings when
// settings sync has delivered them, and Obsidian's defaults when it has not.
// The readers never throw: a broken settings file must not stop a note.

let root: string;
let vault: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "notemesh-unique-")));
  vault = path.join(root, "vault");
  fs.mkdirSync(vault, { recursive: true });
  process.env.DATA_DIR = root;
  process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 14).toString("base64");
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

function obsidianConfig(name: string, body: string) {
  const dir = path.join(vault, ".obsidian");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), body);
}
const put = (rel: string, content: string) => {
  const abs = path.join(vault, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};
const get = (rel: string) => fs.readFileSync(path.join(vault, rel), "utf8");

describe("readObsidianConfig", () => {
  it("answers null for a missing, unreadable, or non-object file, and the object otherwise", async () => {
    const { readObsidianConfig } = await import("./obsidian-config");
    expect(readObsidianConfig("app")).toBeNull();
    obsidianConfig("app", "not json");
    expect(readObsidianConfig("app")).toBeNull();
    obsidianConfig("app", "[1, 2]");
    expect(readObsidianConfig("app")).toBeNull();
    obsidianConfig("app", '{"newFileLocation": "folder"}');
    expect(readObsidianConfig("app")).toEqual({ newFileLocation: "folder" });
  });
});

describe("the default location for new notes", () => {
  it("is the root without app.json, and Obsidian's folder when it names one", async () => {
    const { resolveNewNoteLocation, placeNewNote } = await import("./obsidian-config");
    expect(resolveNewNoteLocation()).toEqual({ folder: "", source: "default" });
    expect(placeNewNote("Idea.md")).toBe("Idea.md");

    obsidianConfig("app", JSON.stringify({ newFileLocation: "folder", newFileFolderPath: "/Inbox/" }));
    expect(resolveNewNoteLocation()).toEqual({ folder: "Inbox", source: "vault" });
    expect(placeNewNote("Idea.md")).toBe("Inbox/Idea.md");
    // A path that names a folder is the caller's decision.
    expect(placeNewNote("Projects/Idea.md")).toBe("Projects/Idea.md");
    expect(placeNewNote("Projects\\Idea.md")).toBe("Projects\\Idea.md");
  });

  it("treats 'current' and 'root', and a folder setting with no path, as the root", async () => {
    const { resolveNewNoteLocation } = await import("./obsidian-config");
    // Obsidian keeps the folder path even when the location is "current"; only "folder" uses it.
    obsidianConfig("app", JSON.stringify({ newFileLocation: "current", newFileFolderPath: "Inbox" }));
    expect(resolveNewNoteLocation()).toEqual({ folder: "", source: "vault" });
    obsidianConfig("app", JSON.stringify({ newFileLocation: "root" }));
    expect(resolveNewNoteLocation()).toEqual({ folder: "", source: "vault" });
    obsidianConfig("app", JSON.stringify({ newFileLocation: "folder", newFileFolderPath: "" }));
    expect(resolveNewNoteLocation()).toEqual({ folder: "", source: "vault" });
  });
});

describe("uniqueNote", () => {
  it("is YYYYMMDDHHmm at the root without settings, as before", async () => {
    const { uniqueNote, resolveUniqueConfig } = await import("./unique");
    expect(resolveUniqueConfig()).toEqual({ folder: "", format: "YYYYMMDDHHmm", template: undefined, vaultConfigFound: false });
    const rel = uniqueNote("hello");
    expect(rel).toMatch(/^\d{12}\.md$/);
    expect(get(rel)).toBe("hello");
  });

  it("follows zk-prefixer.json for the folder, the format with time tokens and literals, and the template", async () => {
    obsidianConfig("zk-prefixer", JSON.stringify({ folder: "Zettel/", format: "[Z] YYYY-MM-DD HHmm", template: "Templates/Zettel" }));
    obsidianConfig("templates", JSON.stringify({ dateFormat: "D MMMM YYYY", timeFormat: "h:mm A" }));
    put("Templates/Zettel.md", "# {{title}}\n\nMade {{date}} at {{time}}.\n");
    const { uniqueNote } = await import("./unique");
    const rel = uniqueNote("first thought");
    expect(rel).toMatch(/^Zettel\/Z \d{4}-\d{2}-\d{2} \d{4}\.md$/);
    const stamp = rel.slice("Zettel/".length, -".md".length);
    expect(get(rel)).toMatch(
      new RegExp(`^# ${stamp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n\\nMade \\d{1,2} [A-Z][a-z]+ \\d{4} at \\d{1,2}:\\d{2} (AM|PM)\\.\\n\\nfirst thought$`),
    );
  });

  it("creates an empty note from a missing template, and a second note in the same minute gets a suffix", async () => {
    obsidianConfig("zk-prefixer", JSON.stringify({ folder: "Zettel", template: "Templates/Nope" }));
    const { uniqueNote } = await import("./unique");
    const first = uniqueNote();
    expect(first).toMatch(/^Zettel\/\d{12}\.md$/);
    expect(get(first)).toBe("");
    const second = uniqueNote();
    expect(second).toMatch(/^Zettel\/\d{12}-[0-9a-f]{4}\.md$/);
  });
});

describe("formatMoment", () => {
  it("renders date and time tokens in one pass, with bracketed text literal", async () => {
    const { formatMoment } = await import("./daily");
    const d = { year: 2026, month: 9, day: 8, weekday: 2 };
    const t = { hour: 14, minute: 5, second: 9 };
    expect(formatMoment(d, t, "YYYYMMDDHHmm")).toBe("202609081405");
    expect(formatMoment(d, t, "YYYY-MM-DD HH:mm:ss")).toBe("2026-09-08 14:05:09");
    expect(formatMoment(d, t, "dddd D MMMM YYYY h:mm a")).toBe("Tuesday 8 September 2026 2:05 pm");
    // A month's M is not read again as a minute, and brackets are literal.
    expect(formatMoment(d, t, "[Minute] m [of] M")).toBe("Minute 5 of 9");
    expect(formatMoment(d, t, "[YYYY]-YY")).toBe("YYYY-26");
  });
});
