import { createSignal, createResource, createEffect, onMount, onCleanup, Show, For } from "solid-js";
import {
  getStatusPage,
  getSyncActivity,
  revokeOAuthClient,
  syncNow,
  restartSync,
  rebuildIndex,
  reauth as reauthServer,
} from "~/server/admin";
import { AdminShell } from "~/components/AdminShell";

type LiveStatus = Awaited<ReturnType<typeof getSyncActivity>>;

const STATE_LABEL: Record<string, { cls: string; label: string }> = {
  running: { cls: "ok", label: "Syncing continuously" },
  stopped: { cls: "warn", label: "Stopped" },
  backoff: { cls: "warn", label: "Retrying after an error" },
  "needs-reauth": { cls: "err", label: "Needs re-authentication" },
};

export default function Status() {
  const [data, { refetch }] = createResource(() => getStatusPage());

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

  async function reauth() {
    setBusy(true);
    setReauthMsg(null);
    const res = await reauthServer({ mfa: mfa() || undefined });
    setBusy(false);
    setReauthMsg(res.ok ? "Re-authenticated. Sync restarting." : (res.message ?? "Failed."));
    if (res.ok) refetch();
  }

  return (
    <AdminShell>
      <Show when={data()} keyed>
        {(d) => (
          <>
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
                        {" "}
                        · last sync activity{" "}
                        {new Date(sync().lastActivityAt!).toLocaleTimeString()}
                      </Show>
                    </p>
                    <Show when={syncing()}>
                      <progress />
                      <small class="muted">
                        {[
                          activity()!.downloaded > 0 &&
                            `${activity()!.downloaded.toLocaleString()} downloaded`,
                          activity()!.uploaded > 0 &&
                            `${activity()!.uploaded.toLocaleString()} uploaded`,
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
                <button onClick={() => syncNow().then(() => refetch())}>Sync now</button>
                <button class="secondary" onClick={() => restartSync().then(() => refetch())}>
                  Restart daemon
                </button>
                <button class="secondary" onClick={() => rebuildIndex().then(() => refetch())}>
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
                <input
                  id="mfa"
                  type="text"
                  value={mfa()}
                  onInput={(e) => setMfa(e.currentTarget.value)}
                />
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
                              onClick={() => revokeOAuthClient(c.clientId).then(() => refetch())}
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
              <small class="muted">
                Revoking a client deletes its registration, its consent, and every token it holds —
                access stops immediately.
              </small>
            </article>
          </>
        )}
      </Show>
    </AdminShell>
  );
}
