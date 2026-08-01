import path from "node:path";
import fs from "node:fs";
import { env } from "../env";

export class VaultPathError extends Error {}

// Largest note we will read into memory. Vault content is synced from other
// devices and must be treated as untrusted; an oversized file would otherwise
// OOM the process (OWASP A10). 10 MiB is far above any real markdown note.
export const MAX_NOTE_BYTES = 10 * 1024 * 1024;

// Read a vault file with a hard size cap. The path must already be resolved
// via resolveNotePath (which rejects symlinks and traversal). We re-lstat here
// so a file that grew, or a symlink swapped in after resolution, is still
// rejected rather than followed (TOCTOU hardening).
export function readVaultFile(abs: string): string {
  const st = fs.lstatSync(abs);
  if (st.isSymbolicLink()) throw new VaultPathError("Symlinks are not accessible");
  if (!st.isFile()) throw new VaultPathError("Not a file");
  if (st.size > MAX_NOTE_BYTES) {
    throw new VaultPathError(
      `Note is too large to read (${Math.round(st.size / 1024 / 1024)} MB; limit ${MAX_NOTE_BYTES / 1024 / 1024} MB)`,
    );
  }
  if (isBinaryFile(abs)) {
    throw new VaultPathError(
      `This is a binary attachment (${formatBytes(st.size)}), not readable as text. ` +
        `Use read_attachment for images and other binary files.`,
    );
  }
  return fs.readFileSync(abs, "utf8");
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Sniff the head of the file for NUL bytes rather than trusting the extension:
// reading a 4.6 MB JPEG as UTF-8 produced a 12 MB response of replacement
// characters (JSON escaping inflates it ~2.6x), which is useless to a client
// and can blow its entire context in one call.
export function isBinaryFile(abs: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(abs, "r");
    const buf = Buffer.alloc(8192);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    for (let i = 0; i < read; i++) if (buf[i] === 0) return true;
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Reject control characters (incl. NUL) and Unicode bidi overrides in a path.
// These enable filename spoofing and, for control chars, odd fs behavior.
// Covers C0/C1 controls, LRM/RLM, and the LRE..RLO / LRI..PDI bidi formatters.
const CONTROL_OR_BIDI =
  /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

// Resolve a user/LLM-supplied note path to an absolute path inside the vault.
// Rejects traversal, absolute paths, and the .obsidian config directory.
// Appends .md when no extension is given.
export function resolveNotePath(notePath: string, opts: { allowMissingExt?: boolean } = {}): string {
  // Normalize to NFC so client input and on-disk (often NFD on macOS) names
  // compare and round-trip consistently.
  let p = notePath.normalize("NFC").trim().replace(/\\/g, "/");
  if (!p) throw new VaultPathError("Empty path");
  if (CONTROL_OR_BIDI.test(p)) {
    throw new VaultPathError("Path contains control or bidirectional-override characters");
  }
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
  return path.relative(env.vaultDir, abs).replace(/\\/g, "/").normalize("NFC");
}

// True only if `abs` is inside the vault and no path component is a symlink.
// Used by the indexer to backstop chokidar (which may hand us symlinked paths).
export function isSafeVaultPath(abs: string): boolean {
  const rel = path.relative(env.vaultDir, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  if (rel.split(path.sep).some((s) => s.startsWith(".") && s !== ".")) return false;
  let cur = abs;
  while (cur !== env.vaultDir) {
    try {
      if (fs.lstatSync(cur).isSymbolicLink()) return false;
    } catch {
      // Component doesn't exist yet — fine for a not-yet-written file.
    }
    cur = path.dirname(cur);
  }
  return true;
}

// Folder variant (no extension appending).
export function resolveFolderPath(folder: string): string {
  return resolveNotePath(folder === "" || folder === "/" ? "." : folder, { allowMissingExt: true });
}
