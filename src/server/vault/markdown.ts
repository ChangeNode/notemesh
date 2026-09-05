import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { splitLines } from "./text";

/**
 * Structure extracted from a note body: headings, wikilinks, tags, tasks.
 *
 * One implementation, used by the indexer (which stores what it finds) and by
 * get_outline (which reports it). They used to be two copies of the same
 * regexes, and the copies drifted — outline scanned the whole file, frontmatter
 * included, so a YAML comment came back as an H1 that search had never seen.
 * With one function there is nothing to keep in step.
 *
 * Obsidian-flavoured, not CommonMark. Wikilinks, #tags and task checkboxes are
 * extensions no general parser knows, and the tag rule deliberately follows
 * Obsidian's (#fff and #include are tags; #123 is not) — those patterns are
 * kept exactly as they were, because changing them would quietly re-index
 * every vault. What is borrowed from CommonMark is block structure: which
 * lines are code, which are comment, which are a heading. That is precisely
 * where a line-by-line scan went wrong, and it is the same for both callers.
 */

export interface Heading {
  level: number;
  text: string;
  /** 1-based, relative to the body handed in. Add the frontmatter offset for a file line. */
  line: number;
}

export interface Task {
  line: number;
  text: string;
  done: boolean;
}

// Rows one note may contribute per kind. A note made of nothing but tags
// produced 5,000 tag rows in 43 ms — speed is not the concern, index size is:
// the read cap alone would allow on the order of a million rows from a single
// synced file. The excess is dropped and the note is still indexed. (#26)
export const MAX_PER_KIND = 2000;

export interface NoteStructure {
  headings: Heading[];
  links: string[];
  tags: string[];
  tasks: Task[];
}

/**
 * Frontmatter, parsed the one way this server parses it.
 *
 * Every parse — the indexer, get_outline, the property tools — comes through
 * here, so its security behaviour cannot drift between callers. Three rules,
 * each the answer to a way the previous parser went wrong (NM-SEC-001, 004,
 * 005, 006):
 *
 * YAML, and only YAML. The previous library autodetected a language from the
 * text after the opening `---`, and for `---js` it ran the block through
 * eval — inside this process, with the vault, the database and the
 * environment in reach. A note is Obsidian frontmatter only when its first
 * line is exactly `---`; anything else is note text and is indexed as such.
 *
 * YAML 1.2 core schema. No timestamps (so `created: 2026-08-06` stays the
 * string Obsidian means, rather than a Date shifted to midnight UTC), no
 * `!!omap` (the quadratic-time path in the old parser), and an alias
 * expansion cap, so a billion-laughs document is refused rather than parsed.
 *
 * Normalised before anyone sees it. Valid YAML can refer to itself, and the
 * old parser handed the cycle on to JSON.stringify, which threw and aborted
 * the whole index rebuild at that note. The result is walked with a depth
 * limit, a node limit, cycle detection and prototype-key removal, and comes
 * out as a bounded, acyclic, JSON-safe plain object or is refused.
 */

export const MAX_FRONTMATTER_DEPTH = 32;
export const MAX_FRONTMATTER_NODES = 10_000;
const MAX_ALIAS_COUNT = 100;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export interface SplitFrontmatter {
  data: Record<string, unknown>;
  body: string;
  /** Lines the frontmatter occupied, so a body line number can be made file-absolute. */
  fmOffset: number;
  /**
   * True when the note opens with a frontmatter block that could not be
   * parsed or normalised. The whole content is then the body — the indexer
   * wants that — but a property edit must refuse rather than stack a second
   * block on top of a broken one.
   */
  invalid: boolean;
}

/**
 * Frontmatter off the top, plus how many lines it occupied. Bad frontmatter is
 * not an error here: the raw content is the body, and gets indexed as such.
 */
export function splitFrontmatter(content: string): SplitFrontmatter {
  const none: SplitFrontmatter = { data: {}, body: content, fmOffset: 0, invalid: false };
  // Exactly `---` on the first line. `---js`, `---yaml`, `--- ` are not
  // frontmatter to Obsidian and are not to us.
  if (!/^---\r?\n/.test(content)) return none;
  const openLen = content.indexOf("\n") + 1;
  const rest = content.slice(openLen);
  const close = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (!close) return none;
  const yamlText = rest.slice(0, close.index);
  const bodyStart = openLen + close.index + close[0].length;
  const body = content.slice(bodyStart);
  let data: Record<string, unknown>;
  try {
    // "error": warnings are not printed, errors are thrown. ("silent" would
    // swallow the errors too and hand back a best-effort value for broken YAML.)
    data = normalizeFrontmatter(parseYaml(yamlText, { maxAliasCount: MAX_ALIAS_COUNT, logLevel: "error" }));
  } catch {
    return { ...none, invalid: true };
  }
  const fmOffset = content.slice(0, bodyStart).split("\n").length - 1;
  return { data, body, fmOffset, invalid: false };
}

/**
 * A parsed YAML value as a bounded, acyclic, JSON-safe plain object, or a
 * throw. The mapping's own keys are kept in order; prototype-affecting keys
 * are dropped; an object reached twice on one path is a cycle and is refused,
 * while the same object reached on two different paths (a shared anchor) is
 * simply copied twice.
 */
export function normalizeFrontmatter(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("frontmatter is not a mapping");
  const onPath = new Set<object>();
  let nodes = 0;
  const walk = (v: unknown, depth: number): unknown => {
    if (++nodes > MAX_FRONTMATTER_NODES) throw new Error("frontmatter has too many values");
    if (depth > MAX_FRONTMATTER_DEPTH) throw new Error("frontmatter is nested too deeply");
    if (v === null || v === undefined) return null;
    switch (typeof v) {
      case "string":
      case "boolean":
        return v;
      case "number":
        return Number.isFinite(v) ? v : null;
      case "bigint":
        return String(v);
      case "object":
        break;
      default:
        throw new Error("frontmatter holds an unsupported value");
    }
    const o = v as object;
    if (onPath.has(o)) throw new Error("frontmatter refers to itself");
    onPath.add(o);
    try {
      if (o instanceof Date) return o.toISOString();
      if (Array.isArray(o) || o instanceof Set) return [...(o as Iterable<unknown>)].map((x) => walk(x, depth + 1));
      const entries = o instanceof Map ? [...o.entries()].map(([k, x]) => [String(k), x] as const) : Object.entries(o);
      const out: Record<string, unknown> = {};
      for (const [k, x] of entries) {
        if (FORBIDDEN_KEYS.has(k)) continue;
        out[k] = walk(x, depth + 1);
      }
      return out;
    } finally {
      onPath.delete(o);
    }
  };
  return walk(value, 0) as Record<string, unknown>;
}

/**
 * A note with this frontmatter above this body, laid out the way Obsidian
 * writes it: `---`, the mapping, `---`, then the body as given. Long strings
 * are never folded; Obsidian does not fold them either.
 */
export function joinFrontmatter(body: string, data: Record<string, unknown>): string {
  const normalized = normalizeFrontmatter(data);
  return `---\n${stringifyYaml(normalized, { lineWidth: 0 })}---\n${body}`;
}

// The extraction patterns. Unchanged on purpose — see the header comment.
const ATX_HEADING = /^#{1,6}\s+(.+)$/;
const WIKILINK = /\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const TAG = /(^|\s)#([A-Za-z0-9_][A-Za-z0-9_/-]*)/g;
const TASK = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/;

// Block structure.
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;
const INDENTED = /^(?: {4,}|\t)/;

/**
 * Replace every inline code span with spaces of the same length, so the
 * link and tag patterns never see its contents. CommonMark's rule: a run of N
 * backticks opens a span that the next run of exactly N backticks closes; an
 * unmatched run is literal text. Length is preserved so nothing else shifts.
 */
export function maskCodeSpans(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      out += line[i++];
      continue;
    }
    let n = 0;
    while (line[i + n] === "`") n++;
    const open = "`".repeat(n);
    // The closing run must be exactly n long: not part of a longer run.
    let j = i + n;
    let close = -1;
    while (j < line.length) {
      const k = line.indexOf(open, j);
      if (k < 0) break;
      let m = 0;
      while (line[k + m] === "`") m++;
      if (m === n) {
        close = k;
        break;
      }
      j = k + m;
    }
    if (close < 0) {
      out += open;
      i += n;
      continue;
    }
    out += " ".repeat(close + n - i);
    i = close + n;
  }
  return out;
}

export function extractStructure(body: string): NoteStructure {
  const headings: Heading[] = [];
  const links: string[] = [];
  const tags = new Set<string>();
  const tasks: Task[] = [];

  // Normalised, so a CRLF note still yields its headings and tasks — see text.ts.
  const lines = splitLines(body);

  let fence: { ch: string; len: number } | null = null;
  let inComment = false;
  let inIndentedCode = false;
  let prevBlank = true; // the start of the body counts as a blank before it
  // Whether the nearest preceding non-blank line was a list item or its
  // continuation. Four spaces of indent under a list item is nested list
  // content, not a code block — nested tasks are exactly how people use
  // Obsidian, and they must keep being tasks.
  let inList = false;
  // The previous line, if it could be the text of a setext heading: a plain
  // paragraph line, not a heading, list item, fence or code.
  let setextCandidate: { text: string; line: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Inside a fenced block: only a closing fence of the same character, at
    // least as long as the opener, ends it. ~~~ does not close ```.
    if (fence) {
      const m = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len) fence = null;
      continue;
    }

    // Inside an HTML comment: skip until it closes; what follows the close on
    // the same line is ordinary text.
    if (inComment) {
      const end = line.indexOf("-->");
      if (end < 0) continue;
      inComment = false;
      line = line.slice(end + 3);
    }
    // Comments that open and close on this line contribute nothing; one that
    // opens and does not close swallows the rest of the line and the lines
    // after it. Openers are looked for on the code-span-masked line: a
    // backticked `<!--` in a note about HTML syntax is text, and treating it
    // as an opener swallowed every line after it until a closer that never
    // came. Masking preserves length, so an index on the masked copy is the
    // same index on the line, and both are cut the same way. (The closer
    // above is found on the raw line: inside a comment there are no spans.)
    let spans = maskCodeSpans(line);
    for (const m of [...spans.matchAll(/<!--[\s\S]*?-->/g)].reverse()) {
      const a = m.index!;
      const b = a + m[0].length;
      line = line.slice(0, a) + " " + line.slice(b);
      spans = spans.slice(0, a) + " " + spans.slice(b);
    }
    const open = spans.indexOf("<!--");
    if (open >= 0) {
      inComment = true;
      line = line.slice(0, open);
    }

    const blank = line.trim() === "";

    // Indented code: continues through indented or blank lines, ends at the
    // first non-indented non-blank one.
    if (inIndentedCode) {
      if (blank || INDENTED.test(line)) continue;
      inIndentedCode = false;
    }

    if (blank) {
      prevBlank = true;
      setextCandidate = null;
      continue;
    }

    const fenceOpen = line.match(FENCE_OPEN);
    if (fenceOpen) {
      fence = { ch: fenceOpen[1][0], len: fenceOpen[1].length };
      prevBlank = false;
      inList = false;
      setextCandidate = null;
      continue;
    }

    const isList = LIST_ITEM.test(line);

    // A code block by indentation, but only where CommonMark would see one:
    // after a blank line, and not as the continuation of a list.
    if (INDENTED.test(line) && prevBlank && !inList && !isList) {
      inIndentedCode = true;
      prevBlank = false;
      setextCandidate = null;
      continue;
    }

    // Setext: a line of = or - directly under a paragraph line makes that
    // line the heading. Under anything else — a list, a heading, a blank —
    // it is a thematic break and nothing here.
    const underline = line.match(SETEXT_UNDERLINE);
    if (underline && setextCandidate) {
      headings.push({
        level: underline[1][0] === "=" ? 1 : 2,
        text: setextCandidate.text.trim(),
        line: setextCandidate.line,
      });
      setextCandidate = null;
      prevBlank = false;
      continue;
    }

    const atx = line.match(ATX_HEADING);
    if (atx) {
      headings.push({ level: line.match(/^#+/)![0].length, text: atx[1].trim(), line: i + 1 });
      setextCandidate = null;
      prevBlank = false;
      inList = false;
      continue;
    }

    // Links and tags never come from inside inline code; a note about
    // Obsidian syntax must not invent them.
    const masked = maskCodeSpans(line);
    for (const m of masked.matchAll(WIKILINK)) {
      const target = m[1].trim();
      if (target && links.length < MAX_PER_KIND) links.push(target);
    }
    for (const m of masked.matchAll(TAG)) {
      // Obsidian requires at least one non-numeric character in a tag; a bare
      // "#1" in prose is not a tag.
      if (!/^\d+$/.test(m[2]) && tags.size < MAX_PER_KIND) tags.add(m[2]);
    }

    const task = line.match(TASK);
    if (task && tasks.length < MAX_PER_KIND) tasks.push({ line: i + 1, text: task[2].trim(), done: task[1] !== " " });

    // A list item, or an indented line under one, keeps us in the list. A
    // plain paragraph line is a setext candidate; a list item is not.
    inList = isList || (inList && /^\s+\S/.test(line));
    setextCandidate = isList || underline ? null : { text: line, line: i + 1 };
    prevBlank = false;
  }

  return { headings, links, tags: [...tags], tasks };
}
