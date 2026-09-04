import { ensureDiskWatched } from "./disk";
import fs from "node:fs";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { countWords } from "./text";
import { extractStructure, splitFrontmatter } from "./markdown";
import { db } from "../db";
import { env } from "../env";
import { toVaultRelative, isSafeVaultPath, openNoFollow, MAX_INDEX_BYTES } from "./paths";

// Notes skipped for size. They are listed and readable but absent from the
// index, and get_vault_info reports how many so the absence from search is
// explainable. Cleared by a rebuild, maintained by every index and remove.
const oversized = new Set<string>();

// Parses one markdown note into everything the index stores. The structure —
// headings, links, tags, tasks — comes from markdown.ts, the same function
// get_outline reads, so the two cannot disagree about what a heading is.
export function parseNote(relPath: string, content: string) {
  const { data, body, fmOffset } = splitFrontmatter(content);

  // Strip control chars and bidi overrides from the display title so a
  // maliciously-named synced file can't spoof UIs that render titles.
  const title = path
    .basename(relPath, ".md")
    .normalize("NFC")
    // eslint-disable-next-line no-control-regex -- matching control and bidi characters is the point: they are stripped from indexed titles
    .replace(/[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "");
  const tags = new Set<string>();

  // Frontmatter tags (string or array).
  const fmTags = (data as any).tags ?? (data as any).tag;
  if (typeof fmTags === "string") {
    fmTags.split(/[,\s]+/).filter(Boolean).forEach((t) => tags.add(t.replace(/^#/, "")));
  } else if (Array.isArray(fmTags)) {
    fmTags.filter((t) => typeof t === "string").forEach((t) => tags.add(t.replace(/^#/, "")));
  }

  const structure = extractStructure(body);
  for (const t of structure.tags) tags.add(t);
  const headings = structure.headings.map((h) => h.text);
  const links = structure.links;
  // Task line numbers are made file-absolute here, so toggle_task lands on
  // the right line of the file on disk, frontmatter included.
  const tasks = structure.tasks.map((t) => ({ ...t, line: t.line + fmOffset }));

  const wordCount = countWords(body);

  return { title, headings, body, frontmatter: data, tags: [...tags], links, tasks, wordCount };
}

// Resolve a wikilink target to an indexed note path, mimicking Obsidian's
// shortest-path-wins resolution: exact path match first, then unique basename.
function resolveLink(
  target: string,
  byBasename: Map<string, string[]>,
  byPathLower: Map<string, string>,
): string | null {
  // NFC-normalize so an NFC wikilink matches an NFD on-disk name, and compare
  // case-insensitively on both branches for consistency.
  const t = target.replace(/\\/g, "/").normalize("NFC");
  const pick = (candidate: string): string | null => {
    const exact = byPathLower.get(candidate.toLowerCase());
    if (exact) return exact;
    const byBase = byBasename.get(path.basename(candidate).toLowerCase());
    return byBase && byBase.length > 0 ? byBase[0] : null;
  };
  // Try the target verbatim first: that is how embeds of attachments are
  // written (![[Diagram.png]]), and how fully-qualified note paths are written.
  const literal = pick(t);
  if (literal) return literal;
  // Markdown links are conventionally written without the .md extension.
  return t.toLowerCase().endsWith(".md") ? null : pick(`${t}.md`);
}

function indexFile(relPath: string, absPath: string) {
  let content: string;
  let st: fs.Stats;
  try {
    if (!isSafeVaultPath(absPath)) return;
    // One descriptor, opened without following symlinks, and everything else
    // asked of it: the stat, the size cap and the read all describe the same
    // inode. An lstat followed by a read *by path* left a gap in which sync
    // could swap the file for a symlink — `x.md -> /etc/passwd` — that the
    // read would then follow straight into the search index. It also means the
    // mtime and size stored below belong to the bytes that were indexed, not to
    // whatever the path pointed at a moment earlier.
    const fd = openNoFollow(absPath);
    try {
      st = fs.fstatSync(fd);
      if (!st.isFile()) return;
      if (st.size > MAX_INDEX_BYTES) {
        // Listed and readable, not indexed. Any rows from a smaller earlier
        // version go too, so nothing stale is ever served for it.
        removeFile(relPath);
        oversized.add(relPath);
        return;
      }
      content = fs.readFileSync(fd, "utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return; // Deleted between event and read, or a symlink: either way, not indexed.
  }
  const parsed = parseNote(relPath, content);
  const d = db();
  const tx = d.transaction(() => {
    // The notes row's rowid keys the FTS row. `path` is UNINDEXED in FTS5, and
    // FTS5 accelerates only MATCH — an equality on any column is a scan of the
    // whole virtual table, measured at ~9x the cost of a rowid lookup at 2,600
    // notes and growing with the vault, on every write. The rowid is a real
    // key. This depends on the upsert being ON CONFLICT DO UPDATE, which keeps
    // the rowid; INSERT OR REPLACE would delete and reinsert, and the FTS row
    // would be orphaned. indexer-storage.test.ts pins both.
    const { rowid } = d
      .prepare(
        `INSERT INTO notes (path, title, mtime, size, frontmatter, word_count) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET title=excluded.title, mtime=excluded.mtime, size=excluded.size,
           frontmatter=excluded.frontmatter, word_count=excluded.word_count
         RETURNING rowid`,
      )
      .get(
        relPath,
        parsed.title,
        Math.round(st.mtimeMs),
        st.size,
        Object.keys(parsed.frontmatter).length ? JSON.stringify(parsed.frontmatter) : null,
        parsed.wordCount,
      ) as { rowid: number };
    d.prepare("DELETE FROM notes_fts WHERE rowid = ?").run(rowid);
    d.prepare("INSERT INTO notes_fts (rowid, path, title, headings, body) VALUES (?, ?, ?, ?, ?)").run(
      rowid,
      relPath,
      parsed.title,
      parsed.headings.join("\n"),
      parsed.body,
    );
    d.prepare("DELETE FROM links WHERE source_path = ?").run(relPath);
    const insLink = d.prepare(
      "INSERT OR IGNORE INTO links (source_path, target, resolved_path) VALUES (?, ?, NULL)",
    );
    for (const target of parsed.links) insLink.run(relPath, target);
    d.prepare("DELETE FROM tags WHERE path = ?").run(relPath);
    const insTag = d.prepare("INSERT OR IGNORE INTO tags (path, tag) VALUES (?, ?)");
    for (const tag of parsed.tags) insTag.run(relPath, tag);
    d.prepare("DELETE FROM tasks WHERE path = ?").run(relPath);
    const insTask = d.prepare("INSERT OR REPLACE INTO tasks (path, line, text, done) VALUES (?, ?, ?, ?)");
    for (const t of parsed.tasks) insTask.run(relPath, t.line, t.text, t.done ? 1 : 0);
  });
  tx();
  oversized.delete(relPath);
}

// Index a single path synchronously. Called right after a tool writes a note
// so index-backed tools (search, tasks, tags, links) see the change on the very
// next call instead of waiting for the watcher's debounce (~1s). The watcher
// still fires afterwards and is idempotent.
export function reindexPath(relPath: string) {
  try {
    const abs = path.join(env.vaultDir, relPath);
    if (!isSafeVaultPath(abs)) return;
    if (fs.existsSync(abs)) indexFile(relPath, abs);
    else removeFile(relPath);
    resolveLinksFor(relPath);
  } catch (e) {
    console.error("[indexer] reindexPath failed:", e);
  }
}

// Targeted link resolution for a single changed note: its own outgoing links,
// plus any currently-unresolved links vault-wide (a new note may resolve them).
// Whole-vault re-resolution is left to the debounced watcher path — doing it on
// every write would rescan every link row in the vault.
function resolveLinksFor(relPath: string) {
  const d = db();
  const { byPathLower, byBasename } = buildPathMaps(d);
  const rows = d
    .prepare("SELECT source_path, target FROM links WHERE source_path = ? OR resolved_path IS NULL")
    .all(relPath) as { source_path: string; target: string }[];
  const upd = d.prepare("UPDATE links SET resolved_path = ? WHERE source_path = ? AND target = ?");
  const tx = d.transaction(() => {
    for (const row of rows) {
      upd.run(resolveLink(row.target, byBasename, byPathLower), row.source_path, row.target);
    }
  });
  tx();
}

function buildPathMaps(d: ReturnType<typeof db>) {
  const paths = (
    d
      .prepare("SELECT path FROM notes UNION ALL SELECT path FROM attachments")
      .all() as { path: string }[]
  ).map((r) => r.path);
  const byPathLower = new Map<string, string>();
  const byBasename = new Map<string, string[]>();
  for (const p of paths) {
    byPathLower.set(p.toLowerCase(), p);
    const base = path.basename(p).toLowerCase();
    const arr = byBasename.get(base) ?? [];
    arr.push(p);
    byBasename.set(base, arr);
  }
  return { byPathLower, byBasename };
}

function removeFile(relPath: string) {
  const d = db();
  const tx = d.transaction(() => {
    // The FTS row is keyed by the note's rowid, so look it up before the note
    // row goes. An attachment has no FTS row and no notes row; nothing to do.
    const note = d.prepare("SELECT rowid FROM notes WHERE path = ?").get(relPath) as { rowid: number } | undefined;
    if (note) d.prepare("DELETE FROM notes_fts WHERE rowid = ?").run(note.rowid);
    d.prepare("DELETE FROM notes WHERE path = ?").run(relPath);
    d.prepare("DELETE FROM links WHERE source_path = ?").run(relPath);
    d.prepare("DELETE FROM tags WHERE path = ?").run(relPath);
    d.prepare("DELETE FROM tasks WHERE path = ?").run(relPath);
    d.prepare("DELETE FROM attachments WHERE path = ?").run(relPath);
  });
  tx();
  oversized.delete(relPath);
}

// Re-resolve every wikilink against the current set of notes. Cheap enough to
// run after any batch of changes (debounced).
function resolveAllLinks() {
  const d = db();
  const { byPathLower, byBasename } = buildPathMaps(d);
  const rows = d.prepare("SELECT source_path, target FROM links").all() as {
    source_path: string;
    target: string;
  }[];
  const upd = d.prepare("UPDATE links SET resolved_path = ? WHERE source_path = ? AND target = ?");
  const tx = d.transaction(() => {
    for (const row of rows) {
      upd.run(resolveLink(row.target, byBasename, byPathLower), row.source_path, row.target);
    }
  });
  tx();
}

// Attachments are tracked by path only — enough to resolve embeds.
function indexAttachment(relPath: string, absPath: string) {
  try {
    const st = fs.lstatSync(absPath);
    if (st.isSymbolicLink() || !st.isFile()) return;
    if (!isSafeVaultPath(absPath)) return;
    db()
      .prepare(
        `INSERT INTO attachments (path, mtime, size) VALUES (?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime, size=excluded.size`,
      )
      .run(relPath, Math.round(st.mtimeMs), st.size);
  } catch {
    // vanished between event and stat
  }
}

class VaultIndexer {
  private watcher: FSWatcher | null = null;
  private resolveTimer: ReturnType<typeof setTimeout> | null = null;
  private building: Promise<void> | null = null;
  lastFullIndexAt: number | null = null;
  // False until a full rebuild finishes, and false again while one is in
  // flight — the tables are wiped at the start of every rebuild, not only the
  // first. Index-backed tools still answer while warming; they just may see a
  // partial vault, and this is how they can tell.
  ready = false;

  private scheduleLinkResolve() {
    if (this.resolveTimer) clearTimeout(this.resolveTimer);
    this.resolveTimer = setTimeout(() => resolveAllLinks(), 1_000);
  }

  // Full rebuild, yielding to the event loop between batches. This used to be
  // one synchronous pass over every note: on a 2,600-note vault it blocked Node
  // for ~100s, so concurrent MCP requests hung and clients declared the server
  // dead. Callers can await it; readiness is exposed via `ready`.
  async rebuild(): Promise<void> {
    if (this.building) return this.building;
    this.building = (async () => {
      // Cleared before the wipe, not after the first build only. It used to be
      // set once and never unset, so a rebuild from the Status tab — which
      // empties every table and refills them over the better part of a minute
      // on a large vault — ran with `ready` reporting true throughout.
      this.ready = false;
      const d = db();
      // One transaction. A multi-statement exec is not atomic: each statement
      // commits on its own, so a failure mid-way left some tables empty and
      // others full. Wrapped, a failed wipe leaves the previous index intact.
      // The rebuild as a whole still is not atomic — it yields between batches
      // — and does not need to be; see the note on start().
      d.transaction(() =>
        d.exec(
          "DELETE FROM notes; DELETE FROM notes_fts; DELETE FROM links; DELETE FROM tags; DELETE FROM tasks; DELETE FROM attachments;",
        ),
      )();
      oversized.clear();
      const notes: string[] = [];
      const attachments: string[] = [];
      const walk = (dir: string, depth = 0) => {
        if (depth > 32) return;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (entry.name.startsWith(".")) continue;
          const abs = path.join(dir, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) walk(abs, depth + 1);
          else if (entry.isFile()) {
            (entry.name.toLowerCase().endsWith(".md") ? notes : attachments).push(abs);
          }
        }
      };
      walk(env.vaultDir);

      const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));
      for (let i = 0; i < notes.length; i++) {
        indexFile(toVaultRelative(notes[i]), notes[i]);
        if (i % 50 === 49) await yieldToLoop();
      }
      for (let i = 0; i < attachments.length; i++) {
        indexAttachment(toVaultRelative(attachments[i]), attachments[i]);
        if (i % 200 === 199) await yieldToLoop();
      }
      resolveAllLinks();
      this.lastFullIndexAt = Date.now();
      this.ready = true;
    })().finally(() => {
      this.building = null;
    });
    return this.building;
  }

  // Always rebuilds. This is the recovery model for the whole indexer, and it
  // is load-bearing: a note written by a tool and not yet indexed when the
  // process died, a rebuild interrupted part-way, a watcher event that never
  // fired — none of those paths is atomic, and none needs to be, because the
  // next boot recomputes everything from the vault. Nothing else reconciles;
  // mtime and size are stored but never compared. Removing this rebuild "for
  // performance" would remove the only repair there is. indexer-recovery.test.ts
  // pins it.
  async start(): Promise<void> {
    if (this.watcher) return;
    if (!fs.existsSync(env.vaultDir)) fs.mkdirSync(env.vaultDir, { recursive: true });
    this.watcher = chokidar.watch(env.vaultDir, {
      // Do NOT follow symlinks — the rebuild walk skips them too, and following
      // them here would let a synced symlink expose out-of-vault file contents
      // through the index.
      followSymlinks: false,
      ignored: (p: string) => {
        const rel = toVaultRelative(p);
        return rel.split("/").some((seg) => seg.startsWith("."));
      },
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
    });
    const onChange = (absPath: string) => {
      // Defense in depth: only index paths that are genuinely inside the vault
      // with no symlinked component (indexFile re-checks, but reject early).
      if (!isSafeVaultPath(absPath)) return;
      const rel = toVaultRelative(absPath);
      if (absPath.toLowerCase().endsWith(".md")) indexFile(rel, absPath);
      else indexAttachment(rel, absPath);
      this.scheduleLinkResolve();
    };
    this.watcher.on("add", onChange);
    this.watcher.on("change", onChange);
    this.watcher.on("unlink", (absPath: string) => {
      const rel = toVaultRelative(absPath);
      if (rel.startsWith("..") || path.isAbsolute(rel)) return;
      removeFile(rel);
      this.scheduleLinkResolve();
    });
    await this.rebuild();
  }

  async stop() {
    await this.watcher?.close();
    this.watcher = null;
  }
}

const globalKey = "__vaultIndexer";
export function indexer(): VaultIndexer {
  const g = globalThis as any;
  if (!g[globalKey]) g[globalKey] = new VaultIndexer();
  return g[globalKey];
}

let indexBootChecked = false;
// Fire-and-forget: kick the watcher + first rebuild off in the background so a
// request never waits on a full-vault scan. The rebuild yields to the event
// loop, so requests are served (against a partial index) while it warms.
export function ensureIndexerStarted() {
  if (indexBootChecked) return;
  indexBootChecked = true;
  // The disk watcher rides the same first-request hook: the other thing the
  // process should be doing from its first request onward.
  ensureDiskWatched();
  void indexer()
    .start()
    .catch((e) => console.error("[indexer] failed to start:", e));
}

export function indexerStatus() {
  const i = indexer();
  return { ready: i.ready, lastFullIndexAt: i.lastFullIndexAt, unindexedNotes: oversized.size };
}
