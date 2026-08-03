import { createResource, Show } from "solid-js";
import { getSettingsPage, setDeleteEnabled, setDailyConfig } from "~/server/admin";
import { AdminShell } from "~/components/AdminShell";

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
                <button type="submit">Save daily note settings</button>
              </form>
            </article>
          </>
        )}
      </Show>
    </AdminShell>
  );
}
