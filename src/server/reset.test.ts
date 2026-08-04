import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A recovery path is exercised by nobody until the day it matters, which is how
// Jellyfin's shipped broken and stayed broken. These drive the real module: the
// gate, the window, the attempt budget, and an end-to-end reset against a live
// Better Auth database.

let root: string;
let mod: typeof import("./reset");

async function load(env: Record<string, string | undefined> = {}) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // Each load gets a fresh module registry, so the PIN and attempt counter
  // start clean — the same state a restart produces.
  delete (globalThis as Record<string, unknown>).__obSyncAdminReset;
  mod = await import("./reset");
  return mod;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ob-sync-reset-"));
  process.env.DATA_DIR = root;
  process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 9).toString("base64");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.RESET_ADMIN_FLOW;
  delete (globalThis as Record<string, unknown>).__obSyncAdminReset;
});

describe("the flow is off unless deliberately armed", () => {
  it("is off when the variable is absent", async () => {
    const m = await load({ RESET_ADMIN_FLOW: undefined });
    expect(m.resetFlowEnabled()).toBe(false);
    expect(m.resetState()).toEqual({ mode: "off" });
  });

  it.each(["0", "true", "yes", "on", "", " 1", "1 ", "TRUE"])(
    "is off for RESET_ADMIN_FLOW=%j",
    async (value) => {
      // Only an exact "1" arms it. A recovery path should never be ambiguous
      // about whether it is open, and near-misses must fail closed.
      const m = await load({ RESET_ADMIN_FLOW: value });
      expect(m.resetFlowEnabled()).toBe(false);
    },
  );

  it("is on for exactly 1", async () => {
    const m = await load({ RESET_ADMIN_FLOW: "1" });
    expect(m.resetFlowEnabled()).toBe(true);
    expect(m.resetState().mode).toBe("open");
  });

  it("refuses a reset outright when it is off", async () => {
    const m = await load({ RESET_ADMIN_FLOW: undefined });
    const res = await m.performAdminReset("12345678", "a-long-enough-password");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/not enabled/i);
  });
});

describe("the PIN", () => {
  it("is eight digits", async () => {
    const m = await load({ RESET_ADMIN_FLOW: "1" });
    // Read it the way the operator does — off the log.
    expect(capturePin(m)).toMatch(/^\d{8}$/);
  });

  it("is announced once per boot, not once per request", async () => {
    // announceResetFlow runs from middleware, so it is called on every request.
    // Reprinting the PIN on each one would bury it and fill the log.
    const m = await load({ RESET_ADMIN_FLOW: "1" });
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a) => void lines.push(a.join(" ")));
    for (let i = 0; i < 5; i++) m.announceResetFlow();
    spy.mockRestore();
    expect(lines.join("\n").match(/PIN:/g) ?? []).toHaveLength(1);
  });

  it("announces once per process even when the module is loaded twice", async () => {
    // The bundler instantiates this module in more than one chunk, so a
    // module-level "already announced" flag resets while the process does not —
    // which printed the PIN twice on a real boot. Reloading the module without
    // clearing the shared state reproduces exactly that.
    const first = await load({ RESET_ADMIN_FLOW: "1" });
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a) => void lines.push(a.join(" ")));
    first.announceResetFlow();
    vi.resetModules();
    const second = await import("./reset"); // fresh module, same globalThis
    second.announceResetFlow();
    spy.mockRestore();
    expect(lines.join("\n").match(/PIN:/g) ?? []).toHaveLength(1);
  });

  it("prints nothing at all when the flow is off", async () => {
    const m = await load({ RESET_ADMIN_FLOW: undefined });
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a) => void lines.push(a.join(" ")));
    m.announceResetFlow();
    spy.mockRestore();
    expect(lines).toEqual([]);
  });

  it("differs between boots", async () => {
    const pins = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const m = await load({ RESET_ADMIN_FLOW: "1" });
      pins.add(capturePin(m));
    }
    // Eight independent draws from 10^8 colliding is a birthday probability of
    // about 3 in 10 million; a fixed or seeded PIN fails this every time.
    expect(pins.size).toBe(8);
  });

  it("is never included in the state handed to the page", async () => {
    const m = await load({ RESET_ADMIN_FLOW: "1" });
    const pin = capturePin(m);
    expect(JSON.stringify(m.resetState())).not.toContain(pin);
  });

  it("compares without leaking length or content", async () => {
    const m = await load({ RESET_ADMIN_FLOW: "1" });
    expect(m.pinMatches("1234", "12345678")).toBe(false);
    expect(m.pinMatches("123456789", "12345678")).toBe(false);
    expect(m.pinMatches("12345678", "12345678")).toBe(true);
    expect(m.pinMatches("", "")).toBe(true);
  });
});

describe("the attempt budget", () => {
  it("burns an attempt on a wrong PIN and reports what is left", async () => {
    const m = await load({ RESET_ADMIN_FLOW: "1" });
    const res = await m.performAdminReset("00000000", "a-long-enough-password");
    expect(res.ok).toBe(false);
    expect(res.attemptsLeft).toBe(m.MAX_PIN_ATTEMPTS - 1);
  });

  it("burns an attempt on a weak password too", async () => {
    // Otherwise the password field is a free oracle: submit a candidate PIN
    // with a deliberately short password and learn whether the PIN was right
    // without spending anything.
    const m = await load({ RESET_ADMIN_FLOW: "1" });
    const pin = capturePin(m);
    const res = await m.performAdminReset(pin, "short");
    expect(res.ok).toBe(false);
    expect(res.attemptsLeft).toBe(m.MAX_PIN_ATTEMPTS - 1);
  });

  it("stops accepting guesses once the budget is spent", async () => {
    const m = await load({ RESET_ADMIN_FLOW: "1" });
    for (let i = 0; i < m.MAX_PIN_ATTEMPTS; i++) {
      await m.performAdminReset("00000000", "a-long-enough-password");
    }
    expect(m.resetState().mode).toBe("exhausted");
    const res = await m.performAdminReset("00000000", "a-long-enough-password");
    expect(res.message).toMatch(/too many attempts/i);
  });

  it("refuses the correct PIN once the budget is spent", async () => {
    // The budget is the backstop, so it has to hold even against a right answer
    // arriving late.
    const m = await load({ RESET_ADMIN_FLOW: "1" });
    const pin = capturePin(m);
    for (let i = 0; i < m.MAX_PIN_ATTEMPTS; i++) {
      await m.performAdminReset("00000000", "a-long-enough-password");
    }
    const res = await m.performAdminReset(pin, "a-long-enough-password");
    expect(res.ok).toBe(false);
  });
});

describe("resetting a real account", () => {
  it("changes the password, clears sessions, and reports the account", async () => {
    const m = await load({ RESET_ADMIN_FLOW: "1" });
    const pin = capturePin(m);
    const { auth } = await import("./auth");
    const { runAuthMigrations } = await import("./auth");
    await runAuthMigrations();
    await auth.api.signUpEmail({
      body: { email: "admin@example.com", password: "the-original-password", name: "Admin" },
    });

    const { db } = await import("./db");
    const sessionsBefore = (
      db().prepare('SELECT COUNT(*) AS n FROM "session"').get() as { n: number }
    ).n;
    expect(sessionsBefore).toBeGreaterThan(0);

    const res = await m.performAdminReset(pin, "a-brand-new-password");
    expect(res).toMatchObject({ ok: true, email: "admin@example.com" });

    // Sessions issued under the old password must not survive it.
    expect((db().prepare('SELECT COUNT(*) AS n FROM "session"').get() as { n: number }).n).toBe(0);

    // The new password works and the old one does not.
    await expect(
      auth.api.signInEmail({
        body: { email: "admin@example.com", password: "a-brand-new-password" },
      }),
    ).resolves.toBeTruthy();
    await expect(
      auth.api.signInEmail({
        body: { email: "admin@example.com", password: "the-original-password" },
      }),
    ).rejects.toThrow();
  });

  it("says so when there is no account to reset", async () => {
    const m = await load({ RESET_ADMIN_FLOW: "1" });
    const pin = capturePin(m);
    const { runAuthMigrations } = await import("./auth");
    await runAuthMigrations();
    const res = await m.performAdminReset(pin, "a-long-enough-password");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/no admin account/i);
  });
});

// The PIN only ever leaves the process through the log, so read it back the
// same way rather than exporting an accessor that exists only for tests.
function capturePin(m: typeof import("./reset")): string {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
    lines.push(args.join(" "));
  });
  m.announceResetFlow();
  spy.mockRestore();
  const match = lines.join("\n").match(/PIN:\s*(\d{8})/);
  if (!match) throw new Error("no PIN was announced");
  return match[1];
}

// process.uptime() is what bounds the window, so pushing it past the limit is
// the only way to reach the expired state without waiting half an hour. Without
// this, "expired" was the one mode nothing asserted — and it is a mode an
// operator only ever meets when something has already gone wrong.
function pretendUptime(seconds: number) {
  return vi.spyOn(process, "uptime").mockReturnValue(seconds);
}

describe("the window closing", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports expired once the window has passed", async () => {
    const m = await load({ RESET_ADMIN_FLOW: "1" });
    pretendUptime(31 * 60);
    expect(m.resetState()).toEqual({ mode: "expired", windowMinutes: 30 });
  });

  it("is still open a minute before the boundary", async () => {
    const m = await load({ RESET_ADMIN_FLOW: "1" });
    pretendUptime(29 * 60);
    expect(m.resetState().mode).toBe("open");
  });

  it("refuses the correct PIN after the window closes", async () => {
    const m = await load({ RESET_ADMIN_FLOW: "1" });
    const pin = capturePin(m);
    pretendUptime(31 * 60);
    const res = await m.performAdminReset(pin, "a-long-enough-password");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/window has closed/i);
  });

  it("does not spend an attempt on a request the window already refused", async () => {
    // Otherwise a closed window quietly eats the budget that a restart is
    // supposed to restore.
    const m = await load({ RESET_ADMIN_FLOW: "1" });
    pretendUptime(31 * 60);
    await m.performAdminReset("00000000", "a-long-enough-password");
    vi.restoreAllMocks();
    expect(m.resetState()).toMatchObject({ mode: "open" });
    const res = await m.performAdminReset("00000000", "a-long-enough-password");
    expect(res.attemptsLeft).toBe(m.MAX_PIN_ATTEMPTS - 1);
  });
});

describe("more than one account", () => {
  it("refuses rather than guessing which one to reset", async () => {
    const m = await load({ RESET_ADMIN_FLOW: "1" });
    const pin = capturePin(m);
    const { runAuthMigrations } = await import("./auth");
    await runAuthMigrations();
    const { db } = await import("./db");
    const insert = db().prepare(
      'INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)',
    );
    const now = new Date().toISOString();
    insert.run("u1", "One", "one@example.com", 1, now, now);
    insert.run("u2", "Two", "two@example.com", 1, now, now);
    const res = await m.performAdminReset(pin, "a-long-enough-password");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/more than one account/i);
  });
});

// The sign-in page used to collapse three states into two, telling someone
// whose window had closed to use a PIN that would be refused. These check the
// decision against every mode, which is the part a browser test would miss
// because two of the three need a 30-minute wait or ten spent guesses.
describe("which card the sign-in page shows", () => {
  it("folds the how-to away when the flow is off", async () => {
    const m = await load();
    expect(m.resetBanner({ mode: "off" })).toBe("instructions");
  });

  it("offers the link only while the reset can actually be used", async () => {
    const m = await load();
    expect(m.resetBanner({ mode: "open", secondsLeft: 600, windowMinutes: 30 })).toBe("armed");
  });

  it.each(["expired", "exhausted"] as const)(
    "does not offer a link that leads nowhere when %s",
    async (mode) => {
      const m = await load();
      expect(m.resetBanner({ mode, windowMinutes: 30 })).toBe("unusable");
    },
  );

  it("handles every mode resetState can return", async () => {
    // Exhaustiveness, so a mode added later cannot silently fall through to
    // whichever branch happens to be last.
    const m = await load();
    const all = [
      { mode: "off" } as const,
      { mode: "open", secondsLeft: 1, windowMinutes: 30 } as const,
      { mode: "expired", windowMinutes: 30 } as const,
      { mode: "exhausted", windowMinutes: 30 } as const,
    ];
    for (const state of all) {
      expect(["instructions", "armed", "unusable"]).toContain(m.resetBanner(state));
    }
  });
});
