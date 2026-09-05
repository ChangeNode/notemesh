import { describe, expect, it } from "vitest";
import {
  alertsFrom,
  capBlocks,
  ALERT_PREFIX,
  MAX_ALERT_BLOCKS,
  BACKOFF_ERROR_MS,
  type AlertSnapshot,
} from "./alerts";

// The rules, against snapshots rather than a live server: every condition,
// the severity order, the cap, and — the one that is easy to lose — that the
// wording holds still while a condition holds.

const NOW = 1_800_000_000_000;

function healthy(over: Partial<AlertSnapshot> = {}): AlertSnapshot {
  return {
    sync: { kind: "git", state: "running", restartCount: 0, stateSince: NOW - 60_000 },
    vaultConfigured: true,
    extraAdmins: 0,
    credentialsUnreadable: false,
    index: { ready: true, lastRebuildError: null, unindexedNotes: 0 },
    disk: "ok",
    originMismatch: null,
    insecureBaseUrl: false,
    now: NOW,
    ...over,
  };
}

const texts = (s: AlertSnapshot) => alertsFrom(s).map((a) => a.text);

describe("alertsFrom", () => {
  it("says nothing about a healthy server", () => {
    expect(alertsFrom(healthy())).toEqual([]);
  });

  it("names the backend whose credentials were rejected, as an error", () => {
    const git = healthy({ sync: { kind: "git", state: "needs-reauth", restartCount: 0, stateSince: NOW } });
    expect(alertsFrom(git)).toEqual([{ level: "error", text: expect.stringMatching(/the git credentials were rejected/) }]);
    const ob = healthy({ sync: { kind: "obsidian", state: "needs-reauth", restartCount: 0, stateSince: NOW } });
    expect(texts(ob)[0]).toMatch(/the Obsidian credentials were rejected/);
  });

  it("tells an unreadable credential apart from a rejected one", () => {
    // Re-entering the same password fixes one and does nothing for the other.
    const s = healthy({ credentialsUnreadable: true });
    expect(alertsFrom(s)).toEqual([{ level: "error", text: expect.stringMatching(/encryption key has changed/) }]);
  });

  it("treats a fresh backoff as a warning and a long one as an error", () => {
    const fresh = healthy({ sync: { kind: "git", state: "backoff", restartCount: 2, stateSince: NOW - 60_000 } });
    expect(alertsFrom(fresh)).toEqual([{ level: "warn", text: expect.stringMatching(/failing and retrying/) }]);
    const long = healthy({
      sync: { kind: "git", state: "backoff", restartCount: 9, stateSince: NOW - 2 * BACKOFF_ERROR_MS - 1 },
    });
    expect(alertsFrom(long)).toEqual([{ level: "error", text: expect.stringMatching(/failing for over 30 minutes/) }]);
    // No stateSince at all reads as fresh, never as forever.
    const unknown = healthy({ sync: { kind: "git", state: "backoff", restartCount: 2, stateSince: null } });
    expect(alertsFrom(unknown)[0].level).toBe("warn");
  });

  it("keeps the wording still while a condition holds", () => {
    // A minute later and one more restart: the same text, so a model that
    // already mentioned it sees nothing new to mention.
    const a = healthy({ sync: { kind: "git", state: "backoff", restartCount: 6, stateSince: NOW - 60_000 } });
    const b = healthy({
      sync: { kind: "git", state: "backoff", restartCount: 7, stateSince: NOW - 60_000 },
      now: NOW + 60_000,
    });
    expect(texts(a)).toEqual(texts(b));
  });

  it("says no vault is linked, once, either way it can tell", () => {
    expect(texts(healthy({ vaultConfigured: false }))).toEqual([expect.stringMatching(/no vault is linked/)]);
    const both = healthy({
      vaultConfigured: false,
      sync: { kind: "git", state: "needs-setup", restartCount: 0, stateSince: NOW },
    });
    expect(texts(both)).toHaveLength(1);
  });

  it("reports more than one admin account as an error, with the count", () => {
    expect(alertsFrom(healthy({ extraAdmins: 2 }))).toEqual([
      { level: "error", text: expect.stringMatching(/3 admin accounts and should have exactly one/) },
    ]);
  });

  it("reports the disk at two levels", () => {
    expect(alertsFrom(healthy({ disk: "warn" }))).toEqual([
      { level: "warn", text: expect.stringMatching(/under 100 MB free/) },
    ]);
    expect(alertsFrom(healthy({ disk: "critical" }))).toEqual([
      { level: "error", text: expect.stringMatching(/under 50 MB free.*refused/) },
    ]);
    expect(alertsFrom(healthy({ disk: null }))).toEqual([]);
  });

  it("reports the index: failed, rebuilding, and notes too large to index", () => {
    // A failed rebuild leaves ready false too: one block, the actionable one,
    // not a second saying it is rebuilding.
    expect(alertsFrom(healthy({ index: { ready: false, lastRebuildError: "boom", unindexedNotes: 0 } }))).toEqual([
      { level: "error", text: expect.stringMatching(/failed to rebuild/) },
    ]);
    expect(alertsFrom(healthy({ index: { ready: false, lastRebuildError: null, unindexedNotes: 0 } }))).toEqual([
      { level: "warn", text: expect.stringMatching(/index is rebuilding/) },
    ]);
    expect(alertsFrom(healthy({ index: { ready: true, lastRebuildError: null, unindexedNotes: 3 } }))).toEqual([
      { level: "warn", text: expect.stringMatching(/3 note\(s\) exceed the index size limit/) },
    ]);
  });

  it("reports the two origin problems", () => {
    const s = healthy({
      originMismatch: { configured: "https://a.example", reachedAt: "b.example" },
      insecureBaseUrl: true,
    });
    expect(texts(s)).toEqual([
      expect.stringMatching(/configured as https:\/\/a\.example but reached at b\.example/),
      expect.stringMatching(/BASE_URL is http:\/\//),
    ]);
  });

  it("orders errors before warnings, whatever their place in the list", () => {
    // A fresh backoff is a warning and is listed before the disk; the disk at
    // critical is an error and must still come first.
    const s = healthy({
      sync: { kind: "git", state: "backoff", restartCount: 1, stateSince: NOW - 1000 },
      disk: "critical",
      index: { ready: false, lastRebuildError: null, unindexedNotes: 0 },
      insecureBaseUrl: true,
    });
    const alerts = alertsFrom(s);
    expect(alerts.map((a) => a.level)).toEqual(["error", "warn", "warn", "warn"]);
    expect(alerts[0].text).toMatch(/under 50 MB/);
    expect(alerts[1].text).toMatch(/failing and retrying/);
    expect(alerts[2].text).toMatch(/index is rebuilding/);
  });

  it("prefixes every alert the same way", () => {
    const everything = healthy({
      sync: { kind: "obsidian", state: "needs-reauth", restartCount: 0, stateSince: NOW },
      vaultConfigured: false,
      extraAdmins: 1,
      credentialsUnreadable: true,
      index: { ready: false, lastRebuildError: "x", unindexedNotes: 1 },
      disk: "critical",
      originMismatch: { configured: "https://a", reachedAt: "b" },
      insecureBaseUrl: true,
    });
    const all = alertsFrom(everything);
    // Ten conditions, nine blocks: a failed rebuild leaves the index not
    // ready too, and that is one alert, not two.
    expect(all.length).toBe(9);
    for (const a of all) expect(a.text.startsWith(`${ALERT_PREFIX} `), a.text).toBe(true);
  });
});

describe("capBlocks", () => {
  it("passes a short list through unchanged", () => {
    expect(capBlocks(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("keeps the cap and says how many were left out", () => {
    const capped = capBlocks(["a", "b", "c", "d", "e"]);
    expect(capped).toHaveLength(MAX_ALERT_BLOCKS);
    expect(capped.slice(0, 2)).toEqual(["a", "b"]);
    expect(capped[2]).toBe(`${ALERT_PREFIX} and 3 more on the Status tab.`);
  });
});
