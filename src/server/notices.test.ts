import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postNotice, takeNotices, clearNotices, NOTICE_TTL_MS } from "./notices";

beforeEach(clearNotices);
afterEach(clearNotices);

describe("notices", () => {
  it("reach each connector once", () => {
    postNotice("a");
    expect(takeNotices("k1")).toEqual(["a"]);
    expect(takeNotices("k1")).toEqual([]);
    expect(takeNotices("k2")).toEqual(["a"]);
  });

  it("are dropped after the TTL rather than held for a connector that never comes back", () => {
    const t0 = 1_800_000_000_000;
    postNotice("old", t0);
    expect(takeNotices("k", Infinity, t0 + NOTICE_TTL_MS + 1)).toEqual([]);
    postNotice("new", t0 + NOTICE_TTL_MS);
    expect(takeNotices("k", Infinity, t0 + NOTICE_TTL_MS + 1)).toEqual(["new"]);
  });

  it("hold back what the limit leaves, for the next call, rather than losing it", () => {
    postNotice("a");
    postNotice("b");
    postNotice("c");
    expect(takeNotices("k", 2)).toEqual(["a", "b"]);
    expect(takeNotices("k", 2)).toEqual(["c"]);
    expect(takeNotices("k", 2)).toEqual([]);
  });

  it("keep a bounded list, newest kept", () => {
    for (let i = 0; i < 25; i++) postNotice(`n${i}`);
    const got = takeNotices("late");
    expect(got).toHaveLength(20);
    expect(got[0]).toBe("n5");
    expect(got[19]).toBe("n24");
  });

  it("survive a module reload, like the backends that post to them", async () => {
    postNotice("x");
    vi.resetModules();
    const fresh = await import("./notices");
    expect(fresh.takeNotices("k")).toEqual(["x"]);
  });
});
