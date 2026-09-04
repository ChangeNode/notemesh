import { createSignal, createResource, createEffect, onMount, onCleanup, Show, For } from "solid-js";
import { AdminShell } from "~/components/AdminShell";
import { api } from "~/lib/api";

type LiveStatus = Awaited<ReturnType<typeof api.getSyncActivity>>;

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

/**
 * Decimal byte sizes, matching how disks are sold and how Railway states its
 * plan ceilings. Duplicated from the server's formatBytes on purpose: that
 * lives in vault/paths.ts, and importing it here would drag the vault module
 * graph — better-sqlite3 included — into the browser bundle. That exact mistake
 * broke sign-in once already.
 */
function fmtBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1e6) return `${(n / 1000).toFixed(1)} KB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e9).toFixed(1)} GB`;
}

/** Bar colour from the server's level: green, amber under 100 MB free, red under 50 MB. */
function diskClass(level: "ok" | "warn" | "critical"): string {
  return level === "critical" ? "err" : level;
}

const STATE_LABEL: Record<string, { cls: string; label: string }> = {
  running: { cls: "ok", label: "Syncing continuously" },
  stopped: { cls: "warn", label: "Stopped" },
  backoff: { cls: "warn", label: "Retrying after an error" },
  "needs-reauth": { cls: "err", label: "Needs re-authentication" },
  "needs-setup": { cls: "err", label: "Vault not linked" },
};

export default function Status() {
  const [data, { refetch }] = createResource(() => api.getStatusPage());

  const [reauthMsg, setReauthMsg] = createSignal<string | null>(null);
  const [mfa, setMfa] = createSignal("");
  const [obEmail, setObEmail] = createSignal("");
  const [obPassword, setObPassword] = createSignal("");
  // Set when the server says it has no usable stored credentials, which opens
  // the fields needed to supply them.
  const [needCreds, setNeedCreds] = createSignal(false);
  const [relinking, setRelinking] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  // Which daemon action is in flight, if any. All three act on the same sync
  // daemon, so running one disables the lot rather than just the button that
  // was clicked.
  type Action = "sync" | "stop" | "restart" | "rebuild";
  const [running, setRunning] = createSignal<Action | null>(null);

  async function run(kind: Action, fn: () => Promise<unknown>) {
    if (running()) return;
    setRunning(kind);
    try {
      await fn();
      refetch();
      // The header reads from the live poll, which ticks every two seconds —
      // long enough after an action for the button to look like it did
      // nothing. Pull once immediately so the new state lands with the click.
      await refreshLive();
    } finally {
      // finally, not after await: a rejected call must still re-enable the
      // buttons rather than leaving the page permanently stuck.
      setRunning(null);
    }
  }

  // Live status/log poll — cheap in-memory read on the server every 2s.
  const [live, setLive] = createSignal<LiveStatus | null>(null);
  let logsEl: HTMLPreElement | undefined;

  /**
   * Is the sync service genuinely stopped?
   *
   * Only "stopped". backoff and the needs-* latches are still trying, so Stop
   * Sync stays available there — halting a retry loop is exactly what it is
   * for. Reads the live poll first so it follows an action immediately rather
   * than waiting for the page resource to refetch.
   */
  const stopped = () => (live()?.sync ?? data()?.sync)?.state === "stopped";

  async function refreshLive() {
    try {
      setLive(await api.getSyncActivity());
    } catch {
      // transient — the poll retries
    }
  }

  onMount(() => {
    let inFlight = false;
    const tick = async () => {
      if (inFlight || document.hidden) return;
      inFlight = true;
      try {
        await refreshLive();
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

  async function doReauth() {
    setBusy(true);
    setReauthMsg(null);
    const res = await api.reauth({
      email: obEmail() || undefined,
      password: obPassword() || undefined,
      mfa: mfa() || undefined,
    });
    setBusy(false);
    if ((res as { needCredentials?: boolean }).needCredentials) setNeedCreds(true);
    setReauthMsg(res.ok ? "Re-authenticated. Sync restarting." : (res.message ?? "Failed."));
    if (res.ok) {
      setObPassword("");
      setMfa("");
      setNeedCreds(false);
      refetch();
    }
  }

  return (
    <AdminShell>
      {/* Deliberately NOT keyed. A keyed Show compares by value, and refetch
          always resolves a fresh object — so every action tore down this whole
          subtree and rebuilt it, which read as the page reloading and threw
          away the log scroll position. Unkeyed, `d` is an accessor and the DOM
          is updated in place. */}
      <Show when={data()}>
        {(d) => (
          <>
            <article>
              {(() => {
                const sync = () => live()?.sync ?? d().sync;
                const vault = () => live()?.vault ?? d().vault;
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
                    {/* Disk. The volume is the hard ceiling on a deployment,
                        and a full one does not fail gracefully — writes return
                        ENOSPC and the service wedges. Growing it early is free;
                        growing one already at 100% forces an offline resize. So
                        the useful thing to show is how close it is while the
                        fix is still cheap. */}
                    <Show when={d().disk}>
                      <div class="disk">
                        <Show when={d().disk.filesystem}>
                          <div class="disk-bar">
                            <div
                              class={`disk-fill ${diskClass(d().disk.filesystem!.level)}`}
                              style={{ width: `${Math.min(d().disk.filesystem!.percentUsed, 100)}%` }}
                            />
                          </div>
                          <p class="muted">
                            <b>{fmtBytes(d().disk.filesystem!.usedBytes)}</b> used of{" "}
                            {fmtBytes(d().disk.filesystem!.totalBytes)} (
                            {d().disk.filesystem!.percentUsed}%) ·{" "}
                            <b>{fmtBytes(d().disk.filesystem!.availableBytes)}</b> free
                          </p>
                        </Show>
                        <p class="muted">
                          This vault accounts for {fmtBytes(d().disk.vaultBytes)} across{" "}
                          {d().disk.noteCount.toLocaleString()} notes and{" "}
                          {d().disk.attachmentCount.toLocaleString()} attachments, plus{" "}
                          {fmtBytes(d().disk.databaseBytes)} of index.
                        </p>
                        <Show when={d().disk.filesystem?.sharedWithRoot}>
                          <small class="muted">
                            The data directory is on this machine's main filesystem rather than its
                            own volume, so the figures above cover the whole disk — not just the
                            vault. On a deployment with a mounted volume they describe the volume.
                          </small>
                        </Show>
                        <Show when={d().disk.filesystem && d().disk.filesystem!.level !== "ok" && !d().disk.filesystem?.sharedWithRoot}>
                          <small class="muted">
                            {d().disk.filesystem!.level === "critical"
                              ? "Under 50 MB free: writes that would not leave room for the index are being refused. "
                              : "Under 100 MB free. "}
                            Worth growing the volume now. Railway resizes live with no downtime
                            until it is full; at 100% the resize goes offline and restarts the
                            service.
                          </small>
                        </Show>
                        <Show when={!d().disk.filesystem}>
                          <small class="muted">
                            This platform did not report filesystem usage, so only what the vault
                            itself accounts for is shown.
                          </small>
                        </Show>
                      </div>
                    </Show>
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
                {/* Hidden while the Obsidian daemon is up. `ob sync` locks the
                    vault, so a one-shot started underneath the continuous run
                    cannot succeed — it fails with "Another sync instance is
                    already running for this vault" — and there is nothing for
                    it to do anyway, since the daemon is already syncing.

                    Only that backend. A git vault's normal running state is a
                    pair of timers with no lock, and forcing an immediate
                    push/pull rather than waiting for the next tick is exactly
                    what the button is for; its cycle already returns early if
                    one is in flight. */}
                <Show
                  when={
                    (live()?.sync ?? d().sync).kind !== "obsidian" ||
                    (live()?.sync ?? d().sync).state !== "running"
                  }
                >
                  {/* Secondary once the service is stopped: starting it again
                      is the thing to do there, and a one-off sync is the
                      lesser action. */}
                  <button
                    class={stopped() ? "secondary" : ""}
                    disabled={running() !== null}
                    aria-busy={running() === "sync"}
                    onClick={() => run("sync", api.syncNow)}
                  >
                    {running() === "sync" ? "Syncing…" : stopped() ? "Manual Sync" : "Sync Now"}
                  </button>
                </Show>
                {/* Nothing to stop when it is already stopped. */}
                <Show when={!stopped()}>
                  <button
                    class="secondary"
                    disabled={running() !== null}
                    aria-busy={running() === "stop"}
                    onClick={() => run("stop", api.stopSync)}
                  >
                    {running() === "stop" ? "Stopping…" : "Stop Sync"}
                  </button>
                </Show>
                {/* Same action either way — the label and the emphasis follow
                    the state, because "Restart" reads as a thing you do to
                    something already running. */}
                <button
                  class={stopped() ? "" : "secondary"}
                  disabled={running() !== null}
                  aria-busy={running() === "restart"}
                  onClick={() => run("restart", api.restartSync)}
                >
                  {running() === "restart"
                    ? stopped()
                      ? "Starting…"
                      : "Restarting…"
                    : stopped()
                      ? "Start Sync Service"
                      : "Restart Sync"}
                </button>
                <button
                  class="secondary"
                  disabled={running() !== null}
                  aria-busy={running() === "rebuild"}
                  onClick={() => run("rebuild", api.rebuildIndex)}
                >
                  {running() === "rebuild" ? "Rebuilding…" : "Rebuild Index"}
                </button>
              </div>
              <Show when={(live()?.sync ?? d().sync).conflicts?.length}>
                <div class="callout warn">
                  <p>
                    <b>Conflicting edits.</b> Your other devices and this server changed the same
                    part of the same note. Nothing was lost — here's where each version went.
                  </p>
                  <For each={(live()?.sync ?? d().sync).conflicts ?? []}>
                    {(c) => (
                      <p class="muted logfile">
                        <code>{c.paths.join(", ")}</code>
                        <span>
                          {new Date(c.at).toLocaleString()} —{" "}
                          the assistant's version was saved as {c.copies?.join(", ")}
                        </span>
                      </p>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={(live()?.sync ?? d().sync).state === "needs-setup"}>
                <div class="callout warn">
                  <p>
                    <b>This vault is not linked to Obsidian Sync.</b> The sync client has no
                    configuration for it, so it exits immediately every time it starts — retrying
                    cannot fix that, and the daemon has stopped rather than loop.
                  </p>
                  <p class="muted">
                    Sign in and pick the vault again from the setup wizard. Nothing is lost: the
                    files already here stay where they are, and linking re-attaches them.
                  </p>
                  <button
                    aria-busy={relinking()}
                    disabled={relinking()}
                    onClick={async () => {
                      // Clear the stale "configured" flag before navigating,
                      // or the wizard computes its stage from that flag and
                      // greets you with "Setup complete" on a vault it has
                      // just been told is not linked.
                      setRelinking(true);
                      await api.relinkVault().catch(() => undefined);
                      window.location.href = "/setup";
                    }}
                  >
                    {relinking() ? "Opening setup…" : "Link the vault again"}
                  </button>
                </div>
              </Show>
              <Show when={d().sync.state === "needs-reauth"}>
                <p class="error">
                  The Obsidian session expired. Re-authenticate to restart sync.
                </p>
                <label for="mfa">Two-factor code (if your account uses one)</label>
                <input
                  id="mfa"
                  type="text"
                  autocomplete="one-time-code"
                  value={mfa()}
                  onInput={(e) => setMfa(e.currentTarget.value)}
                />

                {/* Usually the stored credentials plus a fresh code are all
                    that is needed, so these stay folded away. They open on
                    their own when the server reports it cannot use what it has
                    — previously that answer said "enter them again" with
                    nowhere to enter anything. */}
                <details open={needCreds()}>
                  <summary>Use different credentials</summary>
                  <p class="muted">
                    Leave these blank to reuse the credentials already stored. Fill them in if your
                    Obsidian password changed, or if this server can no longer read what it saved.
                  </p>
                  <label for="ob-email">Obsidian email</label>
                  <input
                    id="ob-email"
                    type="email"
                    autocomplete="username"
                    value={obEmail()}
                    onInput={(e) => setObEmail(e.currentTarget.value)}
                  />
                  <label for="ob-password">Obsidian password</label>
                  <input
                    id="ob-password"
                    type="password"
                    autocomplete="current-password"
                    value={obPassword()}
                    onInput={(e) => setObPassword(e.currentTarget.value)}
                  />
                </details>

                <button aria-busy={busy()} disabled={busy()} onClick={doReauth}>
                  {busy() ? "Re-authenticating…" : "Re-authenticate"}
                </button>
                <Show when={reauthMsg()}>
                  <p class={needCreds() ? "error" : "muted"}>{reauthMsg()}</p>
                </Show>
              </Show>
            </article>

            <article>
              <header>
                <strong>Sync log</strong>
              </header>
              <pre class="logs" ref={logsEl}>
                <Show
                  when={(live()?.logs ?? d().logs).length > 0}
                  fallback={<div class="muted">(no log output yet)</div>}
                >
                  <For each={live()?.logs ?? d().logs}>
                    {(l) => (
                      <div class={lineClass(l)}>
                        {`${new Date(l.ts).toLocaleTimeString()}  ${l.line}`}
                        <Show when={(l.repeat ?? 1) > 1}>
                          <span class="repeat">{` ×${l.repeat}`}</span>
                        </Show>
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
                when={d().oauthClients.length > 0}
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
                    <For each={d().oauthClients}>
                      {(c) => (
                        <tr>
                          <td>{c.name}</td>
                          <td class="muted">
                            {c.createdAt ? new Date(c.createdAt).toLocaleDateString() : "—"}
                          </td>
                          <td>
                            <button
                              class="danger"
                              onClick={() => api.revokeOAuthClient(c.clientId).then(() => refetch())}
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
