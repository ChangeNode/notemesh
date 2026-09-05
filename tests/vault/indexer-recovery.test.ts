import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The indexer's recovery model, pinned.
 *
 * Nothing here is atomic across a crash — a tool's file write and its index
 * write, a rebuild interrupted between batches — and none of it needs to be,
 * because start() rebuilds the whole index on every boot. That single fact is
 * what repairs every partial state, and it is easy to remove in the name of a
 * faster boot without noticing what it was holding up. So it is a test.
 *
 * Alongside it: the readiness flag, which is the only way an index-backed
 * tool can tell a partial answer from a complete one, and the wipe at the top
 * of a rebuild, which must not be able to leave the tables half-cleared.
 */

let root: string;
let vault: string;

beforeEach(() => {
  // realpath: on macOS os.tmpdir() is /var/… symlinked to /private/var/…, and
  // the vault guard compares resolved paths.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "notemesh-recovery-")));
  vault = path.join(root, "vault");
  fs.mkdirSync(vault, { recursive: true });
  process.env.DATA_DIR = root;
  process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 5).toString("base64");
  // The indexer is a globalThis singleton that outlives resetModules.
  delete (globalThis as Record<string, unknown>).__vaultIndexer;
  vi.resetModules();
});

afterEach(async () => {
  // A started indexer holds a chokidar watcher; leave one open and the
  // process lingers.
  const g = globalThis as Record<string, unknown>;
  const live = g.__vaultIndexer as { stop?: () => Promise<void> } | undefined;
  await live?.stop?.();
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

function seed(n: number) {
  for (let i = 0; i < n; i++) {
    fs.writeFileSync(path.join(vault, `n${i}.md`), `# Note ${i}\n\nzebra content ${i}\n`);
  }
}

async function load() {
  const { indexer } = await import("~/server/vault/indexer");
  const { db } = await import("~/server/db");
  const notes = () => (db().prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number }).n;
  return { indexer, db, notes };
}

describe("readiness", () => {
  it("is false before the first rebuild and true after it", async () => {
    seed(5);
    const { indexer, notes } = await load();
    expect(indexer().ready).toBe(false);
    await indexer().rebuild();
    expect(indexer().ready).toBe(true);
    expect(notes()).toBe(5);
  });

  it("drops to false while a second rebuild is in flight, when the index is partial", async () => {
    // The "Rebuild Index" button. 400 notes so the rebuild has to yield at
    // least once; the sample is taken one tick in, past the wipe and into the
    // first batch — exactly where a search would answer from a mostly-empty
    // table. This used to report true throughout.
    seed(400);
    const { indexer, notes } = await load();
    await indexer().rebuild();
    expect(indexer().ready).toBe(true);
    expect(notes()).toBe(400);

    const second = indexer().rebuild();
    await new Promise((r) => setImmediate(r));
    expect(indexer().ready, "ready must be false mid-rebuild").toBe(false);
    expect(notes(), "the index is genuinely partial at this point").toBeLessThan(400);

    await second;
    expect(indexer().ready).toBe(true);
    expect(notes()).toBe(400);
  });

  it("advances lastFullIndexAt across a second rebuild", async () => {
    seed(3);
    const { indexer } = await load();
    await indexer().rebuild();
    const first = indexer().lastFullIndexAt!;
    await new Promise((r) => setTimeout(r, 5));
    await indexer().rebuild();
    expect(indexer().lastFullIndexAt!).toBeGreaterThan(first);
  });
});

describe("the boot rebuild", () => {
  it("start() rebuilds the whole index, unconditionally", async () => {
    // Notes exist before the indexer does, so nothing but a rebuild could have
    // put them in the tables — the watcher ignores what is already there.
    seed(12);
    const { indexer, notes } = await load();
    expect(notes()).toBe(0);
    await indexer().start();
    expect(notes()).toBe(12);
    expect(indexer().lastFullIndexAt).not.toBeNull();
    expect(indexer().ready).toBe(true);
  });
});

describe("the wipe at the top of a rebuild", () => {
  it("is one transaction: a failure mid-wipe leaves the previous index intact", async () => {
    seed(6);
    const { indexer, db, notes } = await load();
    await indexer().rebuild();
    expect(notes()).toBe(6);

    // Make the second statement of the wipe fail. Unwrapped, the first DELETE
    // has already committed by then and `notes` is empty; wrapped, the whole
    // wipe rolls back and the index is exactly what it was.
    const d = db();
    const real = d.exec.bind(d);
    const spy = vi.spyOn(d, "exec").mockImplementationOnce((sql: string) =>
      real(sql.replace("DELETE FROM notes_fts;", "DELETE FROM notes_fts; DELETE FROM no_such_table;")),
    );
    await expect(indexer().rebuild()).rejects.toThrow(/no such table/);
    spy.mockRestore();

    expect(notes(), "the wipe rolled back").toBe(6);
    // And the indexer is not wedged: the next rebuild is the ordinary one.
    await indexer().rebuild();
    expect(notes()).toBe(6);
    expect(indexer().ready).toBe(true);
  });
});

describe("a rebuild that fails", () => {
  it("is remembered until one succeeds", async () => {
    seed(3);
    const { indexer, db } = await load();
    const i = indexer();
    vi.spyOn(db(), "exec").mockImplementationOnce(() => {
      throw new Error("SQLITE_BUSY: simulated");
    });
    await expect(i.rebuild()).rejects.toThrow(/simulated/);
    const { indexerStatus } = await import("~/server/vault/indexer");
    expect(indexerStatus().lastRebuildError).toMatch(/simulated/);
    expect(indexerStatus().ready).toBe(false);
    await i.rebuild();
    expect(indexerStatus().lastRebuildError).toBeNull();
    expect(indexerStatus().ready).toBe(true);
  });
});

describe("a note that cannot be indexed", () => {
  it("is skipped, and the rest of the vault still indexes", async () => {
    seed(3);
    fs.writeFileSync(path.join(vault, "bad.md"), "# Bad\n");
    const { indexer, notes } = await load();
    // A failure indexFile does not swallow itself: its own guard covers the
    // open and the read, so the read of this one note hands back a non-string
    // and the parse that follows throws. The descriptor is matched at open
    // time and forgotten once used, since descriptor numbers are reused.
    let badFd = -1;
    const realOpen = fs.openSync;
    const realRead = fs.readFileSync;
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      const fd = (realOpen as any)(p, ...rest);
      if (String(p).endsWith("bad.md")) badFd = fd;
      return fd;
    }) as typeof fs.openSync);
    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(((p: unknown, ...rest: unknown[]) => {
      if (p === badFd) {
        badFd = -1;
        return null as unknown as string;
      }
      return (realRead as any)(p, ...rest);
    }) as typeof fs.readFileSync);
    try {
      await indexer().rebuild();
    } finally {
      openSpy.mockRestore();
      readSpy.mockRestore();
    }
    expect(indexer().ready).toBe(true);
    expect(indexer().lastRebuildError).toBeNull();
    expect(notes()).toBe(3);
  });
});
