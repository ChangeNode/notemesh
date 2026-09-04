import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * GitBackend end to end, against a real bare remote.
 *
 * conflict.test.ts proves that a conflict produces a conflicted copy and a
 * clean commit. This proves the part a user actually depends on: the backend
 * pushes that copy so it reaches their other devices, and then carries on —
 * its state never becomes anything a human has to clear. That second half is
 * the reason the "conflict" state was removed: a handled conflict is
 * information on the Status tab, not something the server is waiting on.
 *
 * Driven through syncNow(), the public "run one cycle now" entry point, so no
 * timers are involved and nothing is reached into.
 */

let root: string;
let remote: string;
let device: string; // stands in for the user's phone or laptop

// Env-isolated git, as in conflict.test.ts: the suite must not depend on the
// developer's identity or config, and bare repos are created with `-b main`
// so a host defaulting to "master" cannot break the clones.
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@t",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  }).toString();
}

function write(dir: string, rel: string, content: string) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function read(dir: string, rel: string): string {
  return fs.readFileSync(path.join(dir, rel), "utf8");
}

function commitAll(dir: string, message: string) {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
}

beforeEach(() => {
  // realpath: the vault guard compares resolved paths, and os.tmpdir() is a
  // symlink on macOS.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "notemesh-gitbackend-")));
  remote = path.join(root, "remote.git");
  device = path.join(root, "device");
  git(root, "init", "-q", "--bare", "-b", "main", "remote.git");

  // The user's device seeds the vault and pushes it.
  git(root, "clone", "-q", remote, "device");
  write(device, "Daily/2026-08-03.md", "# Today\n\n- [ ] task one\n");
  commitAll(device, "seed");
  git(device, "branch", "-M", "main");
  git(device, "push", "-q", "-u", "origin", "main");

  // The server side. DATA_DIR drives env.vaultDir; the backend is a globalThis
  // singleton that outlives resetModules, so it is dropped explicitly.
  process.env.DATA_DIR = path.join(root, "data");
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
  process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 5).toString("base64");
  delete (globalThis as Record<string, unknown>).__obSyncGitBackend;
  vi.resetModules();
});

afterEach(async () => {
  const live = (globalThis as Record<string, unknown>).__obSyncGitBackend as { stop?: () => void } | undefined;
  live?.stop?.();
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

/** Configure the git backend the way the setup wizard does, and clone the vault. */
async function configuredBackend() {
  const { setSetting } = await import("~/server/db");
  setSetting("sync_backend", "git");
  setSetting("git_remote", remote);
  setSetting("git_branch", "main");
  setSetting("vault_configured", "true");
  const { cloneVault, gitBackend } = await import("~/server/sync/git");
  const { env } = await import("~/server/env");
  const cloned = await cloneVault(remote, "main");
  expect(cloned.ok, cloned.message).toBe(true);
  return { backend: gitBackend(), vault: env.vaultDir };
}

describe("a conflict, end to end", () => {
  it("pushes the conflicted copy to the remote and stays running", async () => {
    const { backend, vault } = await configuredBackend();

    // The assistant's edit, already committed — what commitPending would have
    // done on the previous cycle. Committed with the test's identity rather
    // than through the backend so the conflict does not depend on debounce
    // timing.
    write(vault, "Daily/2026-08-03.md", "# Today\n\n- [ ] task one\n- [ ] ASSISTANT\n");
    commitAll(vault, "assistant: append");

    // Meanwhile the device changed the same region and pushed first.
    write(device, "Daily/2026-08-03.md", "# Today\n\n- [ ] task one\n- [ ] DEVICE\n");
    commitAll(device, "device: append");
    git(device, "push", "-q");

    const result = await backend.syncNow();
    expect(result.ok, result.output).toBe(true);

    // Never a stuck state. The cycle ended in a push, so it is simply running.
    const status = backend.status();
    expect(status.state).toBe("running");

    // The device's version kept the filename; ours is beside it.
    expect(read(vault, "Daily/2026-08-03.md")).toContain("DEVICE");
    expect(read(vault, "Daily/2026-08-03.md")).not.toContain("ASSISTANT");
    expect(status.conflicts).toHaveLength(1);
    const record = status.conflicts![0];
    expect(record.paths).toEqual(["Daily/2026-08-03.md"]);
    expect(record.copies).toHaveLength(1);
    expect(record).not.toHaveProperty("strategy");
    expect(record).not.toHaveProperty("branch");
    const copy = record.copies![0];
    expect(copy).toMatch(/Conflicted copy notemesh/);
    expect(read(vault, copy)).toContain("ASSISTANT");

    // The part that matters: it reached the remote, so the device sees it on
    // its next pull — exactly how the user finds out.
    git(device, "pull", "-q");
    expect(fs.existsSync(path.join(device, copy)), "copy arrived on the device").toBe(true);
    expect(read(device, copy)).toContain("ASSISTANT");

    // And the server is left clean, on the same commit as the remote.
    expect(git(vault, "status", "--porcelain").trim()).toBe("");
    expect(git(vault, "rev-list", "--count", "origin/main..HEAD").trim()).toBe("0");
  });

  it("does not disturb a cycle with nothing to reconcile", async () => {
    const { backend } = await configuredBackend();
    const result = await backend.syncNow();
    expect(result.ok, result.output).toBe(true);
    // Nothing was pushed, so nothing moved the state; a manual cycle on a
    // backend that was never started leaves it stopped. What matters is that
    // an empty cycle is not an error.
    expect(backend.status().state).not.toBe("backoff");
    expect(backend.status().conflicts).toBeUndefined();
  });
});

describe("what a conflict tells connectors", () => {
  it("posts a one-shot notice naming the copy, and the state says when it changed", async () => {
    const { clearNotices, takeNotices } = await import("~/server/notices");
    clearNotices();
    const { backend, vault } = await configuredBackend();
    write(vault, "Daily/2026-08-03.md", "# Today\n\n- [ ] task one\n- [ ] ASSISTANT\n");
    commitAll(vault, "assistant: append");
    write(device, "Daily/2026-08-03.md", "# Today\n\n- [ ] task one\n- [ ] DEVICE\n");
    commitAll(device, "device: append");
    git(device, "push", "-q");
    expect(takeNotices("phone")).toEqual([]);

    const before = Date.now();
    const result = await backend.syncNow();
    expect(result.ok, result.output).toBe(true);

    const copy = backend.status().conflicts![0].copies![0];
    const notices = takeNotices("phone");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("Daily/2026-08-03.md");
    expect(notices[0]).toContain(copy);
    expect(notices[0]).toMatch(/Ask the user/);
    expect(takeNotices("phone")).toEqual([]);

    const status = backend.status();
    expect(status.state).toBe("running");
    expect(status.stateSince).toBeGreaterThanOrEqual(before);
  });
});
