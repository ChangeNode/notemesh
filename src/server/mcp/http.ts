import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { toReqRes, toFetchResponse } from "fetch-to-node";
import { createMcpServer, type McpAccess } from "./server";
import { ensureIndexerStarted } from "../vault/indexer";

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
  await transport.handleRequest(req, res, await request.json().catch(() => undefined));
  const response = await toFetchResponse(res);
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  return response;
}
