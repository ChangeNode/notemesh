import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// unique_note names a note after the minute it was created. The first timezone
// fix added a zone-aware helper and pointed daily notes at it, but unique_note
// kept formatting its own stamp from Date's local getters — so in a UTC
// container every Zettelkasten note created after 5pm Pacific was named for
// tomorrow, while daily notes were correct.
//
// A test on the helper alone would not have caught that: the helper was fine
// and the caller simply wasn't using it. So these drive uniqueNote itself and
// check it against the configured zone.

let root: string;
let vault: string;
let uniqueNote: typeof import("./queries").uniqueNote;
let splitHighlights: typeof import("./queries").splitHighlights;
let timestampInZone: typeof import("./daily").timestampInZone;
let setSetting: typeof import("../db").setSetting;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "notemesh-unique-"));
  vault = path.join(root, "vault");
  fs.mkdirSync(vault, { recursive: true });
  process.env.DATA_DIR = root;
  ({ uniqueNote, splitHighlights } = await import("./queries"));
  ({ timestampInZone } = await import("./daily"));
  ({ setSetting } = await import("../db"));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

beforeEach(() => {
  for (const f of fs.readdirSync(vault)) fs.rmSync(path.join(vault, f), { force: true });
});

// The clock can cross a minute boundary between creating the note and checking
// it, so accept the stamp for either side of the boundary.
function acceptableStamps(tz: string): string[] {
  const now = Date.now();
  return [
    timestampInZone(new Date(now - 60_000), tz),
    timestampInZone(new Date(now), tz),
    timestampInZone(new Date(now + 60_000), tz),
  ];
}

describe("uniqueNote", () => {
  it.each([
    "UTC",
    "America/Los_Angeles",
    "Pacific/Kiritimati", // UTC+14 — a different calendar day from UTC much of the time
    "Etc/GMT+12", // UTC-12, the other extreme
  ])("stamps the name in the configured zone (%s)", (tz) => {
    setSetting("timezone", tz);
    const created = uniqueNote("body");
    const stamp = created.replace(/\.md$/, "");
    expect(acceptableStamps(tz)).toContain(stamp);
  });

  it("produces a different name in zones a day apart", () => {
    // The decisive check: two zones 26 hours apart cannot agree on the stamp,
    // so a uniqueNote that ignored the setting would return the same one twice.
    // Compare the stamp alone, not the filename: two notes in the same minute
    // collide and the second gets a random suffix, which would make the names
    // differ even when the stamps agree.
    setSetting("timezone", "Pacific/Kiritimati");
    const a = uniqueNote("a").slice(0, 12);
    setSetting("timezone", "Etc/GMT+12");
    const b = uniqueNote("b").slice(0, 12);
    expect(a).not.toBe(b);
  });

  it("uses Obsidian's YYYYMMDDHHmm shape", () => {
    setSetting("timezone", "UTC");
    expect(uniqueNote("x")).toMatch(/^\d{12}\.md$/);
  });

  it("writes the note it names", () => {
    setSetting("timezone", "UTC");
    const created = uniqueNote("hello");
    expect(fs.readFileSync(path.join(vault, created), "utf8")).toContain("hello");
  });

  it("suffixes rather than overwriting when the minute already has a note", () => {
    setSetting("timezone", "UTC");
    const first = uniqueNote("one");
    const second = uniqueNote("two");
    expect(second).not.toBe(first);
    expect(second).toMatch(/^\d{12}-[0-9a-f]{4}\.md$/);
    // The first note must survive intact.
    expect(fs.readFileSync(path.join(vault, first), "utf8")).toContain("one");
  });
});

// Search snippets used to come back with FTS5's highlight delimiters inline and
// undocumented — "polls, rolls, >>leaderboards<<" — so every consumer either
// knew to strip them or passed them downstream into whatever it produced. The
// markers are parsed off now, and what matched is returned as its own field:
// stemming means the matched word is often not the queried one, and nothing
// else recovers it.
const S = "\u0001";
const E = "\u0002";
// eslint-disable-next-line no-control-regex -- asserts the sanitizer strips control characters
const CONTROL = /[\u0001\u0002]/;

describe("splitHighlights", () => {
  it("returns a snippet free of markup", () => {
    const r = splitHighlights(`polls, rolls, ${S}leaderboards${E}`);
    expect(r.snippet).toBe("polls, rolls, leaderboards");
    expect(r.snippet).not.toMatch(CONTROL);
  });

  it("reports which words matched", () => {
    const r = splitHighlights(`${S}polls${E}, rolls, ${S}leaderboards${E}`);
    expect(r.matches).toEqual(["polls", "leaderboards"]);
  });

  it("deduplicates a term that matched more than once", () => {
    const r = splitHighlights(`${S}roll${E} and another ${S}roll${E}`);
    expect(r.matches).toEqual(["roll"]);
    expect(r.snippet).toBe("roll and another roll");
  });

  it("leaves an unmatched snippet alone", () => {
    expect(splitHighlights("no matches here")).toEqual({
      snippet: "no matches here",
      matches: [],
    });
  });

  it("does not mistake note content for a marker", () => {
    // Why the delimiters are control characters. With >> and <<, a note
    // containing a shell redirect or an ASCII arrow was indistinguishable from
    // a highlight, and stripping one meant eating the other.
    const r = splitHighlights(`run cmd >> log.txt and ${S}search${E} it`);
    expect(r.snippet).toBe("run cmd >> log.txt and search it");
    expect(r.matches).toEqual(["search"]);
  });

  it("strips a marker left unpaired by truncation", () => {
    // FTS5 can cut a snippet mid-highlight; a stray control character must not
    // reach the caller.
    const r = splitHighlights(`… some text ${S}partial`);
    expect(r.snippet).toBe("… some text partial");
    expect(r.snippet).not.toMatch(CONTROL);
  });

  it("preserves the ellipsis FTS5 puts between fragments", () => {
    expect(splitHighlights(`start … ${S}term${E} … end`).snippet).toBe("start … term … end");
  });

  it("never leaks a control character, whatever the input", () => {
    for (const raw of [S, E, `${E}${S}`, `${S}${E}`, `a${S}b${S}c${E}d`, ""]) {
      expect(splitHighlights(raw).snippet).not.toMatch(CONTROL);
    }
  });
});

// vaultInfo's syncNote told every deployment its writes propagate "via Obsidian
// Sync", including git-backed ones that have never touched Obsidian. Found by
// running the git backend against a real GitHub repo and reading the tool
// output, not by a test — nothing asserted the sentence at all.
describe("vaultInfo sync note", () => {
  let vaultInfo: typeof import("./queries").vaultInfo;

  beforeAll(async () => {
    ({ vaultInfo } = await import("./queries"));
  });

  it("names git when that is the backend", () => {
    setSetting("sync_backend", "git");
    const note = vaultInfo().syncNote;
    expect(note).toMatch(/commit and push/i);
    expect(note).not.toMatch(/Obsidian Sync/i);
  });

  it("names Obsidian Sync when that is the backend", () => {
    setSetting("sync_backend", "obsidian");
    expect(vaultInfo().syncNote).toMatch(/Obsidian Sync/i);
  });

  it("still says writes land immediately either way", () => {
    // The part that stops someone checking another copy of the vault and
    // concluding the write was lost.
    for (const backend of ["git", "obsidian"]) {
      setSetting("sync_backend", backend);
      expect(vaultInfo().syncNote).toMatch(/immediately/i);
    }
  });
});
