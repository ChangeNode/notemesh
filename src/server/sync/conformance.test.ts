import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SyncBackend, SyncStatus } from "./types";

/**
 * What the SyncBackend contract promises, asserted the same way of both
 * backends. The state machines were tested only where a bug once forced it;
 * the nine `this.state = …` sites in git.ts and eight in supervisor.ts were
 * otherwise unpinned, and #7's backoff-duration alert reads the `stateSince`
 * they are all supposed to stamp.
 *
 * Both backends run for real: GitBackend against a bare remote, and
 * SyncSupervisor through its real start() with OB_BIN pointed at a script that
 * idles until SIGTERM or exits non-zero on demand. What is faked is only what
 * needs a network or an Obsidian account: the git driver puts a stub `git`
 * first on PATH to answer `fetch` with an authentication failure, and the
 * supervisor's cli module is mocked so the exit path's checks can be steered.
 * Behaviour specific to one backend lives in that backend's own tests.
 */

const cli = {
  authenticated: true,
  configured: true,
};
vi.mock("../ob/cli", () => ({
  obIsAuthenticated: () => Promise.resolve(cli.authenticated),
  obSyncConfigured: () => Promise.resolve(cli.configured),
  obSyncOnce: () => Promise.resolve({ ok: true, combined: "Fully synced\n", stdout: "", stderr: "" }),
}));

interface Driver {
  kind: "git" | "obsidian";
  /** A fresh, configured, not-yet-started backend. */
  make(): Promise<SyncBackend>;
  /** Make the next cycle (or child run) fail in an ordinary way. */
  breakSync(): void;
  /** Make the next cycle (or child run) fail as rejected credentials. */
  rejectAuth(): void;
  /** Undo both. */
  heal(): void;
  /** Whether notifyLocalChange is expected to publish. */
  notifyPublishes: boolean;
  /** For the git driver: is there a notemesh commit on the remote? */
  remoteHasPush(): boolean;
  /** Write a file into the vault, as a tool would. */
  writeNote(rel: string, content: string): void;
}

let root: string;
const originalPath = process.env.PATH ?? "";
const originalEnv = { OB_BIN: process.env.OB_BIN, FAKE_OB_MODE: process.env.FAKE_OB_MODE };

function gitEnv() {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "T",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "T",
    GIT_COMMITTER_EMAIL: "t@t",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv() }).toString();
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "notemesh-conform-")));
  process.env.DATA_DIR = path.join(root, "data");
  fs.mkdirSync(path.join(process.env.DATA_DIR, "vault"), { recursive: true });
  process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
  delete (globalThis as Record<string, unknown>).__obSyncGitBackend;
  delete (globalThis as Record<string, unknown>).__notemeshSupervisor;
  cli.authenticated = true;
  cli.configured = true;
  vi.resetModules();
});

afterEach(async () => {
  process.env.PATH = originalPath;
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k as keyof typeof originalEnv];
    else process.env[k] = v;
  }
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

// ---- git -------------------------------------------------------------------

const gitDriver: Driver = {
  kind: "git",
  notifyPublishes: true,
  async make() {
    const remote = path.join(root, "remote.git");
    const device = path.join(root, "device");
    git(root, "init", "-q", "--bare", "-b", "main", "remote.git");
    git(root, "clone", "-q", remote, "device");
    fs.writeFileSync(path.join(device, "Seed.md"), "# Seed\n");
    git(device, "add", "-A");
    git(device, "commit", "-q", "-m", "seed");
    git(device, "branch", "-M", "main");
    git(device, "push", "-q", "-u", "origin", "main");

    // A stub git for rejectAuth(): fetch fails as rejected credentials,
    // everything else is the real binary. Only on PATH while rejecting.
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const stubDir = path.join(root, "stub-bin");
    fs.mkdirSync(stubDir);
    fs.writeFileSync(
      path.join(stubDir, "git"),
      `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = fetch ]; then\n    echo "fatal: Authentication failed for 'https://example.invalid/'" >&2\n    exit 128\n  fi\ndone\nexec "${realGit}" "$@"\n`,
      { mode: 0o755 },
    );

    const { setSetting } = await import("../db");
    setSetting("sync_backend", "git");
    setSetting("git_remote", remote);
    setSetting("git_branch", "main");
    setSetting("vault_configured", "true");
    setSetting("git_pull_seconds", "3600");
    setSetting("git_debounce_seconds", "1");
    const { cloneVault, gitBackend } = await import("./git");
    const cloned = await cloneVault(remote, "main");
    expect(cloned.ok, cloned.message).toBe(true);
    return gitBackend();
  },
  breakSync() {
    fs.renameSync(path.join(root, "remote.git"), path.join(root, "remote.gone"));
  },
  rejectAuth() {
    process.env.PATH = `${path.join(root, "stub-bin")}:${originalPath}`;
  },
  heal() {
    process.env.PATH = originalPath;
    if (fs.existsSync(path.join(root, "remote.gone"))) {
      fs.renameSync(path.join(root, "remote.gone"), path.join(root, "remote.git"));
    }
  },
  remoteHasPush() {
    const log = git(path.join(root, "remote.git"), "log", "--format=%s", "main");
    return /^notemesh:/m.test(log);
  },
  writeNote(rel, content) {
    fs.writeFileSync(path.join(process.env.DATA_DIR!, "vault", rel), content);
  },
};

// ---- obsidian --------------------------------------------------------------

const obsidianDriver: Driver = {
  kind: "obsidian",
  notifyPublishes: false,
  async make() {
    // The fake daemon: idles until SIGTERM, or exits 1 at once when told to.
    const fake = path.join(root, "ob");
    fs.writeFileSync(
      fake,
      `#!/bin/sh\nif [ "$FAKE_OB_MODE" = fail ]; then echo "sync failed: boom" >&2; exit 1; fi\necho "Fully synced"\ntrap 'exit 0' TERM\nwhile :; do sleep 0.05; done\n`,
      { mode: 0o755 },
    );
    process.env.OB_BIN = fake;
    process.env.FAKE_OB_MODE = "idle";
    const { setSetting } = await import("../db");
    setSetting("sync_backend", "obsidian");
    setSetting("vault_configured", "true");
    const { SyncSupervisor } = await import("../ob/supervisor");
    return new SyncSupervisor();
  },
  breakSync() {
    process.env.FAKE_OB_MODE = "fail";
  },
  rejectAuth() {
    process.env.FAKE_OB_MODE = "fail";
    cli.authenticated = false;
  },
  heal() {
    process.env.FAKE_OB_MODE = "idle";
    cli.authenticated = true;
  },
  remoteHasPush() {
    return false;
  },
  writeNote(rel, content) {
    fs.writeFileSync(path.join(process.env.DATA_DIR!, "vault", rel), content);
  },
};

// ---- the script ------------------------------------------------------------

const WAIT = { timeout: 8_000, interval: 25 };

async function untilState(b: SyncBackend, state: SyncStatus["state"]) {
  await vi.waitFor(() => expect(b.status().state).toBe(state), WAIT);
}
/** The git backend runs a cycle on start; wait for it to finish. */
async function untilIdle(b: SyncBackend) {
  await vi.waitFor(() => expect(b.status().activity.active).toBe(false), WAIT);
}
async function shutdown(b: SyncBackend) {
  b.stop();
  await untilState(b, "stopped");
}

describe.each([gitDriver, obsidianDriver])("SyncBackend conformance: $kind", (driver) => {
  let backend: SyncBackend;

  beforeEach(async () => {
    backend = await driver.make();
  });

  afterEach(async () => {
    driver.heal();
    await shutdown(backend).catch(() => {});
  });

  it("starts stopped, with the full status shape", () => {
    const s = backend.status();
    expect(s.kind).toBe(driver.kind);
    expect(s.state).toBe("stopped");
    expect(s.stateSince).toBeNull();
    expect(s.startedAt).toBeNull();
    expect(s.restartCount).toBe(0);
    expect(s.activity).toMatchObject({ downloaded: 0, uploaded: 0, deleted: 0, active: false });
    expect(s.conflicts).toBeUndefined();
    expect(backend.getLogs()).toEqual([]);
  });

  it("runs on start and stops on stop, stamping stateSince at each change", async () => {
    const t0 = Date.now();
    backend.start();
    expect(backend.status().state).toBe("running");
    const started = backend.status();
    expect(started.startedAt).toBeGreaterThanOrEqual(t0);
    expect(started.stateSince).toBeGreaterThanOrEqual(t0);
    await untilIdle(backend);

    // A second start is a no-op: the state did not change, so its stamp stands.
    backend.start();
    expect(backend.status().state).toBe("running");
    expect(backend.status().stateSince).toBe(started.stateSince);

    await new Promise((r) => setTimeout(r, 5));
    await shutdown(backend);
    const stopped = backend.status();
    expect(stopped.state).toBe("stopped");
    expect(stopped.stateSince).toBeGreaterThan(started.stateSince!);
  });

  it("lands in backoff when sync fails, and resetAndStart runs it again", async () => {
    driver.breakSync();
    backend.start();
    await untilState(backend, "backoff");
    expect(backend.status().stateSince).not.toBeNull();
    expect(backend.getLogs().some((l) => l.level === "error" || l.level === "warn")).toBe(true);

    driver.heal();
    backend.resetAndStart();
    await untilState(backend, "running");
    await untilIdle(backend);
    expect(backend.status().restartCount).toBe(0);
  });

  it("lands in needs-reauth on rejected credentials and stays there until resetAndStart", async () => {
    driver.rejectAuth();
    backend.start();
    await untilState(backend, "needs-reauth");
    const latched = backend.status().stateSince;

    // Still rejected: another attempt changes nothing.
    await backend.syncNow();
    expect(backend.status().state).toBe("needs-reauth");
    expect(backend.status().stateSince).toBe(latched);

    driver.heal();
    backend.resetAndStart();
    await untilState(backend, "running");
    await untilIdle(backend);
  });

  it("treats notifyLocalChange as a request to publish, or ignores it, but never fails", async () => {
    backend.start();
    await untilIdle(backend);
    driver.writeNote("Written.md", "# Written\n");
    expect(() => backend.notifyLocalChange?.({ tool: "create_note", path: "Written.md" })).not.toThrow();
    if (driver.notifyPublishes) {
      await vi.waitFor(() => expect(driver.remoteHasPush()).toBe(true), WAIT);
    } else {
      expect(backend.notifyLocalChange).toBeUndefined();
      expect(driver.remoteHasPush()).toBe(false);
    }
  });

  it("puts note() in the log, collapsing repeats, without counting as activity", () => {
    const before = backend.status().lastActivityAt;
    backend.note("[test] hello");
    backend.note("[test] hello");
    backend.note("[test] hello", "warn");
    const logs = backend.getLogs();
    const hello = logs.filter((l) => l.line === "[test] hello");
    // Two identical entries collapse; a different level is a new entry.
    expect(hello).toHaveLength(2);
    expect(hello[0].repeat).toBe(2);
    expect(hello[1].level).toBe("warn");
    expect(backend.status().lastActivityAt).toBe(before);
  });

  it("resolves syncNow with ok and output on a stopped backend, never throwing", async () => {
    const res = await backend.syncNow();
    expect(typeof res.ok).toBe("boolean");
    expect(typeof res.output).toBe("string");
    expect(res.ok).toBe(true);
  });
});
