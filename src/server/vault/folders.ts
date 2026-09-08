import fs from "node:fs";
import path from "node:path";
import { env } from "../env";
import { VaultPathError, resolveFolderPath, toVaultRelative } from "./paths";
import { assertNoReservedSegments, isMarkdown } from "./notes";
import { rewriteLinksForMoves, type RewriteResult } from "./links";

/**
 * Folders. They come into being through create_note paths; these are the
 * two things that could not be done to one afterwards. There is no create:
 * git cannot store an empty folder, so one made here would not survive a
 * sync on that backend.
 */
export interface FolderMove {
  from: string;
  to: string;
  /** Every file that moved, old path to new, dotfiles included. */
  moved: Map<string, string>;
  /** The rewrite across the vault, sources reported at their current paths. */
  rewritten: RewriteResult;
}

function resolveExistingFolder(folder: string): string {
  const abs = resolveFolderPath(folder);
  if (!fs.existsSync(abs)) throw new VaultPathError(`Folder not found: ${folder}`);
  if (!fs.statSync(abs).isDirectory()) throw new VaultPathError(`Not a folder: ${folder}`);
  if (path.resolve(abs) === path.resolve(env.vaultDir)) throw new VaultPathError("The vault root cannot be moved or deleted");
  return abs;
}

function filesBeneath(dir: string, out: string[], depth = 0) {
  if (depth > 32) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) filesBeneath(abs, out, depth + 1);
    else if (entry.isFile()) out.push(abs);
  }
}

/**
 * Rename or move a folder, then fix every link to anything inside it the way
 * move_note does for one note. Callers reindex the old paths, the new ones
 * and the rewritten sources; the rewrite runs first, while the index still
 * knows who linked where.
 */
export function moveFolder(folder: string, newFolder: string): FolderMove {
  const absFrom = resolveExistingFolder(folder);
  const absTo = resolveFolderPath(newFolder);
  assertNoReservedSegments(absTo);
  if (fs.existsSync(absTo)) throw new VaultPathError(`Target already exists: ${toVaultRelative(absTo)}`);
  const fromRoot = path.resolve(absFrom) + path.sep;
  if ((path.resolve(absTo) + path.sep).startsWith(fromRoot)) {
    throw new VaultPathError(`Cannot move ${toVaultRelative(absFrom)} into itself`);
  }

  const files: string[] = [];
  filesBeneath(absFrom, files);
  const from = toVaultRelative(absFrom);
  const to = toVaultRelative(absTo);
  const moved = new Map<string, string>();
  for (const abs of files) {
    const rel = toVaultRelative(abs);
    moved.set(rel, `${to}/${rel.slice(from.length + 1)}`);
  }

  fs.mkdirSync(path.dirname(absTo), { recursive: true });
  fs.renameSync(absFrom, absTo);

  // Links to notes and to attachments alike: an embed written by path
  // breaks the same way a link does.
  const linkable = new Map<string, string>();
  for (const [a, b] of moved) {
    if (!path.basename(a).startsWith(".")) linkable.set(a, b);
  }
  const rewritten = rewriteLinksForMoves(linkable);
  return { from, to, moved, rewritten };
}

/** Removes an empty folder. Anything inside it is a reason to refuse. */
export function deleteFolder(folder: string): string {
  const abs = resolveExistingFolder(folder);
  const entries = fs.readdirSync(abs);
  if (entries.length > 0) {
    throw new VaultPathError(
      `${toVaultRelative(abs)} is not empty: ${entries.length} ${entries.length === 1 ? "entry" : "entries"}. ` +
        "delete_note removes a note; a folder goes when nothing is left in it.",
    );
  }
  fs.rmdirSync(abs);
  return toVaultRelative(abs);
}

export { isMarkdown };
