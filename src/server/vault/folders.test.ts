import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let root: string;
let vault: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "notemesh-folders-")));
  vault = path.join(root, "vault");
  fs.mkdirSync(vault, { recursive: true });
  process.env.DATA_DIR = root;
  process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 6).toString("base64");
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

function put(rel: string, content: string | Buffer) {
  const abs = path.join(vault, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
const get = (rel: string) => fs.readFileSync(path.join(vault, rel), "utf8");
const exists = (rel: string) => fs.existsSync(path.join(vault, rel));

async function indexed(...rels: string[]) {
  const { reindexPath } = await import("./indexer");
  for (const rel of rels) reindexPath(rel);
}

/** What the tool does after moveFolder: reindex old, new and rewritten. */
async function move(from: string, to: string) {
  const { moveFolder } = await import("./folders");
  const { reindexPath } = await import("./indexer");
  const res = moveFolder(from, to);
  for (const [a, b] of res.moved) {
    reindexPath(a);
    reindexPath(b);
  }
  for (const rel of res.rewritten.notes) reindexPath(rel);
  return res;
}

describe("moveFolder", () => {
  it("moves everything beneath, rewrites path links from outside and inside, and leaves bare sibling links", async () => {
    put("Old/a.md", "sibling [[b]] and by path [[Old/b]] and ![[Old/pic.png]]\n");
    put("Old/deep/b.md", "x\n");
    put("Old/pic.png", Buffer.from([1, 2, 3]));
    put("Old/.hidden", "h\n");
    put("Src.md", "[[Old/a]] and [[Old/deep/b]] and bare [[a]]\n");
    await indexed("Old/a.md", "Old/deep/b.md", "Old/pic.png", "Src.md");

    const res = await move("Old", "Archive/New");
    expect(res.from).toBe("Old");
    expect(res.to).toBe("Archive/New");
    expect([...res.moved].sort()).toEqual([
      ["Old/.hidden", "Archive/New/.hidden"],
      ["Old/a.md", "Archive/New/a.md"],
      ["Old/deep/b.md", "Archive/New/deep/b.md"],
      ["Old/pic.png", "Archive/New/pic.png"],
    ]);
    expect(res.rewritten.links).toBe(4);
    expect(res.rewritten.notes.sort()).toEqual(["Archive/New/a.md", "Src.md"]);
    expect(exists("Old")).toBe(false);
    expect(get("Archive/New/.hidden")).toBe("h\n");
    // [[Old/b]] resolved by basename to deep/b.md, so it is rewritten to where that note really is.
    expect(get("Archive/New/a.md")).toBe("sibling [[b]] and by path [[Archive/New/deep/b]] and ![[Archive/New/pic.png]]\n");
    expect(get("Src.md")).toBe("[[Archive/New/a]] and [[Archive/New/deep/b]] and bare [[a]]\n");

    // The index has moved with it: nothing left under the old prefix, and
    // every link resolves.
    const { db } = await import("../db");
    const d = db();
    expect(d.prepare("SELECT COUNT(*) AS n FROM notes WHERE substr(path, 1, 4) = 'Old/'").get()).toEqual({ n: 0 });
    expect(d.prepare("SELECT COUNT(*) AS n FROM attachments WHERE substr(path, 1, 4) = 'Old/'").get()).toEqual({ n: 0 });
    // The attachment is an attachment at its new path, not a note of decoded bytes.
    expect(d.prepare("SELECT path FROM attachments WHERE path LIKE 'Archive/%'").all()).toEqual([{ path: "Archive/New/pic.png" }]);
    expect(d.prepare("SELECT COUNT(*) AS n FROM notes WHERE path LIKE '%.png'").get()).toEqual({ n: 0 });
    const { unresolvedLinks, backlinks } = await import("./queries");
    expect(unresolvedLinks()).toEqual([]);
    // One row per link; a.md links to b twice, by name and by path.
    expect([...new Set(backlinks("Archive/New/deep/b.md").map((b) => b.path))].sort()).toEqual(["Archive/New/a.md", "Src.md"]);
  });

  it("forgets the moved-from paths' recorded times, as moveNote does", async () => {
    put("Old/a.md", "x\n");
    const { recordLocalModification, modifiedFor } = await import("./modified");
    recordLocalModification("Old/a.md", 5000);
    const { moveFolder } = await import("./folders");
    moveFolder("Old", "New");
    expect(modifiedFor("Old/a.md", 1)).toBe(1);
  });

  it("refuses a missing folder, a file, the root, an existing target, a move into itself, and a reserved name", async () => {
    put("Old/a.md", "x\n");
    put("note.md", "x\n");
    put("Taken/x.md", "x\n");
    const { moveFolder } = await import("./folders");
    expect(() => moveFolder("Nope", "New")).toThrow(/Folder not found/);
    expect(() => moveFolder("note.md", "New")).toThrow(/Not a folder/);
    expect(() => moveFolder(".", "New")).toThrow(/vault root/);
    expect(() => moveFolder("Old", "Taken")).toThrow(/Target already exists/);
    expect(() => moveFolder("Old", "Old/inner")).toThrow(/into itself/);
    expect(() => moveFolder("Old", "CON/x")).toThrow(/Reserved name/);
    // A sibling whose name merely starts with the folder's is not "inside".
    expect(() => moveFolder("Old", "Older")).not.toThrow();
    expect(exists("Older/a.md")).toBe(true);
  });
});

describe("deleteFolder", () => {
  it("removes an empty folder and refuses one with anything in it, dotfiles included", async () => {
    const { deleteFolder } = await import("./folders");
    fs.mkdirSync(path.join(vault, "Empty"));
    expect(deleteFolder("Empty")).toBe("Empty");
    expect(exists("Empty")).toBe(false);

    put("Full/a.md", "x\n");
    put("Full/b.md", "x\n");
    expect(() => deleteFolder("Full")).toThrow(/Full is not empty: 2 entries/);
    put("Dot/.keep", "");
    expect(() => deleteFolder("Dot")).toThrow(/Dot is not empty: 1 entry/);
    expect(exists("Full/a.md")).toBe(true);
    expect(() => deleteFolder(".")).toThrow(/vault root/);
    expect(() => deleteFolder("Nope")).toThrow(/Folder not found/);
    expect(() => deleteFolder("Full/a.md")).toThrow(/Not a folder/);
  });
});
