import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  conflictCopyPath,
  conflictStamp,
  probeMerge,
  resolveConflict,
} from "./conflict";

// These run against the real git binary in throwaway repositories. Mocking git
// here would test nothing worth testing: the whole point is that git's merge
// behaviour is what decides whether a conflict exists, and that our handling
// never leaves markers in the vault.

let root: string;
let server: string; // the notemesh side
let device: string; // stands in for the user's phone/laptop
let remote: string;

// Bare repos below are created with `-b main` on purpose. Without it the repo's
// HEAD follows the host's init.defaultBranch, so on a machine that still
// defaults to "master" a later clone tracks a ref that was never pushed and
// every `git pull` in these tests fails. GIT_CONFIG_GLOBAL is nulled for the
// same reason: the suite must not depend on the developer's git config.
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
  git(dir, "commit", "-m", message);
}

/** Every file in the working tree that carries git conflict markers. */
function filesWithMarkers(dir: string): string[] {
  const found: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (fs.readFileSync(abs, "utf8").includes("<<<<<<<")) {
        found.push(path.relative(dir, abs));
      }
    }
  };
  walk(dir);
  return found;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "notemesh-conflict-"));
  remote = path.join(root, "remote.git");
  server = path.join(root, "server");
  device = path.join(root, "device");
  git(root, "init", "-q", "--bare", "-b", "main", "remote.git");
  git(root, "clone", "-q", remote, "server");
  write(server, "Daily/2026-08-03.md", "# Today\n\n- [ ] task one\n");
  write(server, "Projects/Alpha.md", "# Alpha\n\nline one\nline two\nline three\n");
  commitAll(server, "seed");
  git(server, "branch", "-M", "main");
  git(server, "push", "-q", "-u", "origin", "main");
  git(root, "clone", "-q", remote, "device");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Have the user's device change something and push it. */
function devicePushes(rel: string, content: string, message: string) {
  git(device, "pull", "-q");
  write(device, rel, content);
  commitAll(device, message);
  git(device, "push", "-q");
  git(server, "fetch", "-q", "origin", "main");
}

describe("probeMerge", () => {
  it("reports clean when the two sides touch different notes", async () => {
    write(server, "Projects/Beta.md", "# Beta\n");
    commitAll(server, "assistant: add Beta");
    devicePushes("Projects/Gamma.md", "# Gamma\n", "device: add Gamma");

    const probe = await probeMerge(server, "HEAD", "origin/main");
    expect(probe.clean).toBe(true);
    expect(probe.paths).toEqual([]);
  });

  it("reports clean when the same note changes in different places", async () => {
    // The case people assume breaks: assistant appends, human edits the top.
    write(server, "Projects/Alpha.md", "# Alpha\n\nline one\nline two\nline three\nASSISTANT\n");
    commitAll(server, "assistant: append");
    devicePushes(
      "Projects/Alpha.md",
      "# Alpha EDITED\n\nline one\nline two\nline three\n",
      "device: edit heading",
    );

    const probe = await probeMerge(server, "HEAD", "origin/main");
    expect(probe.clean).toBe(true);
  });

  it("reports the conflicting path when both sides change the same region", async () => {
    write(server, "Daily/2026-08-03.md", "# Today\n\n- [ ] task one\n- [ ] ASSISTANT\n");
    commitAll(server, "assistant: append");
    devicePushes("Daily/2026-08-03.md", "# Today\n\n- [ ] task one\n- [ ] DEVICE\n", "device: append");

    const probe = await probeMerge(server, "HEAD", "origin/main");
    expect(probe.clean).toBe(false);
    expect(probe.paths).toEqual(["Daily/2026-08-03.md"]);
  });

  it("leaves the working tree untouched while probing a conflict", async () => {
    write(server, "Daily/2026-08-03.md", "# Today\n\n- [ ] task one\n- [ ] ASSISTANT\n");
    commitAll(server, "assistant: append");
    devicePushes("Daily/2026-08-03.md", "# Today\n\n- [ ] task one\n- [ ] DEVICE\n", "device: append");

    const before = read(server, "Daily/2026-08-03.md");
    await probeMerge(server, "HEAD", "origin/main");
    expect(read(server, "Daily/2026-08-03.md")).toBe(before);
    expect(filesWithMarkers(server)).toEqual([]);
  });
});

describe("a clean merge keeps both sides", () => {
  it("preserves the assistant's append and the device's heading edit", async () => {
    write(server, "Projects/Alpha.md", "# Alpha\n\nline one\nline two\nline three\nASSISTANT\n");
    commitAll(server, "assistant: append");
    devicePushes(
      "Projects/Alpha.md",
      "# Alpha EDITED\n\nline one\nline two\nline three\n",
      "device: edit heading",
    );

    expect((await probeMerge(server, "HEAD", "origin/main")).clean).toBe(true);
    git(server, "merge", "--no-edit", "origin/main");

    const merged = read(server, "Projects/Alpha.md");
    expect(merged).toContain("# Alpha EDITED");
    expect(merged).toContain("ASSISTANT");
    expect(filesWithMarkers(server)).toEqual([]);
  });
});

describe("a conflict", () => {
  /** Drive both sides into a genuine same-region conflict. */
  async function makeConflict() {
    write(server, "Daily/2026-08-03.md", "# Today\n\n- [ ] task one\n- [ ] ASSISTANT\n");
    commitAll(server, "assistant: append");
    devicePushes("Daily/2026-08-03.md", "# Today\n\n- [ ] task one\n- [ ] DEVICE\n", "device: append");
    const probe = await probeMerge(server, "HEAD", "origin/main");
    expect(probe.clean).toBe(false);
    return probe.paths;
  }

  it("keeps the device's version at the real filename", async () => {
    const paths = await makeConflict();
    const out = await resolveConflict({
      dir: server,
      remoteRef: "origin/main",
      paths,
      now: new Date(2026, 7, 3, 19, 58),
    });

    expect(out.ok).toBe(true);
    expect(read(server, "Daily/2026-08-03.md")).toContain("DEVICE");
    expect(read(server, "Daily/2026-08-03.md")).not.toContain("ASSISTANT");
  });

  it("saves the assistant's version alongside, and never leaves markers", async () => {
    const paths = await makeConflict();
    const out = await resolveConflict({
      dir: server,
      remoteRef: "origin/main",
      paths,
      now: new Date(2026, 7, 3, 19, 58),
    });

    const copy = "Daily/2026-08-03 (Conflicted copy notemesh 202608031958).md";
    expect(out.copies).toEqual([copy]);
    expect(read(server, copy)).toContain("ASSISTANT");
    expect(filesWithMarkers(server)).toEqual([]);
  });

  it("commits the copy so it reaches the user's other devices", async () => {
    const paths = await makeConflict();
    await resolveConflict({
      dir: server,
      remoteRef: "origin/main",
      paths,
      now: new Date(2026, 7, 3, 19, 58),
    });

    // Nothing left uncommitted, and the copy is in the tree that gets pushed.
    expect(git(server, "status", "--porcelain").trim()).toBe("");
    expect(git(server, "ls-tree", "-r", "--name-only", "HEAD")).toContain("Conflicted copy notemesh");
  });

it("leaves a clean tree on a single commit", async () => {
    const paths = await makeConflict();
    const out = await resolveConflict({ dir: server, remoteRef: "origin/main", paths });
    expect(out.ok).toBe(true);
    expect(git(server, "status", "--porcelain").trim()).toBe("");
    // Exactly one commit ahead of the remote - the copy - and nothing half-done.
    expect(git(server, "rev-list", "--count", "origin/main..HEAD").trim()).toBe("1");
  });
});

describe("binary attachments", () => {
  it("writes the conflict copy byte-for-byte, not as mangled text", async () => {
    // A PNG header plus a NUL — round-tripping this through UTF-8 would corrupt it.
    const assistantBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    const deviceBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

    fs.writeFileSync(path.join(server, "image.png"), assistantBytes);
    commitAll(server, "assistant: image");
    git(device, "pull", "-q");
    fs.writeFileSync(path.join(device, "image.png"), deviceBytes);
    commitAll(device, "device: image");
    git(device, "push", "-q");
    git(server, "fetch", "-q", "origin", "main");

    const probe = await probeMerge(server, "HEAD", "origin/main");
    expect(probe.clean).toBe(false);

    const out = await resolveConflict({
      dir: server,
      remoteRef: "origin/main",
      paths: probe.paths,
      now: new Date(2026, 7, 3, 19, 58),
    });

    const copy = out.copies![0];
    expect(fs.readFileSync(path.join(server, copy))).toEqual(assistantBytes);
    expect(fs.readFileSync(path.join(server, "image.png"))).toEqual(deviceBytes);
  });
});

describe("naming", () => {
  it("mirrors Obsidian Sync's conflicted-copy convention", () => {
    expect(conflictCopyPath("Daily/2026-08-03.md", "202608031958")).toBe(
      "Daily/2026-08-03 (Conflicted copy notemesh 202608031958).md",
    );
  });

  it("handles a note at the vault root", () => {
    expect(conflictCopyPath("Index.md", "202608031958")).toBe(
      "Index (Conflicted copy notemesh 202608031958).md",
    );
  });

  it("keeps the extension on attachments", () => {
    expect(conflictCopyPath("assets/diagram.excalidraw.png", "202601020304")).toBe(
      "assets/diagram.excalidraw (Conflicted copy notemesh 202601020304).png",
    );
  });

  it("zero-pads the timestamp", () => {
    expect(conflictStamp(new Date(2026, 0, 2, 3, 4))).toBe("202601020304");
  });
});
