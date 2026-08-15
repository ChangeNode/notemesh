import {createResource, Show} from "solid-js";
import {Accordion, AccordionPanel} from "~/components/Accordion";
import {AdminShell, Snippet} from "~/components/AdminShell";
import {api} from "~/lib/api";

export default function Setup() {
    const [data] = createResource(() => api.getSetupPage());

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
                                    <strong><a href="https://www.youtube.com/@changenode" target="_blank">Video Setup
                                        Guides</a>
                                    </strong>
                                </header>

                                <Show when={d.originMismatch}>
                                    <div class="callout warn">
                                        <p>
                                            <b>This server needs a restart.</b> It booted before it had a public domain,
                                            so it is still configured
                                            as <code>{d.originMismatch!.configured}</code> even
                                            though you reached it at <code>{d.originMismatch!.reachedAt}</code>. The
                                            endpoint URL below and the OAuth issuer are both wrong until you restart it.
                                        </p>
                                        <p>
                                            On Railway: your service → <b>Deployments</b> → <b>Restart</b>. Nothing is
                                            lost; the domain is picked up on the next boot.
                                        </p>
                                    </div>
                                </Show>

                                <Show when={localOnly}>
                                    <div class="callout warn">
                                        <p>
                                            <b>This server is on a local address.</b> Claude Desktop and claude.ai
                                            connect from Anthropic's servers rather than from your machine, so they
                                            can't reach{" "}
                                            <code>{d.baseUrl}</code>. Deploy to a public HTTPS URL to use them.
                                        </p>
                                        <p class="muted">
                                            Claude Code and Codex run on your machine and work against this address
                                            today.
                                        </p>
                                    </div>
                                </Show>

                                {/* Exclusive: opening one closes the others. These are alternative
                    answers to the same question, so two open at once is just a
                    longer page to scroll past the part you need.

                    None open at load, so the card arrives as a list of clients
                    to pick from rather than leading with one of them already
                    answered. */}
                                <Accordion>
                                    <AccordionPanel summary="Default Setup">
                                        <Snippet text={endpoint}/>
                                        <p>Clients authenticate one of two ways:</p>
                                        <ul>
                                            <li><b>OAuth</b>, which sends you back here to approve access (preferred),
                                                or
                                            </li>
                                            <li><b>API key</b> from the <b>Keys</b> tab.</li>
                                        </ul>
                                        <p class="muted">Make sure to select the Streamable HTTP(S) option</p>
                                    </AccordionPanel>

                                    <AccordionPanel summary="Anthropic: Claude Desktop and claude.ai">
                                        <p>
                                            Add NoteMesh as a <b>custom connector</b> using the <a
                                            href="https://claude.ai">Claude.ai</a> web app.
                                            Go to <b>Settings → Connectors</b>,
                                            click <b>Add custom connector</b>, and paste the endpoint URL. Configure it
                                            once and it becomes available across all your Claude apps. The OAuth flow
                                            will bring you back here to approve access.
                                        </p>
                                        <Snippet text={endpoint}/>
                                        <p class="muted">
                                            Not to be confused with the <b>“drag .MCPB or .DXT files here”</b> box in
                                            Settings → Extensions. Those bundles package a <i>local</i> MCP server that
                                            runs on your own machine over stdio; NoteMesh is a remote HTTP server, which
                                            is what custom connectors are for. (<code>.dxt</code> was renamed
                                            to <code>.mcpb</code>, so you'll see both names around.) There is no bundle
                                            to install for NoteMesh.
                                        </p>
                                    </AccordionPanel>

                                    <AccordionPanel summary="OpenAI: ChatGPT">
                                        <p>Go to <a href="https://chatgpt.com/plugins">ChatGPT plugins setup</a>.
                                            Click the + in the upper-right. Add the endpoint URL and hit Create. Then
                                            follow the OAuth flow to approve.
                                        </p>
                                        <Snippet text={endpoint}/>
                                    </AccordionPanel>

                                    <AccordionPanel summary="Anthropic: Claude Code">
                                        <p>Register the server, then run <code>/mcp</code> inside Claude Code to sign
                                            in.
                                        </p>
                                        <Snippet text={`claude mcp add --transport http notemesh ${endpoint}`}/>
                                    </AccordionPanel>

                                    <AccordionPanel summary="OpenAI: Codex">
                                        <p class="muted">
                                            Add this to <code>~/.codex/config.toml</code>. The approval mode lets Codex
                                            call vault tools without prompting for each one.
                                        </p>
                                        <Snippet
                                            text={`[mcp_servers.notemesh]\nurl = "${endpoint}"\ndefault_tools_approval_mode = "approve"`}
                                        />
                                    </AccordionPanel>

                                    <AccordionPanel summary="Other Client (API key)">
                                        <p>
                                            For command-line tools and anything else with no browser to complete a
                                            sign-in, create a key on the <b>Keys</b> tab and send it on every request as
                                            either header:
                                        </p>
                                        <Snippet text={"Authorization: Bearer <key>\nx-api-key: <key>"}/>
                                        <p class="muted">For example, <a
                                            href="https://raycast.com/raycast/model-context-protocol-registry"
                                            target="_blank">RayCast</a> requires API Key setup</p>
                                    </AccordionPanel>
                                </Accordion>
                            </article>
                        </>
                    );
                }}
            </Show>
        </AdminShell>
    )
}
