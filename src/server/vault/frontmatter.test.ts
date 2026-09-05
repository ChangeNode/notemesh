import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readProperties, removeProperty, setProperty } from "./frontmatter";
import { VaultPathError } from "./paths";

let root: string;
let vault: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "notemesh-fm-"));
  vault = path.join(root, "vault");
  fs.mkdirSync(vault, { recursive: true });
  process.env.DATA_DIR = root;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

function put(rel: string, content: string) {
  fs.writeFileSync(path.join(vault, rel), content);
}

function read(rel: string): string {
  return fs.readFileSync(path.join(vault, rel), "utf8");
}

const WITH_PROPS = `---
title: Alpha
status: draft
---

Body text.
`;

describe("removeProperty", () => {
  it("removes a property that is set and says so", () => {
    put("a.md", WITH_PROPS);
    const res = removeProperty("a.md", "status");
    expect(res.changed).toBe(true);
    expect(res.properties).toEqual({ title: "Alpha" });
    expect(readProperties("a.md")).toEqual({ title: "Alpha" });
  });

  it("reports changed:false for a property that was never set", () => {
    // Idempotent, but the caller still has to be able to tell a real removal
    // from a typo in the property name.
    put("a.md", WITH_PROPS);
    const res = removeProperty("a.md", "auhtor");
    expect(res.changed).toBe(false);
    expect(res.properties).toEqual({ title: "Alpha", status: "draft" });
  });

  it("leaves the file byte-identical on a miss", () => {
    // Rewriting an unchanged note is not free: it moves the mtime, forces a
    // reindex, and on the git backend produces a commit and a push for a file
    // whose content did not change.
    put("a.md", WITH_PROPS);
    const before = read("a.md");
    const mtimeBefore = fs.statSync(path.join(vault, "a.md")).mtimeMs;
    removeProperty("a.md", "nope");
    expect(read("a.md")).toBe(before);
    expect(fs.statSync(path.join(vault, "a.md")).mtimeMs).toBe(mtimeBefore);
  });

  it("does not treat an inherited Object key as a property", () => {
    // hasOwnProperty, not `in`: otherwise removing "toString" would report a
    // successful removal and rewrite the note.
    put("a.md", WITH_PROPS);
    const res = removeProperty("a.md", "toString");
    expect(res.changed).toBe(false);
  });

  it("removes the frontmatter block entirely when the last property goes", () => {
    put("only.md", "---\nstatus: draft\n---\n\nBody.\n");
    const res = removeProperty("only.md", "status");
    expect(res.changed).toBe(true);
    expect(res.properties).toEqual({});
    expect(read("only.md")).toBe("Body.\n");
  });

  it("reports changed:false on a note with no frontmatter at all", () => {
    put("plain.md", "Just a body.\n");
    const before = read("plain.md");
    expect(removeProperty("plain.md", "status").changed).toBe(false);
    expect(read("plain.md")).toBe(before);
  });

  it("still refuses a note that does not exist", () => {
    expect(() => removeProperty("missing.md", "status")).toThrow(VaultPathError);
  });

  it("round-trips with setProperty", () => {
    put("a.md", WITH_PROPS);
    setProperty("a.md", "tags", ["x"]);
    expect(removeProperty("a.md", "tags")).toMatchObject({ changed: true });
    expect(removeProperty("a.md", "tags")).toMatchObject({ changed: false });
  });
});

// set_property used to return a bare properties object while remove_property
// returned a wrapper, so two sibling operations answered the same question in
// two different shapes. Both now report whether the file was rewritten.
describe("setProperty", () => {
  it("sets a new property and reports the change", () => {
    put("a.md", WITH_PROPS);
    const res = setProperty("a.md", "author", "Will");
    expect(res.changed).toBe(true);
    expect(res.properties).toMatchObject({ title: "Alpha", status: "draft", author: "Will" });
  });

  it("reports changed:true when overwriting a different value", () => {
    put("a.md", WITH_PROPS);
    expect(setProperty("a.md", "status", "published").changed).toBe(true);
    expect(readProperties("a.md")).toMatchObject({ status: "published" });
  });

  it("reports changed:false when the value is already set", () => {
    put("a.md", WITH_PROPS);
    const res = setProperty("a.md", "status", "draft");
    expect(res.changed).toBe(false);
    expect(res.properties).toEqual({ title: "Alpha", status: "draft" });
  });

  it("leaves the file byte-identical when nothing changes", () => {
    put("a.md", WITH_PROPS);
    const before = read("a.md");
    const mtimeBefore = fs.statSync(path.join(vault, "a.md")).mtimeMs;
    setProperty("a.md", "status", "draft");
    expect(read("a.md")).toBe(before);
    expect(fs.statSync(path.join(vault, "a.md")).mtimeMs).toBe(mtimeBefore);
  });

  it("compares list values by content, not identity", () => {
    put("a.md", "---\ntags:\n  - x\n  - y\n---\n\nBody.\n");
    expect(setProperty("a.md", "tags", ["x", "y"]).changed).toBe(false);
    expect(setProperty("a.md", "tags", ["x", "z"]).changed).toBe(true);
  });

  it("matches removeProperty's response shape", () => {
    // The whole point of the alignment: a caller can handle both the same way.
    put("a.md", WITH_PROPS);
    const set = setProperty("a.md", "author", "Will");
    const removed = removeProperty("a.md", "author");
    expect(Object.keys(set).sort()).toEqual(Object.keys(removed).sort());
    expect(Object.keys(set).sort()).toEqual(["changed", "properties"]);
  });

  it("still refuses a prototype-polluting name", () => {
    put("a.md", WITH_PROPS);
    expect(() => setProperty("a.md", "__proto__", "x")).toThrow(VaultPathError);
  });
});

describe("frontmatter the tools must not touch", () => {
  it("refuses to read or edit properties on a note whose frontmatter will not parse", () => {
    const before = "---\ntitle: \"unclosed\n---\n\nBody.\n";
    put("bad.md", before);
    expect(() => readProperties("bad.md")).toThrow(/not valid YAML/);
    expect(() => setProperty("bad.md", "status", "draft")).toThrow(/not valid YAML/);
    expect(() => removeProperty("bad.md", "title")).toThrow(/not valid YAML/);
    expect(read("bad.md")).toBe(before);
  });

  it("never evaluates a ---js block, through read or write", () => {
    put("poc.md", "---js\n(globalThis.__notemesh_poc_props = 1, {})\n---\nBody.\n");
    expect(readProperties("poc.md")).toEqual({});
    setProperty("poc.md", "status", "draft");
    expect((globalThis as Record<string, unknown>).__notemesh_poc_props).toBeUndefined();
    // The block is text; the new frontmatter sits above it, and reads back alone.
    expect(readProperties("poc.md")).toEqual({ status: "draft" });
    expect(read("poc.md")).toContain("\n---js\n");
  });

  it("restores the exact bytes when a set is removed again", () => {
    put("a.md", WITH_PROPS);
    setProperty("a.md", "summary", "word ".repeat(40).trim());
    removeProperty("a.md", "summary");
    expect(read("a.md")).toBe(WITH_PROPS);
  });

  it("keeps a date property as the string it was written as", () => {
    put("d.md", "---\ncreated: 2026-08-06\n---\n");
    expect(readProperties("d.md")).toEqual({ created: "2026-08-06" });
  });
});
