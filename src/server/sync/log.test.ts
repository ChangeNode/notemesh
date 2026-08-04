import { describe, expect, it } from "vitest";
import { LogRing, MAX_LOG_LINES, appendLogLine, logLinesOf, type LogLine } from "./types";

// `ob sync --continuous` logs "Fully synced" at the end of every polling pass —
// about twice a minute, indefinitely. Stored verbatim that is the entire buffer
// within hours, and any real event has scrolled out of the window an operator
// can see. These pin the collapsing that keeps the window useful.

describe("appendLogLine", () => {
  it("keeps distinct lines separate", () => {
    const lines: LogLine[] = [];
    appendLogLine(lines, "Starting sync");
    appendLogLine(lines, "Downloaded a.md");
    expect(lines.map((l) => l.line)).toEqual(["Starting sync", "Downloaded a.md"]);
    expect(lines.every((l) => l.repeat === undefined)).toBe(true);
  });

  it("collapses a repeated line into one entry with a count", () => {
    const lines: LogLine[] = [];
    for (let i = 0; i < 40; i++) appendLogLine(lines, "Fully synced");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ line: "Fully synced", repeat: 40 });
  });

  it("only collapses consecutive lines", () => {
    const lines: LogLine[] = [];
    appendLogLine(lines, "Fully synced");
    appendLogLine(lines, "Downloaded a.md");
    appendLogLine(lines, "Fully synced");
    expect(lines.map((l) => l.line)).toEqual(["Fully synced", "Downloaded a.md", "Fully synced"]);
    expect(lines.every((l) => l.repeat === undefined)).toBe(true);
  });

  it("does not merge lines that differ only by level", () => {
    // Same text from the daemon and from an admin action are different events.
    const lines: LogLine[] = [];
    appendLogLine(lines, "sync failed");
    appendLogLine(lines, "sync failed", "error");
    expect(lines).toHaveLength(2);
  });

  it("advances the timestamp to the most recent occurrence", () => {
    const lines: LogLine[] = [];
    appendLogLine(lines, "Fully synced");
    const first = lines[0].ts;
    appendLogLine(lines, "Fully synced");
    expect(lines[0].ts).toBeGreaterThanOrEqual(first);
    expect(lines[0].repeat).toBe(2);
  });

  it("replaces the entry rather than mutating a handed-out one", () => {
    // getLogs() returns a shallow copy, so a caller can be holding the element.
    const lines: LogLine[] = [];
    appendLogLine(lines, "Fully synced");
    const escaped = lines[0];
    appendLogLine(lines, "Fully synced");
    expect(escaped.repeat).toBeUndefined();
    expect(lines[0].repeat).toBe(2);
  });

  it("still bounds the buffer when every line differs", () => {
    const lines: LogLine[] = [];
    for (let i = 0; i < MAX_LOG_LINES + 250; i++) appendLogLine(lines, `line ${i}`);
    expect(lines).toHaveLength(MAX_LOG_LINES);
    // Oldest dropped, newest kept.
    expect(lines[lines.length - 1].line).toBe(`line ${MAX_LOG_LINES + 249}`);
  });

  it("makes a heartbeat cost one slot instead of the whole buffer", () => {
    // The regression in one assertion: a day of heartbeat must not evict a real
    // event that happened before it.
    const lines: LogLine[] = [];
    appendLogLine(lines, "Error: sync failed", "error");
    for (let i = 0; i < 5_000; i++) appendLogLine(lines, "Fully synced");
    expect(lines).toHaveLength(2);
    expect(lines[0].line).toBe("Error: sync failed");
  });
});

describe("logLinesOf", () => {
  it("splits a chunk and drops blank lines", () => {
    expect(logLinesOf("a\n\nb\n")).toEqual(["a", "b"]);
  });

  it("caps a single enormous line", () => {
    expect(logLinesOf("x".repeat(5_000))[0]).toHaveLength(2_000);
  });

  it("trims trailing whitespace but keeps leading indentation", () => {
    expect(logLinesOf("  indented   \n")).toEqual(["  indented"]);
  });
});

describe("LogRing", () => {
  it("collapses through the ring's own push path", () => {
    const ring = new LogRing();
    for (let i = 0; i < 12; i++) ring.push("Fully synced\n");
    expect(ring.all()).toHaveLength(1);
    expect(ring.all()[0].repeat).toBe(12);
  });

  it("collapses repeats that arrive within a single chunk", () => {
    const ring = new LogRing();
    ring.push("Fully synced\nFully synced\nFully synced\n");
    expect(ring.all()).toHaveLength(1);
    expect(ring.all()[0].repeat).toBe(3);
  });
});
