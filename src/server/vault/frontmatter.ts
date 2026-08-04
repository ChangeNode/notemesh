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

export function setProperty(notePath: string, name: string, value: unknown): Record<string, unknown> {
  if (FORBIDDEN_PROP_NAMES.has(name)) {
    throw new VaultPathError(`Property name "${name}" is not allowed`);
  }
  const abs = resolveNotePath(notePath);
  if (!fs.existsSync(abs)) throw new VaultPathError(`Note not found: ${notePath}`);
  const parsed = matter(readVaultFile(abs));
  const data = { ...(parsed.data ?? {}), [name]: value };
  fs.writeFileSync(abs, matter.stringify(parsed.content, data), "utf8");
  return data;
}

/**
 * Remove a frontmatter property.
 *
 * Reports whether the property was actually there. Removing something absent is
 * still a success — the caller asked for a state, and the note is in it — but
 * "removed" and "was never set" are different answers to "did my edit apply",
 * and collapsing them leaves a caller unable to tell a typo in the property
 * name from a no-op.
 *
 * A miss also skips the write entirely. Rewriting an unchanged note is not
 * free: it moves the mtime, re-indexes, and on the git backend produces a
 * commit and a push for a file whose bytes did not change.
 */
export function removeProperty(
  notePath: string,
  name: string,
): { removed: boolean; properties: Record<string, unknown> } {
  const abs = resolveNotePath(notePath);
  if (!fs.existsSync(abs)) throw new VaultPathError(`Note not found: ${notePath}`);
  const parsed = matter(readVaultFile(abs));
  const data = { ...(parsed.data ?? {}) };
  if (!Object.prototype.hasOwnProperty.call(data, name)) {
    return { removed: false, properties: data };
  }
  delete data[name];
  const body = parsed.content;
  const next = Object.keys(data).length > 0 ? matter.stringify(body, data) : body.replace(/^\n+/, "");
  fs.writeFileSync(abs, next, "utf8");
  return { removed: true, properties: data };
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
