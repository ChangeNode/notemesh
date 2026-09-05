import path from "node:path";
import fs from "node:fs";
import { env } from "../env";

export class VaultPathError extends Error {}

// Largest note we will read into memory. Vault content is synced from other
// devices and must be treated as untrusted; an oversized file would otherwise
// OOM the process (OWASP A10). 10 MB is far above any real markdown note.
// Sizes are decimal (1 MB = 1,000,000 bytes) so they match the labels shown.
export const MAX_NOTE_BYTES = 10 * 1000 * 1000;

// Largest note the indexer will parse. Well under the read cap: a megabyte of
// markdown is past the point where tokenising it into the search index earns
// its keep, and a note that size is better listed and readable than dominating
// every search. Above this a note is still listed by list_notes (marked
// indexed: false) and still readable through read_note's paging; it is absent
// from search, tags, tasks and links. Same figure as the inline attachment cap.
export const MAX_INDEX_BYTES = 1 * 1000 * 1000;

// Largest note a write tool will produce. Equal to the read cap on purpose:
// anything this server writes, it can read back. See assertWriteSize in
// notes.ts, and the test that pins the ordering of these three.
export const MAX_WRITE_BYTES = MAX_NOTE_BYTES;

// Open a vault file for reading without following a symlink at the final
// path component. ELOOP is what the kernel answers for a symlink under
// O_NOFOLLOW, and it becomes the same VaultPathError every other symlink guard
// raises. Everything a caller then asks — fstat, a sniff of the head, the read
// itself — is asked of this one descriptor, so it all describes one inode.
export function openNoFollow(abs: string): number {
  try {
    return fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (e: unknown) {
    if ((e as { code?: string })?.code === "ELOOP") {
      throw new VaultPathError("Symlinks are not accessible");
    }
    throw e;
  }
}

/**
 * One open descriptor, and everything a caller learns about the file comes
 * from it: the stat, the first bytes, and the bytes themselves. `fn` gets all
 * three; `read` is valid only inside it, and the descriptor is closed after.
 *
 * This is the whole answer to a symlink swapped in between a check and a
 * read. A by-path check followed by a by-path read is two resolutions of one
 * name, and whatever sits at the name second time is what gets read. A
 * descriptor is one inode, fixed at the open, and the open refuses to follow.
 */
export function withVaultFile<T>(
  abs: string,
  fn: (file: { stat: fs.Stats; head: Buffer; read: () => Buffer<ArrayBuffer> }) => T,
): T {
  const fd = openNoFollow(abs);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new VaultPathError("Not a file");
    const head = readHead(fd);
    return fn({ stat, head, read: () => fs.readFileSync(fd) });
  } finally {
    fs.closeSync(fd);
  }
}

// Read a vault file with a hard size cap. The path must already be resolved
// via resolveNotePath, which rejects symlinks and traversal at resolve time.
//
// This used to lstat by path and then read by path — with the LFS and binary
// sniffs each opening the path again in between. Four separate resolutions,
// and a symlink swapped in by sync between any two of them was followed by the
// next. Now it is withVaultFile: one open, one inode, nothing to redirect.
export function readVaultFile(abs: string): string {
  return withVaultFile(abs, ({ stat, head, read }) => {
    if (stat.size > MAX_NOTE_BYTES) {
      throw new VaultPathError(
        `Note is too large to read (${Math.round(stat.size / 1000 / 1000)} MB; limit ${MAX_NOTE_BYTES / 1000 / 1000} MB)`,
      );
    }
    if (isLfsPointerHead(head)) throw lfsPointerError();
    if (hasNul(head)) {
      throw new VaultPathError(
        `This is a binary attachment (${formatBytes(stat.size)}), not readable as text. ` +
          `Use read_attachment for images and other binary files.`,
      );
    }
    return read().toString("utf8");
  });
}

export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1000 * 1000) return `${(n / 1000).toFixed(1)} KB`;
  if (n < 1000 * 1000 * 1000) return `${(n / 1e6).toFixed(1)} MB`;
  // Volumes are measured in gigabytes, and "994700.0 MB" is not a size anyone
  // reads. Decimal units throughout, matching how disks are sold and how
  // Railway states its plan ceilings.
  return `${(n / 1e9).toFixed(1)} GB`;
}

const HEAD_BYTES = 8192;

// The first bytes of an open file, read positionally so the descriptor's own
// offset is untouched and a following readFileSync(fd) starts at zero.
function readHead(fd: number): Buffer {
  const buf = Buffer.alloc(HEAD_BYTES);
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  return buf.subarray(0, n);
}

// Sniff the head of the file for NUL bytes rather than trusting the extension:
// reading a 4.6 MB JPEG as UTF-8 produced a 12 MB response of replacement
// characters (JSON escaping inflates it ~2.6x), which is useless to a client
// and can blow its entire context in one call.
export function hasNul(head: Buffer): boolean {
  return head.includes(0);
}

// A Git LFS pointer stands in for a file whose content lives outside the repo.
// It is small, plain ASCII, and contains no NUL — so the binary sniff above
// says "text" and every read path would happily serve 130 bytes of metadata as
// though it were the note or the image. Detect it explicitly.
const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/";

export function isLfsPointerHead(head: Buffer): boolean {
  return head.subarray(0, 64).toString("utf8").startsWith(LFS_POINTER_PREFIX);
}

// Path-based forms of the two sniffs. No production caller any more — every
// reader sniffs the head of its own descriptor — but the unit tests use them.
// False on any error, as before: a missing file is not binary and not a pointer.
function sniffHead(abs: string): Buffer | null {
  let fd: number | undefined;
  try {
    fd = openNoFollow(abs);
    return readHead(fd);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function isBinaryFile(abs: string): boolean {
  const head = sniffHead(abs);
  return head !== null && hasNul(head);
}

export function isLfsPointer(abs: string): boolean {
  const head = sniffHead(abs);
  return head !== null && isLfsPointerHead(head);
}

export function lfsPointerError(): VaultPathError {
  return new VaultPathError(
    "This file is stored in Git LFS and its content hasn't been fetched, so only a " +
      "pointer is on disk. Check the Status tab: the LFS objects may have failed to " +
      "download (quota, or an access token without LFS permission).",
  );
}

// Reject control characters (incl. NUL) and Unicode bidi overrides in a path.
// These enable filename spoofing and, for control chars, odd fs behavior.
// Covers C0/C1 controls, LRM/RLM, and the LRE..RLO / LRI..PDI bidi formatters.
const CONTROL_OR_BIDI =
  // eslint-disable-next-line no-control-regex -- this regex exists to catch control and bidi characters in vault paths
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
