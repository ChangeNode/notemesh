import path from "node:path";
import fs from "node:fs";
import { env } from "../env";

export class VaultPathError extends Error {}

// Resolve a user/LLM-supplied note path to an absolute path inside the vault.
// Rejects traversal, absolute paths, and the .obsidian config directory.
// Appends .md when no extension is given.
export function resolveNotePath(notePath: string, opts: { allowMissingExt?: boolean } = {}): string {
  let p = notePath.trim().replace(/\\/g, "/");
  if (!p) throw new VaultPathError("Empty path");
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) {
    throw new VaultPathError("Path must be relative to the vault root");
  }
  if (!path.extname(p) && !opts.allowMissingExt) p += ".md";
  const abs = path.resolve(env.vaultDir, p);
  const rel = path.relative(env.vaultDir, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new VaultPathError("Path escapes the vault");
  }
  if (rel === ".obsidian" || rel.startsWith(".obsidian/") || rel.split("/").some((s) => s.startsWith(".") && s !== ".")) {
    throw new VaultPathError("Dot-directories (including .obsidian) are not accessible");
  }
  // No symlink escapes: check each existing ancestor.
  let cur = abs;
  while (cur !== env.vaultDir) {
    if (fs.existsSync(cur) && fs.lstatSync(cur).isSymbolicLink()) {
      throw new VaultPathError("Symlinks are not accessible");
    }
    cur = path.dirname(cur);
  }
  return abs;
}

export function toVaultRelative(abs: string): string {
  return path.relative(env.vaultDir, abs).replace(/\\/g, "/");
}

// Folder variant (no extension appending).
export function resolveFolderPath(folder: string): string {
  return resolveNotePath(folder === "" || folder === "/" ? "." : folder, { allowMissingExt: true });
}
