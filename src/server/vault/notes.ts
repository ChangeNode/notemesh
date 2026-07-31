import fs from "node:fs";
import path from "node:path";
import { env } from "../env";
import { resolveNotePath, resolveFolderPath, toVaultRelative, readVaultFile, VaultPathError } from "./paths";

export interface NoteInfo {
  path: string;
  mtime: number;
  size: number;
}

export function readNote(notePath: string): { path: string; content: string } {
  const abs = resolveNotePath(notePath);
  if (!fs.existsSync(abs)) throw new VaultPathError(`Note not found: ${notePath}`);
  return { path: toVaultRelative(abs), content: readVaultFile(abs) };
}

export function noteExists(notePath: string): boolean {
  try {
    return fs.existsSync(resolveNotePath(notePath));
  } catch {
    return false;
  }
}

export function createNote(notePath: string, content: string): string {
  const abs = resolveNotePath(notePath);
  if (fs.existsSync(abs)) {
    throw new VaultPathError(`Note already exists: ${toVaultRelative(abs)} (use update_note to replace it)`);
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return toVaultRelative(abs);
}

export function updateNote(notePath: string, content: string): string {
  const abs = resolveNotePath(notePath);
  if (!fs.existsSync(abs)) throw new VaultPathError(`Note not found: ${notePath}`);
  fs.writeFileSync(abs, content, "utf8");
  return toVaultRelative(abs);
}

export function appendToNote(notePath: string, content: string): string {
  const abs = resolveNotePath(notePath);
  if (!fs.existsSync(abs)) throw new VaultPathError(`Note not found: ${notePath}`);
  const existing = readVaultFile(abs);
  const sep = existing.endsWith("\n") || existing === "" ? "" : "\n";
  fs.writeFileSync(abs, existing + sep + content + (content.endsWith("\n") ? "" : "\n"), "utf8");
  return toVaultRelative(abs);
}

// Insert after YAML frontmatter (matching the Obsidian CLI's prepend behavior).
export function prependToNote(notePath: string, content: string): string {
  const abs = resolveNotePath(notePath);
  if (!fs.existsSync(abs)) throw new VaultPathError(`Note not found: ${notePath}`);
  const existing = readVaultFile(abs);
  const block = content.endsWith("\n") ? content : content + "\n";
  const fmMatch = existing.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  const next = fmMatch
    ? existing.slice(0, fmMatch[0].length) + block + existing.slice(fmMatch[0].length)
    : block + existing;
  fs.writeFileSync(abs, next, "utf8");
  return toVaultRelative(abs);
}

export function moveNote(notePath: string, newPath: string): { from: string; to: string } {
  const absFrom = resolveNotePath(notePath);
  const absTo = resolveNotePath(newPath);
  if (!fs.existsSync(absFrom)) throw new VaultPathError(`Note not found: ${notePath}`);
  if (fs.existsSync(absTo)) throw new VaultPathError(`Target already exists: ${toVaultRelative(absTo)}`);
  fs.mkdirSync(path.dirname(absTo), { recursive: true });
  fs.renameSync(absFrom, absTo);
  return { from: toVaultRelative(absFrom), to: toVaultRelative(absTo) };
}

export function deleteNote(notePath: string): string {
  const abs = resolveNotePath(notePath);
  if (!fs.existsSync(abs)) throw new VaultPathError(`Note not found: ${notePath}`);
  fs.rmSync(abs);
  return toVaultRelative(abs);
}

export function listNotes(folder?: string): NoteInfo[] {
  const root = folder ? resolveFolderPath(folder) : env.vaultDir;
  if (!fs.existsSync(root)) throw new VaultPathError(`Folder not found: ${folder}`);
  const out: NoteInfo[] = [];
  walk(root, out);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

// Bounded so a pathologically deep synced tree can't blow the stack (A10).
const MAX_WALK_DEPTH = 32;

function walk(dir: string, out: NoteInfo[], depth = 0) {
  if (depth > MAX_WALK_DEPTH) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      walk(abs, out, depth + 1);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      const st = fs.statSync(abs);
      out.push({ path: toVaultRelative(abs), mtime: st.mtimeMs, size: st.size });
    }
  }
}

export function listFolders(): string[] {
  const out: string[] = [];
  const walkDirs = (dir: string, depth = 0) => {
    if (depth > MAX_WALK_DEPTH) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const abs = path.join(dir, entry.name);
      out.push(toVaultRelative(abs));
      walkDirs(abs, depth + 1);
    }
  };
  walkDirs(env.vaultDir);
  return out.sort();
}
