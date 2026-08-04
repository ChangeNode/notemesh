import fs from "node:fs";
import matter from "gray-matter";
import { resolveNotePath, readVaultFile, VaultPathError } from "./paths";
import { db } from "../db";

export function readProperties(notePath: string): Record<string, unknown> {
  const abs = resolveNotePath(notePath);
  if (!fs.existsSync(abs)) throw new VaultPathError(`Note not found: ${notePath}`);
  return matter(readVaultFile(abs)).data ?? {};
}

// Property names that could pollute a prototype if this object were ever
// merged unsafely downstream. Rejected defensively even though our own reads
// (JSON.parse + Object.keys) don't pollute.
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

// Values come back from YAML as scalars, arrays, plain objects, or Dates.
// Comparing their JSON is enough to decide "is this already the value", and
// avoids rewriting a note to store what it already says.
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function setProperty(notePath: string, name: string, value: unknown): PropertyEdit {
  if (FORBIDDEN_PROP_NAMES.has(name)) {
    throw new VaultPathError(`Property name "${name}" is not allowed`);
  }
  const abs = resolveNotePath(notePath);
  if (!fs.existsSync(abs)) throw new VaultPathError(`Note not found: ${notePath}`);
  const parsed = matter(readVaultFile(abs));
  const existing = { ...(parsed.data ?? {}) };
  const data = { ...existing, [name]: value };
  if (
    Object.prototype.hasOwnProperty.call(existing, name) &&
    sameValue(existing[name], value)
  ) {
    return { changed: false, properties: existing };
  }
  fs.writeFileSync(abs, matter.stringify(parsed.content, data), "utf8");
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
  const abs = resolveNotePath(notePath);
  if (!fs.existsSync(abs)) throw new VaultPathError(`Note not found: ${notePath}`);
  const parsed = matter(readVaultFile(abs));
  const data = { ...(parsed.data ?? {}) };
  if (!Object.prototype.hasOwnProperty.call(data, name)) {
    return { changed: false, properties: data };
  }
  delete data[name];
  const body = parsed.content;
  const next = Object.keys(data).length > 0 ? matter.stringify(body, data) : body.replace(/^\n+/, "");
  fs.writeFileSync(abs, next, "utf8");
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
