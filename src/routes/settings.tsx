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
            <article>
              <header>
                <strong>Vault writes</strong>
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
                  <strong>Git sync</strong>
                </header>
                <p class="muted">
                  Syncing <code>{d.gitRemote}</code> on <code>{d.gitBranch}</code>.
                </p>
                <label for="git-conflict">Conflict resolution</label>
                <select
                  id="git-conflict"
                  value={d.gitConflictStrategy}
                  onChange={(e) => api.setGitConflictStrategy(e.currentTarget.value).then(() => refetch())}
                >
                  <option value="file">Generate conflict file (recommended)</option>
                  <option value="branch">Place conflicts on a branch</option>
                  <option value="inline">Inline git-style markers</option>
                </select>
                <small class="muted">
                  Only applies when git can't merge two versions itself — edits to different notes,
                  or to different parts of the same note, always merge cleanly and keep both sides.
                  <br />
                  <b>Conflict file</b> keeps your other devices' version at the original filename
                  and saves the assistant's alongside as{" "}
                  <code>Note (Conflicted copy notemesh …).md</code>, the way Obsidian Sync does — it
                  syncs to all your devices, so you'll see it.{" "}
                  <b>Branch</b> leaves the vault untouched and keeps the assistant's version in git
                  only, visible here and in a git client.{" "}
                  <b>Inline markers</b> puts both versions in the note separated by{" "}
                  <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code> — be aware the assistant reads your
                  notes and will treat those markers as content until you resolve them.
                </small>
                <hr />
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
                <strong>Daily notes</strong>
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
                <strong>Where logs go</strong>
              </header>
              <p class="muted">
                Three separate destinations, only one of which is a file on disk.
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
