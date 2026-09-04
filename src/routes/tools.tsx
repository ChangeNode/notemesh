import { createResource, For, Show } from "solid-js";
import { AdminShell, Snippet } from "~/components/AdminShell";
import { api } from "~/lib/api";

/**
 * What this server can do, as its clients see it.
 *
 * The list comes from a real tools/list against a real MCP server instance, so
 * it is the tool surface rather than a description of it — nothing here is
 * written down twice.
 */
export default function Tools() {
  const [data] = createResource(() => api.getToolsPage());

  return (
    <AdminShell>
      <Show when={data()} keyed>
        {(d) => (
          <>
            <article>
              <header>
                <strong>MCP tools</strong>
              </header>
              <p class="muted">
                The {d.tools.length} tools an assistant connected to this server can call —{" "}
                {d.readCount} that only read the vault, and {d.writeCount} that change it. This is
                read from the server itself, so it is exactly what a client is offered, including
                anything a setting has turned on or off.
              </p>
              <Snippet text={d.endpoint} />

              <For each={[false, true]}>
                {(write) => (
                  <Show when={d.tools.some((t) => t.write === write)}>
                    <h4 class="tool-group">{write ? "Change the vault" : "Read the vault"}</h4>
                    <p class="muted">
                      {write
                        ? "Offered only to a credential carrying vault:write — an OAuth client you approved for it, or any API key. API keys always carry both scopes; there is no read-only key."
                        : "Offered to any credential carrying vault:read. A credential with neither scope is refused outright."}
                    </p>
                    <For each={d.tools.filter((t) => t.write === write)}>
                      {(t) => (
                        <div class="tool">
                          <code class="tool-name">{t.name}</code>
                          <Show when={t.annotations?.destructiveHint}>
                            <span class="muted tool-type"> · can discard content; a client may ask first</span>
                          </Show>
                          <p>{t.description}</p>
                          <Show when={t.params.length}>
                            <p class="muted tool-params">
                              <For each={t.params}>
                                {(p, i) => (
                                  <>
                                    {i() > 0 ? ", " : ""}
                                    <code>{p.name}</code>
                                    <span class="tool-type">
                                      {" "}
                                      {p.type}
                                      {p.required ? "" : "?"}
                                    </span>
                                    <Show when={p.description}>
                                      <span class="tool-type"> — {p.description}</span>
                                    </Show>
                                  </>
                                )}
                              </For>
                            </p>
                          </Show>
                        </div>
                      )}
                    </For>
                  </Show>
                )}
              </For>
            </article>
          </>
        )}
      </Show>
    </AdminShell>
  );
}
