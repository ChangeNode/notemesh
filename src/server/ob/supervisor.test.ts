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
    const a = fresh();
    applyActivityLine(a, "Uploaded Notes/Alpha.md", T0);
    expect(a.uploaded).toBe(1);
  });

  it("counts a delete under either wording ob uses", () => {
    const a = fresh();
    applyActivityLine(a, "Deleted Notes/Old.md", T0);
    applyActivityLine(a, "Removed Notes/Older.md", T0 + 1);
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
    applyActivityLine(a, "Uploaded b.md", T0 + 1);
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
