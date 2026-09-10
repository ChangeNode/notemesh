import fs from "node:fs";
import path from "node:path";
import { env } from "../env";
import { db } from "../db";
import { VaultPathError, resolveFolderPath, toVaultRelative, MAX_INDEX_BYTES } from "./paths";
import { isMarkdown } from "./notes";
import { createdFor, isoInZone, modifiedFor } from "./modified";
import { configuredTimeZone } from "./timezone";

/**
 * One level of the vault, the way `ls -l` shows it: files and folders side by
 * side, each with a time and a size, so an assistant can browse rather than
 * pull the whole tree through list_notes.
 *
 * A folder has no time of its own that means anything, so it borrows the
 * newest modified time of anything beneath it, and its size is the bytes
 * beneath. Both come from the index in one query per table, grouped here by
 * the folder's first segment. A folder the index knows nothing under — empty,
 * holding only files over the index cap, or not yet indexed after boot —
 * falls back to its own mtime and says so with modifiedFrom: "folder".
 */
export interface DirectoryEntry {
  name: string;
  path: string;
  kind: "file" | "folder";
  /** ISO 8601 in the configured timezone; for a folder, the newest item beneath it. */
  modified: string;
  /** ISO 8601 in the configured timezone; for a folder, the oldest item beneath it. */
  created: string;
  /** Bytes; for a folder, the bytes of everything the index holds beneath it. */
  size: number;
  /** Present only when a folder's times are its own because nothing beneath it is indexed. */
  modifiedFrom?: "folder";
  /** Present, and false, only for a note over the index size cap. */
  indexed?: false;
}

interface Beneath {
  modified: number | null;
  created: number | null;
  size: number;
}

/** Newest and oldest times and total bytes the index holds under each immediate child of prefix. */
function beneathByChild(prefix: string): Map<string, Beneath> {
  const d = db();
  const rows = [
    ...(d
      .prepare("SELECT path, modified, created, size FROM notes WHERE substr(path, 1, ?) = ?")
      .all(prefix.length, prefix) as { path: string; modified: number | null; created: number | null; size: number }[]),
    ...(d
      .prepare("SELECT path, modified, created, size FROM attachments WHERE substr(path, 1, ?) = ?")
      .all(prefix.length, prefix) as { path: string; modified: number | null; created: number | null; size: number }[]),
  ];
  const out = new Map<string, Beneath>();
  for (const row of rows) {
    const rest = row.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash < 0) continue; // a file directly here, listed from disk instead
    const child = rest.slice(0, slash);
    const have = out.get(child) ?? { modified: null, created: null, size: 0 };
    have.size += row.size;
    if (row.modified !== null && (have.modified === null || row.modified > have.modified)) {
      have.modified = row.modified;
    }
    if (row.created !== null && (have.created === null || row.created < have.created)) {
      have.created = row.created;
    }
    out.set(child, have);
  }
  return out;
}

export function listDirectory(folder?: string): DirectoryEntry[] {
  const root = folder ? resolveFolderPath(folder) : env.vaultDir;
  if (!fs.existsSync(root)) throw new VaultPathError(`Folder not found: ${folder}`);
  if (!fs.statSync(root).isDirectory()) throw new VaultPathError(`Not a folder: ${folder}`);
  const relRoot = toVaultRelative(root);
  const prefix = relRoot === "" || relRoot === "." ? "" : `${relRoot}/`;
  const timeZone = configuredTimeZone();
  const beneath = beneathByChild(prefix);

  const out: DirectoryEntry[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
    const abs = path.join(root, entry.name);
    const rel = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      const under = beneath.get(entry.name);
      if (under?.modified != null) {
        out.push({
          name: entry.name,
          path: rel,
          kind: "folder",
          modified: isoInZone(under.modified, timeZone),
          created: isoInZone(Math.min(under.created ?? under.modified, under.modified), timeZone),
          size: under.size,
        });
      } else {
        const st = fs.statSync(abs);
        const mtime = Math.round(st.mtimeMs);
        out.push({
          name: entry.name,
          path: rel,
          kind: "folder",
          modified: isoInZone(mtime, timeZone),
          created: isoInZone(Math.min(st.birthtimeMs > 0 ? Math.round(st.birthtimeMs) : mtime, mtime), timeZone),
          size: under?.size ?? 0,
          modifiedFrom: "folder",
        });
      }
    } else if (entry.isFile()) {
      const st = fs.statSync(abs);
      const mtime = Math.round(st.mtimeMs);
      const info: DirectoryEntry = {
        name: entry.name,
        path: rel,
        kind: "file",
        modified: isoInZone(modifiedFor(rel, mtime), timeZone),
        created: isoInZone(createdFor(rel, st), timeZone),
        size: st.size,
      };
      if (isMarkdown(entry.name) && st.size > MAX_INDEX_BYTES) info.indexed = false;
      out.push(info);
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}
