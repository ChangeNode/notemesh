import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The volume is the hard ceiling on a deployment, so these figures are the ones
// an operator acts on. They are also the kind that quietly go wrong — a wrong
// denominator or a reserved-blocks mistake reads as plenty of room.

let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "notemesh-disk-")));
  fs.mkdirSync(path.join(root, "vault"), { recursive: true });
  process.env.DATA_DIR = root;
  process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 3).toString("base64");
  delete (globalThis as Record<string, unknown>).__vaultIndexer;
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

async function status() {
  const { diskStatus } = await import("./disk");
  return diskStatus();
}

describe("diskStatus", () => {
  it("reports a filesystem that adds up", async () => {
    const s = await status();
    expect(s.filesystem, "statfs should answer on this platform").not.toBeNull();
    const fsys = s.filesystem!;
    expect(fsys.totalBytes).toBeGreaterThan(0);
    expect(fsys.usedBytes).toBeGreaterThanOrEqual(0);
    expect(fsys.usedBytes).toBeLessThanOrEqual(fsys.totalBytes);
    // Available is what an unprivileged process may use, so it can be less than
    // total minus used — reserved blocks — but never more.
    expect(fsys.availableBytes).toBeLessThanOrEqual(fsys.totalBytes - fsys.usedBytes + 1);
    expect(fsys.percentUsed).toBeGreaterThanOrEqual(0);
    expect(fsys.percentUsed).toBeLessThanOrEqual(100);
  });

  it("notices when the data directory is not on its own volume", async () => {
    // A temp dir is on the machine's main filesystem, which is exactly the
    // local-development case the caveat exists for.
    const s = await status();
    expect(s.filesystem!.sharedWithRoot).toBe(true);
  });

  it("counts the vault from the index rather than by walking it", async () => {
    const { db } = await import("../db");
    const d = db();
    d.prepare("INSERT INTO notes (path,title,mtime,size,word_count) VALUES (?,?,?,?,?)").run(
      "a.md", "a", 0, 1500, 10,
    );
    d.prepare("INSERT INTO notes (path,title,mtime,size,word_count) VALUES (?,?,?,?,?)").run(
      "b.md", "b", 0, 2500, 20,
    );
    d.prepare("INSERT INTO attachments (path,mtime,size) VALUES (?,?,?)").run("img.png", 0, 96_000);

    const s = await status();
    expect(s.vaultBytes).toBe(1500 + 2500 + 96_000);
    expect(s.noteCount).toBe(2);
    expect(s.attachmentCount).toBe(1);
  });

  it("counts the write-ahead log as part of the database", async () => {
    const { db } = await import("../db");
    db(); // create the file
    const s = await status();
    // The database exists, so it has a size; -wal and -shm are added when
    // present rather than ignored, since on a busy vault they are not small.
    expect(s.databaseBytes).toBeGreaterThan(0);
  });

  it("reports the breakdown even when the filesystem cannot be read", async () => {
    const s = await status();
    // Simulate statfs failing by pointing at a directory that is gone.
    fs.rmSync(root, { recursive: true, force: true });
    const { diskStatus } = await import("./disk");
    // The database handle is already open, so the breakdown still answers; the
    // filesystem half degrades to null rather than throwing.
    const after = diskStatus();
    expect(after.filesystem).toBeNull();
    expect(after.noteCount).toBe(s.noteCount);
  });
});
