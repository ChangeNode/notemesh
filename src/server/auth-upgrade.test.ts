import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Upgrades to the current Better Auth, from the account tables deployments
// have in the field. 1.6 had no `issuer` column. 1.7.0–1.7.2 added one, NOT
// NULL with a unique index; NoteMesh 1.3.0 backfilled it with a default on
// databases upgraded from 1.6. Later 1.7 releases dropped it and refuse to
// boot while a NOT NULL column they never write is present, so every
// deployment created on 1.3.0 threw at boot and could not sign in.
// Reproduced against a database written by 1.7.2 before the fix.

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

const KEPT = `id, accountId, providerId, userId, accessToken, refreshToken, idToken,
  accessTokenExpiresAt, refreshTokenExpiresAt, scope, password, createdAt, updatedAt`;

/** Rebuild the account table with the given `issuer` column definition and indexes. */
async function reshape(issuer: string | null, indexes: string[] = []) {
  const { db } = await import("./db");
  const d = db();
  d.exec(`
    CREATE TABLE account_old AS SELECT * FROM account;
    DROP TABLE account;
    CREATE TABLE account ("id" text not null primary key, ${issuer ? `"issuer" ${issuer},` : ""}
      "accountId" text not null, "providerId" text not null,
      "userId" text not null references "user" ("id") on delete cascade,
      "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date,
      "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null,
      "updatedAt" date not null);
    INSERT INTO account (${issuer ? "issuer, " : ""}${KEPT})
      SELECT ${issuer ? "'local:credential', " : ""}${KEPT} FROM account_old;
    DROP TABLE account_old;
    CREATE INDEX "account_userId_idx" on "account" ("userId");
    ${indexes.join(";\n")}
  `);
  return d;
}

const columns = (d: { prepare(sql: string): { all(): unknown[] } }) =>
  (d.prepare("PRAGMA table_info(account)").all() as { name: string }[]).map((c) => c.name);

async function signUp() {
  const auth = await boot();
  await auth.api.signUpEmail({
    body: { email: "admin@example.com", password: "the-original-password", name: "Admin" },
  });
}

async function expectSignIn(auth: Awaited<ReturnType<typeof boot>>) {
  const res = await auth.api.signInEmail({
    body: { email: "admin@example.com", password: "the-original-password" },
  });
  expect(res.user.email).toBe("admin@example.com");
}

describe("upgrading the account table", () => {
  it("drops the issuer column and index a 1.7.2 database has, and the admin can still sign in", async () => {
    await signUp();
    const d = await reshape("text not null", [
      'CREATE UNIQUE INDEX "account_issuer_accountId_uidx" on "account" ("issuer", "accountId")',
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const upgraded = await boot();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/removed issuer/));
    expect(columns(d)).not.toContain("issuer");
    await expectSignIn(upgraded);
  });

  it("drops the column NoteMesh 1.3.0 backfilled on a database upgraded from 1.6", async () => {
    await signUp();
    const d = await reshape("text not null default 'local:credential'", [
      'CREATE UNIQUE INDEX "account_issuer_accountId_uidx" on "account" ("issuer", "accountId")',
    ]);
    const upgraded = await boot();
    expect(columns(d)).not.toContain("issuer");
    await expectSignIn(upgraded);
  });

  it("boots a 1.6 database, which never had the column", async () => {
    await signUp();
    await reshape(null);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const upgraded = await boot();
    expect(log).not.toHaveBeenCalledWith(expect.stringMatching(/removed issuer/));
    await expectSignIn(upgraded);
  });
});
