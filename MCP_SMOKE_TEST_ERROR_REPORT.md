# Obsidian MCP smoke-test error report

## Summary

The Obsidian MCP integration became unavailable during a non-destructive smoke
test on 2026-07-31 (America/Los_Angeles). The first six calls in a nine-call
concurrent read batch completed, slowly, while the final three returned
`MCP tool ... is not available to the model`. Immediately afterward, all 24
previously advertised Obsidian tools disappeared from the callable inventory.
Repeated MCP discovery calls then returned:

```text
resources/list failed: MCP server 'obsidian' was not ready for this step
```

The integration did not recover after waits of 10 seconds, 30 seconds, and
additional diagnostic time. Testing was stopped at the user's request.

This is a release-blocking reliability issue for the Codex integration. The
available evidence does not yet prove whether the fault is in this server, the
MCP host/client, or their interaction under concurrency. The first diagnostic
step must be to correlate the timestamps below with server request logs.

## Environment

- Repository: `ob-sync-mcp` version `0.1.0`
- MCP transport: stateless Streamable HTTP
- MCP SDK: `@modelcontextprotocol/sdk ^1.30.0`
- Vault: `Home`
- Vault size before the test: 2,605 notes / 940,840 words
- Vault size during the formal batch: 2,610 notes / 940,896 words
- Sync state reported by `get_vault_info`: `running`
- Formal run ID: `1785564127683`
- Formal run start: `2026-08-01T06:02:07.683Z`
- A later `get_vault_info` reported sync start time
  `2026-08-01T05:49:39.304Z`, about 12 minutes before the run.

## Scope

The intended test covered all read-only, additive, and reversible tools. The
following destructive operations were intentionally excluded:

- `update_note`
- `move_note`
- `remove_property`
- `delete_note` (not advertised because deletion is disabled)

For `toggle_task`, the plan was to toggle a fixture task twice so final state
would be unchanged. The integration failed before that test could run.

## Test artifacts left in the vault

The server has no enabled delete tool, so these fixtures remain and should be
removed manually after debugging:

- `MCP Server Tests/Smoke Test 1785564127683.md`
- `202607312304.md`
- `Daily/2099-12-31.md`

The existing daily note `Daily/2026-07-31.md` also contains the earlier manual
verification sentence:

```text
I am able to write successfully
```

## Results before failure

### Passed in earlier standalone calls

| Operation | Result |
| --- | --- |
| `get_vault_info` | Returned vault statistics and sync status. |
| `search_vault(query="Java", limit=100)` | Returned 100 results. |
| `search_vault(limit=10000)` validation | Cleanly rejected the value because the maximum is 100. |
| `daily_note(action="path", date="2026-07-31")` | Returned `Daily/2026-07-31.md`. |
| `daily_note(action="append")` | Appended to the current daily note. |
| `read_note` | Verified the appended sentence appeared exactly once. |
| `list_notes(folder="Daily")` | Returned 288 notes under the folder. |

### Passed while creating isolated fixtures

Four calls were issued sequentially inside one test cell. All passed, but the
batch took approximately **157 seconds**, which is unexpectedly slow.

| Operation | Observed result |
| --- | --- |
| `create_note` | Created the named fixture. |
| `unique_note` | Created `202607312304.md`. |
| `daily_note(action="append", date="2099-12-31")` | Appended and created the isolated daily fixture as needed. |
| `daily_note(action="prepend", date="2099-12-31")` | Prepended successfully. |

### Concurrent read batch

Nine calls were started with `Promise.all`. Six completed and three failed.

| Operation | Result | Duration |
| --- | --- | ---: |
| `get_vault_info` | Pass | 98,248 ms |
| `list_folders` | Pass | 101,079 ms |
| `list_notes(folder)` | Pass | 102,612 ms |
| `search_vault` | Pass | 103,613 ms |
| `read_note` | Pass | 104,434 ms |
| `get_outline` | Pass | 111,279 ms |
| `get_links(direction="outgoing")` | Fail: unavailable to model | 141,308 ms |
| `get_links(direction="backlinks")` | Fail: unavailable to model | 141,311 ms |
| `random_note` | Fail: unavailable to model | 141,316 ms |

Exact failure texts:

```text
MCP tool `obsidian/get_links` is not available to the model
MCP tool `obsidian/random_note` is not available to the model
```

The fact that exactly six concurrent calls completed is significant. It may
indicate a six-call limit or queue in the MCP host rather than a handler defect.
Confirm in server logs whether requests for the two `get_links` calls and the
`random_note` call ever reached `/api/mcp`.

## Failure progression

1. The server initially advertised 24 Obsidian tools.
2. Fixture writes succeeded, but four simple calls took about 157 seconds.
3. In a nine-call concurrent read batch, six calls completed in 98-111 seconds.
4. The remaining three calls failed at about 141 seconds with
   `not available to the model`.
5. The next attempted batch (`list_tags`, `notes_by_tag`, and two
   `read_properties` calls) failed locally and immediately because the tool
   functions were no longer present on the callable tool object.
6. Both the advertised and callable Obsidian tool counts then became zero.
7. `resources/list` and `resources/templates/list` reported that the Obsidian
   MCP server was not ready.
8. The state persisted through multiple readiness checks.

## Coverage blocked by the outage

These intended non-destructive tests did not reach a functioning handler after
the outage:

- `append_to_note`
- `prepend_to_note`
- `daily_note(action="read")`
- `read_properties` for a note and for the whole vault
- `set_property` on the fixture
- `list_tasks` with `all`, `todo`, and `daily`
- `toggle_task` twice on the fixture task
- `list_link_issues` with `unresolved`, `orphans`, and `deadends`
- `list_tags`
- `notes_by_tag`
- `word_count` for a note and for the whole vault
- successful `get_links` in both directions
- successful `random_note`

## Expected behavior

- Tool discovery remains stable for the lifetime of the client connection.
- Concurrent tool calls either execute concurrently or queue with a documented,
  bounded delay; they must not make tools disappear.
- A failed or timed-out call must not unregister the entire MCP server.
- Normal read calls against a 2,600-note vault should not take 98-141 seconds.
- The server should recover cleanly from client cancellation or transport
  timeout without requiring manual reconnection or restart.

## Investigation plan for a fixing LLM

### 1. Determine whether the failed calls reached this application

Inspect Railway/application logs around `2026-08-01T06:02Z` through
`2026-08-01T06:08Z`.

- If only six of the nine concurrent requests reached `/api/mcp`, the primary
  failure is likely in the Codex MCP host/concurrency layer. Reproduce with the
  same client and avoid assuming a server handler bug.
- If all nine arrived, record request start/end, status, tool name, and any
  exception or disconnect. Then investigate server blocking/resource leakage.
- Check process restarts, OOM kills, Railway CPU throttling, open connections,
  event-loop delay, and SQLite busy/lock events.

Add temporary structured logging around `POST /api/mcp` and `serveMcp` with a
request ID, tool name, start time, end time, duration, response status, and
transport/server close outcome. Do not log note content or credentials.

### 2. Reproduce sequentially before adding concurrency

Run the complete non-destructive matrix with concurrency 1. Record latency for
every call. Then repeat with concurrency 2, 4, 6, 7, 8, and 9 using:

1. MCP Inspector or another direct Streamable HTTP client.
2. Codex using the same connector configuration.

This separates server capacity from a host-specific tool-execution limit.

### 3. Audit per-request MCP lifecycle cleanup

`src/server/mcp/http.ts` creates a fresh `McpServer` and
`StreamableHTTPServerTransport` for every request. Cleanup is currently attached
after `await toFetchResponse(res)`:

```ts
const response = await toFetchResponse(res);
res.on("close", () => {
  void transport.close();
  void server.close();
});
return response;
```

Verify whether `close` can fire before the listener is registered. If so,
servers/transports leak on successful requests. Prefer cleanup that is
registered before request handling and is guaranteed through `try/finally`,
while respecting any streaming response lifecycle required by the SDK. Add an
automated test that runs hundreds of stateless requests and asserts that
handles/listeners/memory do not grow without bound.

### 4. Measure synchronous index work

`ensureIndexerStarted()` calls `indexer().start()`, and `start()` performs a
synchronous full-vault rebuild before installing the watcher. A cold request can
therefore block the Node event loop while all notes are read and SQLite is
rewritten. Also, each write calls synchronous `reindexPath()` before returning.

Measure separately:

- cold full rebuild duration;
- `reindexPath()` duration;
- `resolveLinksFor()` duration and unresolved-link row count;
- SQLite transaction duration;
- event-loop delay during each phase.

Do not rebuild synchronously on the first MCP request if it can be initialized
at process startup or in a background readiness phase. Expose readiness
explicitly and return a bounded 503 while initializing rather than allowing
requests to hang for minutes.

### 5. Verify cancellation and timeout behavior

Simulate the client abandoning requests at 30, 60, 90, and 140 seconds. Confirm
that cancellation closes the request's transport/server and does not affect tool
discovery for subsequent requests.

### 6. Complete the original tool matrix

After stabilizing the connection, rerun every operation listed under “Coverage
blocked by the outage,” using only the three fixture notes above. Keep
destructive tests disabled unless explicitly authorized.

## Acceptance criteria

1. All 21 advertised non-destructive/additive/reversible tools pass sequentially.
2. All action variants pass (`daily_note`, `get_links`, `list_link_issues`,
   `list_tasks`, `read_properties`, and `word_count`).
3. A nine-call concurrent read batch completes or queues without tool inventory
   loss, `not available to the model`, or server-not-ready state.
4. Tool discovery remains at 24 tools before and after stress tests when using
   a write-authorized client with deletion disabled.
5. Common read calls have a documented latency target and no call hangs beyond
   the server's timeout budget.
6. Client cancellation does not leak transports, servers, listeners, or memory.
7. Automated integration tests cover sequential calls, concurrency boundaries,
   transport cleanup, cold index startup, and recovery after cancellation.

## Important caution

Do not “fix” the report by merely increasing client timeouts. The key failure is
loss of tool availability and failure to recover. First establish whether the
server received the failed requests; then fix the responsible layer and add a
regression test at that boundary.

## Retest after MCP re-registration — 2026-08-01

A later retest attempted to reload the schema from a clean client state.

### Server health

The sandbox could not reach loopback, but a host-level request succeeded:

```http
HTTP/1.1 200 OK
content-type: application/json

{"ok":true,"configured":true}
```

The endpoint was still configured as:

```text
http://localhost:3000/api/mcp
```

### Registration refresh

There is no `codex mcp reload` command, so the registration was removed and
re-added with the same URL. The add command detected OAuth, opened the OAuth
flow, requested `vault:read` and `vault:write`, and printed:

```text
Successfully logged in.
```

However, `codex mcp list` continued to report the Obsidian connection as:

```text
Status: enabled
Auth: Unsupported
```

The already-running Codex session still had zero advertised Obsidian tools,
which may be expected if active sessions cannot hot-reload schemas.

### Fresh-process verification

A new ephemeral, read-only `codex exec` process was started after the
registration and OAuth refresh. It was instructed to call only
`get_vault_info` and `daily_note(action="path", date="2026-08-01")`.

The fresh process reported:

```text
Unable to perform the calls: no configured Obsidian MCP tools, including
`get_vault_info` or `daily_note`, are available in this session.
```

Neither call reached a tool handler.

During startup, that process also logged an `invalid_token` error for an
unrelated Cloudflare MCP endpoint. Do not attribute that error to Obsidian, but
check whether one failed MCP initialization incorrectly suppresses other MCP
servers during global tool discovery.

### Updated fault boundary

The Obsidian application health endpoint is available, but a newly launched
Codex client still cannot load its tool schema after an apparently successful
OAuth flow. Prioritize these checks:

1. Inspect server access logs to confirm whether the fresh client requested the
   protected-resource metadata, authorization-server metadata, token endpoint,
   and MCP `initialize` / `tools/list` methods.
2. Confirm the access token is persisted by Codex and sent to `/api/mcp` after
   the successful login message.
3. Confirm the token audience/resource exactly matches
   `http://localhost:3000/api/mcp`; look for an HTTP/HTTPS or localhost/127.0.0.1
   mismatch.
4. Determine why Codex reports `Auth: Unsupported` immediately after completing
   OAuth successfully.
5. Test with all unrelated MCP servers disabled to determine whether a failure
   initializing one server prevents Obsidian tool discovery.
6. Capture the raw status and response body for the fresh client's
   `initialize` and `tools/list` requests.

## Post-restart retest — schema loads, then disappears

After the Codex app was restarted, the active model runtime initially exposed
all **25** current Obsidian tools, including the newly added `read_attachment`.
This proves that OAuth, initial schema discovery, and model tool injection can
all succeed after a full client restart.

An initial `get_vault_info` call passed in approximately 4.3 seconds and
reported 2,614 notes, 940,892 words, and sync state `running`.

### Sequential read-only test

No concurrent MCP calls and no vault mutations were used.

The first sequence produced these results:

| Call | Duration | Result |
| --- | ---: | --- |
| `list_folders` | 110,306 ms | Returned valid first page: 147 total, 100 items, `hasMore: true`. |
| `list_notes` for a removed test folder | 2,210 ms | Correctly returned `Folder not found`. |
| `read_note` for the removed fixture | 3,183 ms | Correctly returned `Note not found`. |
| `get_outline` for the removed fixture | 2,444 ms | Correctly returned `Note not found`. |
| `search_vault` for the removed fixture token | 1,869 ms | Correctly returned an empty array. |

The prior smoke-test fixture had been removed, so those negative results are
expected handler behavior, not failures. The 110-second latency on the first
call remains abnormal.

A second sequential sequence used existing vault data and the new pagination
arguments:

| Call | Duration | Result |
| --- | ---: | --- |
| `list_folders(limit=500)` | 24 ms | Pass; returned all 147 folders. |
| `list_notes(folder="Daily", limit=500)` | 16 ms | Pass; included `Daily/2026-07-31.md`. |
| `daily_note(action="path", date="2026-08-01")` | 28,390 ms | Pass; returned `Daily/2026-08-01.md`. |
| `daily_note(action="read", date="2026-07-31")` | 30,061 ms | Failed with `unsupported call`. |
| Later `read_note`, `get_outline`, `search_vault` | 0-1 ms | Failed immediately with `unsupported call`. |

The runtime rendered the failing names without the separator between server
and tool, for example:

```text
unsupported call: mcp__obsidiandaily_note
unsupported call: mcp__obsidianread_note
unsupported call: mcp__obsidianget_outline
unsupported call: mcp__obsidiansearch_vault
```

Immediately after these errors, the active runtime's advertised Obsidian tool
count fell from 25 to zero again.

### Updated conclusion

This failure does **not** require concurrent requests. A full client restart
restores the schema temporarily, but a slow call near the 30-second boundary is
followed by dispatcher rejection of all subsequent Obsidian calls and complete
loss of the model-visible schema.

Correlate the 28.4-second successful `daily_note/path` call and 30.1-second
failed `daily_note/read` call with both client and server logs. Determine:

1. whether the failed read request reached `/api/mcp`;
2. whether a 30-second client timeout invalidates or unregisters the server;
3. whether the server closes or fails to close its stateless transport near
   that timeout boundary;
4. why one timeout changes later calls from normal MCP requests into local
   `unsupported call` failures;
5. why a full app restart, rather than ordinary MCP reconnection, is required
   to restore the tool schema.
