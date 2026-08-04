import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  CLAIM_WINDOW_MINUTES,
  CLAIM_WINDOW_MS,
  claimWindowRemainingMs,
  isSetupComplete,
  userCount,
  withinClaimWindow,
} from "./claim";

// The bug these exist for: userCount() used to swallow every exception and
// answer "0 users", which the rest of the app reads as "nobody has claimed this
// server". On a live, configured instance that meant a momentary database
// problem either offered the admin claim form to whoever was looking (inside
// the claim window) or, past it, replaced a perfectly healthy server with a
// "locked down, never claimed" screen. Only a query that actually ran may
// produce a count.

function emptyDb(): Database.Database {
  return new Database(":memory:");
}

function dbWithUsers(rows: number): Database.Database {
  const d = emptyDb();
  d.exec('CREATE TABLE "user" (id TEXT PRIMARY KEY)');
  const insert = d.prepare('INSERT INTO "user" (id) VALUES (?)');
  for (let i = 0; i < rows; i++) insert.run(`u${i}`);
  return d;
}

// A handle whose query fails the way a real one does under duress.
function failingDb(message: string): { prepare(sql: string): { get(): unknown } } {
  return {
    prepare() {
      return {
        get() {
          throw new Error(message);
        },
      };
    },
  };
}

describe("userCount", () => {
  it("counts an existing table", () => {
    expect(userCount(dbWithUsers(0))).toEqual({ known: true, count: 0 });
    expect(userCount(dbWithUsers(1))).toEqual({ known: true, count: 1 });
    expect(userCount(dbWithUsers(3))).toEqual({ known: true, count: 3 });
  });

  it("treats a missing table as genuinely zero users", () => {
    // First boot: the process is up before Better Auth has created its tables,
    // and that really is an unclaimed server.
    expect(userCount(emptyDb())).toEqual({ known: true, count: 0 });
  });

  it("recognises the missing-table case from SQLite's own wording", () => {
    // The special case above is only safe if it matches what SQLite actually
    // says. Pin the real message rather than trusting the regex in isolation.
    expect(() => emptyDb().prepare('SELECT COUNT(*) AS n FROM "user"').get()).toThrow(
      /no such table/i,
    );
  });

  it("does not claim zero users when the connection is gone", () => {
    const d = dbWithUsers(1);
    d.close();
    const c = userCount(d);
    expect(c.known).toBe(false);
  });

  it.each([
    "database is locked",
    "database disk image is malformed",
    "attempt to write a readonly database",
    "SQLITE_IOERR: disk I/O error",
    "unable to open database file",
    "no such column: n", // a schema we don't understand is not an empty one
  ])("does not claim zero users after: %s", (message) => {
    const c = userCount(failingDb(message));
    expect(c.known).toBe(false);
    expect(c).toMatchObject({ error: expect.stringContaining(message) });
  });

  it("survives a thrown non-Error", () => {
    const c = userCount({
      prepare() {
        return {
          get() {
            throw "kaboom";
          },
        };
      },
    });
    expect(c).toEqual({ known: false, error: "kaboom" });
  });

  it.each([
    "no such table: oauthClient", // a different table is missing, not this one
    "no such tablespace", // near-miss wording that is not the case we allow
    "no such table", // truncated: not proof of anything
  ])("only allows zero for this exact table, not: %s", (message) => {
    expect(userCount(failingDb(message)).known).toBe(false);
  });

  it("still recognises the message when SQLite qualifies the schema", () => {
    // `SELECT ... FROM main."user"` phrases it as `no such table: main.user`.
    expect(userCount(failingDb("no such table: main.user"))).toEqual({ known: true, count: 0 });
  });
});

describe("isSetupComplete", () => {
  it("is false only when the server is provably unclaimed", async () => {
    await expect(isSetupComplete(emptyDb())).resolves.toBe(false);
    await expect(isSetupComplete(dbWithUsers(0))).resolves.toBe(false);
  });

  it("is true once an admin exists", async () => {
    await expect(isSetupComplete(dbWithUsers(1))).resolves.toBe(true);
  });

  it("fails closed when the count is unknown", async () => {
    // The regression, stated directly. Being wrong this way shows a signed-out
    // admin a login page; being wrong the other way hands a stranger the claim
    // form on a running server — or tells the owner it was never claimed.
    await expect(isSetupComplete(failingDb("database is locked"))).resolves.toBe(true);
  });
});

// The other half of "may this be claimed": the window itself. Time-based, so
// these assert the shape and bounds rather than a specific instant.
describe("claim window", () => {
  it("is open on a freshly started process", () => {
    expect(withinClaimWindow()).toBe(true);
    expect(claimWindowRemainingMs()).toBeGreaterThan(0);
  });

  it("never reports more time than the window is long", () => {
    expect(claimWindowRemainingMs()).toBeLessThanOrEqual(CLAIM_WINDOW_MS);
  });

  it("counts down with the process, not the wall clock", () => {
    // Uptime is what resets on a restart, which is the recovery path the
    // lockdown screen tells the operator to use.
    expect(claimWindowRemainingMs()).toBeLessThanOrEqual(
      CLAIM_WINDOW_MS - Math.floor(process.uptime()) * 1000,
    );
  });

  it("describes itself in whole minutes for the UI copy", () => {
    expect(CLAIM_WINDOW_MINUTES).toBe(30);
    expect(Number.isInteger(CLAIM_WINDOW_MINUTES)).toBe(true);
  });
});
