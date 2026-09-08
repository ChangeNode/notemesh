import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The operations that scale with the vault, timed against a vault big enough
 * to show it: two thousand notes in forty folders, three links each. The
 * bounds are loose on purpose — an order of magnitude above a laptop — so a
 * slow CI runner passes and only a change in complexity fails. Where the
 * work can be counted rather than timed, it is: the link rewriter opens only
 * the notes that link, and that number is asserted exactly.
 *
 * Timings are appended to the file named by PERF_LOG when it is set, for a
 * human to read.
 */

const NOTES = 2000;
const FOLDERS = 40;
const PER_FOLDER = NOTES / FOLDERS;

let root: string;
let vault: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "notemesh-perf-")));
  vault = path.join(root, "vault");
  fs.mkdirSync(vault, { recursive: true });
  process.env.DATA_DIR = root;
  process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 8).toString("base64");
  vi.resetModules();
  delete (globalThis as Record<string, unknown>).__vaultIndexer;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

function note(folder: number, i: number) {
  return `F${String(folder).padStart(2, "0")}/note-${String(i).padStart(4, "0")}.md`;
}

/** Every note links to the next three in the vault, by bare name, crossing folder boundaries. */
function seedVault() {
  for (let n = 0; n < NOTES; n++) {
    const rel = note(Math.floor(n / PER_FOLDER), n);
    const links = [1, 2, 3].map((k) => `[[${path.basename(note(0, (n + k) % NOTES), ".md")}]]`).join(" ");
    const abs = path.join(vault, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `# Note ${n}\n\nSome body text, zebra number ${n}. ${links}\n`);
  }
}

async function indexAll() {
  const { indexer } = await import("~/server/vault/indexer");
  await indexer().rebuild();
}

async function timed<T>(label: string, fn: () => T | Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  const value = await fn();
  const ms = performance.now() - t0;
  if (process.env.PERF_LOG) fs.appendFileSync(process.env.PERF_LOG, `${label}: ${ms.toFixed(0)} ms\n`);
  return { ms, value };
}

describe("a 2,000-note vault", () => {
  it("indexes, lists, searches, and finds within bounds", async () => {
    seedVault();
    const index = await timed("full index of 2,000 notes", indexAll);
    expect(index.ms).toBeLessThan(30_000);

    const { listDirectory } = await import("~/server/vault/directory");
    const { listNotes } = await import("~/server/vault/notes");
    const { arrange } = await import("~/server/vault/listing");
    const dir = await timed("list_directory at the root (40 folder rows from the index)", () => listDirectory());
    expect(dir.value).toHaveLength(FOLDERS);
    expect(dir.ms).toBeLessThan(1_000);
    const list = await timed("list_notes sorted by modified with a name glob", () =>
      arrange(listNotes(), { sort: "modified", name: "note-1*" }, "UTC"),
    );
    expect(list.value.length).toBeGreaterThan(0);
    expect(list.ms).toBeLessThan(2_000);

    const { searchVault } = await import("~/server/vault/queries");
    const search = await timed("search narrowed by folder, sorted by modified", () =>
      searchVault("zebra", { folder: "F07", sort: "modified", modifiedAfter: "2000-01-01" }),
    );
    expect(search.value.total).toBe(PER_FOLDER);
    expect(search.ms).toBeLessThan(1_000);

    // One note of fifty thousand lines.
    const big = "Big.md";
    fs.writeFileSync(
      path.join(vault, big),
      Array.from({ length: 50_000 }, (_, i) => `line ${i} of a long note with words`).join("\n") + "\n",
    );
    const { findInNote } = await import("~/server/vault/notes");
    const literal = await timed("find_in_note literal over 50,000 lines", () => findInNote(big, "line 4999"));
    expect(literal.value.matches.length).toBeGreaterThan(0);
    expect(literal.ms).toBeLessThan(2_000);
    // One page of a note that is a single nine-million-character line, under the read cap.
    fs.writeFileSync(path.join(vault, "Line.md"), "a".repeat(9_000_000) + "\n");
    const line = await timed("find_in_note over a 9 MB single line, one page", () => findInNote("Line.md", "a", { limit: 50 }));
    expect(line.value.total).toBe(10_000);
    expect(line.value.matches).toHaveLength(50);
    expect(line.ms).toBeLessThan(3_000);
  }, 120_000);

  it("moves a folder of 50 notes with links from everywhere, opening only the notes that link", async () => {
    seedVault();
    await indexAll();
    const { moveFolder } = await import("~/server/vault/folders");
    const { reindexPath } = await import("~/server/vault/indexer");
    const { db } = await import("~/server/db");

    // Who links into F07? Every note whose links resolve there.
    const linking = (
      db()
        .prepare("SELECT DISTINCT source_path AS p FROM links WHERE substr(resolved_path, 1, 4) = 'F07/'")
        .all() as { p: string }[]
    ).map((r) => r.p);
    expect(linking.length).toBeGreaterThanOrEqual(PER_FOLDER);

    const opens = vi.spyOn(fs, "openSync");
    const move = await timed("move_folder of 50 notes (rename and link rewrite)", () => moveFolder("F07", "Archive/F07"));
    const rewriteOpens = opens.mock.calls.length;
    opens.mockRestore();
    expect(move.value.moved.size).toBe(PER_FOLDER);
    // Bare-name links keep their text, and the seed writes only those: the
    // rewriter reads each linking note once and writes none of them.
    expect(move.value.rewritten.links).toBe(0);
    expect(rewriteOpens).toBeLessThanOrEqual(linking.length + 2);
    expect(move.ms).toBeLessThan(3_000);

    const reindex = await timed("reindex after the move (100 paths)", () => {
      for (const [a, b] of move.value.moved) {
        reindexPath(a);
        reindexPath(b);
      }
    });
    expect(reindex.ms).toBeLessThan(10_000);
    const { unresolvedLinks } = await import("~/server/vault/queries");
    expect(unresolvedLinks()).toEqual([]);
  }, 120_000);

  it("renames a hub note that a thousand notes link to by path, rewriting all of them", async () => {
    seedVault();
    // A thousand notes carry a path-form link to the hub, which must change.
    fs.writeFileSync(path.join(vault, "F00/Hub.md"), "# Hub\n");
    for (let n = 0; n < 1000; n++) {
      const abs = path.join(vault, note(Math.floor(n / PER_FOLDER), n));
      fs.appendFileSync(abs, "\nsee [[F00/Hub]]\n");
    }
    await indexAll();
    const { moveNote } = await import("~/server/vault/notes");
    const { rewriteLinksForMove } = await import("~/server/vault/links");
    const { reindexPath } = await import("~/server/vault/indexer");

    moveNote("F00/Hub.md", "F01/Hub.md");
    const opens = vi.spyOn(fs, "openSync");
    const rewrite = await timed("rewrite 1,000 path links across 1,000 notes", () =>
      rewriteLinksForMove("F00/Hub.md", "F01/Hub.md"),
    );
    const n = opens.mock.calls.length;
    opens.mockRestore();
    expect(rewrite.value.links).toBe(1000);
    expect(rewrite.value.notes).toHaveLength(1000);
    // One read and one write per linking note, nothing else.
    expect(n).toBeLessThanOrEqual(2 * 1000 + 2);
    expect(rewrite.ms).toBeLessThan(5_000);

    const reindex = await timed("reindex the 1,000 rewritten notes", () => {
      reindexPath("F00/Hub.md");
      reindexPath("F01/Hub.md");
      for (const rel of rewrite.value.notes) reindexPath(rel);
    });
    expect(reindex.ms).toBeLessThan(60_000);
  }, 180_000);

  it("parses a long git history quickly", async () => {
    const { parseGitHistory } = await import("~/server/vault/modified");
    // Twenty thousand commits touching three notes each.
    const chunks: string[] = [];
    for (let c = 0; c < 20_000; c++) {
      chunks.push(
        `\0${1_700_000_000 - c * 60}\n${note(c % FOLDERS, c % NOTES)}\n${note((c + 1) % FOLDERS, (c + 1) % NOTES)}\n${note((c + 2) % FOLDERS, (c + 2) % NOTES)}\n\n`,
      );
    }
    const text = chunks.join("");
    const parse = await timed("parse a 20,000-commit log", () => parseGitHistory(text));
    expect(parse.value.modified.size).toBe(NOTES);
    expect(parse.ms).toBeLessThan(1_000);
  });
});
