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
let timestampInZone: typeof import("./daily").timestampInZone;
let setSetting: typeof import("../db").setSetting;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ob-sync-unique-"));
  vault = path.join(root, "vault");
  fs.mkdirSync(vault, { recursive: true });
  process.env.DATA_DIR = root;
  ({ uniqueNote } = await import("./queries"));
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
