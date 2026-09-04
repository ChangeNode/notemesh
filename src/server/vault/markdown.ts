import matter from "gray-matter";
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

export interface NoteStructure {
  headings: Heading[];
  links: string[];
  tags: string[];
  tasks: Task[];
}

/**
 * Frontmatter off the top, plus how many lines it occupied, so a line number
 * counted in the body can be made file-absolute. Bad frontmatter is not an
 * error: the raw content is the body, and gets indexed as such.
 */
export function splitFrontmatter(content: string): {
  data: Record<string, unknown>;
  body: string;
  fmOffset: number;
} {
  let data: Record<string, unknown> = {};
  let body = content;
  try {
    const parsed = matter(content);
    data = parsed.data ?? {};
    body = parsed.content;
  } catch {
    // Unparseable frontmatter — the whole file is the body.
  }
  const fmOffset =
    content.length === body.length
      ? 0
      : content.slice(0, content.length - body.length).split("\n").length - 1;
  return { data, body, fmOffset };
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
    // after it.
    line = line.replace(/<!--[\s\S]*?-->/g, " ");
    const open = line.indexOf("<!--");
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
      if (target) links.push(target);
    }
    for (const m of masked.matchAll(TAG)) {
      // Obsidian requires at least one non-numeric character in a tag; a bare
      // "#1" in prose is not a tag.
      if (!/^\d+$/.test(m[2])) tags.add(m[2]);
    }

    const task = line.match(TASK);
    if (task) tasks.push({ line: i + 1, text: task[2].trim(), done: task[1] !== " " });

    // A list item, or an indented line under one, keeps us in the list. A
    // plain paragraph line is a setext candidate; a list item is not.
    inList = isList || (inList && /^\s+\S/.test(line));
    setextCandidate = isList || underline ? null : { text: line, line: i + 1 };
    prevBlank = false;
  }

  return { headings, links, tags: [...tags], tasks };
}
