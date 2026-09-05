import path from "node:path";
import fs from "node:fs";
import { runGit, runGitBuffer } from "./git-exec";

// What to do when git can't reconcile two versions on its own.
//
// This only ever runs for the residue: the same region of the same note changed
// on both sides inside one sync window. Everything else — different notes, or
// the same note in different places — git merges cleanly and this file is not
// involved.
//
// There is one behaviour, and it is Obsidian Sync's: the remote's version keeps
// the real filename, ours is saved beside it as a conflicted copy, and both are
// committed so the copy reaches every device. The user resolves it in Obsidian,
// with or without asking their assistant to help.
//
// Earlier versions offered two more, chosen on the Settings tab, and both were
// dropped. Parking ours on a branch left the vault pristine — but the branch
// never left the server, so a user without a shell into the container could
// not reach it, while the UI told them it was "visible in a git client". And
// letting git write <<<<<<< markers put both versions in front of the user at
// once — inside a note the assistant then read as content. A copy in the vault
// is the only outcome the user can act on from where they actually are.

export interface ConflictOutcome {
  ok: boolean;
  /** Vault-relative paths git could not merge. */
  paths: string[];
  /**
   * Aligned with `paths`: the conflicted copy written for each, or null where
   * our side had no version to save (a path only the other side had). Kept in
   * step by construction, because the notice to connectors pairs them up.
   */
  copies?: (string | null)[];
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
  paths: string[];
  now?: Date;
}

// Ours becomes `<name> (Conflicted copy ...)`, the remote keeps the real
// filename. Your device's version stays where you left it; the assistant's
// arrives alongside, and both are committed so the copy reaches your devices.
//
// Leaves the repo on a single commit with a clean working tree, so the next
// sync cycle proceeds normally rather than finding a half-finished merge — and
// so the caller has nothing to wait on. A handled conflict is not a state.
export async function resolveConflict(opts: ResolveOptions): Promise<ConflictOutcome> {
  const { dir, remoteRef, paths } = opts;
  const now = opts.now ?? new Date();
  const local = (await runGit(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
  const stamp = conflictStamp(now);

  // Read our versions out of the object database before moving the working
  // tree, so nothing depends on what is currently checked out.
  // One entry per path, in order, so the copies line up with the paths they
  // were made for; a null is a path that only the other side had.
  const saved: ({ copyPath: string; content: Buffer } | null)[] = [];
  for (const rel of paths) {
    const blob = await runGitBuffer(["show", `${local}:${rel}`], { cwd: dir });
    // A path that only exists on one side has no blob here; the remote's state
    // is then already correct and there is nothing of ours to preserve.
    saved.push(blob.ok ? { copyPath: conflictCopyPath(rel, stamp), content: blob.stdout } : null);
  }

  const reset = await runGit(["reset", "--hard", remoteRef], { cwd: dir });
  if (!reset.ok) {
    return {
      ok: false,
      paths,
      message: `Could not reset to the remote: ${reset.combined.trim()}`,
    };
  }

  for (const s of saved) {
    if (!s) continue;
    const { copyPath, content } = s;
    const abs = path.join(dir, copyPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  const copies = saved.map((s) => (s ? s.copyPath : null));
  const written = copies.filter((c): c is string => c !== null);
  if (written.length) {
    await runGit(["add", "-A"], { cwd: dir });
    await runGit(
      [
        "-c",
        "user.name=notemesh",
        "-c",
        "user.email=notemesh@localhost",
        "commit",
        "-m",
        `notemesh: conflict ${written.length === 1 ? "copy" : "copies"}\n\n${written.join("\n")}`,
      ],
      { cwd: dir },
    );
  }

  return {
    ok: true,
    paths,
    copies,
    // Built from the pairs, so the log line and the Status tab say the same
    // thing the notices do.
    message:
      `Conflicting edits on ${paths
        .map((p, i) =>
          copies[i] ? `${p} (the assistant's version saved as ${copies[i]})` : `${p} (nothing of ours to save)`,
        )
        .join("; ")}. Your other devices' version kept the original filename.`,
  };
}
