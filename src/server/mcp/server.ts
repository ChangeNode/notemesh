import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getSetting } from "../db";
import { supervisor } from "../ob/supervisor";
import { VaultPathError } from "../vault/paths";
import {
  readNote,
  createNote,
  updateNote,
  appendToNote,
  prependToNote,
  moveNote,
  deleteNote,
  listNotes,
  listFolders,
} from "../vault/notes";
import { readProperties, setProperty, removeProperty, listVaultProperties } from "../vault/frontmatter";
import { dailyNotePath, dailyRead, dailyAppend, dailyPrepend } from "../vault/daily";
import {
  searchVault,
  backlinks,
  outgoingLinks,
  unresolvedLinks,
  orphanNotes,
  deadEndNotes,
  listTags,
  notesByTag,
  listTasks,
  toggleTask,
  vaultInfo,
  wordCount,
  outline,
  randomNote,
  uniqueNote,
} from "../vault/queries";

export interface McpAccess {
  read: boolean;
  write: boolean;
  label: string; // e.g. "api-key:xyz" or "oauth:<client name>"
}

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

// Wrap a handler so vault errors surface as tool errors, not protocol errors.
// Only VaultPathError messages (already vault-relative and safe) are returned
// verbatim; any other error (e.g. a native fs error carrying an absolute path
// and OS username) is logged server-side and replaced with a generic message.
function safe<A extends unknown[], R>(fn: (...args: A) => R) {
  return (...args: A) => {
    try {
      return fn(...args);
    } catch (e: any) {
      if (e instanceof VaultPathError) return err(e.message);
      console.error("[mcp] tool error:", e);
      return err("The operation failed. Check the server logs for details.");
    }
  };
}

// The tool surface mirrors the official Obsidian CLI's vault-level commands,
// reimplemented against the synced files (the desktop app isn't running here).
export function createMcpServer(access: McpAccess): McpServer {
  const server = new McpServer({
    name: "obsidian-vault",
    version: "0.1.0",
  });

  const writable = access.write;

  // ---- Files ----
  server.registerTool(
    "read_note",
    {
      title: "Read note",
      description: "Read the full contents of a note. Path is vault-relative; '.md' is optional.",
      inputSchema: { path: z.string().describe("Vault-relative note path, e.g. 'Projects/Ideas.md'") },
    },
    safe(({ path }: { path: string }) => json(readNote(path))),
  );

  server.registerTool(
    "list_notes",
    {
      title: "List notes",
      description: "List markdown notes in the vault (optionally within a folder), with modified time and size.",
      inputSchema: { folder: z.string().optional().describe("Folder to list; omit for the whole vault") },
    },
    safe(({ folder }: { folder?: string }) => json(listNotes(folder))),
  );

  server.registerTool(
    "list_folders",
    {
      title: "List folders",
      description: "List every folder in the vault.",
      inputSchema: {},
    },
    safe(() => json(listFolders())),
  );

  if (writable) {
    server.registerTool(
      "create_note",
      {
        title: "Create note",
        description: "Create a new note. Fails if the note already exists (use update_note to replace).",
        inputSchema: {
          path: z.string().describe("Vault-relative path for the new note"),
          content: z.string().describe("Markdown content"),
        },
      },
      safe(({ path, content }: { path: string; content: string }) =>
        text(`Created ${createNote(path, content)}`),
      ),
    );

    server.registerTool(
      "update_note",
      {
        title: "Update note",
        description: "Replace the full contents of an existing note.",
        inputSchema: {
          path: z.string(),
          content: z.string().describe("New markdown content (replaces everything)"),
        },
      },
      safe(({ path, content }: { path: string; content: string }) =>
        text(`Updated ${updateNote(path, content)}`),
      ),
    );

    server.registerTool(
      "append_to_note",
      {
        title: "Append to note",
        description: "Append markdown to the end of an existing note. The safest way to add content.",
        inputSchema: { path: z.string(), content: z.string() },
      },
      safe(({ path, content }: { path: string; content: string }) =>
        text(`Appended to ${appendToNote(path, content)}`),
      ),
    );

    server.registerTool(
      "prepend_to_note",
      {
        title: "Prepend to note",
        description: "Insert markdown at the top of a note, after any YAML frontmatter.",
        inputSchema: { path: z.string(), content: z.string() },
      },
      safe(({ path, content }: { path: string; content: string }) =>
        text(`Prepended to ${prependToNote(path, content)}`),
      ),
    );

    server.registerTool(
      "move_note",
      {
        title: "Move / rename note",
        description: "Move or rename a note within the vault. Fails if the target exists.",
        inputSchema: {
          path: z.string().describe("Current vault-relative path"),
          newPath: z.string().describe("New vault-relative path"),
        },
      },
      safe(({ path, newPath }: { path: string; newPath: string }) => {
        const res = moveNote(path, newPath);
        return text(`Moved ${res.from} → ${res.to}`);
      }),
    );

    if (getSetting("delete_enabled") === "true") {
      server.registerTool(
        "delete_note",
        {
          title: "Delete note",
          description: "Permanently delete a note. The deletion syncs to all devices.",
          inputSchema: { path: z.string() },
        },
        safe(({ path }: { path: string }) => text(`Deleted ${deleteNote(path)}`)),
      );
    }
  }

  // ---- Daily notes ----
  server.registerTool(
    "daily_note",
    {
      title: "Daily note",
      description:
        "Work with daily notes: read today's (or a given date's) note, append/prepend to it (creating it if needed), or get its path. Uses the vault's daily-notes settings.",
      inputSchema: {
        action: z.enum(writable ? ["read", "append", "prepend", "path"] : ["read", "path"]),
        content: z.string().optional().describe("Markdown content (for append/prepend)"),
        date: z.string().optional().describe("Date as YYYY-MM-DD; defaults to today"),
      },
    },
    safe(({ action, content, date }: { action: string; content?: string; date?: string }) => {
      switch (action) {
        case "read":
          return json(dailyRead(date));
        case "path":
          return text(dailyNotePath(date));
        case "append":
          if (!content) return err("content is required for append");
          return text(`Appended to ${dailyAppend(content, date)}`);
        case "prepend":
          if (!content) return err("content is required for prepend");
          return text(`Prepended to ${dailyPrepend(content, date)}`);
        default:
          return err(`Unknown action: ${action}`);
      }
    }),
  );

  // ---- Search ----
  server.registerTool(
    "search_vault",
    {
      title: "Search vault",
      description: "Full-text search across all notes (titles, headings, body). Returns paths and snippets.",
      inputSchema: {
        query: z.string().describe("Search terms (all terms must match)"),
        context: z.boolean().optional().describe("Return longer snippets with more surrounding context"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)"),
      },
    },
    safe(({ query, context, limit }: { query: string; context?: boolean; limit?: number }) =>
      json(searchVault(query, { context, limit })),
    ),
  );

  // ---- Properties ----
  server.registerTool(
    "read_properties",
    {
      title: "Read properties",
      description:
        "Read a note's frontmatter properties, or (with no path) survey all property names used in the vault with usage counts.",
      inputSchema: { path: z.string().optional() },
    },
    safe(({ path }: { path?: string }) => json(path ? readProperties(path) : listVaultProperties())),
  );

  if (writable) {
    server.registerTool(
      "set_property",
      {
        title: "Set property",
        description: "Set a frontmatter property on a note (creates frontmatter if missing).",
        inputSchema: {
          path: z.string(),
          name: z.string(),
          value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
        },
      },
      safe(({ path, name, value }: { path: string; name: string; value: unknown }) =>
        json(setProperty(path, name, value)),
      ),
    );

    server.registerTool(
      "remove_property",
      {
        title: "Remove property",
        description: "Remove a frontmatter property from a note.",
        inputSchema: { path: z.string(), name: z.string() },
      },
      safe(({ path, name }: { path: string; name: string }) => json(removeProperty(path, name))),
    );
  }

  // ---- Tasks ----
  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description: "List markdown tasks (- [ ] / - [x]) across the vault. Filter: all, todo, or daily (today's note).",
      inputSchema: { filter: z.enum(["all", "todo", "daily"]).optional() },
    },
    safe(({ filter }: { filter?: "all" | "todo" | "daily" }) => json(listTasks(filter ?? "all"))),
  );

  if (writable) {
    server.registerTool(
      "toggle_task",
      {
        title: "Toggle task",
        description: "Toggle a task's completion state, identified by note path and line number (from list_tasks).",
        inputSchema: { path: z.string(), line: z.number().int().min(1) },
      },
      safe(({ path, line }: { path: string; line: number }) => json(toggleTask(path, line))),
    );
  }

  // ---- Links & tags ----
  server.registerTool(
    "get_links",
    {
      title: "Get links",
      description: "Get a note's backlinks (notes linking to it) or outgoing wikilinks.",
      inputSchema: {
        path: z.string(),
        direction: z.enum(["backlinks", "outgoing"]),
      },
    },
    safe(({ path, direction }: { path: string; direction: string }) =>
      json(direction === "backlinks" ? backlinks(path) : outgoingLinks(path)),
    ),
  );

  server.registerTool(
    "list_link_issues",
    {
      title: "Link issues",
      description:
        "Vault link health: unresolved (broken wikilinks), orphans (notes nothing links to), or deadends (notes with no outgoing links).",
      inputSchema: { type: z.enum(["unresolved", "orphans", "deadends"]) },
    },
    safe(({ type }: { type: string }) =>
      json(type === "unresolved" ? unresolvedLinks() : type === "orphans" ? orphanNotes() : deadEndNotes()),
    ),
  );

  server.registerTool(
    "list_tags",
    {
      title: "List tags",
      description: "All tags in the vault with usage counts (frontmatter and inline #tags).",
      inputSchema: {},
    },
    safe(() => json(listTags())),
  );

  server.registerTool(
    "notes_by_tag",
    {
      title: "Notes by tag",
      description: "List the notes carrying a given tag.",
      inputSchema: { tag: z.string().describe("Tag name, with or without leading #") },
    },
    safe(({ tag }: { tag: string }) => json(notesByTag(tag))),
  );

  // ---- Vault ----
  server.registerTool(
    "get_vault_info",
    {
      title: "Vault info",
      description: "Vault name, note count, word totals, and sync daemon status.",
      inputSchema: {},
    },
    safe(() => json({ ...vaultInfo(), sync: supervisor().status() })),
  );

  server.registerTool(
    "get_outline",
    {
      title: "Note outline",
      description: "Heading structure of a note with levels and line numbers.",
      inputSchema: { path: z.string() },
    },
    safe(({ path }: { path: string }) => json(outline(path))),
  );

  server.registerTool(
    "word_count",
    {
      title: "Word count",
      description: "Word and character counts for a note, or for the whole vault when no path is given.",
      inputSchema: { path: z.string().optional() },
    },
    safe(({ path }: { path?: string }) => json(wordCount(path))),
  );

  server.registerTool(
    "random_note",
    {
      title: "Random note",
      description: "Return a random note from the vault.",
      inputSchema: {},
    },
    safe(() => json(randomNote())),
  );

  if (writable) {
    server.registerTool(
      "unique_note",
      {
        title: "Create unique note",
        description: "Create a Zettelkasten-style timestamped note (YYYYMMDDHHmm) with optional content.",
        inputSchema: { content: z.string().optional() },
      },
      safe(({ content }: { content?: string }) => text(`Created ${uniqueNote(content)}`)),
    );
  }

  return server;
}
