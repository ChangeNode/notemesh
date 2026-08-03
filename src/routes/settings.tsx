import { createResource, For, Show } from "solid-js";
import { getSettingsPage, setDeleteEnabled, setDailyConfig } from "~/server/admin";
import { AdminShell, Check } from "~/components/AdminShell";

export default function Settings() {
  const [data, { refetch }] = createResource(() => getSettingsPage());

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
                  onChange={(e) => setDeleteEnabled(e.currentTarget.checked).then(() => refetch())}
                />
                Allow MCP clients to delete notes (<code>delete_note</code> tool)
              </label>
              <small class="muted">
                Deletions sync to every device. Off by default; leave it off unless you need it.
              </small>
            </article>

            <article>
              <header>
                <strong>Daily notes</strong>
              </header>
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
                    <input
                      id="daily-folder"
                      name="daily-folder"
                      type="text"
                      placeholder="e.g. Daily"
                      value={d.dailyFolder}
                    />
                  </div>
                  <div>
                    <label for="daily-format">Daily note filename format</label>
                    <input id="daily-format" name="daily-format" type="text" value={d.dailyFormat} />
                  </div>
                </div>
                <small class="muted">
                  Used by the <code>daily_note</code> tool. The sync daemon doesn't sync your vault's{" "}
                  <code>.obsidian</code> settings, so set this to match your Daily Notes plugin
                  config (format uses{" "}
                  <a
                    href="https://momentjscom.readthedocs.io/en/latest/moment/04-displaying/01-format/"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    moment tokens
                  </a>{" "}
                  like YYYY-MM-DD).
                </small>
                <button type="submit">Save Daily Note Settings</button>
              </form>
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
