import Database from "better-sqlite3";
import { env, ensureDataDirs } from "./env";

let _db: Database.Database | undefined;

export function db(): Database.Database {
  if (!_db) {
    ensureDataDirs();
    _db = new Database(env.dbPath);
    _db.pragma("journal_mode = WAL");
    _db.pragma("foreign_keys = ON");
    migrate(_db);
  }
  return _db;
}

// App-owned tables. Better Auth manages its own tables in the same file via
// its runtime migrator (see auth.ts).
function migrate(d: Database.Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS notes (
      path TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL,
      frontmatter TEXT,          -- JSON object or null
      word_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
      path UNINDEXED,
      title,
      headings,
      body,
      tokenize = 'porter unicode61'
    );

    CREATE TABLE IF NOT EXISTS links (
      source_path TEXT NOT NULL,
      target TEXT NOT NULL,        -- raw link target as written
      resolved_path TEXT,          -- resolved note path, null if unresolved
      PRIMARY KEY (source_path, target)
    );
    CREATE INDEX IF NOT EXISTS idx_links_resolved ON links(resolved_path);

    -- Non-markdown vault files (images, PDFs, audio…). Tracked so that embeds
    -- like ![[Diagram.png]] resolve instead of being reported as broken links.
    CREATE TABLE IF NOT EXISTS attachments (
      path TEXT PRIMARY KEY,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tags (
      path TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (path, tag)
    );
    CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);

    CREATE TABLE IF NOT EXISTS tasks (
      path TEXT NOT NULL,
      line INTEGER NOT NULL,
      text TEXT NOT NULL,
      done INTEGER NOT NULL,
      PRIMARY KEY (path, line)
    );
  `);
}

export function getSetting(key: string): string | undefined {
  const row = db().prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string) {
  db()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`,
    )
    .run(key, value);
}

export function deleteSetting(key: string) {
  db().prepare("DELETE FROM settings WHERE key = ?").run(key);
}
