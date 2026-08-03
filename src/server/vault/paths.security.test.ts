import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveNotePath, isSafeVaultPath, toVaultRelative, VaultPathError } from "./paths";

// Path resolution is the security boundary between an LLM-supplied string and
// the filesystem. Everything an MCP client can name goes through here, so these
// are the tests that matter most: a hole here reads or overwrites files outside
// the vault on the operator's server.

let root: string;
let vault: string;
let outside: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ob-sync-paths-sec-"));
  vault = path.join(root, "vault");
  outside = path.join(root, "outside");
  fs.mkdirSync(path.join(vault, "Projects"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(vault, "Note.md"), "# Note\n");
  fs.writeFileSync(path.join(outside, "secret.txt"), "SECRET");
  process.env.DATA_DIR = root;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

/** Assert the path is rejected, and that it's rejected as a vault error. */
function rejects(p: string, opts?: { allowMissingExt?: boolean }) {
  expect(() => resolveNotePath(p, opts)).toThrow(VaultPathError);
}

/**
 * Assert *which* guard rejected it. Several guards overlap — a traversal also
 * produces a ".." segment that the dot-directory rule would catch — so without
 * pinning the message these tests pass even with the containment check deleted.
 */
function rejectsWith(p: string, message: RegExp, opts?: { allowMissingExt?: boolean }) {
  expect(() => resolveNotePath(p, opts)).toThrow(VaultPathError);
  expect(() => resolveNotePath(p, opts)).toThrow(message);
}

describe("accepts legitimate vault paths", () => {
  it("resolves a note at the vault root", () => {
    expect(resolveNotePath("Note.md")).toBe(path.join(vault, "Note.md"));
  });

  it("resolves a nested note", () => {
    expect(resolveNotePath("Projects/Alpha.md")).toBe(path.join(vault, "Projects/Alpha.md"));
  });

  it("appends .md when no extension is given", () => {
    expect(resolveNotePath("Note")).toBe(path.join(vault, "Note.md"));
  });

  it("leaves a non-markdown extension alone", () => {
    expect(resolveNotePath("assets/diagram.png")).toBe(path.join(vault, "assets/diagram.png"));
  });

  it("accepts an extensionless path when the caller allows it", () => {
    expect(resolveNotePath("Projects", { allowMissingExt: true })).toBe(
      path.join(vault, "Projects"),
    );
  });

  it("normalises backslashes to forward slashes", () => {
    expect(resolveNotePath("Projects\\Alpha.md")).toBe(path.join(vault, "Projects/Alpha.md"));
  });

  it("accepts non-ASCII note names", () => {
    expect(resolveNotePath("Café résumé.md")).toBe(path.join(vault, "Café résumé.md"));
  });

  it("treats decomposed and composed unicode as the same note", () => {
    // macOS hands back NFD from readdir while clients typically send NFC.
    const nfc = resolveNotePath("Café.md");
    const nfd = resolveNotePath("Cafe\u0301.md");
    expect(nfd).toBe(nfc);
  });

  it("tolerates surrounding whitespace", () => {
    expect(resolveNotePath("  Note.md  ")).toBe(path.join(vault, "Note.md"));
  });
});

describe("rejects traversal out of the vault", () => {
  it("refuses a parent-directory hop", () => rejectsWith("../secret.txt", /escapes the vault/));
  it("refuses a deep traversal", () => rejectsWith("../../etc/passwd", /escapes the vault/));
  it("refuses traversal hidden mid-path", () => rejectsWith("Projects/../../outside/secret.txt", /escapes the vault/));
  it("refuses traversal that lands back outside via many hops", () =>
    rejectsWith("a/b/c/../../../../outside/secret.txt", /escapes the vault/));

  it("refuses a POSIX absolute path", () => rejectsWith("/etc/passwd", /must be relative/));
  it("refuses a Windows drive-letter path", () => rejectsWith("C:\\Windows\\System32\\config", /must be relative/));

  it("does not allow a traversal to read a real file outside the vault", () => {
    // Belt and braces: prove the file genuinely exists and is still unreachable.
    expect(fs.readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("SECRET");
    rejectsWith("../outside/secret.txt", /escapes the vault/);
  });
});

describe("rejects dot-directories and Obsidian internals", () => {
  it("refuses the .obsidian directory itself", () =>
    rejects(".obsidian", { allowMissingExt: true }));
  it("refuses a file inside .obsidian", () => rejectsWith(".obsidian/app.json", /Dot-directories/));
  it("refuses a nested .obsidian path", () => rejects(".obsidian/plugins/x/main.js"));
  it("refuses any other dot-directory", () => rejects(".git/config"));
  it("refuses a dot-directory deeper in the path", () => rejects("Projects/.secrets/keys.md"));
  it("refuses a dotfile at the root", () => rejects(".env"));
});

describe("rejects control and bidirectional characters", () => {
  it("refuses an embedded NUL", () => rejectsWith("Note\u0000.md", /control or bidirectional/));
  it("refuses a C0 control character", () => rejects("No\u0001te.md"));
  it("refuses a DEL character", () => rejects("Note\u007F.md"));
  it("refuses a C1 control character", () => rejects("Note\u0085.md"));

  // Bidi overrides let a filename render as something other than what it is —
  // "exp\u202Egnp.md" displays as "expdmg.png". Spoofing, not traversal.
  it("refuses a right-to-left override", () => rejectsWith("Note\u202E.md", /control or bidirectional/));
  it("refuses a left-to-right embedding", () => rejects("Note\u202A.md"));
  it("refuses an isolate formatter", () => rejects("Note\u2066.md"));
  it("refuses a right-to-left mark", () => rejects("Note\u200F.md"));
});

describe("rejects empty input", () => {
  it("refuses an empty string", () => rejects(""));
  it("refuses whitespace only", () => rejects("   "));
});

describe("rejects symlink escapes", () => {
  it("refuses a symlinked file pointing outside the vault", () => {
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(vault, "leak.md"));
    // The link genuinely resolves to the secret — it is the guard that stops it.
    expect(fs.readFileSync(path.join(vault, "leak.md"), "utf8")).toBe("SECRET");
    rejectsWith("leak.md", /Symlinks are not accessible/);
  });

  it("refuses a path whose parent directory is a symlink", () => {
    fs.symlinkSync(outside, path.join(vault, "linked"));
    rejects("linked/secret.txt");
  });

  it("refuses a symlink to a directory even for an as-yet-missing file", () => {
    fs.symlinkSync(outside, path.join(vault, "linked"));
    rejects("linked/brand-new.md");
  });

  it("still allows a real directory of the same shape", () => {
    fs.mkdirSync(path.join(vault, "real"));
    expect(resolveNotePath("real/new.md")).toBe(path.join(vault, "real/new.md"));
  });
});

describe("isSafeVaultPath", () => {
  it("accepts a plain file inside the vault", () => {
    expect(isSafeVaultPath(path.join(vault, "Note.md"))).toBe(true);
  });

  it("accepts a file that does not exist yet", () => {
    expect(isSafeVaultPath(path.join(vault, "Projects/New.md"))).toBe(true);
  });

  it("rejects the vault directory itself", () => {
    expect(isSafeVaultPath(vault)).toBe(false);
  });

  it("rejects a path outside the vault", () => {
    expect(isSafeVaultPath(path.join(outside, "secret.txt"))).toBe(false);
  });

  it("rejects anything under a dot-directory", () => {
    expect(isSafeVaultPath(path.join(vault, ".obsidian/app.json"))).toBe(false);
  });

  it("rejects a symlinked file", () => {
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(vault, "leak.md"));
    expect(isSafeVaultPath(path.join(vault, "leak.md"))).toBe(false);
  });

  it("rejects a file under a symlinked directory", () => {
    fs.symlinkSync(outside, path.join(vault, "linked"));
    expect(isSafeVaultPath(path.join(vault, "linked/secret.txt"))).toBe(false);
  });
});

describe("toVaultRelative", () => {
  it("round-trips a resolved path back to its vault-relative form", () => {
    expect(toVaultRelative(resolveNotePath("Projects/Alpha.md"))).toBe("Projects/Alpha.md");
  });
});
