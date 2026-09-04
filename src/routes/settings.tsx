import { createResource, For, Show } from "solid-js";
import { AdminShell, Check } from "~/components/AdminShell";
import { api } from "~/lib/api";

export default function Settings() {
  const [data, { refetch }] = createResource(() => api.getSettingsPage());

  return (
    <AdminShell>
      <Show when={data()} keyed>
        {(d) => (
          <>
            {/* First, because it is the way out of this page: everything else
                here is a NoteMesh setting, and these two are the platform the
                server runs on. Only rendered on Railway, where both IDs are
                injected — anywhere else there is no panel at all rather than
                links that go somewhere wrong.

                New tabs: the dashboard is a live view of a running sync, and
                sending it away loses what the operator was looking at. */}
            <Show when={d.railway}>
              <article>
                <header>
                  <strong>Server Configuration</strong>
                </header>
                <p>
                  <a href={d.railway!.service} target="_blank" rel="noopener noreferrer">
                    Check for updates
                  </a>{" "}
                  and{" "}
                  <a href={d.railway!.project} target="_blank" rel="noopener noreferrer">
                    configure
                  </a>{" "}
                  on Railway
                </p>
              </article>
            </Show>
            <article>
              <header>
                <strong>Vault Writes</strong>
              </header>
              <label>
                <input
                  type="checkbox"
                  role="switch"
                  checked={d.deleteEnabled}
                  onChange={(e) => api.setDeleteEnabled(e.currentTarget.checked).then(() => refetch())}
                />
                Allow MCP clients to delete notes (<code>delete_note</code> tool)
              </label>
              <small class="muted">
                Deletions sync to every device. Deleted files can be recovered from history.
              </small>
            </article>

            <Show when={d.backend === "git"}>
              <article>
                <header>
                  <strong>Git Sync</strong>
                </header>
                <p class="muted">
                  Syncing <code>{d.gitRemote}</code> on <code>{d.gitBranch}</code>.
                </p>
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const form = e.currentTarget as HTMLFormElement;
                    const debounce = Number(
                      (form.elements.namedItem("git-debounce") as HTMLInputElement).value,
                    );
                    const pull = Number(
                      (form.elements.namedItem("git-pull") as HTMLInputElement).value,
                    );
                    await api.setGitTiming(debounce, pull);
                    refetch();
                  }}
                >
                  <div class="grid">
                    <div>
                      <label for="git-debounce">Push after idle (seconds)</label>
                      <input
                        id="git-debounce"
                        name="git-debounce"
                        type="number"
                        min="1"
                        max="300"
                        value={d.gitDebounceSeconds}
                      />
                    </div>
                    <div>
                      <label for="git-pull">Pull every (seconds)</label>
                      <input
                        id="git-pull"
                        name="git-pull"
                        type="number"
                        min="5"
                        max="3600"
                        value={d.gitPullSeconds}
                      />
                    </div>
                  </div>
                  <small class="muted">
                    Writes hit this server's disk immediately; these control when they reach the
                    remote and how fresh the assistant's view is. Edits are batched into one commit
                    per push, and a push happens at least every 30 seconds regardless of idle time
                    so a busy assistant can't defer it indefinitely.
                  </small>
                  <button type="submit">Save Git Settings</button>
                </form>
              </article>
            </Show>

            <article>
              <header>
                <strong>Daily Notes</strong>
              </header>
              <label for="tz">Timezone</label>
              <div class="actions">
                <input
                  id="tz"
                  type="text"
                  value={d.timezone}
                  onChange={(e) => api.setTimezone(e.currentTarget.value).then(() => refetch())}
                />
                <button
                  type="button"
                  class="secondary"
                  onClick={() => {
                    const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
                    const el = document.getElementById("tz") as HTMLInputElement;
                    if (el) el.value = browser;
                    api.setTimezone(browser).then(() => refetch());
                  }}
                >
                  Use This Device's
                </button>
              </div>
              <small class="muted">
                Which timezone <b>today</b> means. The server itself runs in UTC, so without this a
                daily note created in the evening in the Americas would land on tomorrow's date.
                Use an IANA name like <code>America/Los_Angeles</code> — the button fills in
                whatever this browser is set to.
              </small>
              <hr />
              {/* Reported, not editable. The daily note location is a property
                  of the vault, and the vault says what it is — a second place
                  to set it here could only ever disagree with Obsidian. */}
              <p>
                <b>Daily notes</b> go to{" "}
                <code>
                  {d.daily.folder ? `${d.daily.folder}/` : ""}
                  {d.daily.format}.md
                </code>
              </p>
              <small class="muted">
                <Show
                  when={d.daily.vaultConfigFound}
                  fallback={
                    <>
                      Read from your vault's Daily Notes plugin settings — except this vault hasn't
                      sent <code>.obsidian/daily-notes.json</code>, so the{" "}
                      <code>daily_note</code> tool is using Obsidian's defaults. Settings sync is
                      turned on when a vault is linked; a vault linked before that, or a git repo
                      without its <code>.obsidian</code> folder committed, won't have it. Re-linking
                      from the Setup tab turns it on.
                    </>
                  }
                >
                  Read from your vault's own Daily Notes plugin settings (
                  <code>.obsidian/daily-notes.json</code>), so this follows whatever Obsidian is set
                  to. Change it there and it changes here on the next sync.
                </Show>
              </small>
            </article>

            <article>
              <header>
                <strong>Logs</strong>
              </header>
              <p class="muted">
                Logs are sent to three destinations, only one of which is a file on disk.
              </p>

              <Check
                state="ok"
                label="This app → standard output"
                detail={
                  <>
                    Admin actions, authentication failures, and errors are written to stdout as
                    JSON. Nothing from the app itself is written to a log file. On Railway these
                    are the service's <b>Deploy Logs</b>; locally they're your terminal.
                  </>
                }
              />

              <Check
                state="ok"
                label="Sync daemon tail → memory only"
                detail={
                  <>
                    The last {d.logTailLines} lines shown on the Status tab are held in memory and
                    lost on restart. They are never persisted by this app.
                  </>
                }
              />

              <Show
                when={d.syncLogs.length > 0}
                fallback={
                  <Check
                    state="ok"
                    label="Sync client → no log file yet"
                    detail="The sync client writes its own log once a vault is linked and syncing."
                  />
                }
              >
                <Check
                  state="warn"
                  label="Sync client → file on the data volume"
                  detail={
                    <>
                      The Obsidian headless sync client keeps its own log, outside this app's
                      control. It grows without bound and counts against your volume, so check it
                      if space gets tight — deleting it is safe while the daemon is stopped.
                      <For each={d.syncLogs}>
                        {(l) => (
                          <div class="logfile">
                            <code>{l.path}</code>
                            <span>
                              {l.size}
                              {l.modified
                                ? ` · last written ${new Date(l.modified).toLocaleString()}`
                                : ""}
                            </span>
                          </div>
                        )}
                      </For>
                    </>
                  }
                />
              </Show>
            </article>
          </>
        )}
      </Show>
    </AdminShell>
  );
}
