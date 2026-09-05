import fs from "node:fs";
import { resolveNotePath, readVaultFile, VaultPathError } from "./paths";
import { writeVaultFile } from "./disk";
import { splitFrontmatter, joinFrontmatter } from "./markdown";
import { db } from "../db";

// Every parse and every serialisation goes through markdown.ts; see the note
// there on why there is exactly one parser.

function parsed(notePath: string) {
  const abs = resolveNotePath(notePath);
  if (!fs.existsSync(abs)) throw new VaultPathError(`Note not found: ${notePath}`);
  return { abs, ...splitFrontmatter(readVaultFile(abs)) };
}

// A property edit on a note whose frontmatter will not parse would stack a
// second block above the broken one. Refuse, and say what to do.
function assertEditable(p: { invalid: boolean }, notePath: string) {
  if (p.invalid) {
    throw new VaultPathError(
      `${notePath} opens with frontmatter that is not valid YAML, so its properties cannot be read or ` +
        `changed here. Fix the block at the top of the note in Obsidian first.`,
    );
  }
}

export function readProperties(notePath: string): Record<string, unknown> {
  const p = parsed(notePath);
  assertEditable(p, notePath);
  return p.data;
}

// Property names that could pollute a prototype if this object were ever
// merged unsafely downstream. Rejected defensively even though our own reads
// (JSON.parse + Object.keys) don't pollute, and the parser drops them anyway.
const FORBIDDEN_PROP_NAMES = new Set(["__proto__", "constructor", "prototype"]);

/**
 * The result of a frontmatter edit.
 *
 * `changed` says whether the note's bytes were actually rewritten, which is the
 * same question for both operations — "was it already in the state you asked
 * for?" — so both return it under the same name rather than one saying `removed`
 * and the other returning a bare object.
 */
export interface PropertyEdit {
  changed: boolean;
  properties: Record<string, unknown>;
}

// Values come back from the parser as JSON-safe scalars, arrays and plain
// objects. Comparing their JSON is enough to decide "is this already the
// value", and avoids rewriting a note to store what it already says.
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function setProperty(notePath: string, name: string, value: unknown): PropertyEdit {
  if (FORBIDDEN_PROP_NAMES.has(name)) {
    throw new VaultPathError(`Property name "${name}" is not allowed`);
  }
  const p = parsed(notePath);
  assertEditable(p, notePath);
  const existing = { ...p.data };
  const data = { ...existing, [name]: value };
  if (
    Object.prototype.hasOwnProperty.call(existing, name) &&
    sameValue(existing[name], value)
  ) {
    return { changed: false, properties: existing };
  }
  writeVaultFile(p.abs, joinFrontmatter(p.body, data));
  return { changed: true, properties: data };
}

/**
 * Remove a frontmatter property.
 *
 * `changed` reports whether the property was actually there. Removing something
 * absent is still a success — the caller asked for a state, and the note is in
 * it — but "removed it" and "it was never set" are different answers to "did my
 * edit apply", and collapsing them leaves a caller unable to tell a typo in the
 * property name from a no-op.
 *
 * A miss also skips the write entirely. Rewriting an unchanged note is not
 * free: it moves the mtime, re-indexes, and on the git backend produces a
 * commit and a push for a file whose bytes did not change.
 */
export function removeProperty(notePath: string, name: string): PropertyEdit {
  const p = parsed(notePath);
  assertEditable(p, notePath);
  const data = { ...p.data };
  if (!Object.prototype.hasOwnProperty.call(data, name)) {
    return { changed: false, properties: data };
  }
  delete data[name];
  const next = Object.keys(data).length > 0 ? joinFrontmatter(p.body, data) : p.body.replace(/^\n+/, "");
  writeVaultFile(p.abs, next);
  return { changed: true, properties: data };
}

// Vault-wide property survey from the index (property name -> usage count).
export function listVaultProperties(): Record<string, number> {
  const rows = db()
    .prepare("SELECT frontmatter FROM notes WHERE frontmatter IS NOT NULL")
    .all() as { frontmatter: string }[];
  const counts: Record<string, number> = {};
  for (const row of rows) {
    try {
      for (const key of Object.keys(JSON.parse(row.frontmatter))) {
        counts[key] = (counts[key] ?? 0) + 1;
      }
    } catch {
      // Skip unparseable frontmatter rows.
    }
  }
  return counts;
}
