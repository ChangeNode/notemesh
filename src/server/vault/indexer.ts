import fs from "node:fs";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import matter from "gray-matter";
import { db } from "../db";
import { env } from "../env";
import { toVaultRelative, isSafeVaultPath, MAX_NOTE_BYTES } from "./paths";

// Parses one markdown note into everything the index stores.
export function parseNote(relPath: string, content: string) {
  let data: Record<string, unknown> = {};
  let body = content;
  try {
    const parsed = matter(content);
    data = parsed.data ?? {};
    body = parsed.content;
  } catch {
    // Bad frontmatter — index the raw content.
  }

  // Strip control chars and bidi overrides from the display title so a
  // maliciously-named synced file can't spoof UIs that render titles.
  const title = path
    .basename(relPath, ".md")
    .normalize("NFC")
    .replace(/[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "");
  const headings: string[] = [];
  const tags = new Set<string>();
  const links: string[] = [];
  const tasks: { line: number; text: string; done: boolean }[] = [];

  // Frontmatter tags (string or array).
  const fmTags = (data as any).tags ?? (data as any).tag;
  if (typeof fmTags === "string") {
    fmTags.split(/[,\s]+/).filter(Boolean).forEach((t) => tags.add(t.replace(/^#/, "")));
  } else if (Array.isArray(fmTags)) {
    fmTags.filter((t) => typeof t === "string").forEach((t) => tags.add(t.replace(/^#/, "")));
  }

  const lines = body.split("\n");
  // Frontmatter offset so task line numbers match the file on disk.
  const fmOffset = content.length === body.length ? 0 : content.slice(0, content.length - body.length).split("\n").length - 1;

  let inCodeBlock = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inCodeBlock = !inCodeBlock;
      return;
    }
    if (inCodeBlock) return;

    const h = line.match(/^#{1,6}\s+(.+)$/);
    if (h) headings.push(h[1].trim());

    for (const m of line.matchAll(/\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
      const target = m[1].trim();
      if (target) links.push(target);
    }

    for (const m of line.matchAll(/(^|\s)#([A-Za-z0-9_][A-Za-z0-9_/-]*)/g)) {
      // Obsidian requires at least one non-numeric character in a tag; a bare
      // "#1" in prose is not a tag.
      if (!/^\d+$/.test(m[2])) tags.add(m[2]);
    }

    const task = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
    if (task) {
      tasks.push({ line: i + 1 + fmOffset, text: task[2].trim(), done: task[1] !== " " });
    }
  });

  const wordCount = body.split(/\s+/).filter(Boolean).length;

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
  const withExt = t.toLowerCase().endsWith(".md") ? t : `${t}.md`;
  const exact = byPathLower.get(withExt.toLowerCase());
  if (exact) return exact;
  const base = path.basename(withExt).toLowerCase();
  const candidates = byBasename.get(base);
  return candidates && candidates.length > 0 ? candidates[0] : null;
}

function indexFile(relPath: string, absPath: string) {
  let content: string;
  let st: fs.Stats;
  try {
    // Never follow a symlink into the target's contents (would let a synced
    // symlink like `x.md -> /etc/passwd` be read and served via search), and
    // cap the size so a huge synced file can't OOM the process.
    const ls = fs.lstatSync(absPath);
    if (ls.isSymbolicLink() || !ls.isFile()) return;
    if (ls.size > MAX_NOTE_BYTES) return;
    if (!isSafeVaultPath(absPath)) return;
    content = fs.readFileSync(absPath, "utf8");
    st = ls;
  } catch {
    return; // Deleted between event and read.
  }
  const parsed = parseNote(relPath, content);
  const d = db();
  const tx = d.transaction(() => {
    d.prepare(
      `INSERT INTO notes (path, title, mtime, size, frontmatter, word_count) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET title=excluded.title, mtime=excluded.mtime, size=excluded.size,
         frontmatter=excluded.frontmatter, word_count=excluded.word_count`,
    ).run(
      relPath,
      parsed.title,
      Math.round(st.mtimeMs),
      st.size,
      Object.keys(parsed.frontmatter).length ? JSON.stringify(parsed.frontmatter) : null,
      parsed.wordCount,
    );
    d.prepare("DELETE FROM notes_fts WHERE path = ?").run(relPath);
    d.prepare("INSERT INTO notes_fts (path, title, headings, body) VALUES (?, ?, ?, ?)").run(
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
}

function removeFile(relPath: string) {
  const d = db();
  const tx = d.transaction(() => {
    d.prepare("DELETE FROM notes WHERE path = ?").run(relPath);
    d.prepare("DELETE FROM notes_fts WHERE path = ?").run(relPath);
    d.prepare("DELETE FROM links WHERE source_path = ?").run(relPath);
    d.prepare("DELETE FROM tags WHERE path = ?").run(relPath);
    d.prepare("DELETE FROM tasks WHERE path = ?").run(relPath);
  });
  tx();
}

// Re-resolve every wikilink against the current set of notes. Cheap enough to
// run after any batch of changes (debounced).
function resolveAllLinks() {
  const d = db();
  const paths = (d.prepare("SELECT path FROM notes").all() as { path: string }[]).map((r) => r.path);
  const byPathLower = new Map<string, string>();
  const byBasename = new Map<string, string[]>();
  for (const p of paths) {
    byPathLower.set(p.toLowerCase(), p);
    const base = path.basename(p).toLowerCase();
    const arr = byBasename.get(base) ?? [];
    arr.push(p);
    byBasename.set(base, arr);
  }
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

class VaultIndexer {
  private watcher: FSWatcher | null = null;
  private resolveTimer: ReturnType<typeof setTimeout> | null = null;
  lastFullIndexAt: number | null = null;

  private scheduleLinkResolve() {
    if (this.resolveTimer) clearTimeout(this.resolveTimer);
    this.resolveTimer = setTimeout(() => resolveAllLinks(), 1_000);
  }

  rebuild() {
    const d = db();
    d.exec("DELETE FROM notes; DELETE FROM notes_fts; DELETE FROM links; DELETE FROM tags; DELETE FROM tasks;");
    const walk = (dir: string) => {
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
        if (entry.isDirectory()) walk(abs);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
          indexFile(toVaultRelative(abs), abs);
        }
      }
    };
    walk(env.vaultDir);
    resolveAllLinks();
    this.lastFullIndexAt = Date.now();
  }

  start() {
    if (this.watcher) return;
    if (!fs.existsSync(env.vaultDir)) fs.mkdirSync(env.vaultDir, { recursive: true });
    this.rebuild();
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
      if (!absPath.toLowerCase().endsWith(".md")) return;
      // Defense in depth: only index paths that are genuinely inside the vault
      // with no symlinked component (indexFile re-checks, but reject early).
      if (!isSafeVaultPath(absPath)) return;
      indexFile(toVaultRelative(absPath), absPath);
      this.scheduleLinkResolve();
    };
    this.watcher.on("add", onChange);
    this.watcher.on("change", onChange);
    this.watcher.on("unlink", (absPath: string) => {
      if (!absPath.toLowerCase().endsWith(".md")) return;
      const rel = toVaultRelative(absPath);
      if (rel.startsWith("..") || path.isAbsolute(rel)) return;
      removeFile(rel);
      this.scheduleLinkResolve();
    });
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
export function ensureIndexerStarted() {
  if (indexBootChecked) return;
  indexBootChecked = true;
  try {
    indexer().start();
  } catch (e) {
    console.error("[indexer] failed to start:", e);
  }
}
