import fs from "node:fs";
import path from "node:path";
import { db } from "../db";
import { env } from "../env";
import { readVaultFile } from "./paths";
import { writeVaultFile } from "./disk";
import { maskCodeSpans } from "./markdown";

/**
 * Keep links pointing where they pointed when a note moves.
 *
 * Obsidian rewrites every [[link]] when a note is renamed inside the app;
 * a rename made here used to leave them behind, so the note's backlinks
 * silently became unresolved. The index already knows every note whose
 * links resolve to the moved path, and for each of those the raw targets
 * that did, so the work is a scan of those notes for those targets.
 *
 * A link keeps its form: a bare name stays a bare name unless the new name
 * would be ambiguous, in which case it becomes a path, and a link written
 * as a path stays a path. Alias, heading and block suffixes are kept. Code
 * fences and inline code are left alone: a link there is text about links.
 * Wikilinks only, matching what the index resolves.
 */
export interface RewriteResult {
  /** Vault-relative paths of the notes whose text changed, moved note under its new path. */
  notes: string[];
  links: number;
}

// The same shape as the index's WIKILINK, with the target and the rest
// captured separately so only the target is replaced. No g flag here; it is
// added per scan so a shared regex never carries lastIndex between lines.
const WIKILINK = /\[\[([^\]|#^]+)((?:[#^][^\]|]*)?(?:\|[^\]]*)?)\]\]/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

function stripMd(p: string): string {
  return p.toLowerCase().endsWith(".md") ? p.slice(0, -3) : p;
}

/**
 * What a link that read `oldTarget` and resolved to `from` should read now
 * that the note is at `to`. Null when it can keep its text.
 */
export function newTarget(oldTarget: string, from: string, to: string, basenameCount: (base: string) => number): string | null {
  const t = oldTarget.trim();
  const withMd = t.toLowerCase().endsWith(".md");
  const asPath = withMd ? to : stripMd(to);
  const pathForm = t.includes("/") || t.includes("\\");
  if (pathForm) return asPath === t ? null : asPath;
  const newBase = path.basename(stripMd(to));
  const oldBase = path.basename(stripMd(from));
  // A bare name only needs changing when the name itself changed, or the
  // new name is shared with another file, in which case it can no longer be
  // relied on to find this one.
  if (newBase.toLowerCase() === oldBase.toLowerCase() && basenameCount(newBase) <= 1) return null;
  const bare = basenameCount(newBase) <= 1 ? newBase + (withMd ? ".md" : "") : asPath;
  return bare === t ? null : bare;
}

/**
 * Rewrite, in one note's text, every wikilink whose target is in `targets`.
 * Returns the new text and the number of links changed, or null when
 * nothing changed.
 */
export function rewriteText(
  content: string,
  targets: Set<string>,
  replacement: (target: string) => string | null,
): { text: string; links: number } | null {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  let links = 0;
  let fence: { ch: string; len: number } | null = null;
  const re = new RegExp(WIKILINK.source, "g");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      const m = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len) fence = null;
      continue;
    }
    const open = line.match(FENCE);
    if (open) {
      fence = { ch: open[1][0], len: open[1].length };
      continue;
    }
    // Masking keeps the length, so an index on the masked copy is the same
    // index on the line; the replacement is spliced into the real line.
    const masked = maskCodeSpans(line);
    let out = "";
    let last = 0;
    re.lastIndex = 0;
    for (let m = re.exec(masked); m !== null; m = re.exec(masked)) {
      const target = m[1].trim();
      const next = targets.has(target) ? replacement(target) : null;
      if (next === null) continue;
      const targetStart = m.index + 2 + m[1].indexOf(target);
      out += line.slice(last, targetStart) + next;
      last = targetStart + target.length;
      links++;
    }
    if (last > 0) lines[i] = out + line.slice(last);
  }
  return links === 0 ? null : { text: lines.join(eol), links };
}

/**
 * After `from` has been renamed to `to` on disk, and before the index has
 * been told: fix every note that linked to it. The index still says who
 * did, which is why the order matters.
 */
export function rewriteLinksForMove(from: string, to: string): RewriteResult {
  const d = db();
  const rows = d
    .prepare("SELECT source_path, target FROM links WHERE resolved_path = ?")
    .all(from) as { source_path: string; target: string }[];
  const bySource = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = bySource.get(r.source_path) ?? new Set<string>();
    set.add(r.target.trim());
    bySource.set(r.source_path, set);
  }
  if (bySource.size === 0) return { notes: [], links: 0 };

  // Basenames as they will be after the move, for the ambiguity check.
  const counts = new Map<string, number>();
  const paths = (d.prepare("SELECT path FROM notes UNION ALL SELECT path FROM attachments").all() as { path: string }[])
    .map((r) => r.path)
    .filter((p) => p !== from)
    .concat([to]);
  for (const p of paths) {
    const base = path.basename(stripMd(p)).toLowerCase();
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  const basenameCount = (base: string) => counts.get(base.toLowerCase()) ?? 0;

  const result: RewriteResult = { notes: [], links: 0 };
  for (const [source, targets] of bySource) {
    // The moved note's own links to itself: it is now at `to`.
    const rel = source === from ? to : source;
    const abs = path.join(env.vaultDir, rel);
    if (!fs.existsSync(abs)) continue;
    const content = readVaultFile(abs);
    const rewritten = rewriteText(content, targets, (t) => newTarget(t, from, to, basenameCount));
    if (!rewritten) continue;
    writeVaultFile(abs, rewritten.text);
    result.notes.push(rel);
    result.links += rewritten.links;
  }
  return result;
}
