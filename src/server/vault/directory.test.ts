import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// One level, ls-style. The folder rows are the point: a folder's time is the
// newest thing beneath it, read from the index, and it says so when the
// index has nothing to offer.

let root: string;
let vault: string;

const T = (n: number) => Date.UTC(2026, 0, 1, 12, 0, n);
const iso = (n: number) => `2026-01-01T12:00:${String(n).padStart(2, "0")}+00:00`;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "notemesh-directory-")));
  vault = path.join(root, "vault");
  fs.mkdirSync(vault, { recursive: true });
  process.env.DATA_DIR = root;
  process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

function plant(rel: string, size: number, at: number) {
  const abs = path.join(vault, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "x".repeat(size));
  fs.utimesSync(abs, at / 1000, at / 1000);
}

/** Plant and index, the way the watcher would have by the time anyone lists. */
async function indexed(rel: string, size: number, at: number) {
  plant(rel, size, at);
  const { reindexPath } = await import("./indexer");
  reindexPath(rel);
}

describe("listDirectory", () => {
  it("lists one level: files and folders, with the folder's time being the newest beneath", async () => {
    await indexed("Projects/A/x.md", 10, T(1));
    await indexed("Projects/A/deep/y.md", 20, T(3));
    await indexed("Projects/B/img.png", 30, T(2));
    await indexed("Projects/top.md", 5, T(4));
    const { listDirectory } = await import("./directory");

    expect(listDirectory("Projects")).toEqual([
      { name: "A", path: "Projects/A", kind: "folder", modified: iso(3), size: 30 },
      { name: "B", path: "Projects/B", kind: "folder", modified: iso(2), size: 30 },
      { name: "top.md", path: "Projects/top.md", kind: "file", modified: iso(4), size: 5 },
    ]);
    // From the root the same folder carries the newest of everything under it.
    expect(listDirectory()).toEqual([
      { name: "Projects", path: "Projects", kind: "folder", modified: iso(4), size: 65 },
    ]);
  });

  it("matches a folder by its whole name, not as a prefix of a sibling", async () => {
    await indexed("A/old.md", 1, T(1));
    await indexed("AB/new.md", 1, T(9));
    const { listDirectory } = await import("./directory");
    const byName = Object.fromEntries(listDirectory().map((e) => [e.name, e.modified]));
    expect(byName).toEqual({ A: iso(1), AB: iso(9) });
  });

  it("falls back to the folder's own mtime, and says so, when nothing beneath it is indexed", async () => {
    plant("Empty/.keep", 0, T(1));
    fs.utimesSync(path.join(vault, "Empty"), T(5) / 1000, T(5) / 1000);
    // Planted but never indexed: what a folder looks like before the boot
    // rebuild reaches it.
    plant("Fresh/note.md", 1, T(2));
    fs.utimesSync(path.join(vault, "Fresh"), T(6) / 1000, T(6) / 1000);
    // Indexed by a build before the column existed: a row with no time. The
    // size is still known.
    plant("Legacy/n.md", 7, T(2));
    fs.utimesSync(path.join(vault, "Legacy"), T(7) / 1000, T(7) / 1000);
    const { db } = await import("../db");
    db().exec("INSERT INTO notes (path, title, mtime, size) VALUES ('Legacy/n.md', 'n', 1, 7)");
    const { listDirectory } = await import("./directory");
    expect(listDirectory()).toEqual([
      { name: "Empty", path: "Empty", kind: "folder", modified: iso(5), size: 0, modifiedFrom: "folder" },
      { name: "Fresh", path: "Fresh", kind: "folder", modified: iso(6), size: 0, modifiedFrom: "folder" },
      { name: "Legacy", path: "Legacy", kind: "folder", modified: iso(7), size: 7, modifiedFrom: "folder" },
    ]);
  });

  it("a file's time is the same one list_notes gives it, and an over-cap note is marked", async () => {
    const { MAX_INDEX_BYTES } = await import("./paths");
    plant("small.md", 1, T(1));
    plant("huge.md", MAX_INDEX_BYTES + 1, T(2));
    plant("pic.png", 3, T(3));
    const { recordLocalModification } = await import("./modified");
    recordLocalModification("small.md", T(8));
    const { listDirectory } = await import("./directory");
    expect(listDirectory()).toEqual([
      { name: "huge.md", path: "huge.md", kind: "file", modified: iso(2), size: MAX_INDEX_BYTES + 1, indexed: false },
      { name: "pic.png", path: "pic.png", kind: "file", modified: iso(3), size: 3 },
      { name: "small.md", path: "small.md", kind: "file", modified: iso(8), size: 1 },
    ]);
  });

  it("skips dotfiles and symlinks, and renders in the configured timezone", async () => {
    plant(".obsidian/app.json", 2, T(1));
    plant("real.md", 1, T(1));
    fs.symlinkSync(path.join(vault, "real.md"), path.join(vault, "link.md"));
    const { setSetting } = await import("../db");
    setSetting("timezone", "Pacific/Auckland");
    const { listDirectory } = await import("./directory");
    expect(listDirectory().map((e) => [e.name, e.modified])).toEqual([["real.md", "2026-01-02T01:00:01+13:00"]]);
  });

  it("refuses a folder that is not there, or is a file, or leaves the vault", async () => {
    plant("note.md", 1, T(1));
    const { listDirectory } = await import("./directory");
    expect(() => listDirectory("Nope")).toThrow(/Folder not found/);
    expect(() => listDirectory("note.md")).toThrow(/Not a folder/);
    expect(() => listDirectory("../")).toThrow();
  });
});
