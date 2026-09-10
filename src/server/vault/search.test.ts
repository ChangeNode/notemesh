import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Narrowing and ordering search. The count and the page share one WHERE, so
// total describes the narrowed set; that is what lets hasMore stay honest.

let root: string;
let vault: string;

const T = (n: number) => Date.UTC(2026, 0, 1, 12, 0, n);
const iso = (n: number) => `2026-01-01T12:00:${String(n).padStart(2, "0")}+00:00`;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "notemesh-search-")));
  vault = path.join(root, "vault");
  fs.mkdirSync(vault, { recursive: true });
  process.env.DATA_DIR = root;
  process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 3).toString("base64");
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

async function seed() {
  const { reindexPath } = await import("./indexer");
  const plant = (rel: string, content: string, at: number) => {
    const abs = path.join(vault, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    fs.utimesSync(abs, at / 1000, at / 1000);
    reindexPath(rel);
  };
  // The oldest note says zebra the most, so relevance and recency disagree.
  plant("Work/old.md", "# Old\n\nzebra zebra zebra zebra\n", T(1));
  plant("Work/mid.md", "# Mid\n\nzebra\n", T(2));
  plant("Workshop/new.md", "# New\n\nzebra\n", T(3));
  plant("Home/other.md", "# Other\n\nlion\n", T(4));
  const { searchVault } = await import("./queries");
  return searchVault;
}

describe("searchVault", () => {
  it("carries each hit's modified time and ranks by relevance unless told otherwise", async () => {
    const searchVault = await seed();
    const page = searchVault("zebra");
    expect(page.total).toBe(3);
    expect(page.hits[0]).toMatchObject({ path: "Work/old.md", modified: iso(1) });
    expect(searchVault("zebra", { sort: "modified" }).hits.map((h) => h.path)).toEqual([
      "Workshop/new.md",
      "Work/mid.md",
      "Work/old.md",
    ]);
  });

  it("folder narrows to that folder, not to every folder sharing its prefix", async () => {
    const searchVault = await seed();
    const page = searchVault("zebra", { folder: "Work" });
    expect(page.total).toBe(2);
    expect(page.hits.map((h) => h.path).sort()).toEqual(["Work/mid.md", "Work/old.md"]);
    expect(() => searchVault("zebra", { folder: "Nope" })).toThrow(/Folder not found/);
  });

  it("modifiedAfter narrows strictly after the instant, in the configured zone, and total agrees", async () => {
    const searchVault = await seed();
    const { setSetting } = await import("../db");
    setSetting("timezone", "Pacific/Auckland");
    const page = searchVault("zebra", { modifiedAfter: iso(2), limit: 1 });
    expect(page.total).toBe(1);
    expect(page.hits.map((h) => h.path)).toEqual(["Workshop/new.md"]);
    // Auckland's 2026-01-02 began at 11:00Z on the 1st; all three are after it.
    expect(searchVault("zebra", { modifiedAfter: "2026-01-02" }).total).toBe(3);
    expect(searchVault("zebra", { modifiedAfter: "2026-01-03" }).total).toBe(0);
  });

  it("narrowing and paging compose: total is the narrowed count and pages follow the sort", async () => {
    const searchVault = await seed();
    const first = searchVault("zebra", { folder: "Work", sort: "modified", limit: 1 });
    expect(first.total).toBe(2);
    expect(first.hits.map((h) => h.path)).toEqual(["Work/mid.md"]);
    const second = searchVault("zebra", { folder: "Work", sort: "modified", limit: 1, offset: 1 });
    expect(second.hits.map((h) => h.path)).toEqual(["Work/old.md"]);
  });
});
