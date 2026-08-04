import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIMEZONE,
  formatDate,
  isValidTimeZone,
  partsFromISO,
  todayInZone,
} from "./daily";

// The bug these exist for: a container runs in UTC, so at 17:00 in California
// the process already believes it is tomorrow, and "today's" daily note lands
// on the wrong day. Every case below is a real instant chosen to straddle a
// date boundary somewhere.

describe("todayInZone", () => {
  it("gives the local date, not the server's", () => {
    // 2026-08-04 00:30 UTC is still 2026-08-03 in Los Angeles.
    const instant = new Date("2026-08-04T00:30:00Z");
    expect(todayInZone(instant, "America/Los_Angeles")).toMatchObject({
      year: 2026,
      month: 8,
      day: 3,
    });
    expect(todayInZone(instant, "UTC")).toMatchObject({ year: 2026, month: 8, day: 4 });
  });

  it("handles a zone that is ahead of UTC", () => {
    // 2026-08-03 23:30 UTC is already 2026-08-04 in Tokyo.
    const instant = new Date("2026-08-03T23:30:00Z");
    expect(todayInZone(instant, "Asia/Tokyo")).toMatchObject({ year: 2026, month: 8, day: 4 });
  });

  it("handles a half-hour offset", () => {
    const instant = new Date("2026-08-03T19:00:00Z");
    expect(todayInZone(instant, "Asia/Kolkata")).toMatchObject({ year: 2026, month: 8, day: 4 });
  });

  it("rolls the month and year over correctly", () => {
    const instant = new Date("2027-01-01T02:00:00Z");
    expect(todayInZone(instant, "America/New_York")).toMatchObject({
      year: 2026,
      month: 12,
      day: 31,
    });
  });

  it("respects daylight saving", () => {
    // 2026-07-01 is BST (+1); 2026-01-01 is GMT. Same wall-clock UTC hour,
    // different local dates.
    expect(todayInZone(new Date("2026-06-30T23:30:00Z"), "Europe/London")).toMatchObject({
      day: 1,
    });
    expect(todayInZone(new Date("2025-12-31T23:30:00Z"), "Europe/London")).toMatchObject({
      day: 31,
    });
  });

  it("computes the weekday from the local date", () => {
    // 2026-08-03 is a Monday.
    expect(todayInZone(new Date("2026-08-04T00:30:00Z"), "America/Los_Angeles").weekday).toBe(1);
    // ...while in UTC it is already Tuesday.
    expect(todayInZone(new Date("2026-08-04T00:30:00Z"), "UTC").weekday).toBe(2);
  });

  it("falls back to UTC rather than throwing on a bogus zone", () => {
    const instant = new Date("2026-08-04T00:30:00Z");
    expect(todayInZone(instant, "Mars/Olympus_Mons")).toMatchObject({ day: 4 });
  });
});

describe("partsFromISO", () => {
  it("takes an explicit date at face value", () => {
    // The whole point: an explicit date must never be re-interpreted through a
    // zone, or asking for 2026-08-03 in Los Angeles would hand back the 2nd.
    expect(partsFromISO("2026-08-03")).toEqual({ year: 2026, month: 8, day: 3, weekday: 1 });
  });

  it("gets the weekday right across a year boundary", () => {
    expect(partsFromISO("2027-01-01").weekday).toBe(5); // Friday
  });

  it("handles a leap day", () => {
    expect(partsFromISO("2028-02-29")).toMatchObject({ year: 2028, month: 2, day: 29 });
  });
});

describe("formatDate", () => {
  const d = partsFromISO("2026-08-03"); // a Monday

  it("formats the Obsidian default", () => {
    expect(formatDate(d, "YYYY-MM-DD")).toBe("2026-08-03");
  });

  it("formats long month and weekday names", () => {
    expect(formatDate(d, "dddd, MMMM D, YYYY")).toBe("Monday, August 3, 2026");
  });

  it("formats short forms", () => {
    expect(formatDate(d, "ddd MMM DD YY")).toBe("Mon Aug 03 26");
  });

  it("formats unpadded numbers", () => {
    expect(formatDate(d, "M/D/YYYY")).toBe("8/3/2026");
  });

  it("leaves separators and unknown characters alone", () => {
    expect(formatDate(d, "YYYY_MM_DD [note]")).toBe("2026_08_03 [note]");
  });

  it("pads single-digit months and days", () => {
    expect(formatDate(partsFromISO("2026-01-05"), "YYYY-MM-DD")).toBe("2026-01-05");
  });
});

describe("isValidTimeZone", () => {
  it.each(["UTC", "America/Los_Angeles", "Europe/London", "Asia/Tokyo", "Australia/Sydney"])(
    "accepts %s",
    (tz) => expect(isValidTimeZone(tz)).toBe(true),
  );

  it.each(["Mars/Olympus_Mons", "Not/A/Zone", ""])("rejects %s", (tz) =>
    expect(isValidTimeZone(tz)).toBe(false),
  );

  it("accepts legacy abbreviations, because Intl does", () => {
    // Documenting rather than endorsing. "PST" resolves to America/Los_Angeles
    // and behaves correctly, but "EST" resolves to America/Panama — a fixed -5
    // zone with no daylight saving, so it is an hour out for half the year.
    // Near midnight that is enough to pick the wrong day. The Settings tab
    // offers the browser's IANA zone precisely so nobody types these.
    expect(isValidTimeZone("PST")).toBe(true);
    expect(isValidTimeZone("EST")).toBe(true);
  });

  it("defaults to UTC", () => {
    expect(DEFAULT_TIMEZONE).toBe("UTC");
    expect(isValidTimeZone(DEFAULT_TIMEZONE)).toBe(true);
  });
});
