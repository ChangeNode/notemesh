import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * How the index stores a note, as distinct from what it extracts.
 *
 * The FTS row is keyed by the note row's rowid. `path` is UNINDEXED in FTS5,
 * and FTS5 accelerates nothing but MATCH — an equality on any column scans the
 * whole virtual table, which the indexer used to do on every single write. The
 * rowid is a real key, and using it depends on two things this file pins: the
 * plan for a rowid delete really is a lookup, and the upsert really does keep
 * the rowid across re-indexes of the same path.
 */

let root: string;
let vault: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "notemesh-storage-")));
  vault = path.join(root, "vault");
  fs.mkdirSync(vault, { recursive: true });
  process.env.DATA_DIR = root;
  process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 5).toString("base64");
  delete (globalThis as Record<string, unknown>).__vaultIndexer;
  vi.resetModules();
});

afterEach(async () => {
  const live = (globalThis as Record<string, unknown>).__vaultIndexer as { stop?: () => Promise<void> } | undefined;
  await live?.stop?.();
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

function write(rel: string, content: string) {
  const abs = path.join(vault, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

async function load() {
  const { reindexPath } = await import("~/server/vault/indexer");
  const { db } = await import("~/server/db");
  const { searchVault } = await import("~/server/vault/queries");
  const d = db();
  const noteRowid = (rel: string) => (d.prepare("SELECT rowid FROM notes WHERE path = ?").get(rel) as { rowid: number } | undefined)?.rowid;
  const ftsRows = (rel: string) => d.prepare("SELECT rowid FROM notes_fts WHERE path = ?").all(rel) as { rowid: number }[];
  return { reindexPath, d, searchVault, noteRowid, ftsRows };
}

describe("FTS rows are keyed by the note's rowid", () => {
  it("deletes by rowid, which the plan shows as a lookup rather than a scan", async () => {
    const { d } = await load();
    const plan = (d.prepare("EXPLAIN QUERY PLAN DELETE FROM notes_fts WHERE rowid = ?").all(1) as { detail: string }[])
      .map((r) => r.detail)
      .join(" ");
    // `INDEX 0:=` is the rowid constraint; a bare `INDEX 0:` is a full scan.
    expect(plan).toMatch(/INDEX 0:=/);
    // And the indexer uses that form, not the scan. Read from the source, the
    // way catalog.test.ts reads server.ts: the statement is the thing under test.
    const src = fs.readFileSync("src/server/vault/indexer.ts", "utf8");
    expect(src).toContain("DELETE FROM notes_fts WHERE rowid = ?");
    expect(src).not.toContain("DELETE FROM notes_fts WHERE path = ?");
  });

  it("keeps one FTS row per note, sharing the note's rowid, across re-indexes", async () => {
    const { reindexPath, noteRowid, ftsRows } = await load();
    write("a.md", "# A\n\nzebra\n");
    reindexPath("a.md");
    const first = noteRowid("a.md")!;
    expect(first).toBeTypeOf("number");
    expect(ftsRows("a.md").map((r) => r.rowid)).toEqual([first]);

    // Edit and re-index. The upsert is ON CONFLICT DO UPDATE, which keeps the
    // rowid; INSERT OR REPLACE would not, and the FTS row would be orphaned.
    write("a.md", "# A\n\ngiraffe\n");
    reindexPath("a.md");
    expect(noteRowid("a.md"), "rowid must survive an upsert").toBe(first);
    expect(ftsRows("a.md").map((r) => r.rowid), "still exactly one FTS row, on the same key").toEqual([first]);
  });

  it("searches the edited content, not the old", async () => {
    const { reindexPath, searchVault } = await load();
    write("a.md", "# A\n\nzebra\n");
    reindexPath("a.md");
    expect(searchVault("zebra").hits.map((h) => h.path)).toEqual(["a.md"]);
    write("a.md", "# A\n\ngiraffe\n");
    reindexPath("a.md");
    expect(searchVault("zebra").hits).toEqual([]);
    expect(searchVault("giraffe").hits.map((h) => h.path)).toEqual(["a.md"]);
  });

  it("removes the FTS row with the note", async () => {
    const { reindexPath, ftsRows, noteRowid } = await load();
    write("a.md", "# A\n\nzebra\n");
    reindexPath("a.md");
    expect(ftsRows("a.md")).toHaveLength(1);
    fs.rmSync(path.join(vault, "a.md"));
    reindexPath("a.md");
    expect(noteRowid("a.md")).toBeUndefined();
    expect(ftsRows("a.md")).toEqual([]);
  });
});
