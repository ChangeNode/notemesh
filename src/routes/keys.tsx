import { createSignal, createResource, Show, For } from "solid-js";
import { getKeysPage, createApiKey, deleteApiKey } from "~/server/admin";
import { AdminShell, Snippet } from "~/components/AdminShell";

export default function Keys() {
  const [data, { refetch }] = createResource(() => getKeysPage());
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
        {(d) => (
          <>
            <article>
              <header>
                <strong>API keys</strong>
              </header>
              <p class="muted">
                <b>Most MCP clients should use OAuth instead.</b> Claude Desktop, claude.ai, Claude
                Code and Codex all run the OAuth flow themselves — you approve access once in the
                browser, nothing sensitive is stored in a config file, and access can be revoked per
                client from the Status tab.
              </p>
              <p class="muted">
                API keys exist for the cases OAuth can't cover: command-line tools, scripts, and any
                client with no browser to complete a sign-in. A key is a bearer token — anyone
                holding it has the same access to your vault that you do, with no expiry.
              </p>
              <Show when={freshKey()}>
                <div class="callout">
                  <p>
                    <b>New key — copy it now.</b> This is the only time it is shown.
                  </p>
                  <Snippet text={freshKey()!} />
                </div>
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
                    placeholder="Key name, e.g. terminal"
                    aria-label="Key name"
                    value={newKeyName()}
                    onInput={(e) => setNewKeyName(e.currentTarget.value)}
                  />
                  <button type="submit">Create Key</button>
                </fieldset>
              </form>
            </article>

            <article>
              <header>
                <strong>Using a key</strong>
              </header>
              <p class="muted">Send it on every request as either header:</p>
              <Snippet text={"Authorization: Bearer <key>\nx-api-key: <key>"} />
              <p class="muted">…against this endpoint:</p>
              <Snippet text={`${d.baseUrl}/api/mcp`} />
            </article>
          </>
        )}
      </Show>
    </AdminShell>
  );
}
