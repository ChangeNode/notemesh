import { describe, expect, it } from "vitest";
import { applyActivityLine } from "./supervisor";
import type { SyncActivity } from "../sync/types";

// The transfer counters shown on the Status tab are derived by scraping the
// sync daemon's output, which means they break silently whenever ob changes its
// wording. These pin the shapes we currently understand and, just as
// importantly, that unrecognised lines are ignored rather than miscounted.

function fresh(): SyncActivity {
  return { downloaded: 0, uploaded: 0, deleted: 0, startedAt: null, lastEventAt: null };
}

const T0 = 1_700_000_000_000;

describe("counts transfer events", () => {
  it("counts a download", () => {
    const a = fresh();
    applyActivityLine(a, "Downloaded Notes/Alpha.md", T0);
    expect(a.downloaded).toBe(1);
  });

  it("counts an upload", () => {
    // "Upload complete", not "Uploaded" — see COUNTS in supervisor.ts. This
    // test previously asserted a word ob never emits, which is how uploads
    // came to be permanently uncounted.
    const a = fresh();
    applyActivityLine(a, "Upload complete Notes/Alpha.md", T0);
    expect(a.uploaded).toBe(1);
  });

  it("counts a delete under either wording ob uses", () => {
    const a = fresh();
    applyActivityLine(a, "Deleting remote file Notes/Old.md", T0);
    applyActivityLine(a, "Removing local-only file Notes/Older.md", T0 + 1);
    expect(a.deleted).toBe(2);
  });

  it("accumulates across a burst", () => {
    const a = fresh();
    for (let i = 0; i < 5; i++) applyActivityLine(a, `Downloaded note-${i}.md`, T0 + i);
    expect(a.downloaded).toBe(5);
  });

  it("strips a leading timestamp prefix", () => {
    const a = fresh();
    applyActivityLine(a, "[2026-08-03T19:58:45.123Z] Downloaded Notes/Alpha.md", T0);
    expect(a.downloaded).toBe(1);
  });

  it("records when the burst started and when it last moved", () => {
    const a = fresh();
    applyActivityLine(a, "Downloaded a.md", T0);
    expect(a.startedAt).toBe(T0);
    applyActivityLine(a, "Downloaded b.md", T0 + 500);
    expect(a.lastEventAt).toBe(T0 + 500);
    expect(a.startedAt).toBe(T0);
  });
});

describe("ignores lines that are not transfer events", () => {
  it.each([
    "Fully synced",
    "Waiting to connect to server",
    "Connected",
    "Received signal to shut down...",
    "[supervisor] starting ob sync --continuous",
    "",
  ])("does not count %s", (line) => {
    const a = fresh();
    applyActivityLine(a, line, T0);
    expect(a).toEqual(fresh());
  });

  it("does not count a note whose name merely contains a keyword", () => {
    // The match is anchored to the start of the line, so a note called
    // "Downloaded music.md" being synced must not inflate the tally.
    const a = fresh();
    applyActivityLine(a, "Fully synced Downloaded music.md", T0);
    expect(a.downloaded).toBe(0);
  });
});

describe("burst boundaries", () => {
  it("resets the tally when a new sync announces itself", () => {
    const a = fresh();
    applyActivityLine(a, "Downloaded a.md", T0);
    applyActivityLine(a, "Upload complete b.md", T0 + 1);
    applyActivityLine(a, "Starting sync:", T0 + 2);
    expect(a).toMatchObject({ downloaded: 0, uploaded: 0, deleted: 0 });
    expect(a.startedAt).toBe(T0 + 2);
  });

  it("resets after a long enough silence, so an old burst doesn't accumulate forever", () => {
    const a = fresh();
    applyActivityLine(a, "Downloaded a.md", T0);
    // Well past the burst gap — this is a new burst that never said so.
    applyActivityLine(a, "Downloaded b.md", T0 + 60_000);
    expect(a.downloaded).toBe(1);
    expect(a.startedAt).toBe(T0 + 60_000);
  });

  it("keeps counting within the burst gap", () => {
    const a = fresh();
    applyActivityLine(a, "Downloaded a.md", T0);
    applyActivityLine(a, "Downloaded b.md", T0 + 5_000);
    expect(a.downloaded).toBe(2);
    expect(a.startedAt).toBe(T0);
  });

  it("treats a burst announcement as the start even with nothing before it", () => {
    const a = fresh();
    applyActivityLine(a, "Starting sync:", T0);
    expect(a.startedAt).toBe(T0);
    expect(a.lastEventAt).toBe(T0);
  });
});

describe("recognises the other event verbs without miscounting them", () => {
  it.each(["Downloading a.md", "Uploading b.md", "Merging c.md", "Merged c.md", "Accepted d.md"])(
    "treats %s as activity but not as a completed transfer",
    (line) => {
      const a = fresh();
      applyActivityLine(a, line, T0);
      // It marks the burst as live...
      expect(a.lastEventAt).toBe(T0);
      // ...without incrementing any completed-transfer counter.
      expect(a.downloaded + a.uploaded + a.deleted).toBe(0);
    },
  );
});

// The wording below is lifted from obsidian-headless 0.0.14's own log calls,
// not from what the words "ought" to be. The original parser assumed a
// consistent past tense; ob does not have one, so uploads and deletions were
// never counted at all while downloads were — which read as "sync isn't
// uploading anything" on a server that was uploading fine.
describe("counts the events ob actually emits", () => {
  it("counts a completed upload", () => {
    const a = fresh();
    applyActivityLine(a, "Upload complete Notes/Alpha.md", T0);
    expect(a.uploaded).toBe(1);
  });

  it("does not double-count the start and the end of one upload", () => {
    // Both lines are transfer activity, but only the completion is a file.
    const a = fresh();
    applyActivityLine(a, "Uploading file Notes/Alpha.md", T0);
    applyActivityLine(a, "Upload complete Notes/Alpha.md", T0 + 200);
    expect(a.uploaded).toBe(1);
  });

  it("treats an upload in progress as activity even though it counts nothing", () => {
    const a = fresh();
    applyActivityLine(a, "Uploading file Big.pdf", T0);
    expect(a.uploaded).toBe(0);
    expect(a.lastEventAt).toBe(T0);
    expect(a.startedAt).toBe(T0);
  });

  it.each(["Deleting remote file gone.md", "Removing local-only file stale.md"])(
    "counts %s as a deletion",
    (line) => {
      const a = fresh();
      applyActivityLine(a, line, T0);
      expect(a.deleted).toBe(1);
    },
  );

  it.each(["Deleting remote folder Old", "Removing local-only folder Scratch"])(
    "does not count %s, which is a folder",
    (line) => {
      const a = fresh();
      applyActivityLine(a, line, T0);
      expect(a.deleted).toBe(0);
      // Still activity — the daemon is working.
      expect(a.lastEventAt).toBe(T0);
    },
  );

  it("tallies a mixed burst", () => {
    const a = fresh();
    applyActivityLine(a, "Downloaded one.md", T0);
    applyActivityLine(a, "Uploading file two.md", T0 + 1);
    applyActivityLine(a, "Upload complete two.md", T0 + 2);
    applyActivityLine(a, "Deleting remote file three.md", T0 + 3);
    expect(a).toMatchObject({ downloaded: 1, uploaded: 1, deleted: 1 });
  });

  it("never counts the same line under two headings", () => {
    const a = fresh();
    applyActivityLine(a, "Downloaded x.md", T0);
    expect(a.downloaded + a.uploaded + a.deleted).toBe(1);
  });
});

// Sync Now underneath a running daemon.
//
// `ob sync` locks the vault, so a one-shot started while `ob sync --continuous`
// holds the lock fails with "Another sync instance is already running for this
// vault" — reported to the operator as a failed manual sync, for pressing a
// button that could not have worked and had nothing to do. The Status tab hides
// the button in this state; this is the half that covers a stale page and a
// direct call to the procedure.
describe("syncNow while the daemon is running", () => {
  it("answers instead of launching a second instance", async () => {
    const { supervisor } = await import("./supervisor");
    const sup = supervisor() as unknown as { child: unknown; getLogs(): { line: string }[] };
    const before = sup.child;
    // Stand in for a live child. Nothing is spawned: the point is that the
    // guard returns before obSyncOnce is reached, which a real `ob` would
    // otherwise have to be installed to prove.
    sup.child = { kill() {} };
    try {
      const res = await supervisor().syncNow();
      expect(res.ok).toBe(true);
      expect(res.output).toMatch(/already running/i);
      // Said in the log the operator is watching, not only returned.
      expect(sup.getLogs().at(-1)!.line).toMatch(/already running/i);
      // And not reported as an error, which is what the collision produced.
      expect(res.output).not.toMatch(/fail/i);
    } finally {
      sup.child = before;
    }
  });
});
