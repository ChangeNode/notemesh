import fs from "node:fs";
import { db } from "../db";
import { env } from "../env";

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
    };
  } catch {
    // statfs is not available everywhere, and a missing figure is better than
    // a wrong one — the caller renders the breakdown alone.
    return null;
  }
}

export function diskStatus(): DiskStatus {
  const d = db();
  const sum = (table: string) =>
    (d.prepare(`SELECT COALESCE(SUM(size), 0) AS n FROM ${table}`).get() as { n: number }).n;
  const count = (table: string) =>
    (d.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  let databaseBytes = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    // The write-ahead log is part of what the database costs on disk, and on a
    // busy vault it is not a rounding error.
    try {
      databaseBytes += fs.statSync(`${env.dbPath}${suffix}`).size;
    } catch {
      // Not present — nothing to add.
    }
  }

  return {
    filesystem: filesystemStatus(),
    vaultBytes: sum("notes") + sum("attachments"),
    databaseBytes,
    noteCount: count("notes"),
    attachmentCount: count("attachments"),
  };
}
