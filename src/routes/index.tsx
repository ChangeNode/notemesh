import { createResource, Show } from "solid-js";
import { getSetupPage } from "~/server/admin";
import { AdminShell, Snippet } from "~/components/AdminShell";

export default function Setup() {
  const [data] = createResource(() => getSetupPage());

  return (
    <AdminShell>
      <Show when={data()} keyed>
        {(d) => {
          const endpoint = `${d.baseUrl}/api/mcp`;
          // Anthropic dials custom connectors from its own infrastructure, so a
          // loopback or plain-HTTP address is reachable only by locally-run
          // clients. Say so here rather than letting the user find out from a
          // connector that silently fails to connect.
          const localOnly = d.baseUrl.startsWith("http://");

          return (
            <>
              <article>
                <header>
                  <strong>Set up your client</strong>
                </header>

                <Show when={d.originMismatch}>
                  <div class="callout warn">
                    <p>
                      <b>This server needs a restart.</b> It booted before it had a public domain,
                      so it is still configured as <code>{d.originMismatch!.configured}</code> even
                      though you reached it at <code>{d.originMismatch!.reachedAt}</code>. The
                      endpoint URL below and the OAuth issuer are both wrong until you restart it.
                    </p>
                    <p class="muted">
                      On Railway: your service → <b>Deployments</b> → <b>Restart</b>. Nothing is
                      lost; the domain is picked up on the next boot.
                    </p>
                  </div>
                </Show>

                <Show when={localOnly}>
                  <div class="callout warn">
                    <p>
                      <b>This server is on a local address.</b> Claude Desktop and claude.ai connect
                      from Anthropic's servers rather than from your machine, so they can't reach{" "}
                      <code>{d.baseUrl}</code>. Deploy to a public HTTPS URL to use them.
                    </p>
                    <p class="muted">
                      Claude Code and Codex run on your machine and work against this address today.
                    </p>
                  </div>
                </Show>

                {/* First entry, and the only one open by default: nearly every
                    client needs just this URL, and the per-client sections
                    below are for the ones that want the exact incantation. */}
                <details open>
                  <summary>TL;DR Connect An MCP Client</summary>
                  <p class="muted">
                    Point any MCP client at this endpoint (Streamable HTTP transport):
                  </p>
                  <Snippet text={endpoint} />
                  <p class="muted">
                    Clients authenticate one of two ways: the <b>OAuth</b> flow, which sends you
                    back here to approve access, or an <b>API key</b> from the <b>Keys</b> tab.
                    OAuth is the better option wherever the client supports it.
                  </p>
                </details>

                <details>
                  <summary>Claude Desktop, claude.ai, and Cowork</summary>
                  <p>
                    Add ob-sync as a <b>custom connector</b>. Go to <b>Settings → Connectors</b>,
                    click <b>Add custom connector</b>, and paste the endpoint URL. Configure it once
                    and it becomes available across your Claude apps. The OAuth flow will bring you
                    back here to approve access.
                  </p>
                  <Snippet text={endpoint} />
                  <p class="muted">
                    Not to be confused with the <b>“drag .MCPB or .DXT files here”</b> box in
                    Settings → Extensions. Those bundles package a <i>local</i> MCP server that runs
                    on your own machine over stdio; ob-sync is a remote HTTP server, which is what
                    custom connectors are for. (<code>.dxt</code> was renamed to <code>.mcpb</code>,
                    so you'll see both names around.) There is no bundle to install for ob-sync.
                  </p>
                </details>

                <details>
                  <summary>Claude Code</summary>
                  <p class="muted">Register the server, then run /mcp inside Claude Code to sign in.</p>
                  <Snippet text={`claude mcp add --transport http ob-sync ${endpoint}`} />
                </details>

                <details>
                  <summary>Codex</summary>
                  <p class="muted">
                    Add this to <code>~/.codex/config.toml</code>. The approval mode lets Codex call
                    vault tools without prompting for each one.
                  </p>
                  <Snippet
                    text={`[mcp_servers.ob-sync]\nurl = "${endpoint}"\ndefault_tools_approval_mode = "approve"`}
                  />
                </details>

                <details>
                  <summary>Any other client (API key)</summary>
                  <p class="muted">
                    For command-line tools and anything else with no browser to complete a sign-in,
                    create a key on the <b>Keys</b> tab and send it on every request as either
                    header:
                  </p>
                  <Snippet text={"Authorization: Bearer <key>\nx-api-key: <key>"} />
                </details>
              </article>

            </>
          );
        }}
      </Show>
    </AdminShell>
  );
}
