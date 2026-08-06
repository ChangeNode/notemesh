import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { toReqRes, toFetchResponse } from "fetch-to-node";
import { createMcpServer, type McpAccess } from "./server";
import { ensureIndexerStarted } from "../vault/indexer";
import { startLoopLagMonitor, timed } from "./instrument";

export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Thrown by readCappedJson when the body exceeds the cap. */
export class BodyTooLargeError extends Error {
  constructor() {
    super("Request body too large");
    this.name = "BodyTooLargeError";
  }
}

/**
 * Read and parse the JSON body, counting bytes as they arrive.
 *
 * This used to call request.arrayBuffer() and check the length afterwards,
 * which is the check happening after the damage: the whole body was already in
 * memory by the time it was rejected, so a chunked upload of any size was
 * buffered in full. Counting while reading means an oversized body is abandoned
 * partway, and the reader is cancelled so the sender stops.
 */
export async function readCappedJson(request: Request): Promise<unknown> {
  // Fast path — an honest Content-Length lets us refuse before reading a byte.
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new BodyTooLargeError();

  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  if (total === 0) return undefined;

  const buf = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    buf.set(c, at);
    at += c.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(buf));
}

function tooLarge(): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32600, message: "Request too large" }, id: null }),
    { status: 413, headers: { "Content-Type": "application/json" } },
  );
}

function forbidden(message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32004, message }, id: null }),
    { status: 403, headers: { "Content-Type": "application/json" } },
  );
}

// Stateless Streamable HTTP: a fresh server + transport per request. All state
// lives in the vault/database, so nothing needs to persist between calls.
export async function serveMcp(request: Request, access: McpAccess): Promise<Response> {
  // A credential that carries neither vault scope gets nothing. The read flag
  // used to be computed and then ignored — every read tool registered whatever
  // the token said — so a token with no scopes at all could list and open every
  // note. Refused here rather than by serving an empty tool list, because a
  // caller with no access should be told so, not handed a server that appears
  // to work and does nothing.
  if (!access.read) {
    return forbidden("This credential does not carry the vault:read scope.");
  }

  startLoopLagMonitor();
  ensureIndexerStarted();
  const server = createMcpServer(access);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  const { req, res } = toReqRes(request);
  await server.connect(transport);

  let body: unknown;
  try {
    body = await readCappedJson(request);
  } catch (e) {
    // An oversized body is answered with 413 rather than swallowed. Previously
    // this caught everything and carried on with an undefined body, so the cap
    // produced an ordinary protocol error and the caller never learned why.
    void transport.close();
    void server.close();
    if (e instanceof BodyTooLargeError) return tooLarge();
    body = undefined;
  }

  const toolName =
    (body as any)?.params?.name ?? (body as any)?.method ?? "unknown";
  await timed(`mcp ${toolName}`, () => transport.handleRequest(req, res, body));
  const response = await toFetchResponse(res);
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  return response;
}
