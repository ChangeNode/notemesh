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

export function removeProperty(notePath: string, name: string): Record<string, unknown> {
  const abs = resolveNotePath(notePath);
  if (!fs.existsSync(abs)) throw new VaultPathError(`Note not found: ${notePath}`);
  const parsed = matter(readVaultFile(abs));
  const data = { ...(parsed.data ?? {}) };
  delete data[name];
  const body = parsed.content;
  const next = Object.keys(data).length > 0 ? matter.stringify(body, data) : body.replace(/^\n+/, "");
  fs.writeFileSync(abs, next, "utf8");
  return data;
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
