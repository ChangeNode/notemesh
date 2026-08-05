import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Re-authentication has to tell three situations apart: credentials that work,
// credentials that were never stored, and credentials that are stored but can
// no longer be decrypted. The third happens whenever ENCRYPTION_KEY changes,
// which the README documents as a consequence of rotating it — and it used to
// throw out of getObsidianAccount, turning the reauth call into a 500 with a
// decrypt error in it.

let root: string;
const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("base64");

async function load(key: string) {
  vi.resetModules();
  process.env.ENCRYPTION_KEY = key;
  return import("./credentials");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "notemesh-cred-"));
  process.env.DATA_DIR = root;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.ENCRYPTION_KEY;
});

describe("obsidianAccountState", () => {
  it("reports missing when nothing was ever stored", async () => {
    const m = await load(KEY_A);
    expect(m.obsidianAccountState()).toEqual({ state: "missing" });
    expect(m.getObsidianAccount()).toBeNull();
  });

  it("round-trips what was stored", async () => {
    const m = await load(KEY_A);
    m.storeObsidianAccount("user@example.com", "a-secret-password");
    expect(m.obsidianAccountState()).toEqual({
      state: "ok",
      email: "user@example.com",
      password: "a-secret-password",
    });
  });

  it("reports unreadable — not missing — after the key changes", async () => {
    // The distinction the operator needs: the credentials are still there, and
    // the key is what changed. Saying "no stored credentials" would send them
    // looking for the wrong problem.
    const first = await load(KEY_A);
    first.storeObsidianAccount("user@example.com", "a-secret-password");

    const second = await load(KEY_B);
    expect(second.obsidianAccountState()).toEqual({ state: "unreadable" });
  });

  it("does not throw when the key changed", async () => {
    // It used to: decryptSecret rejects a ciphertext it cannot authenticate,
    // and that exception escaped as a 500 rather than an explanation.
    const first = await load(KEY_A);
    first.storeObsidianAccount("user@example.com", "a-secret-password");
    const second = await load(KEY_B);
    expect(() => second.obsidianAccountState()).not.toThrow();
    expect(() => second.getObsidianAccount()).not.toThrow();
    expect(second.getObsidianAccount()).toBeNull();
  });

  it("recovers once the credentials are stored again", async () => {
    const first = await load(KEY_A);
    first.storeObsidianAccount("user@example.com", "old");
    const second = await load(KEY_B);
    expect(second.obsidianAccountState().state).toBe("unreadable");
    second.storeObsidianAccount("user@example.com", "new-password");
    expect(second.obsidianAccountState()).toMatchObject({ state: "ok", password: "new-password" });
  });
});
