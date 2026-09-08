import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A move used to leave every link to the note behind. The index knows who
// linked, and for each the raw target that resolved; the rewrite is a scan
// of those notes for those targets, keeping each link's form and suffixes.

let root: string;
let vault: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "notemesh-links-")));
  vault = path.join(root, "vault");
  fs.mkdirSync(vault, { recursive: true });
  process.env.DATA_DIR = root;
  process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 4).toString("base64");
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

function put(rel: string, content: string) {
  const abs = path.join(vault, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
const get = (rel: string) => fs.readFileSync(path.join(vault, rel), "utf8");

async function indexed(...rels: string[]) {
  const { reindexPath } = await import("./indexer");
  for (const rel of rels) reindexPath(rel);
}

/** What the tool does: rename, rewrite while the index still knows, reindex. */
async function move(from: string, to: string) {
  const { moveNote } = await import("./notes");
  const { rewriteLinksForMove } = await import("./links");
  const { reindexPath } = await import("./indexer");
  moveNote(from, to);
  const res = rewriteLinksForMove(from, to);
  reindexPath(from);
  reindexPath(to);
  for (const rel of res.notes) reindexPath(rel);
  return res;
}

describe("rewriteLinksForMove", () => {
  it("rewrites every form of link to a renamed note, keeping suffixes and form", async () => {
    put("Notes/Old.md", "# Old\n");
    put(
      "A.md",
      "see [[Old]] and [[Old|the alias]] and [[Old#Heading]] and [[Old^block]] and ![[Old]]\n" +
        "by path [[Notes/Old]] and [[Notes/Old.md]] and lower [[old]]\n" +
        "not [[Older]] nor [[Old Times]]\n",
    );
    await indexed("Notes/Old.md", "A.md");
    const res = await move("Notes/Old.md", "Notes/New.md");
    expect(res).toEqual({ notes: ["A.md"], links: 8 });
    expect(get("A.md")).toBe(
      "see [[New]] and [[New|the alias]] and [[New#Heading]] and [[New^block]] and ![[New]]\n" +
        "by path [[Notes/New]] and [[Notes/New.md]] and lower [[New]]\n" +
        "not [[Older]] nor [[Old Times]]\n",
    );
  });

  it("leaves links inside code alone, and touches nothing when no link pointed at the note", async () => {
    put("Old.md", "x\n");
    put("A.md", "`[[Old]]` in a span\n\n```\n[[Old]] in a fence\n```\n\nreal [[Old]]\n");
    put("B.md", "unrelated [[Other]]\n");
    await indexed("Old.md", "A.md", "B.md");
    const res = await move("Old.md", "New.md");
    expect(res).toEqual({ notes: ["A.md"], links: 1 });
    expect(get("A.md")).toBe("`[[Old]]` in a span\n\n```\n[[Old]] in a fence\n```\n\nreal [[New]]\n");
    expect(get("B.md")).toBe("unrelated [[Other]]\n");
  });

  it("a move that keeps the name leaves bare links as they are and fixes path links", async () => {
    put("A/Note.md", "x\n");
    put("Src.md", "[[Note]] and [[A/Note]]\n");
    await indexed("A/Note.md", "Src.md");
    const res = await move("A/Note.md", "B/Note.md");
    expect(res).toEqual({ notes: ["Src.md"], links: 1 });
    expect(get("Src.md")).toBe("[[Note]] and [[B/Note]]\n");
  });

  it("writes a path when the new name would be ambiguous", async () => {
    put("Old.md", "x\n");
    put("Archive/Plan.md", "the other plan\n");
    put("Src.md", "[[Old]]\n");
    await indexed("Old.md", "Archive/Plan.md", "Src.md");
    await move("Old.md", "Projects/Plan.md");
    expect(get("Src.md")).toBe("[[Projects/Plan]]\n");
  });

  it("fixes the moved note's own link to itself, at its new path", async () => {
    put("Old.md", "I am [[Old]]\n");
    await indexed("Old.md");
    const res = await move("Old.md", "New.md");
    expect(res).toEqual({ notes: ["New.md"], links: 1 });
    expect(get("New.md")).toBe("I am [[New]]\n");
  });

  it("keeps CRLF endings, and afterwards the index resolves the links to the new path", async () => {
    put("Old.md", "x\n");
    put("Src.md", "a [[Old]]\r\nb\r\n");
    await indexed("Old.md", "Src.md");
    await move("Old.md", "New.md");
    expect(get("Src.md")).toBe("a [[New]]\r\nb\r\n");
    const { backlinks, unresolvedLinks } = await import("./queries");
    expect(backlinks("New.md")).toEqual([{ path: "Src.md", target: "New" }]);
    expect(unresolvedLinks()).toEqual([]);
  });
});

describe("newTarget", () => {
  it("decides from the old text and the names around it", async () => {
    const { newTarget } = await import("./links");
    const unique = () => 1;
    const shared = () => 2;
    expect(newTarget("Old", "Old.md", "New.md", unique)).toBe("New");
    expect(newTarget("Old.md", "Old.md", "New.md", unique)).toBe("New.md");
    expect(newTarget("Old", "Old.md", "Dir/New.md", shared)).toBe("Dir/New");
    expect(newTarget("Dir/Old", "Dir/Old.md", "Dir/New.md", unique)).toBe("Dir/New");
    expect(newTarget("Same", "A/Same.md", "B/Same.md", unique)).toBeNull();
    expect(newTarget("Same", "A/Same.md", "B/Same.md", shared)).toBe("B/Same");
    expect(newTarget("Dir\\Old", "Dir/Old.md", "Dir/New.md", unique)).toBe("Dir/New");
  });
});
