import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db } from "../db";
import { env } from "../env";
import { VaultPathError, assertDescriptorInVault, formatBytes, toVaultRelative } from "./paths";
import { recordLocalModification } from "./modified";

/**
 * How much room the vault has left, and what is using it.
 *
 * The volume is the hard ceiling on a deployment: Railway does not grow one
 * automatically, and a full one does not fail gracefully — writes return ENOSPC
 * and the service sits wedged until someone intervenes. Growing early is free;
 * growing a volume that has already hit 100% forces an offline resize. So the
 * number worth showing is how close it is, while there is still a cheap fix.
 *
 * Filesystem figures come from statfs rather than by walking anything, and the
 * breakdown comes from the index, which already records the size of every note
 * and attachment it has seen. Neither costs a directory walk, so this is safe
 * to put on a page that polls.
 */

export interface DiskStatus {
  /** Null when the platform will not answer — the page then shows only the breakdown. */
  filesystem: {
    totalBytes: number;
    availableBytes: number;
    usedBytes: number;
    percentUsed: number;
    /**
     * True when the data directory sits on the root filesystem rather than its
     * own volume. The figures then describe the whole machine, which is the
     * normal case in local development and would otherwise read as a very
     * roomy vault.
     */
    sharedWithRoot: boolean;
    /** ok, warn under DISK_WARN_BYTES available, critical under DISK_CRITICAL_BYTES. */
    level: DiskLevel;
  } | null;
  /** What this deployment accounts for, from the index and the database file. */
  vaultBytes: number;
  databaseBytes: number;
  noteCount: number;
  attachmentCount: number;
}

function filesystemStatus(): DiskStatus["filesystem"] {
  try {
    const s = fs.statfsSync(env.dataDir);
    const totalBytes = s.blocks * s.bsize;
    // bavail, not bfree: the space an unprivileged process can actually use.
    // Filesystems reserve a slice for root, and counting it would promise
    // headroom the server cannot spend.
    const availableBytes = s.bavail * s.bsize;
    const usedBytes = (s.blocks - s.bfree) * s.bsize;
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;

    let sharedWithRoot = false;
    try {
      const rootFs = fs.statfsSync("/");
      sharedWithRoot = rootFs.blocks === s.blocks && rootFs.bsize === s.bsize;
    } catch {
      // Cannot tell; assume a dedicated volume rather than caveat wrongly.
    }

    return {
      totalBytes,
      availableBytes,
      usedBytes,
      percentUsed: Math.round((usedBytes / totalBytes) * 100),
      sharedWithRoot,
      level: diskLevel(availableBytes),
    };
  } catch {
    // statfs is not available everywhere, and a missing figure is better than
    // a wrong one — the caller renders the breakdown alone.
    return null;
  }
}

// What the index costs on disk. The write-ahead log is part of it, and on a
// busy vault it is not a rounding error.
function databaseBytesOnDisk(): number {
  let bytes = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      bytes += fs.statSync(`${env.dbPath}${suffix}`).size;
    } catch {
      // Not present — nothing to add.
    }
  }
  return bytes;
}

export function diskStatus(): DiskStatus {
  const d = db();
  const sum = (table: string) =>
    (d.prepare(`SELECT COALESCE(SUM(size), 0) AS n FROM ${table}`).get() as { n: number }).n;
  const count = (table: string) =>
    (d.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const databaseBytes = databaseBytesOnDisk();

  return {
    filesystem: filesystemStatus(),
    vaultBytes: sum("notes") + sum("attachments"),
    databaseBytes,
    noteCount: count("notes"),
    attachmentCount: count("attachments"),
  };
}

// ---- Headroom: the thresholds, the write guard, and the watcher ------------

/**
 * Thresholds on available bytes, absolute rather than a fraction of the
 * volume. This is a markdown vault: 100 MB is a great many notes, and a
 * percentage reads wrong at both ends — 10% of a 0.5 GB Free volume is
 * 50 MB, 10% of a 50 GB Pro one is more than most vaults. Decimal, as disks
 * are sold. Overrides are #47, not done until someone asks.
 */
export const DISK_WARN_BYTES = 100 * 1000 * 1000;
export const DISK_CRITICAL_BYTES = 50 * 1000 * 1000;

export type DiskLevel = "ok" | "warn" | "critical";

export function diskLevel(availableBytes: number): DiskLevel {
  if (availableBytes < DISK_CRITICAL_BYTES) return "critical";
  if (availableBytes < DISK_WARN_BYTES) return "warn";
  return "ok";
}

/** The filesystem half alone — two statfs calls, no SQL — for the write path and get_vault_info. */
export function headroom(): DiskStatus["filesystem"] {
  return filesystemStatus();
}

/**
 * What a write must leave behind: the critical threshold, or the index
 * database if that is larger. SQLite needs room to rewrite itself, and a
 * vault whose notes fit but whose index cannot checkpoint is wedged too.
 */
export function reserveBytes(): number {
  return Math.max(DISK_CRITICAL_BYTES, databaseBytesOnDisk());
}

function where(f: NonNullable<DiskStatus["filesystem"]>): string {
  return f.sharedWithRoot ? "The disk holding the data directory" : "The server's data volume";
}

const GROW =
  "Grow the Railway volume now — the resize is live while the volume is not yet full — or remove attachments from the vault.";

/**
 * Refuse a write that would not leave the reserve. Checked before the write
 * rather than after: ENOSPC arrives from whichever write happens to cross the
 * line, which may be the index's rather than the caller's, and a refused
 * write costs nothing to retry once the volume is grown.
 */
export function assertHeadroom(bytes: number): void {
  const f = filesystemStatus();
  // The platform will not say; let the write try, and a full disk is
  // translated when it answers.
  if (!f) return;
  const reserve = reserveBytes();
  if (f.availableBytes - bytes < reserve) {
    throw new VaultPathError(
      `${where(f)} has ${formatBytes(f.availableBytes)} free; writing ${formatBytes(bytes)} would leave less than ` +
        `the ${formatBytes(reserve)} the index needs to keep working. ${GROW}`,
    );
  }
}

/** True for the errors a full disk produces, from the filesystem or from SQLite. */
export function isDiskFull(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === "ENOSPC" || code === "SQLITE_FULL") return true;
  const message = e instanceof Error ? e.message : "";
  return /\bENOSPC\b|database or disk is full/i.test(message);
}

export function diskFullMessage(): string {
  return `The server's data volume is full, so the write failed. ${GROW} At 100% the resize goes offline and restarts the service.`;
}

/**
 * The one way vault content is written. Every note write goes through here so
 * the guard and the translation cannot be forgotten at a new call site; a test
 * scans the vault sources for a raw writeFileSync.
 */
export interface WriteOptions {
  /**
   * Sync the file and its directory before returning (the default). A batch
   * rewriting a thousand notes passes false: each note is still old-or-new,
   * and a thousand fsyncs turned a 74 ms rewrite into twelve seconds.
   */
  sync?: boolean;
}

export function writeVaultFile(abs: string, content: string, opts: WriteOptions = {}): void {
  const bytes = Buffer.from(content, "utf8");
  assertHeadroom(bytes.length);
  const sync = opts.sync !== false;

  // The note is never opened for writing. It used to be, with O_TRUNC: a
  // write that failed after the open — the disk full after all, an I/O
  // error, the process killed — left the note empty or half written. Now
  // the bytes go to a temporary file beside it, are synced, and are renamed
  // over it: the note is the old version or the new one, never anything
  // else. The directory is synced after so the rename itself survives a
  // crash. rename replaces a symlink rather than following one, so the
  // swap-in case (#57) cannot write through a link; it is refused outright
  // when seen, as before.
  const existing = lstatOrNull(abs);
  if (existing?.isSymbolicLink()) throw new VaultPathError("Symlinks are not accessible");
  const mode = existing?.isFile() ? existing.mode & 0o777 : 0o644;
  const dir = path.dirname(abs);
  const temp = path.join(dir, `.${path.basename(abs)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);

  let fd: number;
  try {
    fd = fs.openSync(
      temp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      mode,
    );
  } catch (e) {
    if (isDiskFull(e)) throw new VaultPathError(diskFullMessage());
    throw e;
  }
  try {
    // Where the descriptor landed: a directory above swapped for a symlink
    // would have put the temporary file outside the vault (paths.ts).
    assertDescriptorInVault(fd);
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (sync) fs.fsyncSync(fd);
  } catch (e) {
    fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
    if (isDiskFull(e)) throw new VaultPathError(diskFullMessage());
    throw e;
  }
  fs.closeSync(fd);

  if (lstatOrNull(abs)?.isSymbolicLink()) {
    fs.rmSync(temp, { force: true });
    throw new VaultPathError("Symlinks are not accessible");
  }
  try {
    fs.renameSync(temp, abs);
  } catch (e) {
    fs.rmSync(temp, { force: true });
    throw e;
  }
  if (sync) fsyncDirectory(dir);
  // Written, so this is its modification time from here on, whatever git
  // remembers about the path from before (vault/modified.ts).
  recordLocalModification(toVaultRelative(abs));
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/** The rename is durable only once the directory entry is: sync it, where the platform allows. */
function fsyncDirectory(dir: string): void {
  let fd: number;
  try {
    fd = fs.openSync(dir, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
  } catch {
    return;
  }
  try {
    fs.fsyncSync(fd);
  } catch {
    // Some filesystems refuse fsync on a directory; the rename still happened.
  } finally {
    fs.closeSync(fd);
  }
}

// The watcher. A level is logged when it changes, not every minute, so the
// log tail on the Status tab says when the volume crossed a line rather than
// filling with the same warning. #7 will carry the level to the assistant.
export const DISK_CHECK_MS = 60_000;
let lastLevel: DiskLevel | null = null;
let watchTimer: ReturnType<typeof setInterval> | null = null;

/** The level the last check saw; null before the first, or when the platform cannot say. */
export function lastDiskLevel(): DiskLevel | null {
  return lastLevel;
}

export function checkDisk(): DiskLevel | null {
  const f = filesystemStatus();
  const level = f ? f.level : null;
  if (f && level !== lastLevel) {
    const free = `${formatBytes(f.availableBytes)} free`;
    if (level === "critical") {
      console.error(
        `[disk] ${where(f)} has ${free}: critical. Writes that would not leave the reserve are refused. ${GROW}`,
      );
    } else if (level === "warn") {
      console.warn(`[disk] ${where(f)} has ${free}: low. ${GROW}`);
    } else if (lastLevel !== null) {
      console.log(`[disk] ${where(f)} has ${free}: back above the warning line.`);
    }
  }
  lastLevel = level;
  return level;
}

export function ensureDiskWatched(): void {
  if (watchTimer) return;
  checkDisk();
  watchTimer = setInterval(checkDisk, DISK_CHECK_MS);
  // Never the reason the process stays up.
  watchTimer.unref();
}
