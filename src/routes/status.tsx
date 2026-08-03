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

// Lines this app injects carry an explicit level. Everything else comes from
// the sync client, which has no severity channel, so the only signal available
// is the text itself. Deliberately loose — a missed highlight is worse than a
// spurious one, though it does mean a note whose filename contains "error"
// will light up as it syncs.
const ERROR_RE = /error|failed|failure/i;
const WARN_RE = /warn/i;

function lineClass(l: { line: string; level?: "error" | "warn" }): string {
  const level = l.level ?? (ERROR_RE.test(l.line) ? "error" : WARN_RE.test(l.line) ? "warn" : "");
  return level ? `log-${level}` : "";
}

const STATE_LABEL: Record<string, { cls: string; label: string }> = {
  running: { cls: "ok", label: "Syncing continuously" },
  stopped: { cls: "warn", label: "Stopped" },
  backoff: { cls: "warn", label: "Retrying after an error" },
  "needs-reauth": { cls: "err", label: "Needs re-authentication" },
  conflict: { cls: "err", label: "Conflicting edits parked" },
};

export default function Status() {
  const [data, { refetch }] = createResource(() => getStatusPage());

  const [reauthMsg, setReauthMsg] = createSignal<string | null>(null);
  const [mfa, setMfa] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  // Which daemon action is in flight, if any. All three act on the same sync
  // daemon, so running one disables the lot rather than just the button that
  // was clicked.
  type Action = "sync" | "restart" | "rebuild";
  const [running, setRunning] = createSignal<Action | null>(null);

  async function run(kind: Action, fn: () => Promise<unknown>) {
    if (running()) return;
    setRunning(kind);
    try {
      await fn();
      refetch();
    } finally {
      // finally, not after await: a rejected call must still re-enable the
      // buttons rather than leaving the page permanently stuck.
      setRunning(null);
    }
  }

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
    if (!logsEl) return;
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
              <div class="actions">
                <button
                  disabled={running() !== null}
                  aria-busy={running() === "sync"}
                  onClick={() => run("sync", syncNow)}
                >
                  {running() === "sync" ? "Syncing…" : "Sync Now"}
                </button>
                <button
                  class="secondary"
                  disabled={running() !== null}
                  aria-busy={running() === "restart"}
                  onClick={() => run("restart", restartSync)}
                >
                  {running() === "restart" ? "Restarting…" : "Restart Daemon"}
                </button>
                <button
                  class="secondary"
                  disabled={running() !== null}
                  aria-busy={running() === "rebuild"}
                  onClick={() => run("rebuild", rebuildIndex)}
                >
                  {running() === "rebuild" ? "Rebuilding…" : "Rebuild Index"}
                </button>
              </div>
              <Show when={(live()?.sync ?? d.sync).conflicts?.length}>
                <div class="callout warn">
                  <p>
                    <b>Conflicting edits.</b> Your other devices and this server changed the same
                    part of the same note. Nothing was lost — here's where each version went.
                  </p>
                  <For each={(live()?.sync ?? d.sync).conflicts ?? []}>
                    {(c) => (
                      <p class="muted logfile">
                        <code>{c.paths.join(", ")}</code>
                        <span>
                          {new Date(c.at).toLocaleString()} —{" "}
                          {c.strategy === "file"
                            ? `the assistant's version was saved as ${c.copies?.join(", ")}`
                            : c.strategy === "branch"
                              ? `kept on branch ${c.branch} — recover with git merge ${c.branch}`
                              : "both versions are in the note, separated by <<<<<<< markers"}
                        </span>
                      </p>
                    )}
                  </For>
                </div>
              </Show>
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
            </article>

            <article>
              <header>
                <strong>Sync log</strong>
              </header>
              <pre class="logs" ref={logsEl}>
                <Show
                  when={(live()?.logs ?? d.logs).length > 0}
                  fallback={<div class="muted">(no log output yet)</div>}
                >
                  <For each={live()?.logs ?? d.logs}>
                    {(l) => (
                      <div class={lineClass(l)}>
                        {`${new Date(l.ts).toLocaleTimeString()}  ${l.line}`}
                      </div>
                    )}
                  </For>
                </Show>
              </pre>
              <small class="muted">
                Live tail of the sync daemon, following new output unless you scroll up to read.
                Held in memory only — see Settings for everything written to disk.
              </small>
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
