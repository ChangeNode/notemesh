import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The ancestor-symlink race: O_NOFOLLOW guards the final component only, so
// a directory swapped for a symlink after the resolve-time check is followed
// by the kernel. On Linux the server asks where the descriptor landed and
// refuses. These call the open helpers directly on a path through such a
// link, which is what a call would see after the swap.

let root: string;
let vault: string;
let outside: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "notemesh-fd-")));
  vault = path.join(root, "vault");
  outside = path.join(root, "outside");
  fs.mkdirSync(vault, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "secret.md"), "SECRET\n");
  fs.symlinkSync(outside, path.join(vault, "link"));
  process.env.DATA_DIR = root;
  process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 11).toString("base64");
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const linux = process.platform === "linux";

describe("a descriptor that landed outside the vault", () => {
  it.skipIf(!linux)("is refused for reading", async () => {
    const { openNoFollow } = await import("./paths");
    expect(() => openNoFollow(path.join(vault, "link", "secret.md"))).toThrow(/Symlinks are not accessible/);
  });

  it.skipIf(!linux)("is refused for writing, and nothing lands outside", async () => {
    const { writeVaultFile } = await import("./disk");
    expect(() => writeVaultFile(path.join(vault, "link", "new.md"), "payload")).toThrow(/Symlinks are not accessible/);
    expect(fs.readdirSync(outside)).toEqual(["secret.md"]);
    expect(fs.readFileSync(path.join(outside, "secret.md"), "utf8")).toBe("SECRET\n");
  });

  it("a descriptor inside the vault passes, on every platform", async () => {
    fs.writeFileSync(path.join(vault, "ok.md"), "fine\n");
    const { openNoFollow, assertDescriptorInVault } = await import("./paths");
    const fd = openNoFollow(path.join(vault, "ok.md"));
    expect(() => assertDescriptorInVault(fd)).not.toThrow();
    fs.closeSync(fd);
  });
});
