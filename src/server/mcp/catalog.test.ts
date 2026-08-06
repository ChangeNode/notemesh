import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The Tools tab is documentation that has to stay true, and the only way it
// stays true is by being the tool surface rather than a description of it.
// These check that: same names as the server registers, write flags that follow
// the registration conditionals, and conditional tools that appear and vanish
// with their setting.

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "notemesh-catalog-"));
  process.env.DATA_DIR = root;
  // db.ts caches its handle at module scope; these cases differ by settings.
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

async function catalog() {
  const { listMcpTools } = await import("./catalog");
  return listMcpTools();
}

async function registered(read: boolean, write: boolean): Promise<string[]> {
  const { createMcpServer } = await import("./server");
  const server = createMcpServer({ read, write, label: "test" }) as unknown as {
    _registeredTools: Record<string, unknown>;
  };
  return Object.keys(server._registeredTools).sort();
}

describe("the tool catalogue", () => {
  it("lists exactly what a write-scoped client is registered", async () => {
    const names = (await catalog()).map((t) => t.name).sort();
    expect(names).toEqual(await registered(true, true));
    expect(names.length).toBeGreaterThan(20);
  });

  it("marks as write exactly the tools a read-only client does not get", async () => {
    const tools = await catalog();
    const readOnly = new Set(await registered(true, false));
    for (const t of tools) {
      expect(t.write, `${t.name} write flag`).toBe(!readOnly.has(t.name));
    }
    // Both groups are non-empty, so a flag stuck at one value would show here
    // rather than passing the check above vacuously.
    expect(tools.some((t) => t.write)).toBe(true);
    expect(tools.some((t) => !t.write)).toBe(true);
  });

  it("carries the description and parameters the protocol sends", async () => {
    const read = (await catalog()).find((t) => t.name === "read_note")!;
    expect(read.description).toBeTruthy();
    const p = read.params.find((x) => x.name === "path")!;
    expect(p).toBeDefined();
    expect(p.type).toBe("string");
    expect(p.required).toBe(true);
    // Optional parameters are marked as such, not merely present.
    expect(read.params.find((x) => x.name === "offset")!.required).toBe(false);
  });

  it("every tool has a description, so no row renders blank", async () => {
    for (const t of await catalog()) {
      expect(t.description, `${t.name} has a description`).toBeTruthy();
    }
  });

  it("follows a conditional tool rather than hardcoding it", async () => {
    // delete_note is registered behind a setting. A catalogue built from a
    // written-down list would show it either always or never.
    expect((await catalog()).map((t) => t.name)).toContain("delete_note");

    const { setSetting } = await import("../db");
    setSetting("delete_enabled", "false");
    vi.resetModules();
    expect((await catalog()).map((t) => t.name)).not.toContain("delete_note");
  });
});
