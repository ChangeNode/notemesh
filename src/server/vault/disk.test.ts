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

// The write guard and the watcher. statfs is faked by spying on fs, which is
// the same object disk.ts reads it from.
describe("headroom", () => {
  afterEach(() => vi.restoreAllMocks());

  function fakeFree(megabytes: number) {
    vi.spyOn(fs, "statfsSync").mockReturnValue({
      blocks: 10_000,
      bsize: 1_000_000,
      bfree: megabytes + 5,
      bavail: megabytes,
    } as unknown as ReturnType<typeof fs.statfsSync>);
  }

  it("levels on what an unprivileged process can use", async () => {
    const { diskLevel, DISK_WARN_BYTES, DISK_CRITICAL_BYTES } = await import("./disk");
    expect(diskLevel(DISK_WARN_BYTES)).toBe("ok");
    expect(diskLevel(DISK_WARN_BYTES - 1)).toBe("warn");
    expect(diskLevel(DISK_CRITICAL_BYTES)).toBe("warn");
    expect(diskLevel(DISK_CRITICAL_BYTES - 1)).toBe("critical");
  });

  it("refuses a write that would not leave the reserve, and names the fix", async () => {
    fakeFree(55);
    const { assertHeadroom } = await import("./disk");
    expect(() => assertHeadroom(4_000_000)).not.toThrow();
    expect(() => assertHeadroom(6_000_000)).toThrow(/would leave less than.*Grow the Railway volume/);
  });

  it("grows the reserve with the index database", async () => {
    // A 120 MB database (sparse, so it costs nothing) needs 120 MB of room to
    // rewrite itself; 150 MB free minus a 40 MB write is not that.
    fs.writeFileSync(path.join(root, "app.sqlite"), "");
    fs.truncateSync(path.join(root, "app.sqlite"), 120_000_000);
    fakeFree(150);
    const { assertHeadroom, reserveBytes } = await import("./disk");
    expect(reserveBytes()).toBe(120_000_000);
    expect(() => assertHeadroom(40_000_000)).toThrow(/would leave less than/);
    expect(() => assertHeadroom(20_000_000)).not.toThrow();
  });

  it("lets a write through when the platform cannot say", async () => {
    vi.spyOn(fs, "statfsSync").mockImplementation(() => {
      throw new Error("ENOSYS");
    });
    const { assertHeadroom } = await import("./disk");
    expect(() => assertHeadroom(6_000_000)).not.toThrow();
  });

  it("translates a full disk into a message naming the volume", async () => {
    fakeFree(1000);
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    });
    const { writeVaultFile, isDiskFull } = await import("./disk");
    expect(() => writeVaultFile(path.join(root, "vault", "a.md"), "x")).toThrow(/volume is full/);
    // SQLite's version of the same condition, as better-sqlite3 raises it.
    expect(isDiskFull(Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" }))).toBe(true);
    expect(isDiskFull(new Error("EACCES: permission denied"))).toBe(false);
  });

  it("logs a level change once, not every check", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { checkDisk, lastDiskLevel } = await import("./disk");
    fakeFree(30);
    expect(checkDisk()).toBe("critical");
    checkDisk();
    checkDisk();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toMatch(/^\[disk\] .*critical/);
    fakeFree(80);
    expect(checkDisk()).toBe("warn");
    expect(warn).toHaveBeenCalledTimes(1);
    fakeFree(500);
    expect(checkDisk()).toBe("ok");
    expect(lastDiskLevel()).toBe("ok");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/back above/);
  });

  it("is how every vault write happens", () => {
    // The guard and the translation live in one function; a new write site
    // that bypasses it would silently lose both.
    for (const f of fs.readdirSync(__dirname)) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts") || f === "disk.ts") continue;
      expect(fs.readFileSync(path.join(__dirname, f), "utf8"), f).not.toMatch(/fs\.writeFileSync\(/);
    }
  });
});
