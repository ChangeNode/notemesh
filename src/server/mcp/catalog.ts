import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, type McpAccess } from "./server";

/**
 * The tool list, asked for the way a client asks for it.
 *
 * This runs a real `tools/list` against a real server instance over an
 * in-memory transport, so what the Tools tab shows is what a connected client
 * is handed — same registration code, same conditionals, same descriptions.
 * There is no second copy of the catalogue to fall out of step, and a tool
 * added, renamed or removed in mcp/server.ts shows up here with no other edit.
 *
 * Not read off the SDK's private _registeredTools: that field is reachable, but
 * it is the server's bookkeeping rather than its answer, and the two could
 * diverge without warning on an SDK upgrade. The protocol round trip is the
 * thing being documented.
 */

export interface ToolParam {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

export interface ToolAnnotationsDoc {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDoc {
  name: string;
  title?: string;
  description?: string;
  params: ToolParam[];
  /** Needs a write-scoped credential. Derived, not declared — see listMcpTools. */
  write: boolean;
  /** What the tool declares about itself to clients. Declared, unlike `write`; the test checks the two agree. */
  annotations?: ToolAnnotationsDoc;
}

/** One connect/list/close cycle. */
async function toolsFor(access: McpAccess) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(access);
  const client = new Client({ name: "notemesh-admin", version: "1.0.0" });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return (await client.listTools()).tools;
  } finally {
    // Both, even if the list threw: these hold an open transport pair, and the
    // page can be reloaded as often as the operator likes.
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

// JSON Schema is what the protocol carries, so read the shape from there rather
// than from the zod definitions — same reasoning as above.
function paramsOf(schema: unknown): ToolParam[] {
  const s = schema as
    | { properties?: Record<string, { type?: string; description?: string }>; required?: string[] }
    | undefined;
  if (!s?.properties) return [];
  const required = new Set(s.required ?? []);
  return Object.entries(s.properties).map(([name, def]) => ({
    name,
    type: def?.type ?? "any",
    required: required.has(name),
    description: def?.description,
  }));
}

/**
 * Every tool this instance exposes, with write tools marked.
 *
 * Listed twice, because "is this a write tool" is not something the protocol
 * reports — a client only ever sees the tools its own credential earns. Asking
 * once with write scope and once without makes the difference between the two
 * answers the definition of a write tool, which keeps it derived from the same
 * registration conditionals instead of a hand-kept list that would rot.
 */
export async function listMcpTools(): Promise<ToolDoc[]> {
  const [all, readOnly] = await Promise.all([
    toolsFor({ read: true, write: true, label: "admin-catalog" }),
    toolsFor({ read: true, write: false, label: "admin-catalog" }),
  ]);
  const readNames = new Set(readOnly.map((t) => t.name));

  return all
    .map((t) => ({
      name: t.name,
      title: t.title ?? (t.annotations?.title as string | undefined),
      description: t.description,
      params: paramsOf(t.inputSchema),
      write: !readNames.has(t.name),
      annotations: t.annotations
        ? {
            readOnlyHint: t.annotations.readOnlyHint,
            destructiveHint: t.annotations.destructiveHint,
            idempotentHint: t.annotations.idempotentHint,
            openWorldHint: t.annotations.openWorldHint,
          }
        : undefined,
    }))
    .sort((a, b) => (a.write === b.write ? a.name.localeCompare(b.name) : a.write ? 1 : -1));
}
