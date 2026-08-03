import fs from "node:fs";
import path from "node:path";
import { env } from "../env";
import {
  resolveNotePath,
  resolveFolderPath,
  toVaultRelative,
  readVaultFile,
  isBinaryFile,
  formatBytes,
  isLfsPointer,
  lfsPointerError,
  VaultPathError,
} from "./paths";

export interface NoteInfo {
  path: string;
  mtime: number;
  size: number;
}

// Full read. Internal callers (word_count, outline, link resolution) need the
// whole document; MCP-facing reads should use readNoteRange so a 465 KB note
// can't return ~121k tokens in a single tool call.
export function readNote(notePath: string): { path: string; content: string } {
  const abs = resolveNotePath(notePath);
  if (!fs.existsSync(abs)) throw new VaultPathError(`Note not found: ${notePath}`);
  return { path: toVaultRelative(abs), content: readVaultFile(abs) };
}

// Default window for client-facing reads: whichever of these is hit first.
export const DEFAULT_READ_LINES = 2000;
export const MAX_READ_LINES = 20000;
export const MAX_READ_BYTES = 100 * 1000;

export interface NoteChunk {
  path: string;
  content: string;
  totalLines: number;
  offset: number;
  count: number;
  hasMore: boolean;
  truncatedForSize?: boolean;
}

// Line-windowed read with a byte ceiling, shaped like the paginated list tools
// so a client can page through a large note instead of being handed all of it.
export function readNoteRange(
  notePath: string,
  opts: { offset?: number; limit?: number } = {},
): NoteChunk {
  const { path: rel, content } = readNote(notePath);
  const lines = content.split("\n");
  const offset = Math.max(opts.offset ?? 0, 0);
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_READ_LINES, 1), MAX_READ_LINES);
  let slice = lines.slice(offset, offset + limit);

  // Enforce the byte ceiling too — a few very long lines can dwarf the line cap.
  let truncatedForSize = false;
  while (slice.length > 1 && Buffer.byteLength(slice.join("\n"), "utf8") > MAX_READ_BYTES) {
    slice = slice.slice(0, Math.max(1, Math.floor(slice.length * 0.8)));
    truncatedForSize = true;
  }
  const out: NoteChunk = {
    path: rel,
    content: slice.join("\n"),
    totalLines: lines.length,
    offset,
    count: slice.length,
    hasMore: offset + slice.length < lines.length,
  };
  if (truncatedForSize) out.truncatedForSize = true;
  return out;
}

// Binary attachments are refused by the text read path; this returns small ones
// as base64 so a model can actually look at an image. Large files stay refused —
// base64 inflates ~1.37x and a 4.6 MB photo would swamp any client.
export const MAX_ATTACHMENT_BYTES = 1000 * 1000;

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", avif: "image/avif",
  pdf: "application/pdf", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4",
  mp4: "video/mp4", mov: "video/quicktime", zip: "application/zip",
  // Text-ish types that can legitimately live in a vault alongside notes.
  md: "text/markdown", txt: "text/plain", csv: "text/csv", json: "application/json",
  canvas: "application/json",
};

export function readAttachment(notePath: string): {
  path: string;
  mimeType: string;
  bytes: number;
  isImage: boolean;
  base64: string;
} {
  const abs = resolveNotePath(notePath, { allowMissingExt: true });
  if (!fs.existsSync(abs)) throw new VaultPathError(`Attachment not found: ${notePath}`);
  const st = fs.lstatSync(abs);
  if (st.isSymbolicLink()) throw new VaultPathError("Symlinks are not accessible");
  if (!st.isFile()) throw new VaultPathError("Not a file");
  // Mirror read_note's refusal in the other direction: handing a markdown note
  // back as base64 octet-stream is never what the caller wanted, and leaving it
  // to "work" makes the two tools quietly inconsistent.
  if (!isBinaryFile(abs) && path.extname(abs).toLowerCase() === ".md") {
    throw new VaultPathError(
      `${toVaultRelative(abs)} is a markdown note, not a binary attachment. Use read_note instead.`,
    );
  }
  // The pointer is small, so this fires well before the size cap below.
  if (isLfsPointer(abs)) throw lfsPointerError();
  if (st.size > MAX_ATTACHMENT_BYTES) {
    throw new VaultPathError(
      `Attachment is ${formatBytes(st.size)}; the limit for inline reads is ` +
        `${formatBytes(MAX_ATTACHMENT_BYTES)}. It exists in the vault but is too large to return.`,
    );
  }
  const ext = path.extname(abs).slice(1).toLowerCase();
  const mimeType = MIME_BY_EXT[ext] ?? "application/octet-stream";
  return {
    path: toVaultRelative(abs),
    mimeType,
    bytes: st.size,
    isImage: mimeType.startsWith("image/") && mimeType !== "image/svg+xml",
    base64: fs.readFileSync(abs).toString("base64"),
  };
}

export function noteExists(notePath: string): boolean {
  try {
    return fs.existsSync(resolveNotePath(notePath));
  } catch {
    return false;
  }
}

// Segment names that are confusing or reserved, blocked on create to avoid
// odd-looking notes (traversal/control chars are already rejected in
// resolveNotePath; these are cosmetic/robustness).
const RESERVED_SEGMENTS = new Set(["~", "__proto__", "constructor", "prototype", "CON", "PRN", "AUX", "NUL"]);

export function createNote(notePath: string, content: string): string {
  const abs = resolveNotePath(notePath);
  if (toVaultRelative(abs).split("/").some((s) => RESERVED_SEGMENTS.has(s))) {
    throw new VaultPathError("Note path contains a reserved name");
  }
  if (fs.existsSync(abs)) {
    throw new VaultPathError(`Note already exists: ${toVaultRelative(abs)} (use update_note to replace it)`);
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return toVaultRelative(abs);
}

export function updateNote(notePath: string, content: string): string {
  const abs = resolveNotePath(notePath);
  if (!fs.existsSync(abs)) throw new VaultPathError(`Note not found: ${notePath}`);
  fs.writeFileSync(abs, content, "utf8");
  return toVaultRelative(abs);
}

export function appendToNote(notePath: string, content: string): string {
  const abs = resolveNotePath(notePath);
  if (!fs.existsSync(abs)) throw new VaultPathError(`Note not found: ${notePath}`);
  const existing = readVaultFile(abs);
  // Separate with a blank line so appended text becomes its own block. A single
  // newline would render as a soft break inside the preceding paragraph, which
  // silently mangles the note for a tool documented as the safest way to add
  // content. Skip the separator when the file is empty or already ends blank.
  let sep = "";
  if (existing !== "") {
    if (existing.endsWith("\n\n")) sep = "";
    else if (existing.endsWith("\n")) sep = "\n";
    else sep = "\n\n";
  }
  fs.writeFileSync(abs, existing + sep + content + (content.endsWith("\n") ? "" : "\n"), "utf8");
  return toVaultRelative(abs);
}

// Insert after YAML frontmatter (matching the Obsidian CLI's prepend behavior).
export function prependToNote(notePath: string, content: string): string {
  const abs = resolveNotePath(notePath);
  if (!fs.existsSync(abs)) throw new VaultPathError(`Note not found: ${notePath}`);
  const existing = readVaultFile(abs);
  // Trailing blank line for the same reason as append: keep the inserted text
  // a distinct block rather than merging into what follows.
  let block = content.endsWith("\n") ? content : content + "\n";
  if (!block.endsWith("\n\n")) block += "\n";
  const fmMatch = existing.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  const next = fmMatch
    ? existing.slice(0, fmMatch[0].length) + block + existing.slice(fmMatch[0].length)
    : block + existing;
  fs.writeFileSync(abs, next, "utf8");
  return toVaultRelative(abs);
}

export function moveNote(notePath: string, newPath: string): { from: string; to: string } {
  const absFrom = resolveNotePath(notePath);
  const absTo = resolveNotePath(newPath);
  if (!fs.existsSync(absFrom)) throw new VaultPathError(`Note not found: ${notePath}`);
  if (fs.existsSync(absTo)) throw new VaultPathError(`Target already exists: ${toVaultRelative(absTo)}`);
  fs.mkdirSync(path.dirname(absTo), { recursive: true });
  fs.renameSync(absFrom, absTo);
  return { from: toVaultRelative(absFrom), to: toVaultRelative(absTo) };
}

export function deleteNote(notePath: string): string {
  const abs = resolveNotePath(notePath);
  if (!fs.existsSync(abs)) throw new VaultPathError(`Note not found: ${notePath}`);
  fs.rmSync(abs);
  return toVaultRelative(abs);
}

export function listNotes(folder?: string): NoteInfo[] {
  const root = folder ? resolveFolderPath(folder) : env.vaultDir;
  if (!fs.existsSync(root)) throw new VaultPathError(`Folder not found: ${folder}`);
  const out: NoteInfo[] = [];
  walk(root, out);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

// Bounded so a pathologically deep synced tree can't blow the stack (A10).
const MAX_WALK_DEPTH = 32;

function walk(dir: string, out: NoteInfo[], depth = 0) {
  if (depth > MAX_WALK_DEPTH) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      walk(abs, out, depth + 1);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      const st = fs.statSync(abs);
      out.push({ path: toVaultRelative(abs), mtime: st.mtimeMs, size: st.size });
    }
  }
}

export function listFolders(): string[] {
  const out: string[] = [];
  const walkDirs = (dir: string, depth = 0) => {
    if (depth > MAX_WALK_DEPTH) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const abs = path.join(dir, entry.name);
      out.push(toVaultRelative(abs));
      walkDirs(abs, depth + 1);
    }
  };
  walkDirs(env.vaultDir);
  return out.sort();
}
