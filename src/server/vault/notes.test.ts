import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendToNote,
  createNote,
  deleteNote,
  listFolders,
  listNotes,
  moveNote,
  noteExists,
  prependToNote,
  readAttachment,
  readNote,
  readNoteRange,
  updateNote,
  MAX_ATTACHMENT_BYTES,
  MAX_READ_BYTES,
} from "./notes";
import { VaultPathError } from "./paths";

// Data-handling behaviour an assistant depends on: that a read window is
// honest about what it left out, that appending doesn't silently mangle the
// note, and that the caps refuse rather than truncate-and-pretend.

let root: string;
let vault: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ob-sync-notes-"));
  vault = path.join(root, "vault");
  fs.mkdirSync(path.join(vault, "Projects"), { recursive: true });
  process.env.DATA_DIR = root;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

function put(rel: string, content: string | Buffer) {
  const abs = path.join(vault, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function get(rel: string): string {
  return fs.readFileSync(path.join(vault, rel), "utf8");
}

describe("readNote", () => {
  it("returns the content and the vault-relative path", () => {
    put("Note.md", "# Hello\n");
    expect(readNote("Note.md")).toEqual({ path: "Note.md", content: "# Hello\n" });
  });

  it("refuses a binary file, pointing at the right tool", () => {
    put("image.png", Buffer.from([0x89, 0x50, 0x00, 0x01]));
    expect(() => readNote("image.png")).toThrow(/read_attachment/);
  });
});

describe("readNoteRange", () => {
  const hundred = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");

  it("windows to the requested lines and reports the total", () => {
    put("Long.md", hundred);
    const out = readNoteRange("Long.md", { offset: 0, limit: 10 });
    expect(out.count).toBe(10);
    expect(out.totalLines).toBe(100);
    expect(out.content.split("\n")[0]).toBe("line 1");
    expect(out.hasMore).toBe(true);
  });

  it("honours the offset", () => {
    put("Long.md", hundred);
    const out = readNoteRange("Long.md", { offset: 90, limit: 10 });
    expect(out.content.split("\n")[0]).toBe("line 91");
    expect(out.hasMore).toBe(false);
  });

  it("says hasMore=false when the whole note fits", () => {
    put("Short.md", "one\ntwo\n");
    expect(readNoteRange("Short.md").hasMore).toBe(false);
  });

  it("clamps a negative offset rather than wrapping", () => {
    put("Long.md", hundred);
    expect(readNoteRange("Long.md", { offset: -5, limit: 3 }).offset).toBe(0);
  });

  it("returns an empty window past the end without throwing", () => {
    put("Short.md", "one\ntwo\n");
    const out = readNoteRange("Short.md", { offset: 500 });
    expect(out.count).toBe(0);
    expect(out.hasMore).toBe(false);
  });

  it("enforces the byte ceiling when a few lines are enormous", () => {
    // Ten lines, each well over the cap on its own terms.
    put("Fat.md", Array.from({ length: 10 }, () => "x".repeat(40_000)).join("\n"));
    const out = readNoteRange("Fat.md", { limit: 10 });
    expect(out.truncatedForSize).toBe(true);
    expect(Buffer.byteLength(out.content, "utf8")).toBeLessThanOrEqual(MAX_READ_BYTES);
    // Truncating must be visible, not silent.
    expect(out.hasMore).toBe(true);
  });

  it("does not flag truncation for an ordinary note", () => {
    put("Long.md", hundred);
    expect(readNoteRange("Long.md").truncatedForSize).toBeUndefined();
  });
});

describe("createNote", () => {
  it("creates the note and any missing folders", () => {
    createNote("A/B/C.md", "# C\n");
    expect(get("A/B/C.md")).toBe("# C\n");
  });

  it("refuses to overwrite an existing note", () => {
    put("Note.md", "original");
    expect(() => createNote("Note.md", "replacement")).toThrow(VaultPathError);
    expect(get("Note.md")).toBe("original");
  });

  it("refuses a reserved path segment", () => {
    expect(() => createNote(".obsidian/x.md", "x")).toThrow(VaultPathError);
  });
});

describe("updateNote", () => {
  it("replaces content in place", () => {
    put("Note.md", "old");
    updateNote("Note.md", "new");
    expect(get("Note.md")).toBe("new");
  });

  it("refuses to create a note that isn't there", () => {
    expect(() => updateNote("Missing.md", "x")).toThrow(/not found/i);
  });
});

describe("appendToNote", () => {
  it("separates the addition with a blank line so it is its own block", () => {
    // A single newline would render as a soft break inside the previous
    // paragraph — silently mangling the note.
    put("Note.md", "First paragraph.\n");
    appendToNote("Note.md", "Second paragraph.");
    expect(get("Note.md")).toBe("First paragraph.\n\nSecond paragraph.\n");
  });

  it("does not add a second blank line when one is already there", () => {
    put("Note.md", "First.\n\n");
    appendToNote("Note.md", "Second.");
    expect(get("Note.md")).toBe("First.\n\nSecond.\n");
  });

  it("handles a file with no trailing newline", () => {
    put("Note.md", "First.");
    appendToNote("Note.md", "Second.");
    expect(get("Note.md")).toBe("First.\n\nSecond.\n");
  });

  it("adds no separator to an empty note", () => {
    put("Note.md", "");
    appendToNote("Note.md", "First.");
    expect(get("Note.md")).toBe("First.\n");
  });

  it("always terminates with a newline", () => {
    put("Note.md", "First.\n");
    appendToNote("Note.md", "no trailing newline");
    expect(get("Note.md").endsWith("\n")).toBe(true);
  });

  it("refuses a note that isn't there", () => {
    expect(() => appendToNote("Missing.md", "x")).toThrow(/not found/i);
  });
});

describe("prependToNote", () => {
  it("inserts at the top of a plain note", () => {
    put("Note.md", "Body.\n");
    prependToNote("Note.md", "Intro.");
    expect(get("Note.md")).toBe("Intro.\n\nBody.\n");
  });

  it("inserts after YAML frontmatter rather than above it", () => {
    // Prepending above the frontmatter would break it entirely.
    put("Note.md", "---\ntags: [a]\n---\nBody.\n");
    prependToNote("Note.md", "Intro.");
    expect(get("Note.md")).toBe("---\ntags: [a]\n---\nIntro.\n\nBody.\n");
  });

  it("leaves a --- horizontal rule in the body alone", () => {
    put("Note.md", "Body.\n\n---\n\nMore.\n");
    prependToNote("Note.md", "Intro.");
    expect(get("Note.md").startsWith("Intro.\n\nBody.")).toBe(true);
  });
});

describe("moveNote", () => {
  it("moves a note and creates the destination folder", () => {
    put("Note.md", "x");
    const res = moveNote("Note.md", "Archive/Note.md");
    expect(res).toEqual({ from: "Note.md", to: "Archive/Note.md" });
    expect(get("Archive/Note.md")).toBe("x");
    expect(noteExists("Note.md")).toBe(false);
  });

  it("refuses to clobber an existing note at the destination", () => {
    put("A.md", "a");
    put("B.md", "b");
    expect(() => moveNote("A.md", "B.md")).toThrow(/already exists/i);
    expect(get("A.md")).toBe("a");
    expect(get("B.md")).toBe("b");
  });

  it("refuses to move out of the vault", () => {
    put("A.md", "a");
    expect(() => moveNote("A.md", "../escaped.md")).toThrow(VaultPathError);
  });
});

describe("deleteNote", () => {
  it("removes the note", () => {
    put("Note.md", "x");
    deleteNote("Note.md");
    expect(noteExists("Note.md")).toBe(false);
  });

  it("refuses a note that isn't there", () => {
    expect(() => deleteNote("Missing.md")).toThrow(/not found/i);
  });
});

describe("readAttachment", () => {
  it("returns a small image as base64 with its mime type", () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    put("image.png", bytes);
    const out = readAttachment("image.png");
    expect(out.mimeType).toBe("image/png");
    expect(out.isImage).toBe(true);
    expect(Buffer.from(out.base64, "base64")).toEqual(bytes);
  });

  it("refuses a markdown note, pointing at the right tool", () => {
    put("Note.md", "# Note\n");
    expect(() => readAttachment("Note.md")).toThrow(/read_note/);
  });

  it("refuses an attachment over the size cap rather than truncating it", () => {
    put("big.bin", Buffer.alloc(MAX_ATTACHMENT_BYTES + 1));
    expect(() => readAttachment("big.bin")).toThrow(/too large/i);
  });

  it("accepts one exactly at the cap", () => {
    put("edge.bin", Buffer.alloc(MAX_ATTACHMENT_BYTES));
    expect(readAttachment("edge.bin").bytes).toBe(MAX_ATTACHMENT_BYTES);
  });

  it("refuses a symlink", () => {
    fs.writeFileSync(path.join(root, "outside.png"), Buffer.from([0x00, 0x01]));
    fs.symlinkSync(path.join(root, "outside.png"), path.join(vault, "link.png"));
    expect(() => readAttachment("link.png")).toThrow(VaultPathError);
  });

  it("refuses an LFS pointer instead of serving it as an image", () => {
    put(
      "photo.png",
      "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 284719\n",
    );
    expect(() => readAttachment("photo.png")).toThrow(/Git LFS/);
  });

  it("falls back to octet-stream for an unknown extension", () => {
    put("thing.xyz", Buffer.from([0x00, 0x01]));
    expect(readAttachment("thing.xyz").mimeType).toBe("application/octet-stream");
  });
});

describe("listNotes / listFolders", () => {
  it("lists markdown notes and ignores other files", () => {
    put("A.md", "a");
    put("Projects/B.md", "b");
    put("image.png", Buffer.from([0x00]));
    const paths = listNotes().map((n) => n.path).sort();
    expect(paths).toEqual(["A.md", "Projects/B.md"]);
  });

  it("scopes to a folder when asked", () => {
    put("A.md", "a");
    put("Projects/B.md", "b");
    expect(listNotes("Projects").map((n) => n.path)).toEqual(["Projects/B.md"]);
  });

  it("does not list anything inside a dot-directory", () => {
    put("A.md", "a");
    put(".obsidian/workspace.md", "internal");
    expect(listNotes().map((n) => n.path)).toEqual(["A.md"]);
  });

  it("lists folders without dot-directories", () => {
    put("Projects/B.md", "b");
    put(".obsidian/x.md", "x");
    expect(listFolders()).toContain("Projects");
    expect(listFolders().some((f) => f.startsWith("."))).toBe(false);
  });
});
