import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The tool surface is an API. A client caches the tool list when it connects,
// so a tool that fails to register is invisible until someone reconnects — and
// an error message naming a tool that isn't there sends an agent down a dead
// end. These pin what each scope exposes.
//
// Registration consults the settings table (delete is opt-in), so each case
// runs against its own scratch data directory rather than whatever ./data
// happens to hold.

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ob-sync-mcp-"));
  process.env.DATA_DIR = root;
  // db.ts caches its handle at module scope, so without this every test in the
  // file would share the first test's database — and these cases differ
  // precisely by what is in the settings table.
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

async function toolNames(read: boolean, write: boolean): Promise<string[]> {
  const { createMcpServer } = await import("./server");
  const server = createMcpServer({ read, write, label: "test" }) as unknown as {
    _registeredTools: Record<string, unknown>;
  };
  return Object.keys(server._registeredTools).sort();
}

async function enableDelete() {
  const { setSetting } = await import("../db");
  setSetting("delete_enabled", "true");
}

const READ_TOOLS = [
  "daily_note",
  "get_links",
  "get_outline",
  "get_vault_info",
  "list_attachments",
  "list_folders",
  "list_link_issues",
  "list_notes",
  "list_tags",
  "list_tasks",
  "notes_by_tag",
  "random_note",
  "read_attachment",
  "read_note",
  "read_properties",
  "search_vault",
  "word_count",
];

const WRITE_TOOLS = [
  "append_to_note",
  "create_note",
  "move_note",
  "prepend_to_note",
  "remove_property",
  "set_property",
  "toggle_task",
  "unique_note",
  "update_note",
];

describe("tool surface", () => {
  it("exposes exactly the read tools to a read-only client", async () => {
    expect(await toolNames(true, false)).toEqual(READ_TOOLS);
  });

  it("adds the write tools for a writable client", async () => {
    expect(await toolNames(true, true)).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
  });

  it("registers list_attachments", async () => {
    // Called out on its own because read_attachment's errors refer callers to
    // it, and advice pointing at a tool that does not exist is worse than no
    // advice at all.
    expect(await toolNames(true, false)).toContain("list_attachments");
  });

  it("never exposes a write tool to a read-only client", async () => {
    const readOnly = await toolNames(true, false);
    for (const w of WRITE_TOOLS) expect(readOnly).not.toContain(w);
  });
});

describe("delete is opt-in", () => {
  it("is absent by default, even for a writable client", async () => {
    expect(await toolNames(true, true)).not.toContain("delete_note");
  });

  it("appears once the setting is enabled", async () => {
    await enableDelete();
    expect(await toolNames(true, true)).toContain("delete_note");
  });

  it("stays absent for a read-only client even when enabled", async () => {
    await enableDelete();
    expect(await toolNames(true, false)).not.toContain("delete_note");
  });
});
