import { describe, expect, it } from "vitest";
import { arrange, parseInstant } from "./listing";
import { isoInZone } from "./modified";

// What a person types for modifiedAfter, and what order a listing comes back
// in. No vault: arrange takes the listing it is given.

const AKL = "Pacific/Auckland";

describe("parseInstant", () => {
  it("reads a bare date as midnight in the configured zone", () => {
    // Auckland is UTC+13 in January, so its midnight is 11:00 the day before in UTC.
    expect(parseInstant("2026-01-15", AKL)).toBe(Date.UTC(2026, 0, 14, 11, 0, 0));
    expect(parseInstant("2026-01-15", "UTC")).toBe(Date.UTC(2026, 0, 15, 0, 0, 0));
  });

  it("reads a timestamp without an offset on the zone's clock", () => {
    expect(parseInstant("2026-01-15T09:30", AKL)).toBe(Date.UTC(2026, 0, 14, 20, 30, 0));
    expect(parseInstant("2026-01-15 09:30:15", AKL)).toBe(Date.UTC(2026, 0, 14, 20, 30, 15));
  });

  it("takes a timestamp with its own offset or Z as written, whatever the zone", () => {
    expect(parseInstant("2026-01-15T09:30:00Z", AKL)).toBe(Date.UTC(2026, 0, 15, 9, 30, 0));
    expect(parseInstant("2026-01-15T09:30:00-07:00", AKL)).toBe(Date.UTC(2026, 0, 15, 16, 30, 0));
  });

  it("round-trips what a listing printed", () => {
    const ms = Date.UTC(2026, 6, 4, 19, 0, 0);
    expect(parseInstant(isoInZone(ms, "America/Los_Angeles"), "UTC")).toBe(ms);
  });

  it("crosses a daylight-saving change on the right side", () => {
    // Auckland leaves daylight time on Sunday 2026-04-05 at 03:00. Midnight
    // that day is still UTC+13, though the same digits read in UTC land after
    // the change, where the offset is +12: the second pass corrects that.
    expect(parseInstant("2026-04-05", AKL)).toBe(Date.UTC(2026, 3, 4, 11, 0, 0));
    expect(parseInstant("2026-04-06", AKL)).toBe(Date.UTC(2026, 3, 5, 12, 0, 0));
  });

  it("refuses a date that does not exist, and anything that is not a date", () => {
    expect(() => parseInstant("2026-02-30", "UTC")).toThrow(/not a real date/);
    expect(() => parseInstant("2026-01-15T25:00", "UTC")).toThrow(/not a real date/);
    expect(() => parseInstant("yesterday", "UTC")).toThrow(/ISO 8601 timestamp .* or a date/);
    expect(() => parseInstant("1700000000", "UTC")).toThrow(/ISO 8601/);
    expect(() => parseInstant("", "UTC")).toThrow(/ISO 8601/);
  });
});

function entry(path: string, modifiedMs: number, size: number, createdMs = modifiedMs - 100_000) {
  return { path, modified: isoInZone(modifiedMs, "UTC"), created: isoInZone(createdMs, "UTC"), size };
}

const T0 = Date.UTC(2026, 0, 1);
// d.md before a.md on purpose: they share a second, and a stable sort with
// no tie-break would keep this order instead of the path's.
const listing = [
  entry("d.md", T0 + 3000, 40, T0 - 4000),
  entry("b.md", T0 + 2000, 30, T0 - 1000),
  entry("a.md", T0 + 3000, 10, T0 - 3000),
  entry("c.md", T0 + 1000, 20, T0 - 2000),
];

describe("arrange", () => {
  it("is alphabetical by path unless asked otherwise", () => {
    expect(arrange(listing, {}, "UTC").map((e) => e.path)).toEqual(["a.md", "b.md", "c.md", "d.md"]);
    expect(arrange(listing, { sort: "name", order: "desc" }, "UTC").map((e) => e.path)).toEqual([
      "d.md",
      "c.md",
      "b.md",
      "a.md",
    ]);
  });

  it("by modified is newest first, ties by path, and asc turns it round", () => {
    expect(arrange(listing, { sort: "modified" }, "UTC").map((e) => e.path)).toEqual(["a.md", "d.md", "b.md", "c.md"]);
    expect(arrange(listing, { sort: "modified", order: "asc" }, "UTC").map((e) => e.path)).toEqual([
      "c.md",
      "b.md",
      "a.md",
      "d.md",
    ]);
  });

  it("by created is newest first, which need not be the modified order", () => {
    expect(arrange(listing, { sort: "created" }, "UTC").map((e) => e.path)).toEqual(["b.md", "c.md", "a.md", "d.md"]);
  });

  it("by size is largest first", () => {
    expect(arrange(listing, { sort: "size" }, "UTC").map((e) => e.path)).toEqual(["d.md", "b.md", "c.md", "a.md"]);
  });

  it("modifiedAfter keeps what changed strictly after the instant, in the configured zone", () => {
    const at = isoInZone(T0 + 2000, "UTC");
    expect(arrange(listing, { modifiedAfter: at }, "UTC").map((e) => e.path)).toEqual(["a.md", "d.md"]);
    // A bare date is midnight in the zone: Auckland's 2026-01-01 began 13
    // hours before T0, so everything is after it; UTC's began at T0 exactly,
    // and everything is after that too; 2026-01-02 in UTC excludes all.
    expect(arrange(listing, { modifiedAfter: "2026-01-01" }, AKL)).toHaveLength(4);
    expect(arrange(listing, { modifiedAfter: "2026-01-02" }, "UTC")).toHaveLength(0);
    // Auckland's 2026-01-02 begins at 11:00Z on the 1st — still after T0's few seconds.
    expect(arrange(listing, { modifiedAfter: "2026-01-02" }, AKL)).toHaveLength(0);
  });

  it("does not disturb the listing it was given", () => {
    const copy = listing.map((e) => ({ ...e }));
    arrange(listing, { sort: "size" }, "UTC");
    expect(listing).toEqual(copy);
  });
});
