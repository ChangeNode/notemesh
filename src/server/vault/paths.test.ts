import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isBinaryFile, isLfsPointer, formatBytes } from "./paths";

// The LFS guard exists because of a specific, silent failure: cloning an
// LFS-backed vault without git-lfs leaves pointer files where the attachments
// should be, and a pointer is small plain ASCII with no NUL — so the binary
// sniff calls it text and every read path would serve it as real content.

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "notemesh-paths-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function file(name: string, content: string | Buffer): string {
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, content);
  return abs;
}

const POINTER =
  "version https://git-lfs.github.com/spec/v1\n" +
  "oid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\n" +
  "size 284719\n";

describe("isLfsPointer", () => {
  it("recognises a pointer standing in for an attachment", () => {
    expect(isLfsPointer(file("photo.png", POINTER))).toBe(true);
  });

  it("recognises a pointer standing in for a note", () => {
    expect(isLfsPointer(file("big.md", POINTER))).toBe(true);
  });

  it("does not fire on ordinary markdown", () => {
    expect(isLfsPointer(file("note.md", "# Note\n\nSome prose about versioning.\n"))).toBe(false);
  });

  it("does not fire on a note that merely mentions git-lfs", () => {
    expect(
      isLfsPointer(file("about.md", "# LFS\n\nSee version https://git-lfs.github.com/spec/v1\n")),
    ).toBe(false);
  });

  it("does not fire on real binary content", () => {
    expect(isLfsPointer(file("real.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])))).toBe(
      false,
    );
  });

  it("returns false rather than throwing on a missing file", () => {
    expect(isLfsPointer(path.join(dir, "nope.png"))).toBe(false);
  });
});

describe("why the guard is needed", () => {
  it("the binary sniff cannot tell a pointer from a note", () => {
    // This is the whole reason isLfsPointer exists. If this assertion ever
    // flips, the guard is redundant — but until then, without it a 131-byte
    // pointer would be base64-encoded and handed to a model as an image.
    expect(isBinaryFile(file("photo.png", POINTER))).toBe(false);
  });

  it("real binaries are still detected by the sniff", () => {
    expect(isBinaryFile(file("real.png", Buffer.from([0x89, 0x50, 0x00, 0x1a])))).toBe(true);
  });
});

describe("formatBytes", () => {
  it("uses decimal units, matching the labels shown to users", () => {
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1_000)).toBe("1.0 KB");
    expect(formatBytes(1_500_000)).toBe("1.5 MB");
  });
});
