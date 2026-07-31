import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { toReqRes, toFetchResponse } from "fetch-to-node";
import { createMcpServer, type McpAccess } from "./server";
import { ensureIndexerStarted } from "../vault/indexer";

const MAX_BODY_BYTES = 4 * 1024 * 1024;

// Read and parse the JSON body with a hard byte cap, independent of the
// (spoofable) Content-Length header — defends against chunked oversized bodies.
async function readCappedJson(request: Request): Promise<unknown> {
  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_BODY_BYTES) throw new Error("Request body too large");
  const text = new TextDecoder().decode(buf);
  if (!text) return undefined;
  return JSON.parse(text);
}

// Stateless Streamable HTTP: a fresh server + transport per request. All state
// lives in the vault/database, so nothing needs to persist between calls.
export async function serveMcp(request: Request, access: McpAccess): Promise<Response> {
  ensureIndexerStarted();
  const server = createMcpServer(access);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  const { req, res } = toReqRes(request);
  await server.connect(transport);
  await transport.handleRequest(req, res, await readCappedJson(request).catch(() => undefined));
  const response = await toFetchResponse(res);
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  return response;
}
