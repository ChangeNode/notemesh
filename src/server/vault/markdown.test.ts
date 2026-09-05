import { describe, expect, it } from "vitest";
import { extractStructure, splitFrontmatter, joinFrontmatter } from "./markdown";

// The comment scanner and the code-span mask, together. Most of extraction is
// exercised through the indexer in tests/vault/hostile-content.test.ts; this
// is the one interaction that needs the function on its own.
describe("HTML comments and code spans", () => {
  const headings = (s: string) => extractStructure(s).headings.map((h) => h.text);

  it("does not open a comment from inside a code span", () => {
    // A note about HTML syntax. Treating the backticked opener as real once
    // swallowed every line after it until a closer that never came.
    const r = extractStructure("The `<!--` sequence begins an HTML comment.\n\n# Section\n\n- [ ] task #tag\n");
    expect(r.headings.map((h) => h.text)).toEqual(["Section"]);
    expect(r.tasks).toHaveLength(1);
    expect(r.tags).toContain("tag");
  });

  it("ignores a whole comment inside a code span", () => {
    const r = extractStructure("`<!-- x -->` keeps #tag and [[Link]]\n");
    expect(r.tags).toContain("tag");
    expect(r.links).toEqual(["Link"]);
  });

  it("still honours a real comment across lines", () => {
    expect(headings("<!-- start\n# Hidden\n- [ ] hidden\nend --> # not a heading\n# Shown\n")).toEqual(["Shown"]);
  });

  it("closes a comment at the first -->, backticks or not", () => {
    // Inside an HTML comment there are no code spans; CommonMark ends the
    // block at the first closer. So the backticked closer really closes.
    expect(headings("<!-- open\n`-->` closes it\n# Shown\n")).toEqual(["Shown"]);
  });
});

// The parser, on its own. Every parse in the server goes through it, and the
// review that found the previous one running eval (NM-SEC-001) is why each
// case below exists.
describe("frontmatter parsing", () => {
  const POC = "---js\n(globalThis.__notemesh_poc = 1, {})\n---\n# Body\n";

  it("treats a ---js block as note text and never evaluates it", () => {
    const r = splitFrontmatter(POC);
    expect((globalThis as Record<string, unknown>).__notemesh_poc).toBeUndefined();
    expect(r.data).toEqual({});
    expect(r.body).toBe(POC);
    expect(r.fmOffset).toBe(0);
    expect(r.invalid).toBe(false);
    // The whole thing indexes as text: the heading after it is still found.
    // (The bare --- under the second line is a setext underline to CommonMark,
    // so there is a heading before Body as well; that is the point: it is text.)
    expect(extractStructure(r.body).headings.map((h) => h.text)).toContain("Body");
  });

  it("is frontmatter only when the first line is exactly ---", () => {
    for (const opener of ["---yaml", "--- ", "----", " ---", "---json"]) {
      const r = splitFrontmatter(`${opener}\ntitle: x\n---\nBody\n`);
      expect(r.data, opener).toEqual({});
      expect(r.fmOffset, opener).toBe(0);
    }
  });

  it("parses plain YAML, counts its lines, and keeps dates as the strings Obsidian means", () => {
    const r = splitFrontmatter("---\ntitle: Alpha\ncreated: 2026-08-06\ntags:\n  - x\n---\n\nBody\n");
    expect(r.data).toEqual({ title: "Alpha", created: "2026-08-06", tags: ["x"] });
    expect(r.body).toBe("\nBody\n");
    expect(r.fmOffset).toBe(6);
    expect(splitFrontmatter("---\r\ntitle: A\r\n---\r\nBody\r\n").data).toEqual({ title: "A" });
    expect(splitFrontmatter("---\n---\nBody\n")).toMatchObject({ data: {}, body: "Body\n", fmOffset: 2 });
    expect(splitFrontmatter("---\ntitle: A\nno closing\n").fmOffset).toBe(0);
  });

  it("refuses frontmatter that refers to itself, and says so", () => {
    const r = splitFrontmatter("---\na: &a [*a]\n---\nBody\n");
    expect(r.invalid).toBe(true);
    expect(r.data).toEqual({});
    expect(() => JSON.stringify(r.data)).not.toThrow();
    // A shared anchor is not a cycle: the same value on two paths is fine.
    const shared = splitFrontmatter("---\nx: &v [1, 2]\ny: *v\n---\n");
    expect(shared.data).toEqual({ x: [1, 2], y: [1, 2] });
  });

  it("refuses an alias bomb quickly", () => {
    const bomb =
      "---\na: &a [x,x,x,x,x,x,x,x,x,x]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\n" +
      "c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]\nd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c,*c]\ne: [*d,*d,*d,*d,*d,*d,*d,*d,*d,*d]\n---\n";
    const t0 = Date.now();
    expect(splitFrontmatter(bomb).invalid).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("bounds depth and size, and drops prototype keys", () => {
    const deep = "---\n" + "a:\n".replace("a", "a") + Array.from({ length: 40 }, (_, i) => `${"  ".repeat(i)}k${i}:\n`).join("") + `${"  ".repeat(40)}v: 1\n---\n`;
    expect(splitFrontmatter(deep).invalid).toBe(true);
    const wide = "---\nitems: [" + Array.from({ length: 12_000 }, (_, i) => i).join(", ") + "]\n---\n";
    expect(splitFrontmatter(wide).invalid).toBe(true);
    const proto = splitFrontmatter("---\n__proto__: {x: 1}\nconstructor: 2\ntitle: ok\n---\n").data;
    expect(Object.keys(proto)).toEqual(["title"]);
    expect(Object.getPrototypeOf(proto)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it("turns !!omap and other tags into plain values rather than special ones", () => {
    const r = splitFrontmatter("---\nx: !!omap [a: 1]\nn: !!float 1.5\n---\n");
    expect(r.invalid).toBe(false);
    expect(r.data.n).toBe(1.5);
    expect(() => JSON.stringify(r.data)).not.toThrow();
  });

  it("round-trips through joinFrontmatter without folding long strings", () => {
    const data = { title: "Alpha", summary: "word ".repeat(40).trim(), tags: ["x", "y"], n: 3 };
    const note = joinFrontmatter("\nBody\n", data);
    expect(note.startsWith("---\ntitle: Alpha\n")).toBe(true);
    expect(note).toContain(`summary: ${data.summary}\n`);
    expect(note).toContain("tags:\n  - x\n  - y\n");
    const back = splitFrontmatter(note);
    expect(back.data).toEqual(data);
    expect(back.body).toBe("\nBody\n");
  });
});
