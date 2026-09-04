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
  root = fs.mkdtempSync(path.join(os.tmpdir(), "notemesh-mcp-"));
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

async function setDelete(on: boolean) {
  const { setSetting } = await import("../db");
  setSetting("delete_enabled", on ? "true" : "false");
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
  // Present unless the setting turns it off — see the delete_note block below.
  "delete_note",
  "edit_note",
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

// Deleting is on by default: both backends keep the file in their history, so
// it is recoverable rather than destructive. The setting still turns it off,
// and read scope still never gets it — those are the parts that matter.
describe("delete_note", () => {
  it("is present by default for a writable client", async () => {
    expect(await toolNames(true, true)).toContain("delete_note");
  });

  it("disappears once the setting is turned off", async () => {
    await setDelete(false);
    expect(await toolNames(true, true)).not.toContain("delete_note");
  });

  it("comes back when the setting is turned on again", async () => {
    await setDelete(true);
    expect(await toolNames(true, true)).toContain("delete_note");
  });

  it("is never exposed to a read-only client", async () => {
    expect(await toolNames(true, false)).not.toContain("delete_note");
    await setDelete(true);
    expect(await toolNames(true, false)).not.toContain("delete_note");
  });
});
