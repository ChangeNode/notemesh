import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// "Modified" as a person means it. The git-backend suite proves the number
// comes from git after a pull; this proves the pieces: the log parser, the
// merge rule between git's time and a tool's own write, the index update,
// the additive column, and the ISO rendering in the configured zone.

let root: string;
let vault: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "notemesh-modified-")));
  vault = path.join(root, "vault");
  fs.mkdirSync(vault, { recursive: true });
  process.env.DATA_DIR = root;
  process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 9).toString("base64");
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const NUL = "\0";
const INSTANT = Date.UTC(2026, 0, 15, 3, 30, 5); // 2026-01-15T03:30:05Z

describe("parseGitHistory", () => {
  it("takes the oldest commit for each path as created and the newest as modified", async () => {
    const { parseGitHistory } = await import("./modified");
    const text = `${NUL}1700000000\nA.md\n\n${NUL}1650000000\nA.md\nB.md\n\n${NUL}1600000000\nA.md\n`;
    expect(parseGitHistory(text)).toEqual({
      modified: new Map([
        ["A.md", 1700000000000],
        ["B.md", 1650000000000],
      ]),
      created: new Map([
        ["A.md", 1600000000000],
        ["B.md", 1650000000000],
      ]),
    });
  });
});

describe("parseGitLog", () => {
  it("takes the first commit listed for a path, since the log is newest first", async () => {
    const { parseGitLog } = await import("./modified");
    const text = `${NUL}1700000000\nA.md\nB.md\n\n${NUL}1600000000\nA.md\nC.md\n`;
    expect(parseGitLog(text)).toEqual(
      new Map([
        ["A.md", 1700000000000],
        ["B.md", 1700000000000],
        ["C.md", 1600000000000],
      ]),
    );
  });

  it("a commit that lists no paths, like a merge, still moves the clock on", async () => {
    const { parseGitLog } = await import("./modified");
    const text = `${NUL}1700000000\n\n${NUL}1600000000\nA.md\n`;
    expect(parseGitLog(text)).toEqual(new Map([["A.md", 1600000000000]]));
  });

  it("a filename made only of digits is a path, not a header", async () => {
    const { parseGitLog } = await import("./modified");
    expect(parseGitLog(`${NUL}1700000000\n123\n`)).toEqual(new Map([["123", 1700000000000]]));
  });

  it("empty output is an empty map", async () => {
    const { parseGitLog } = await import("./modified");
    expect(parseGitLog("")).toEqual(new Map());
  });
});

describe("isoInZone", () => {
  it("renders the instant on the zone's own clock, with its offset", async () => {
    const { isoInZone } = await import("./modified");
    expect(isoInZone(INSTANT, "UTC")).toBe("2026-01-15T03:30:05+00:00");
    expect(isoInZone(INSTANT, "America/Los_Angeles")).toBe("2026-01-14T19:30:05-08:00");
    expect(isoInZone(INSTANT, "Pacific/Auckland")).toBe("2026-01-15T16:30:05+13:00");
    expect(isoInZone(INSTANT, "Asia/Kolkata")).toBe("2026-01-15T09:00:05+05:30");
  });

  it("follows daylight saving and writes midnight as 00", async () => {
    const { isoInZone } = await import("./modified");
    expect(isoInZone(Date.UTC(2026, 6, 4, 19, 0, 0), "America/Los_Angeles")).toBe("2026-07-04T12:00:00-07:00");
    expect(isoInZone(Date.UTC(2026, 5, 1, 0, 0, 0), "UTC")).toBe("2026-06-01T00:00:00+00:00");
  });
});

describe("modifiedFor", () => {
  it("falls back to the rounded mtime when nothing is recorded", async () => {
    const { modifiedFor } = await import("./modified");
    expect(modifiedFor("A.md", 1700000000000.6)).toBe(1700000000001);
  });

  it("a tool's own write beats the older commit git remembers, and a newer commit beats an older record", async () => {
    const { modifiedFor, recordLocalModification, applyGitTimes } = await import("./modified");
    recordLocalModification("A.md", 5000);
    applyGitTimes(new Map([["A.md", 4000]]));
    expect(modifiedFor("A.md", 1)).toBe(5000);

    recordLocalModification("B.md", 3000);
    applyGitTimes(new Map([["B.md", 4000]]));
    expect(modifiedFor("B.md", 1)).toBe(4000);
  });

  it("forgetting a path returns it to the mtime", async () => {
    const { modifiedFor, recordLocalModification, forgetModification } = await import("./modified");
    recordLocalModification("A.md", 5000);
    forgetModification("A.md");
    expect(modifiedFor("A.md", 1)).toBe(1);
  });
});

describe("createdFor", () => {
  const st = (birthtimeMs: number, mtimeMs: number) => ({ birthtimeMs, mtimeMs });

  it("uses git's first commit when there is one", async () => {
    const { createdFor, applyGitHistory } = await import("./modified");
    applyGitHistory({ modified: new Map([["A.md", 9000]]), created: new Map([["A.md", 4000]]) });
    expect(createdFor("A.md", st(8000, 9000))).toBe(4000);
  });

  it("falls back to the birthtime, and to the modified time where the filesystem has none", async () => {
    const { createdFor } = await import("./modified");
    expect(createdFor("B.md", st(3000.4, 9000))).toBe(3000);
    expect(createdFor("B.md", st(0, 9000.6))).toBe(9001);
  });

  it("is never later than modified", async () => {
    const { createdFor, recordLocalModification } = await import("./modified");
    // A copy made with its mtime preserved is born after it was last changed.
    expect(createdFor("C.md", st(9000, 5000))).toBe(5000);
    // A recorded time is the modified time, and caps created the same way.
    recordLocalModification("D.md", 2000);
    expect(createdFor("D.md", st(7000, 8000))).toBe(2000);
  });

  it("is forgotten with the path", async () => {
    const { createdFor, applyGitHistory, forgetModification } = await import("./modified");
    applyGitHistory({ modified: new Map(), created: new Map([["A.md", 4000]]) });
    forgetModification("A.md");
    expect(createdFor("A.md", st(8000, 9000))).toBe(8000);
  });
});

describe("createdFor across a rewrite", () => {
  it("keeps the created time the index holds when a write gives the file a new inode", async () => {
    const abs = path.join(vault, "A.md");
    fs.writeFileSync(abs, "one\n");
    fs.utimesSync(abs, INSTANT / 1000, INSTANT / 1000);
    const { reindexPath } = await import("./indexer");
    reindexPath("A.md");
    const { createdFor } = await import("./modified");
    const { writeVaultFile } = await import("./disk");
    const before = createdFor("A.md", fs.statSync(abs));
    expect(before).toBeLessThanOrEqual(INSTANT);
    writeVaultFile(abs, "two\n");
    // A different inode, born now; created is still what it was.
    expect(createdFor("A.md", fs.statSync(abs))).toBe(before);
  });
});

describe("applyGitHistory", () => {
  it("writes created into the index rows too, and counts them", async () => {
    const { db } = await import("../db");
    const { applyGitHistory } = await import("./modified");
    const d = db();
    d.exec(`
      INSERT INTO notes (path, title, mtime, size, modified, created) VALUES ('A.md', 'A', 1, 1, 1, 1);
      INSERT INTO attachments (path, mtime, size, modified, created) VALUES ('img.png', 1, 1, 1, 1);
    `);
    const history = { modified: new Map([["A.md", 7000]]), created: new Map([["A.md", 3000], ["img.png", 2000]]) };
    expect(applyGitHistory(history)).toBe(3);
    expect(d.prepare("SELECT modified, created FROM notes").all()).toEqual([{ modified: 7000, created: 3000 }]);
    expect(d.prepare("SELECT modified, created FROM attachments").all()).toEqual([{ modified: 1, created: 2000 }]);
    expect(applyGitHistory(history)).toBe(0);
  });
});

describe("applyGitTimes", () => {
  it("updates the index rows for notes and attachments and counts the ones that changed", async () => {
    const { db } = await import("../db");
    const { applyGitTimes } = await import("./modified");
    const d = db();
    d.exec(`
      INSERT INTO notes (path, title, mtime, size, modified) VALUES ('A.md', 'A', 1, 1, 1);
      INSERT INTO notes (path, title, mtime, size, modified) VALUES ('Z.md', 'Z', 1, 1, 999);
      INSERT INTO attachments (path, mtime, size, modified) VALUES ('img.png', 1, 1, 1);
    `);
    const map = new Map([
      ["A.md", 7000],
      ["img.png", 8000],
      ["Z.md", 999],
      ["gone.md", 1],
    ]);
    expect(applyGitTimes(map)).toBe(2);
    expect(d.prepare("SELECT path, modified FROM notes ORDER BY path").all()).toEqual([
      { path: "A.md", modified: 7000 },
      { path: "Z.md", modified: 999 },
    ]);
    expect(d.prepare("SELECT modified FROM attachments").all()).toEqual([{ modified: 8000 }]);
    // Same times again: nothing to do.
    expect(applyGitTimes(map)).toBe(0);
  });
});

describe("the modified column", () => {
  it("is added to a database created before it existed", async () => {
    const { env, ensureDataDirs } = await import("../env");
    ensureDataDirs();
    const old = new Database(env.dbPath);
    old.exec(`
      CREATE TABLE notes (path TEXT PRIMARY KEY, title TEXT NOT NULL, mtime INTEGER NOT NULL,
        size INTEGER NOT NULL, frontmatter TEXT, word_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE attachments (path TEXT PRIMARY KEY, mtime INTEGER NOT NULL, size INTEGER NOT NULL);
      INSERT INTO notes (path, title, mtime, size) VALUES ('A.md', 'A', 1, 1);
    `);
    old.close();

    const { db } = await import("../db");
    const d = db();
    const columns = (table: string) =>
      (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    expect(columns("notes")).toContain("modified");
    expect(columns("attachments")).toContain("modified");
    expect(columns("notes")).toContain("created");
    expect(columns("attachments")).toContain("created");
    // Existing rows survive with the column empty until the boot rebuild fills it.
    expect(d.prepare("SELECT path, modified FROM notes").all()).toEqual([{ path: "A.md", modified: null }]);
  });
});

describe("listings", () => {
  it("show the file's mtime in the configured timezone when nothing better is known", async () => {
    const { setSetting } = await import("../db");
    const { listNotes, listAttachments } = await import("./notes");
    setSetting("timezone", "Pacific/Auckland");
    for (const name of ["A.md", "img.png"]) {
      const abs = path.join(vault, name);
      fs.writeFileSync(abs, "x");
      fs.utimesSync(abs, INSTANT / 1000, INSTANT / 1000);
    }
    // Born just now, modified (per utimes) in January: created is clamped to modified.
    expect(listNotes()).toEqual([
      { path: "A.md", mtime: INSTANT, modified: "2026-01-15T16:30:05+13:00", created: "2026-01-15T16:30:05+13:00", size: 1 },
    ]);
    expect(listAttachments()).toEqual([
      { path: "img.png", mtime: INSTANT, modified: "2026-01-15T16:30:05+13:00", created: "2026-01-15T16:30:05+13:00", size: 1 },
    ]);
  });

  it("show the recorded time when there is one, and keep the mtime beside it", async () => {
    const { listNotes } = await import("./notes");
    const { recordLocalModification } = await import("./modified");
    const abs = path.join(vault, "A.md");
    fs.writeFileSync(abs, "x");
    fs.utimesSync(abs, INSTANT / 1000, INSTANT / 1000);
    recordLocalModification("A.md", Date.UTC(2026, 8, 5, 12, 0, 0));
    // created depends on the platform: Linux keeps the birthtime at "now",
    // clamped to the recorded time; macOS moved it back to the older mtime
    // when utimes set one. Either way it is not after modified.
    const [a] = listNotes();
    expect(a).toEqual({ path: "A.md", mtime: INSTANT, modified: "2026-09-05T12:00:00+00:00", created: expect.any(String), size: 1 });
    expect(Date.parse(a.created)).toBeLessThanOrEqual(Date.parse(a.modified));
  });

  it("a note a tool writes reports now, whatever git remembered", async () => {
    const { listNotes, createNote } = await import("./notes");
    const { applyGitTimes } = await import("./modified");
    applyGitTimes(new Map([["A.md", INSTANT]]));
    const before = Date.now();
    createNote("A.md", "x");
    const [a] = listNotes();
    expect(Date.parse(a.modified)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(a.modified)).not.toBe(INSTANT);
  });
});
