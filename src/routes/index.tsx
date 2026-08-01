import { createSignal, createResource, createEffect, onMount, onCleanup, Show, For } from "solid-js";
import {
  getDashboard,
  getSyncActivity,
  setDailyConfig,
  createApiKey,
  deleteApiKey,
  revokeOAuthClient,
  setDeleteEnabled,
  syncNow,
  restartSync,
  rebuildIndex,
  reauth as reauthServer,
} from "~/server/admin";
import { authClient } from "~/lib/auth-client";

type LiveStatus = Awaited<ReturnType<typeof getSyncActivity>>;

const STATE_LABEL: Record<string, { cls: string; label: string }> = {
  running: { cls: "ok", label: "Syncing continuously" },
  stopped: { cls: "warn", label: "Stopped" },
  backoff: { cls: "warn", label: "Retrying after an error" },
  "needs-reauth": { cls: "err", label: "Needs re-authentication" },
};

export default function Dashboard() {
  const [data, { refetch }] = createResource(() => getDashboard());
  const doCreateKey = createApiKey;
  const doDeleteKey = deleteApiKey;
  const doRevokeClient = revokeOAuthClient;
  const doSetDelete = setDeleteEnabled;
  const doSyncNow = syncNow;
  const doRestart = restartSync;
  const doRebuild = rebuildIndex;
  const doReauth = reauthServer;

  const [newKeyName, setNewKeyName] = createSignal("");
  const [freshKey, setFreshKey] = createSignal<string | null>(null);
  const [showLogs, setShowLogs] = createSignal(false);
  const [reauthMsg, setReauthMsg] = createSignal<string | null>(null);
  const [mfa, setMfa] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  // Live status/log poll — cheap in-memory read on the server every 2s.
  const [live, setLive] = createSignal<LiveStatus | null>(null);
  let logsEl: HTMLPreElement | undefined;
  onMount(() => {
    let inFlight = false;
    const tick = async () => {
      if (inFlight || document.hidden) return;
      inFlight = true;
      try {
        setLive(await getSyncActivity());
      } catch {
        // transient — next tick retries
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const timer = setInterval(tick, 2_000);
    onCleanup(() => clearInterval(timer));
  });

  // Follow the log tail unless the user has scrolled up to read.
  createEffect(() => {
    live();
    if (!logsEl || !showLogs()) return;
    const nearBottom = logsEl.scrollHeight - logsEl.scrollTop - logsEl.clientHeight < 60;
    if (nearBottom) logsEl.scrollTop = logsEl.scrollHeight;
  });

  async function createKey(e: Event) {
    e.preventDefault();
    const res = await doCreateKey(newKeyName());
    setFreshKey(res.key);
    setNewKeyName("");
    refetch();
  }

  async function reauth() {
    setBusy(true);
    setReauthMsg(null);
    const res = await doReauth({ mfa: mfa() || undefined });
    setBusy(false);
    setReauthMsg(res.ok ? "Re-authenticated. Sync restarting." : res.message ?? "Failed.");
    if (res.ok) refetch();
  }

  return (
    <main class="container">
      <nav>
        <ul>
          <li>
            <strong>ob-sync</strong>
          </li>
        </ul>
        <ul>
          <li>
            <button
              class="secondary outline"
              onClick={async () => {
                await authClient.signOut();
                window.location.href = "/login";
              }}
            >
              Sign out
            </button>
          </li>
        </ul>
      </nav>

      <Show when={data()} keyed>
        {(d) => (
          <>
            {/* Sync status (live-updating via the 2s poll) */}
            <article>
              {(() => {
                const sync = () => live()?.sync ?? d.sync;
                const vault = () => live()?.vault ?? d.vault;
                const activity = () => (live()?.sync as any)?.activity;
                const syncing = () => sync().state === "running" && activity()?.active;
                return (
                  <>
                    <header>
                      <span class={`status-dot ${STATE_LABEL[sync().state]?.cls ?? "warn"}`} />
                      <strong>
                        {syncing()
                          ? "Syncing changes…"
                          : sync().state === "running"
                            ? "Watching for changes"
                            : (STATE_LABEL[sync().state]?.label ?? sync().state)}
                      </strong>
                    </header>
                    <p class="muted">
                      Vault <b>{vault().vaultName ?? "(unnamed)"}</b> · {vault().noteCount} notes ·{" "}
                      {vault().totalWords.toLocaleString()} words
                      <Show when={sync().lastActivityAt}>
                        {" "}· last sync activity{" "}
                        {new Date(sync().lastActivityAt!).toLocaleTimeString()}
                      </Show>
                    </p>
                    <Show when={syncing()}>
                      <progress />
                      <small class="muted">
                        {[
                          activity()!.downloaded > 0 && `${activity()!.downloaded.toLocaleString()} downloaded`,
                          activity()!.uploaded > 0 && `${activity()!.uploaded.toLocaleString()} uploaded`,
                          activity()!.deleted > 0 && `${activity()!.deleted.toLocaleString()} deleted`,
                        ]
                          .filter(Boolean)
                          .join(" · ") || "Transferring…"}
                      </small>
                    </Show>
                  </>
                );
              })()}
              <div role="group">
                <button onClick={() => doSyncNow().then(() => refetch())}>Sync now</button>
                <button class="secondary" onClick={() => doRestart().then(() => refetch())}>
                  Restart daemon
                </button>
                <button class="secondary" onClick={() => doRebuild().then(() => refetch())}>
                  Rebuild index
                </button>
                <button class="secondary" onClick={() => setShowLogs(!showLogs())}>
                  {showLogs() ? "Hide logs" : "Logs"}
                </button>
              </div>
              <Show when={d.sync.state === "needs-reauth"}>
                <p class="error">
                  The Obsidian session expired. Re-authenticate with your stored credentials:
                </p>
                <label for="mfa">Two-factor code (if your account uses one)</label>
                <input id="mfa" type="text" value={mfa()} onInput={(e) => setMfa(e.currentTarget.value)} />
                <button aria-busy={busy()} disabled={busy()} onClick={reauth}>
                  Re-authenticate
                </button>
                <Show when={reauthMsg()}>
                  <p class="muted">{reauthMsg()}</p>
                </Show>
              </Show>
              <Show when={showLogs()}>
                <pre class="logs" ref={logsEl}>
                  {(live()?.logs ?? d.logs)
                    .map((l) => `${new Date(l.ts).toLocaleTimeString()}  ${l.line}`)
                    .join("\n") || "(no log output yet)"}
                </pre>
              </Show>
            </article>

            {/* Connect */}
            <article>
              <header>
                <strong>Connect an MCP client</strong>
              </header>
              <p class="muted">MCP endpoint (Streamable HTTP):</p>
              <pre>{d.baseUrl}/api/mcp</pre>
              <p class="muted">
                <b>Claude / OAuth clients:</b> add the URL above as a custom connector — the OAuth
                sign-in flow will bring you back here to approve access.
                <br />
                <b>API-key clients:</b> create a key below and send it as{" "}
                <code>Authorization: Bearer &lt;key&gt;</code> or <code>x-api-key</code>.
              </p>
              <pre>{`claude mcp add --transport http obsidian ${d.baseUrl}/api/mcp`}</pre>
            </article>

            {/* API keys */}
            <article>
              <header>
                <strong>API keys</strong>
              </header>
              <Show when={freshKey()}>
                <p>New key (copy it now — it won't be shown again):</p>
                <pre>{freshKey()}</pre>
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
                            <button class="danger" onClick={() => doDeleteKey(k.id).then(() => refetch())}>
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
                  <button type="submit">Create key</button>
                </fieldset>
              </form>
            </article>

            {/* OAuth clients */}
            <article>
              <header>
                <strong>Connected OAuth clients</strong>
              </header>
              <Show
                when={d.oauthClients.length > 0}
                fallback={<p class="muted">No OAuth clients registered yet.</p>}
              >
                <table>
                  <thead>
                    <tr>
                      <th>Client</th>
                      <th>Registered</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    <For each={d.oauthClients}>
                      {(c) => (
                        <tr>
                          <td>{c.name}</td>
                          <td class="muted">
                            {c.createdAt ? new Date(c.createdAt).toLocaleDateString() : "—"}
                          </td>
                          <td>
                            <button
                              class="danger"
                              onClick={() => doRevokeClient(c.clientId).then(() => refetch())}
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
            </article>

            {/* Settings */}
            <article>
              <header>
                <strong>Settings</strong>
              </header>
              <label>
                <input
                  type="checkbox"
                  role="switch"
                  checked={d.deleteEnabled}
                  onChange={(e) => doSetDelete(e.currentTarget.checked).then(() => refetch())}
                />
                Allow MCP clients to delete notes (<code>delete_note</code> tool)
              </label>
              <small class="muted">
                Deletions sync to every device. Off by default; leave it off unless you need it.
              </small>
              <hr />
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  const form = e.currentTarget as HTMLFormElement;
                  const folder = (form.elements.namedItem("daily-folder") as HTMLInputElement).value;
                  const format = (form.elements.namedItem("daily-format") as HTMLInputElement).value;
                  await setDailyConfig(folder, format);
                  refetch();
                }}
              >
                <div class="grid">
                  <div>
                    <label for="daily-folder">Daily notes folder</label>
                    <input id="daily-folder" name="daily-folder" type="text" placeholder="e.g. Daily" value={d.dailyFolder} />
                  </div>
                  <div>
                    <label for="daily-format">Daily note filename format</label>
                    <input id="daily-format" name="daily-format" type="text" value={d.dailyFormat} />
                  </div>
                </div>
                <small class="muted">
                  Used by the <code>daily_note</code> tool. The sync daemon doesn't sync your
                  vault's <code>.obsidian</code> settings, so set this to match your Daily Notes
                  plugin config (format uses moment tokens like YYYY-MM-DD).
                </small>
                <button type="submit">Save daily note settings</button>
              </form>
            </article>
          </>
        )}
      </Show>
    </main>
  );
}
