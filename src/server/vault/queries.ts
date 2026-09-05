import fs from "node:fs";
import { countWords, stripCr } from "./text";
import { extractStructure, splitFrontmatter } from "./markdown";
import { indexerStatus } from "./indexer";
import crypto from "node:crypto";
import { db, getSetting } from "../db";
import { env } from "../env";
import { resolveNotePath, readVaultFile, VaultPathError } from "./paths";
import { headroom, writeVaultFile } from "./disk";
import { readNote, createNote } from "./notes";
import { dailyNotePath , timestampInZone, configuredTimeZone} from "./daily";

export interface SearchHit {
  path: string;
  title: string;
  /** Plain text, safe to quote verbatim — carries no highlight markup. */
  snippet: string;
  /** The words in `snippet` that matched, deduplicated, in order of appearance. */
  matches: string[];
}

// FTS5 brackets each matched term with delimiters we choose. They used to be
// `>>` and `<<`, returned inline and undocumented, so every consumer either had
// to know to strip them or passed them downstream into whatever it produced.
//
// Control characters rather than printable ones: a snippet is arbitrary note
// prose, and any printable delimiter can also occur naturally in the text, which
// leaves no way to tell a marker from content. These never reach a caller — the
// markers are parsed off here, and what matched comes back as its own field.
// Keeping that separate rather than dropping it: the porter tokenizer means the
// matched word often is not the queried one, and nothing else recovers it.
const HL_START = "\u0001";
const HL_END = "\u0002";
const HIGHLIGHT = new RegExp(`${HL_START}([\\s\\S]*?)${HL_END}`, "g");

export function splitHighlights(raw: string): { snippet: string; matches: string[] } {
  const matches: string[] = [];
  let snippet = raw.replace(HIGHLIGHT, (_full, term: string) => {
    if (term) matches.push(term);
    return term;
  });
  // Any marker left unpaired — a snippet truncated mid-highlight — would
  // otherwise leak a control character into the text.
  snippet = snippet.split(HL_START).join("").split(HL_END).join("");
  return { snippet, matches: [...new Set(matches)] };
}

export interface SearchPage {
  hits: SearchHit[];
  /** Every match for the query, not only this page — what lets a caller tell it was paged. */
  total: number;
}

export function searchVault(
  query: string,
  opts: { limit?: number; offset?: number; context?: boolean } = {},
): SearchPage {
  // Search keeps its own limits (20 / 100) rather than the list tools' 100 / 500:
  // every hit carries a snippet, so a page here is far heavier than a page of
  // paths. With offset a caller who wants more can page.
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  // Sanitize into FTS5 term queries (quoted phrases per token, OR-free AND default).
  const terms = query
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" ");
  if (!terms) return { hits: [], total: 0 };
  const snippetTokens = opts.context ? 24 : 10;
  // A COUNT over the same MATCH is a posting-list walk — far cheaper than the
  // snippet() query below, which builds text for every row it returns. It is
  // what lets the envelope say hasMore honestly instead of leaving a caller to
  // guess from a full page. LIMIT and OFFSET stay in SQL so the whole result
  // set is never materialised; that is why this cannot go through page().
  const total = (
    db().prepare(`SELECT COUNT(*) AS n FROM notes_fts WHERE notes_fts MATCH ?`).get(terms) as { n: number }
  ).n;
  const rows = db()
    .prepare(
      `SELECT path, title, snippet(notes_fts, 3, ?, ?, ' … ', ?) AS snippet
       FROM notes_fts WHERE notes_fts MATCH ? ORDER BY rank LIMIT ? OFFSET ?`,
    )
    .all(HL_START, HL_END, snippetTokens, terms, limit, offset) as {
    path: string;
    title: string;
    snippet: string;
  }[];
  return { hits: rows.map((r) => ({ path: r.path, title: r.title, ...splitHighlights(r.snippet) })), total };
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
  // Match without the carriage return, then put it back: joining with "\n"
  // preserves every other line's ending, and this one must not become the
  // exception — a single toggle would otherwise rewrite the whole file.
  const hadCr = lines[idx].endsWith("\r");
  const m = stripCr(lines[idx]).match(/^(\s*[-*+]\s+\[)([ xX])(\]\s+.*)$/);
  if (!m) throw new VaultPathError(`Line ${line} is not a task`);
  const nowDone = m[2] === " ";
  lines[idx] = m[1] + (nowDone ? "x" : " ") + m[3] + (hadCr ? "\r" : "");
  writeVaultFile(abs, lines.join("\n"));
  const text = stripCr(lines[idx]).replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, "");
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
    syncNote: syncNote(),
    noteCount,
    totalWords,
    // Notes over the index size cap: listed and readable, but not in the
    // count above and not searchable. Reported so "no results" for a note
    // that plainly exists has an explanation.
    unindexedNotes: indexerStatus().unindexedNotes,
    // How much room the volume has left, and whether that is a problem yet.
    // Null when the platform will not say.
    disk: headroom(),
  };
}

// Named the backend that is actually configured. This used to say "Obsidian
// Sync" unconditionally, which told every git-backed deployment that its writes
// propagate through a product it does not use — and the two propagate
// differently enough for that to matter: Obsidian Sync pushes continuously,
// while git waits for a debounce and then a commit.
function syncNote(): string {
  const immediate = "Writes land in this server's vault immediately";
  return getSetting("sync_backend") === "git"
    ? `${immediate}; they reach your other devices after the next commit and push, not instantly.`
    : `${immediate}; propagation to other devices is via Obsidian Sync and is not instant.`;
}

// Both paths answer with the index's two definitions — body-only words, and
// bytes on disk — so a note's own answer equals its contribution to the vault
// total. It used to count the whole file in UTF-16 code units with a path and
// sum body words and bytes without one: the same note gave two numbers, and
// the per-note ones never added up to the total.
export function wordCount(notePath?: string): { path: string | null; words: number; bytes: number } {
  if (notePath) {
    const { content, path } = readNote(notePath);
    // Frontmatter is metadata, not writing — split off exactly as the indexer
    // splits it, unparseable frontmatter included.
    const { body } = splitFrontmatter(content);
    return { path, words: countWords(body), bytes: fs.statSync(resolveNotePath(notePath)).size };
  }
  const words = (db().prepare("SELECT COALESCE(SUM(word_count),0) AS n FROM notes").get() as { n: number }).n;
  const bytes = (db().prepare("SELECT COALESCE(SUM(size),0) AS n FROM notes").get() as { n: number }).n;
  return { path: null, words, bytes };
}

// The same extraction the index runs, on the same text: the body, with the
// frontmatter split off. It used to be a second copy of the heading scan run
// over the whole file, so a YAML comment came back as an H1 that search had
// never indexed. Line numbers are made file-absolute with the same offset the
// indexer applies to tasks, so get_outline and toggle_task agree about which
// line is which.
export function outline(notePath: string): { level: number; heading: string; line: number }[] {
  const { content } = readNote(notePath);
  const { body, fmOffset } = splitFrontmatter(content);
  return extractStructure(body).headings.map((h) => ({
    level: h.level,
    heading: h.text,
    line: h.line + fmOffset,
  }));
}

/**
 * A path chosen at random, and only the path. The note itself comes from
 * read_note, so a random pick is read the way every other note is — windowed,
 * fenced, with the boundary explanation — rather than through a second reader
 * kept in step with the first. It used to return a read window of its own,
 * which was the one note reader that skipped the boundary marker.
 */
export function randomNote(): { path: string } {
  const row = db().prepare("SELECT path FROM notes ORDER BY RANDOM() LIMIT 1").get() as
    | { path: string }
    | undefined;
  if (!row) throw new VaultPathError("The vault has no notes yet");
  return { path: row.path };
}

// Zettelkasten-style unique note (Obsidian default format: YYYYMMDDHHmm).
export function uniqueNote(content?: string): string {
  // Stamped in the configured zone, not the server's. The container runs on
  // UTC, so Date's local getters named every evening note in the Americas after
  // tomorrow — the same bug daily notes had, in a second place that formatted
  // its own timestamp instead of asking daily.ts.
  const stamp = timestampInZone(new Date(), configuredTimeZone());
  let name = `${stamp}.md`;
  if (fs.existsSync(resolveNotePath(name))) {
    name = `${stamp}-${crypto.randomBytes(2).toString("hex")}.md`;
  }
  return createNote(name, content ?? "");
}
