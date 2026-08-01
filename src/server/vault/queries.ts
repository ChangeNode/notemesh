import fs from "node:fs";
import crypto from "node:crypto";
import { db, getSetting } from "../db";
import { env } from "../env";
import { resolveNotePath, readVaultFile, VaultPathError } from "./paths";
import { readNote, readNoteRange, createNote } from "./notes";
import { dailyNotePath } from "./daily";

export interface SearchHit {
  path: string;
  title: string;
  snippet: string;
}

export function searchVault(query: string, opts: { limit?: number; context?: boolean } = {}): SearchHit[] {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  // Sanitize into FTS5 term queries (quoted phrases per token, OR-free AND default).
  const terms = query
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" ");
  if (!terms) return [];
  const snippetTokens = opts.context ? 24 : 10;
  const rows = db()
    .prepare(
      `SELECT path, title, snippet(notes_fts, 3, '>>', '<<', ' … ', ?) AS snippet
       FROM notes_fts WHERE notes_fts MATCH ? ORDER BY rank LIMIT ?`,
    )
    .all(snippetTokens, terms, limit) as SearchHit[];
  return rows;
}

// Normalize a note path the way the index stores it (vault-relative, .md).
function normalizedExisting(notePath: string): string {
  const abs = resolveNotePath(notePath);
  if (!fs.existsSync(abs)) throw new VaultPathError(`Note not found: ${notePath}`);
  return readNote(notePath).path;
}

export function backlinks(notePath: string): { path: string; target: string }[] {
  const rel = normalizedExisting(notePath);
  return db()
    .prepare("SELECT source_path AS path, target FROM links WHERE resolved_path = ? ORDER BY source_path")
    .all(rel) as { path: string; target: string }[];
}

export function outgoingLinks(notePath: string): { target: string; resolved: string | null }[] {
  const rel = normalizedExisting(notePath);
  return db()
    .prepare("SELECT target, resolved_path AS resolved FROM links WHERE source_path = ? ORDER BY target")
    .all(rel) as { target: string; resolved: string | null }[];
}

export function unresolvedLinks(): { source: string; target: string }[] {
  return db()
    .prepare("SELECT source_path AS source, target FROM links WHERE resolved_path IS NULL ORDER BY source_path")
    .all() as { source: string; target: string }[];
}

// Notes with no incoming resolved links. Returns objects (not bare strings) so
// every list_link_issues variant has a consistent shape.
export function orphanNotes(): { path: string }[] {
  return db()
    .prepare(
      `SELECT path FROM notes WHERE path NOT IN
       (SELECT resolved_path FROM links WHERE resolved_path IS NOT NULL) ORDER BY path`,
    )
    .all() as { path: string }[];
}

// Notes with no outgoing links.
export function deadEndNotes(): { path: string }[] {
  return db()
    .prepare(
      `SELECT path FROM notes WHERE path NOT IN
       (SELECT DISTINCT source_path FROM links) ORDER BY path`,
    )
    .all() as { path: string }[];
}

export function listTags(): { tag: string; count: number }[] {
  return db()
    .prepare("SELECT tag, COUNT(*) AS count FROM tags GROUP BY tag ORDER BY count DESC, tag")
    .all() as { tag: string; count: number }[];
}

export function notesByTag(tag: string): string[] {
  const clean = tag.replace(/^#/, "");
  return (
    db().prepare("SELECT path FROM tags WHERE tag = ? ORDER BY path").all(clean) as { path: string }[]
  ).map((r) => r.path);
}

export interface TaskItem {
  path: string;
  line: number;
  text: string;
  done: boolean;
}

export function listTasks(filter: "all" | "todo" | "daily" = "all"): TaskItem[] {
  let rows: { path: string; line: number; text: string; done: number }[];
  if (filter === "daily") {
    const daily = dailyNotePath();
    rows = db()
      .prepare("SELECT path, line, text, done FROM tasks WHERE path = ? ORDER BY line")
      .all(daily) as any;
  } else if (filter === "todo") {
    rows = db()
      .prepare("SELECT path, line, text, done FROM tasks WHERE done = 0 ORDER BY path, line")
      .all() as any;
  } else {
    rows = db().prepare("SELECT path, line, text, done FROM tasks ORDER BY path, line").all() as any;
  }
  return rows.map((r) => ({ ...r, done: r.done === 1 }));
}

export function toggleTask(notePath: string, line: number): TaskItem {
  const abs = resolveNotePath(notePath);
  if (!fs.existsSync(abs)) throw new VaultPathError(`Note not found: ${notePath}`);
  const lines = readVaultFile(abs).split("\n");
  const idx = line - 1;
  if (idx < 0 || idx >= lines.length) throw new VaultPathError(`Line ${line} is out of range`);
  const m = lines[idx].match(/^(\s*[-*+]\s+\[)([ xX])(\]\s+.*)$/);
  if (!m) throw new VaultPathError(`Line ${line} is not a task`);
  const nowDone = m[2] === " ";
  lines[idx] = m[1] + (nowDone ? "x" : " ") + m[3];
  fs.writeFileSync(abs, lines.join("\n"), "utf8");
  const text = lines[idx].replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, "");
  return { path: notePath, line, text, done: nowDone };
}

export function vaultInfo() {
  const noteCount = (db().prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number }).n;
  const totalWords = (db().prepare("SELECT COALESCE(SUM(word_count),0) AS n FROM notes").get() as { n: number }).n;
  return {
    vaultName: getSetting("vault_name") ?? null,
    // The server owns its own replica of the vault. Writes are durable here
    // immediately; they reach your other devices only after Obsidian Sync
    // round-trips (seconds to minutes). Surfacing the path stops anyone
    // verifying a write against a *different* vault copy and concluding the
    // write was lost.
    vaultPath: env.vaultDir,
    syncNote:
      "Writes land in this server's vault immediately; propagation to other devices is via Obsidian Sync and is not instant.",
    noteCount,
    totalWords,
  };
}

export function wordCount(notePath?: string): { path: string | null; words: number; characters: number } {
  if (notePath) {
    const { content, path } = readNote(notePath);
    return {
      path,
      words: content.split(/\s+/).filter(Boolean).length,
      characters: content.length,
    };
  }
  const words = (db().prepare("SELECT COALESCE(SUM(word_count),0) AS n FROM notes").get() as { n: number }).n;
  const chars = (db().prepare("SELECT COALESCE(SUM(size),0) AS n FROM notes").get() as { n: number }).n;
  return { path: null, words, characters: chars };
}

export function outline(notePath: string): { level: number; heading: string; line: number }[] {
  const { content } = readNote(notePath);
  const out: { level: number; heading: string; line: number }[] = [];
  let inCodeBlock = false;
  content.split("\n").forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inCodeBlock = !inCodeBlock;
      return;
    }
    if (inCodeBlock) return;
    const m = line.match(/^(#{1,6})\s+(.+)$/);
    if (m) out.push({ level: m[1].length, heading: m[2].trim(), line: i + 1 });
  });
  return out;
}

export function randomNote() {
  const row = db().prepare("SELECT path FROM notes ORDER BY RANDOM() LIMIT 1").get() as
    | { path: string }
    | undefined;
  if (!row) throw new VaultPathError("The vault has no notes yet");
  // Windowed: a random pick could land on a 465 KB note.
  return readNoteRange(row.path);
}

// Zettelkasten-style unique note (Obsidian default format: YYYYMMDDHHmm).
export function uniqueNote(content?: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`;
  let name = `${stamp}.md`;
  if (fs.existsSync(resolveNotePath(name))) {
    name = `${stamp}-${crypto.randomBytes(2).toString("hex")}.md`;
  }
  return createNote(name, content ?? "");
}
