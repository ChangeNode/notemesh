import { createSignal, createResource, Show, For } from "solid-js";
import { getSetupPage, createApiKey, deleteApiKey } from "~/server/admin";
import { AdminShell, Snippet } from "~/components/AdminShell";

export default function Setup() {
  const [data, { refetch }] = createResource(() => getSetupPage());
  const [newKeyName, setNewKeyName] = createSignal("");
  const [freshKey, setFreshKey] = createSignal<string | null>(null);

  async function createKey(e: Event) {
    e.preventDefault();
    const res = await createApiKey(newKeyName());
    setFreshKey(res.key);
    setNewKeyName("");
    refetch();
  }

  return (
    <AdminShell>
      <Show when={data()} keyed>
        {(d) => {
          const endpoint = `${d.baseUrl}/api/mcp`;
          // Anthropic dials custom connectors from its own infrastructure, so a
          // loopback or plain-HTTP address is reachable only by locally-run
          // clients. Say so here rather than letting the user find out from a
          // connector that silently fails to connect.
          const localOnly = d.baseUrl.startsWith("http://");

          return (
            <>
              <article>
                <header>
                  <strong>Connect an MCP client</strong>
                </header>
                <p class="muted">
                  Point any MCP client at this endpoint (Streamable HTTP transport):
                </p>
                <Snippet text={endpoint} />
                <p class="muted">
                  Clients authenticate one of two ways: the <b>OAuth</b> flow, which sends you back
                  here to approve access, or an <b>API key</b> from the section below.
                </p>
              </article>

              <article>
                <header>
                  <strong>Set up your client</strong>
                </header>

                <Show when={localOnly}>
                  <div class="callout warn">
                    <p>
                      <b>This server is on a local address.</b> Claude Desktop and claude.ai connect
                      from Anthropic's servers rather than from your machine, so they can't reach{" "}
                      <code>{d.baseUrl}</code>. Deploy to a public HTTPS URL to use them.
                    </p>
                    <p class="muted">
                      Claude Code and Codex run on your machine and work against this address today.
                    </p>
                  </div>
                </Show>

                <details open>
                  <summary>Claude Desktop, claude.ai, and Cowork</summary>
                  <p>
                    Add ob-sync as a <b>custom connector</b>. Go to <b>Settings → Connectors</b>,
                    click <b>Add custom connector</b>, and paste the endpoint URL. Configure it once
                    and it becomes available across your Claude apps. The OAuth flow will bring you
                    back here to approve access.
                  </p>
                  <Snippet text={endpoint} />
                  <p class="muted">
                    Not to be confused with the <b>“drag .MCPB or .DXT files here”</b> box in
                    Settings → Extensions. Those bundles package a <i>local</i> MCP server that runs
                    on your own machine over stdio; ob-sync is a remote HTTP server, which is what
                    custom connectors are for. (<code>.dxt</code> was renamed to <code>.mcpb</code>,
                    so you'll see both names around.) There is no bundle to install for ob-sync.
                  </p>
                </details>

                <details>
                  <summary>Claude Code</summary>
                  <p class="muted">Register the server, then run /mcp inside Claude Code to sign in.</p>
                  <Snippet text={`claude mcp add --transport http ob-sync ${endpoint}`} />
                </details>

                <details>
                  <summary>Codex</summary>
                  <p class="muted">
                    Add this to <code>~/.codex/config.toml</code>. The approval mode lets Codex call
                    vault tools without prompting for each one.
                  </p>
                  <Snippet
                    text={`[mcp_servers.ob-sync]\nurl = "${endpoint}"\ndefault_tools_approval_mode = "approve"`}
                  />
                </details>

                <details>
                  <summary>Any other client (API key)</summary>
                  <p class="muted">
                    For clients without an OAuth flow, create a key below and send it on every
                    request as either header:
                  </p>
                  <Snippet text={"Authorization: Bearer <key>\nx-api-key: <key>"} />
                </details>
              </article>

              <article>
                <header>
                  <strong>API keys</strong>
                </header>
                <Show when={freshKey()}>
                  <p>New key — copy it now, it won't be shown again:</p>
                  <Snippet text={freshKey()!} />
                </Show>
                <Show when={d.apiKeys.length > 0} fallback={<p class="muted">No API keys yet.</p>}>
                  <table>
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Key</th>
                        <th>Created</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      <For each={d.apiKeys}>
                        {(k) => (
                          <tr>
                            <td>{k.name}</td>
                            <td>
                              <code>{k.start ? `${k.start}…` : "•••"}</code>
                            </td>
                            <td class="muted">{new Date(k.createdAt).toLocaleDateString()}</td>
                            <td>
                              <button
                                class="danger"
                                onClick={() => deleteApiKey(k.id).then(() => refetch())}
                              >
                                Revoke
                              </button>
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </Show>
                <form onSubmit={createKey}>
                  <fieldset role="group">
                    <input
                      type="text"
                      placeholder="Key name, e.g. chatgpt"
                      aria-label="Key name"
                      value={newKeyName()}
                      onInput={(e) => setNewKeyName(e.currentTarget.value)}
                    />
                    <button type="submit">Create Key</button>
                  </fieldset>
                </form>
              </article>
            </>
          );
        }}
      </Show>
    </AdminShell>
  );
}
