import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The 1.6 → 1.7 upgrade, on the database an existing deployment has: one
// admin row in an account table without the `issuer` column 1.7 requires.
// Better Auth's migrator refuses to add a required column to a populated
// table, so without the backfill in runAuthMigrations every upgraded
// instance threw at boot and could not sign in. Reproduced before the fix.

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "notemesh-authupgrade-"));
  process.env.DATA_DIR = root;
  process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 12).toString("base64");
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

async function boot() {
  vi.resetModules();
  const { auth, runAuthMigrations } = await import("./auth");
  await runAuthMigrations();
  return auth;
}

/** Turn a fresh 1.7 account table into the shape 1.6 left behind. */
async function reshapeTo16() {
  const { db } = await import("./db");
  const d = db();
  d.exec(`
    CREATE TABLE account_16 AS SELECT id, accountId, providerId, userId, accessToken, refreshToken, idToken,
      accessTokenExpiresAt, refreshTokenExpiresAt, scope, password, createdAt, updatedAt FROM account;
    DROP TABLE account;
    ALTER TABLE account_16 RENAME TO account;
  `);
  const columns = (d.prepare("PRAGMA table_info(account)").all() as { name: string }[]).map((c) => c.name);
  expect(columns).not.toContain("issuer");
  return d;
}

describe("upgrading a claimed 1.6 database", () => {
  it("migrates, backfills the issuer, and the admin can still sign in", async () => {
    const auth = await boot();
    await auth.api.signUpEmail({
      body: { email: "admin@example.com", password: "the-original-password", name: "Admin" },
    });
    const d = await reshapeTo16();

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const upgraded = await boot();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/added issuer/));
    expect(d.prepare("SELECT issuer FROM account").all()).toEqual([{ issuer: "local:credential" }]);

    const res = await upgraded.api.signInEmail({
      body: { email: "admin@example.com", password: "the-original-password" },
    });
    expect(res.user.email).toBe("admin@example.com");
  });

  it("leaves a database that already has the column alone", async () => {
    const auth = await boot();
    await auth.api.signUpEmail({
      body: { email: "admin@example.com", password: "the-original-password", name: "Admin" },
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await boot();
    expect(log).not.toHaveBeenCalledWith(expect.stringMatching(/added issuer/));
  });
});
