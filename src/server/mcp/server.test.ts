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
  "preview_edit",
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

// The preview is the read half of an edit: offered without write scope, and
// touching nothing — no write, no reindex, no word to the sync backend. The
// write path is one shared helper, so this pins that the preview is not
// wired to it. The real edit runs through the same spies first, as proof
// that they see what they are meant to see.
describe("preview_edit", () => {
  type Handler = (args: unknown, extra: unknown) => { content: { text: string }[]; isError?: boolean };

  async function serverWith(write: boolean) {
    const reindex = vi.fn();
    const notify = vi.fn();
    vi.doMock("../vault/indexer", async (original) => ({
      ...(await original<typeof import("../vault/indexer")>()),
      reindexPath: reindex,
    }));
    vi.doMock("../sync", async (original) => ({
      ...(await original<typeof import("../sync")>()),
      syncBackend: () => ({ notifyLocalChange: notify }),
    }));
    const { createMcpServer } = await import("./server");
    const server = createMcpServer({ read: true, write, label: "test" }) as unknown as {
      _registeredTools: Record<string, { handler: Handler } | undefined>;
    };
    const call = (tool: string, args: Record<string, unknown>) => server._registeredTools[tool]!.handler(args, {});
    const has = (tool: string) => server._registeredTools[tool] !== undefined;
    return { call, has, reindex, notify };
  }

  afterEach(() => {
    vi.doUnmock("../vault/indexer");
    vi.doUnmock("../sync");
  });

  function plant(content: string) {
    const abs = path.join(root, "vault", "Note.md");
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  }

  it("edit_note reindexes and tells the backend, so the spies are live", async () => {
    const { call, reindex, notify } = await serverWith(true);
    const abs = plant("a\nfoo\nb\n");
    const res = call("edit_note", { path: "Note.md", oldString: "foo", newString: "bar" });
    expect(res.isError).toBeUndefined();
    expect(fs.readFileSync(abs, "utf8")).toBe("a\nbar\nb\n");
    expect(reindex).toHaveBeenCalledWith("Note.md");
    expect(notify).toHaveBeenCalledWith({ tool: "edit_note", path: "Note.md" });
  });

  it("is offered to a read-only credential and touches nothing", async () => {
    const { call, has, reindex, notify } = await serverWith(false);
    expect(has("edit_note")).toBe(false);
    expect(has("preview_edit")).toBe(true);
    const abs = plant("a\nfoo\nb\n");
    const res = call("preview_edit", { path: "Note.md", oldString: "foo", newString: "bar" });
    expect(res.isError).toBeUndefined();
    const body = JSON.parse(res.content[0].text);
    expect(body).toMatchObject({ path: "Note.md", count: 1, wouldReplace: 1 });
    expect(body.matches[0].line).toBe(2);
    expect(fs.readFileSync(abs, "utf8")).toBe("a\nfoo\nb\n");
    expect(reindex).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

// A full disk is the one native error a tool names, because the fix is the
// operator's. The write guard refuses most of them first; this is the write
// that crosses the line anyway — here the index's, which safe() alone sees.
describe("a full disk, as a tool reports it", () => {
  afterEach(() => vi.doUnmock("../vault/notes"));

  it("names the volume instead of the generic failure", async () => {
    vi.doMock("../vault/notes", async (original) => ({
      ...(await original<typeof import("../vault/notes")>()),
      createNote: () => {
        throw Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
      },
    }));
    const { createMcpServer } = await import("./server");
    const server = createMcpServer({ read: true, write: true, label: "test" }) as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: unknown, extra: unknown) => { content: { text: string }[]; isError?: boolean } }
      >;
    };
    const res = server._registeredTools.create_note.handler({ path: "New.md", content: "x" }, {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/volume is full/);
    expect(res.content[0].text).not.toMatch(/server logs/);
  });
});

// Sorting and narrowing happen before paging: total and hasMore describe the
// narrowed list, and page two follows page one under the same order.
describe("list_notes and list_attachments, sorted and narrowed", () => {
  type Handler = (args: unknown, extra: unknown) => { content: { text: string }[]; isError?: boolean };
  type Envelope = { total: number; count: number; hasMore: boolean; items: { path: string }[] };

  async function tools() {
    const { createMcpServer } = await import("./server");
    const server = createMcpServer({ read: true, write: false, label: "test" }) as unknown as {
      _registeredTools: Record<string, { handler: Handler } | undefined>;
    };
    return (tool: string, args: Record<string, unknown>) => {
      const res = server._registeredTools[tool]!.handler(args, {});
      return { res, body: res.isError ? null : (JSON.parse(res.content[0].text) as Envelope) };
    };
  }

  const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
  function plant(rel: string, size: number, modifiedMs: number) {
    const abs = path.join(root, "vault", rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "x".repeat(size));
    fs.utimesSync(abs, modifiedMs / 1000, modifiedMs / 1000);
  }

  beforeEach(() => {
    plant("b.md", 3, T0 + 2000);
    plant("a.md", 1, T0 + 3000);
    plant("c.md", 2, T0 + 1000);
    plant("img/one.png", 5, T0 + 1000);
    plant("img/two.png", 4, T0 + 2000);
  });

  it("sorts by modified, newest first, and pages under that order", async () => {
    const call = await tools();
    const first = call("list_notes", { sort: "modified", limit: 2 }).body!;
    expect(first.items.map((i) => i.path)).toEqual(["a.md", "b.md"]);
    expect(first).toMatchObject({ total: 3, count: 2, hasMore: true });
    const second = call("list_notes", { sort: "modified", limit: 2, offset: 2 }).body!;
    expect(second.items.map((i) => i.path)).toEqual(["c.md"]);
    expect(second.hasMore).toBe(false);
  });

  it("modifiedAfter narrows the whole listing, so total is the narrowed count", async () => {
    const call = await tools();
    const { setSetting } = await import("../db");
    setSetting("timezone", "Pacific/Auckland");
    // Auckland's 2026-01-02 begins at 11:00Z on the 1st; every note is after that.
    expect(call("list_notes", { modifiedAfter: "2026-01-02" }).body!.total).toBe(3);
    // 12:00:02Z exactly: strictly after keeps only the one at 12:00:03Z.
    const after = call("list_notes", { modifiedAfter: "2026-01-01T12:00:02Z", limit: 1 }).body!;
    expect(after).toMatchObject({ total: 1, count: 1, hasMore: false });
    expect(after.items[0].path).toBe("a.md");
  });

  it("attachments sort by size, largest first, and narrow the same way", async () => {
    const call = await tools();
    expect(call("list_attachments", { sort: "size" }).body!.items.map((i) => i.path)).toEqual([
      "img/one.png",
      "img/two.png",
    ]);
    expect(call("list_attachments", { modifiedAfter: "2026-01-01T12:00:01Z" }).body!.items.map((i) => i.path)).toEqual([
      "img/two.png",
    ]);
  });

  it("a modifiedAfter it cannot read is a tool error that says what it wanted", async () => {
    const call = await tools();
    const { res } = call("list_notes", { modifiedAfter: "last tuesday" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/ISO 8601 timestamp .* or a date/);
  });
});
