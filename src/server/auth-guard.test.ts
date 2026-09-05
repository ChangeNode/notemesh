import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The single-admin guard as installed by the real boot path: Better Auth
// creates the user table, then runAuthMigrations installs the trigger and
// checks the database it found. claim.test.ts covers the trigger on a table
// of its own; this covers the wiring, which is the part a refactor of
// runAuthMigrations could drop without any unit test noticing.

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "notemesh-authguard-"));
  process.env.DATA_DIR = root;
  process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 11).toString("base64");
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

/** A fresh module registry, as a restart produces, then the boot migration. */
async function boot() {
  vi.resetModules();
  const { runAuthMigrations } = await import("./auth");
  await runAuthMigrations();
  const { db } = await import("./db");
  return db();
}

const INSERT =
  'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 0, ?, ?)';
function addUser(d: ReturnType<typeof import("better-sqlite3")>, id: string) {
  const now = Date.now();
  d.prepare(INSERT).run(id, id, `${id}@example.com`, now, now);
}

describe("the guard on Better Auth's user table", () => {
  it("is installed on boot, once the table exists", async () => {
    const d = await boot();
    const trigger = d
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'single_admin'")
      .get();
    expect(trigger).toBeTruthy();
    addUser(d, "first");
    expect(() => addUser(d, "second")).toThrow(/already claimed/);
  });

  it("reports a database that already holds more than one account, and reinstalls the guard", async () => {
    // Claimed twice under a version without the guard.
    const d = await boot();
    d.exec("DROP TRIGGER single_admin");
    addUser(d, "one");
    addUser(d, "two");

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const again = await boot();
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/2 admin accounts and should have exactly one/));
    // The invariant is enforced from here on, even though it is already broken.
    expect(() => addUser(again, "three")).toThrow(/already claimed/);
  });

  it("says nothing on a healthy database", async () => {
    const d = await boot();
    addUser(d, "only");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await boot();
    expect(error).not.toHaveBeenCalledWith(expect.stringMatching(/admin accounts/));
  });
});
