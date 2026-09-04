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
  MAX_INDEX_BYTES,
  MAX_WRITE_BYTES,
} from "./paths";

export interface NoteInfo {
  path: string;
  mtime: number;
  size: number;
  /** Present, and false, only for a note over the index size cap: listed and readable, not searchable. */
  indexed?: false;
}

// The write cap. Equal to the read cap on purpose: a note this server writes
// must be one it can read back. That used to rest on the 4 MB request-body
// limit happening to sit below a 10 MB read cap — true, but a coincidence,
// and a coincidence is not an invariant. hostile-content.test.ts asserts the
// ordering of the caps and that an oversized write is refused before it lands.
function assertWriteSize(content: string) {
  const n = Buffer.byteLength(content, "utf8");
  if (n > MAX_WRITE_BYTES) {
    throw new VaultPathError(
      `That would make the note ${formatBytes(n)}; the limit is ${formatBytes(MAX_WRITE_BYTES)}.`,
    );
  }
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

/**
 * Second chance for a path that doesn't exist as given: find the attachment by
 * filename alone.
 *
 * Obsidian writes embeds as bare names — `![[screen.png]]` — while the file
 * lives wherever it was filed, often several folders away. A caller reading a
 * note therefore has a name and no path, and guessing plausible folders is the
 * only move available; every guess produces an honest "not found" and the file
 * is never read. This is the same shortest-name resolution the indexer already
 * does for links, applied at read time.
 *
 * The match is re-resolved through resolveNotePath so a hit is subject to the
 * same containment and traversal checks as a directly supplied path.
 */
function resolveByFilename(requested: string): string {
  const wanted = path.basename(requested).toLowerCase();
  const matches = listAttachments()
    .map((a) => a.path)
    .filter((p) => path.basename(p).toLowerCase() === wanted);

  if (matches.length === 1) return resolveNotePath(matches[0]);
  if (matches.length > 1) {
    throw new VaultPathError(
      `${matches.length} attachments are named ${path.basename(requested)}. ` +
        `Ask for one of these paths: ${matches.slice(0, 10).join(", ")}` +
        (matches.length > 10 ? ", …" : ""),
    );
  }
  // Every folder has already been searched by filename, so this is not a
  // wrong-path problem the caller can fix by looking harder — the file is not
  // in the vault. Say that, rather than pointing at a listing tool that will
  // not contain it either.
  throw new VaultPathError(
    `No attachment named "${path.basename(requested)}" exists anywhere in the vault ` +
      `(every folder was searched by filename). If a note embeds it, that embed is broken: ` +
      `the file was deleted, or was never synced. list_link_issues with type "unresolved" ` +
      `shows every link in this state.`,
  );
}

export interface AttachmentMeta {
  /** Absolute path, already through every vault guard. */
  abs: string;
  path: string;
  mimeType: string;
  bytes: number;
  isImage: boolean;
  /** Over the inline cap, so it has to be fetched rather than returned. */
  tooLarge: boolean;
}

/**
 * Locate an attachment and describe it, without reading it.
 *
 * Split out from readAttachment so an oversized file can be *offered* — as a
 * signed URL — rather than refused. Every guard that mattered still runs here:
 * this is the only place the path is resolved, and the signed-URL route calls
 * it too rather than trusting a path that arrived with a valid signature.
 */
export function attachmentMeta(notePath: string): AttachmentMeta {
  let abs = resolveNotePath(notePath, { allowMissingExt: true });
  if (!fs.existsSync(abs)) abs = resolveByFilename(notePath);
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
  // The pointer is small, so this fires well before the size cap.
  if (isLfsPointer(abs)) throw lfsPointerError();

  const ext = path.extname(abs).slice(1).toLowerCase();
  const mimeType = MIME_BY_EXT[ext] ?? "application/octet-stream";
  return {
    abs,
    path: toVaultRelative(abs),
    mimeType,
    bytes: st.size,
    isImage: mimeType.startsWith("image/") && mimeType !== "image/svg+xml",
    tooLarge: st.size > MAX_ATTACHMENT_BYTES,
  };
}

export function readAttachment(notePath: string): {
  path: string;
  mimeType: string;
  bytes: number;
  isImage: boolean;
  base64: string;
} {
  const meta = attachmentMeta(notePath);
  if (meta.tooLarge) {
    throw new VaultPathError(
      `Attachment is ${formatBytes(meta.bytes)}; the limit for inline reads is ` +
        `${formatBytes(MAX_ATTACHMENT_BYTES)}. It exists in the vault but is too large to return.`,
    );
  }
  return {
    path: meta.path,
    mimeType: meta.mimeType,
    bytes: meta.bytes,
    isImage: meta.isImage,
    base64: fs.readFileSync(meta.abs).toString("base64"),
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
  assertWriteSize(content);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return toVaultRelative(abs);
}

export function updateNote(notePath: string, content: string): string {
  const abs = resolveNotePath(notePath);
  if (!fs.existsSync(abs)) throw new VaultPathError(`Note not found: ${notePath}`);
  assertWriteSize(content);
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
  const next = existing + sep + content + (content.endsWith("\n") ? "" : "\n");
  assertWriteSize(next);
  fs.writeFileSync(abs, next, "utf8");
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
  assertWriteSize(next);
  fs.writeFileSync(abs, next, "utf8");
  return toVaultRelative(abs);
}

export interface EditResult {
  path: string;
  /** Replacements made: one, or every occurrence under replaceAll. */
  replaced: number;
  /** 1-based line in the note as it was before the edit, where each replacement began. */
  lines: number[];
}

/**
 * Replace text in a note by naming it.
 *
 * `oldString` must occur exactly once, or the edit is refused with the line
 * numbers of every occurrence — so the next call can pass `line` to choose one,
 * or expand `oldString` until it is unique. This is not a diff algorithm; it is
 * indexOf and a count, and that is the point. Two properties follow from it.
 *
 * Precision: nothing is replaced that the caller did not spell out. The
 * alternative, rewriting the whole note with update_note, cannot be done
 * safely for a note read in pages, and turns a one-line change into a
 * whole-file commit on the git backend.
 *
 * Safety under sync: the vault changes underneath the model. If Obsidian Sync
 * or a pull rewrote the note between the read and this call, `oldString`
 * simply no longer matches, and the edit is refused rather than applied to
 * the wrong place. A line-numbered patch would have applied anyway.
 *
 * `line` is an assertion, never a search key on its own: with a single match
 * it must agree or the edit is refused; with several it chooses between them.
 * A repeat on the same line is refused with the advice to expand `oldString`.
 */
export function editNote(
  notePath: string,
  oldString: string,
  newString: string,
  opts: { line?: number; replaceAll?: boolean } = {},
): EditResult {
  if (oldString === "") throw new VaultPathError("oldString must not be empty");
  if (oldString === newString) {
    throw new VaultPathError("oldString and newString are identical; there is nothing to change");
  }
  if (opts.replaceAll && opts.line !== undefined) {
    throw new VaultPathError(
      "line and replaceAll cannot be combined: line chooses one occurrence, replaceAll takes all of them",
    );
  }
  const abs = resolveNotePath(notePath);
  if (!fs.existsSync(abs)) throw new VaultPathError(`Note not found: ${notePath}`);
  const rel = toVaultRelative(abs);
  const content = readVaultFile(abs);

  // A note synced from Windows carries \r\n. A caller passing \n-only strings
  // would never match it, and one that did would write mixed endings. So when
  // the file uses CRLF and the caller's strings carry no CR, their breaks are
  // treated as CRLF: the file keeps its convention, as toggleTask keeps it.
  const crlf = content.includes("\r\n");
  const asFile = (s: string) => (crlf && !s.includes("\r") ? s.replace(/\n/g, "\r\n") : s);
  const needle = asFile(oldString);
  const replacement = asFile(newString);

  const positions: number[] = [];
  for (let i = content.indexOf(needle); i !== -1; i = content.indexOf(needle, i + needle.length)) {
    positions.push(i);
  }
  const lineAt = (pos: number) => content.slice(0, pos).split("\n").length;
  const lines = positions.map(lineAt);

  if (positions.length === 0) {
    throw new VaultPathError(
      `oldString was not found in ${rel}. Read the note again; it may have changed since it was last read.`,
    );
  }

  let chosen: number[];
  if (opts.replaceAll) {
    chosen = positions;
  } else if (positions.length === 1) {
    if (opts.line !== undefined && opts.line !== lines[0]) {
      throw new VaultPathError(
        `oldString occurs once in ${rel}, at line ${lines[0]}, not line ${opts.line}. ` +
          `Read the note again; it may have changed since it was last read.`,
      );
    }
    chosen = positions;
  } else if (opts.line === undefined) {
    throw new VaultPathError(
      `oldString occurs ${positions.length} times in ${rel}, at lines ${lines.join(", ")}. ` +
        `Pass line to choose one, expand oldString to include surrounding text so it is unique, or set replaceAll.`,
    );
  } else {
    const at = positions.filter((_, k) => lines[k] === opts.line);
    if (at.length === 0) {
      throw new VaultPathError(
        `oldString occurs ${positions.length} times in ${rel} (lines ${lines.join(", ")}), but not at line ${opts.line}.`,
      );
    }
    if (at.length > 1) {
      throw new VaultPathError(
        `oldString occurs ${at.length} times on line ${opts.line} of ${rel}. ` +
          `Expand oldString to include surrounding text so it names one of them.`,
      );
    }
    chosen = at;
  }

  let out = "";
  let last = 0;
  for (const p of chosen) {
    out += content.slice(last, p) + replacement;
    last = p + needle.length;
  }
  out += content.slice(last);
  assertWriteSize(out);
  fs.writeFileSync(abs, out, "utf8");
  return { path: rel, replaced: chosen.length, lines: chosen.map(lineAt) };
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
  return listFiles(folder, isMarkdown);
}

// Everything in the vault that isn't a note: images, PDFs, audio, canvases.
//
// Attachments need their own listing because embeds are written by name
// (`![[screen.png]]`) while the file itself lives wherever Obsidian filed it
// (`Archive/Reference/Attachments/screen.png`). Without a way to enumerate
// them, the only way to turn an embed into a readable path is to guess.
export function listAttachments(folder?: string): NoteInfo[] {
  return listFiles(folder, (name) => !isMarkdown(name));
}

function isMarkdown(name: string): boolean {
  return name.toLowerCase().endsWith(".md");
}

function listFiles(folder: string | undefined, include: (name: string) => boolean): NoteInfo[] {
  const root = folder ? resolveFolderPath(folder) : env.vaultDir;
  if (!fs.existsSync(root)) throw new VaultPathError(`Folder not found: ${folder}`);
  const out: NoteInfo[] = [];
  walk(root, out, 0, include);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

// Bounded so a pathologically deep synced tree can't blow the stack (A10).
const MAX_WALK_DEPTH = 32;

function walk(
  dir: string,
  out: NoteInfo[],
  depth = 0,
  include: (name: string) => boolean = isMarkdown,
) {
  if (depth > MAX_WALK_DEPTH) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      walk(abs, out, depth + 1, include);
    } else if (entry.isFile() && include(entry.name)) {
      const st = fs.statSync(abs);
      // Round: statSync reports sub-millisecond precision, so mtimeMs is a
      // float (1761764371279.999). Callers treat these as timestamps — sorting
      // and comparing them for equality — and a fractional tail makes both
      // unreliable. The indexer already rounds at its own two ingestion points,
      // so this keeps the value a caller sees consistent with the stored one.
      const info: NoteInfo = { path: toVaultRelative(abs), mtime: Math.round(st.mtimeMs), size: st.size };
      // The same rule the indexer applies, decided from the same number, so the
      // listing can say why a note that plainly exists is missing from search.
      if (isMarkdown(entry.name) && st.size > MAX_INDEX_BYTES) info.indexed = false;
      out.push(info);
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
