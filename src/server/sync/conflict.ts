import path from "node:path";
import fs from "node:fs";
import { runGit, runGitBuffer } from "./git-exec";

// What to do when git can't reconcile two versions on its own.
//
// This only ever runs for the residue: the same region of the same note changed
// on both sides inside one sync window. Everything else — different notes, or
// the same note in different places — git merges cleanly and neither this file
// nor the operator's setting is involved.
export type ConflictStrategy =
  // Keep the remote's version at the real filename and save ours alongside it,
  // mirroring what Obsidian Sync does. The copy syncs to every device, which a
  // branch does not, so the operator actually finds out.
  | "file"
  // Park our version on a branch and take the remote's. Leaves the vault
  // pristine; only discoverable from the Status tab or a git client.
  | "branch"
  // Let git write <<<<<<< markers into the note. Faithful to git, and the only
  // option that puts both versions in front of you at once — but the assistant
  // reads these files and will treat the markers as content.
  | "inline";

export const DEFAULT_CONFLICT_STRATEGY: ConflictStrategy = "file";

export function parseConflictStrategy(value: string | undefined): ConflictStrategy {
  return value === "branch" || value === "inline" ? value : DEFAULT_CONFLICT_STRATEGY;
}

export interface ConflictOutcome {
  ok: boolean;
  strategy: ConflictStrategy;
  /** Vault-relative paths git could not merge. */
  paths: string[];
  /** Branch the local commit was parked on, for the "branch" strategy. */
  branch?: string;
  /** Conflict copies written, for the "file" strategy. */
  copies?: string[];
  message: string;
}

// Would merging these two commits succeed, and if not, which files are the
// problem? `merge-tree --write-tree` answers both entirely inside git's object
// database: no checkout, no index change, and above all nothing written into
// the vault the indexer is watching.
//
// Output shape (git >= 2.38):
//   <tree-oid>\n<conflicted path>\n<conflicted path>\n\n<human-readable notes>
export async function probeMerge(
  dir: string,
  ours: string,
  theirs: string,
): Promise<{ clean: boolean; paths: string[] }> {
  const res = await runGit(["merge-tree", "--write-tree", "--name-only", ours, theirs], {
    cwd: dir,
  });
  if (res.ok) return { clean: true, paths: [] };
  const block = res.stdout.split("\n\n")[0] ?? "";
  const lines = block.split("\n").filter(Boolean);
  return { clean: false, paths: lines.slice(1) };
}

// `Daily/2026-08-03.md` -> `Daily/2026-08-03 (Conflicted copy notemesh 202608031958).md`
// Deliberately Obsidian Sync's convention, with notemesh where it puts the
// device name — because that is what this is: another device that edited the note.
export function conflictCopyPath(relPath: string, stamp: string): string {
  const dir = path.dirname(relPath);
  const ext = path.extname(relPath);
  const base = path.basename(relPath, ext);
  const name = `${base} (Conflicted copy notemesh ${stamp})${ext}`;
  return dir === "." ? name : path.posix.join(dir, name);
}

export function conflictStamp(at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}` +
    `${p(at.getHours())}${p(at.getMinutes())}`
  );
}

export interface ResolveOptions {
  dir: string;
  remoteRef: string;
  strategy: ConflictStrategy;
  paths: string[];
  now?: Date;
}

// Apply the operator's chosen strategy. Every branch leaves the repo on a
// single commit with a clean working tree, so the next sync cycle proceeds
// normally rather than finding a half-finished merge.
export async function resolveConflict(opts: ResolveOptions): Promise<ConflictOutcome> {
  const { dir, remoteRef, strategy, paths } = opts;
  const now = opts.now ?? new Date();

  if (strategy === "inline") return inlineMerge(dir, remoteRef, paths);
  if (strategy === "branch") return parkOnBranch(dir, remoteRef, paths, now);
  return writeConflictCopies(dir, remoteRef, paths, now);
}

// Ours becomes `<name> (Conflicted copy ...)`, the remote keeps the real
// filename. Your device's version stays where you left it; the assistant's
// arrives alongside, and both are committed so the copy reaches your devices.
async function writeConflictCopies(
  dir: string,
  remoteRef: string,
  paths: string[],
  now: Date,
): Promise<ConflictOutcome> {
  const local = (await runGit(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
  const stamp = conflictStamp(now);

  // Read our versions out of the object database before moving the working
  // tree, so nothing depends on what is currently checked out.
  const saved: { copyPath: string; content: Buffer }[] = [];
  for (const rel of paths) {
    const blob = await runGitBuffer(["show", `${local}:${rel}`], { cwd: dir });
    // A path that only exists on one side has no blob here; the remote's state
    // is then already correct and there is nothing of ours to preserve.
    if (!blob.ok) continue;
    saved.push({ copyPath: conflictCopyPath(rel, stamp), content: blob.stdout });
  }

  const reset = await runGit(["reset", "--hard", remoteRef], { cwd: dir });
  if (!reset.ok) {
    return {
      ok: false,
      strategy: "file",
      paths,
      message: `Could not reset to the remote: ${reset.combined.trim()}`,
    };
  }

  for (const { copyPath, content } of saved) {
    const abs = path.join(dir, copyPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  const copies = saved.map((s) => s.copyPath);
  if (copies.length) {
    await runGit(["add", "-A"], { cwd: dir });
    await runGit(
      [
        "-c",
        "user.name=notemesh",
        "-c",
        "user.email=notemesh@localhost",
        "commit",
        "-m",
        `notemesh: conflict ${copies.length === 1 ? "copy" : "copies"}\n\n${copies.join("\n")}`,
      ],
      { cwd: dir },
    );
  }

  return {
    ok: true,
    strategy: "file",
    paths,
    copies,
    message:
      `Conflicting edits on ${paths.join(", ")}. Your other devices' version kept the ` +
      `original filename; the assistant's is saved alongside as ` +
      `${copies.join(", ") || "(nothing to save)"}.`,
  };
}

// Leaves the vault exactly matching the remote and keeps our commit reachable
// under a dated branch. Nothing is written into the notes folder at all.
async function parkOnBranch(
  dir: string,
  remoteRef: string,
  paths: string[],
  now: Date,
): Promise<ConflictOutcome> {
  const branch = `notemesh/conflict-${now.toISOString().replace(/[:.]/g, "-")}`;
  const made = await runGit(["branch", branch], { cwd: dir });
  if (!made.ok) {
    return {
      ok: false,
      strategy: "branch",
      paths,
      message: `Could not park conflicting work: ${made.combined.trim()}`,
    };
  }
  const reset = await runGit(["reset", "--hard", remoteRef], { cwd: dir });
  if (!reset.ok) {
    return {
      ok: false,
      strategy: "branch",
      paths,
      message: `Could not reset to the remote: ${reset.combined.trim()}`,
    };
  }
  return {
    ok: true,
    strategy: "branch",
    paths,
    branch,
    message:
      `Conflicting edits on ${paths.join(", ")}. The vault now matches the remote; the ` +
      `assistant's version is on branch ${branch}. Recover it with: git merge ${branch}`,
  };
}

// The operator explicitly asked for git's own behaviour. Run the merge, let it
// leave markers, and commit the result so the repo isn't stuck mid-merge.
async function inlineMerge(
  dir: string,
  remoteRef: string,
  paths: string[],
): Promise<ConflictOutcome> {
  await runGit(["merge", "--no-edit", remoteRef], { cwd: dir });
  await runGit(["add", "-A"], { cwd: dir });
  const committed = await runGit(
    [
      "-c",
      "user.name=notemesh",
      "-c",
      "user.email=notemesh@localhost",
      "commit",
      "--no-edit",
      "-m",
      `notemesh: merge with conflict markers\n\n${paths.join("\n")}`,
    ],
    { cwd: dir },
  );
  if (!committed.ok) {
    await runGit(["merge", "--abort"], { cwd: dir });
    return {
      ok: false,
      strategy: "inline",
      paths,
      message: `Inline merge failed; aborted: ${committed.combined.trim()}`,
    };
  }
  return {
    ok: true,
    strategy: "inline",
    paths,
    message:
      `Conflicting edits on ${paths.join(", ")}. Both versions are in the note, separated by ` +
      `<<<<<<< markers — the assistant will read those markers as note content until you ` +
      `resolve them.`,
  };
}
