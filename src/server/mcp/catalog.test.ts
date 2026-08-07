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

// The version the server reports on connect, the version in package.json, and
// the version at the top of the changelog are three copies of one fact. They
// drift silently — nothing fails when they disagree, and a client showing a
// stale version is the kind of thing nobody notices for months.
describe("the reported version", () => {
  it("matches package.json and the changelog", async () => {
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(readFileSync("package.json", "utf8")).version as string;
    expect(pkg).toMatch(/^\d+\.\d+\.\d+$/);

    const serverSrc = readFileSync("src/server/mcp/server.ts", "utf8");
    const reported = serverSrc.match(/name: "notemesh",[\s\S]{0,300}?version: "([^"]+)"/)?.[1];
    expect(reported, "the MCP server reports a version").toBeDefined();
    expect(reported).toBe(pkg);

    // The newest released heading in the changelog, ignoring Unreleased.
    const changelog = readFileSync("CHANGELOG.md", "utf8");
    const latest = changelog.match(/^## (\d+\.\d+\.\d+)/m)?.[1];
    expect(latest, "the changelog names a released version").toBeDefined();
    expect(latest).toBe(pkg);
  });

  it("opens every release with what taking it costs the deployer", async () => {
    // The convention only works if it is never skipped: a deployer who learns
    // the first line always answers "what do I have to do" stops reading the
    // rest, and one release without it silently breaks that habit. Cheap to
    // forget when writing an entry, so it is checked rather than remembered.
    const { readFileSync } = await import("node:fs");
    const changelog = readFileSync("CHANGELOG.md", "utf8");
    const sections = changelog.split(/^## /m).slice(1);
    const releases = sections.filter((s) => /^\d+\.\d+\.\d+/.test(s));
    expect(releases.length, "there is at least one released version").toBeGreaterThan(0);
    for (const body of releases) {
      const heading = body.split("\n")[0];
      expect(body, `release "${heading}" must open with **Taking this update:**`).toContain(
        "**Taking this update:**",
      );
    }
  });

  it("counts the tools the changelog claims", async () => {
    // The release notes say how many tools there are; if that number is wrong
    // it is wrong in the one document people read before deploying.
    const { readFileSync } = await import("node:fs");
    const claimed = Number(readFileSync("CHANGELOG.md", "utf8").match(/(\d+) tools covering/)?.[1]);
    expect(claimed).toBeGreaterThan(0);
    expect((await catalog()).length).toBe(claimed);
  });
});
