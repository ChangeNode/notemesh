import { describe, expect, it } from "vitest";
import { extractStructure } from "./markdown";

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
