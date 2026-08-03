import { createResource, Show } from "solid-js";
import { getSecurityPage } from "~/server/admin";
import { AdminShell, Check } from "~/components/AdminShell";

export default function Security() {
  const [data] = createResource(() => getSecurityPage());

  return (
    <AdminShell>
      <Show when={data()} keyed>
        {(d) => (
          <>
            <article>
              <header>
                <strong>Exposure</strong>
              </header>

              <Check
                state={d.isHttps ? "ok" : d.isLocalAddress ? "warn" : "err"}
                label={d.isHttps ? "Served over HTTPS" : "Served over plain HTTP"}
                detail={
                  <>
                    <code>{d.baseUrl}</code>
                    {d.isHttps
                      ? " — tokens and API keys are encrypted in transit."
                      : d.isLocalAddress
                        ? " — fine for local development, since traffic never leaves your machine."
                        : " — bearer tokens travel in the clear. Put this behind TLS before exposing it."}
                  </>
                }
              />

              <Show when={d.originMismatch}>
                <Check
                  state="err"
                  label="Configured origin doesn't match how you reached it"
                  detail={
                    <>
                      Configured as <code>{d.originMismatch!.configured}</code> but reached at{" "}
                      <code>{d.originMismatch!.reachedAt}</code>. The server booted before it had a
                      public domain, so every OAuth URL it advertises is wrong. Restart it.
                    </>
                  }
                />
              </Show>

              <Check
                state={d.trustsProxyHeaders ? "ok" : "warn"}
                label={
                  d.trustsProxyHeaders
                    ? "Client IPs read from proxy headers"
                    : "Client IPs not available"
                }
                detail={
                  d.trustsProxyHeaders
                    ? "Running behind a known proxy, so the abuse throttle tracks each source address separately."
                    : "X-Forwarded-For is ignored here because nothing guarantees a proxy set it — an attacker could otherwise forge a fresh identity per request. Anonymous failures share one global bucket instead. Railway sets this automatically."
                }
              />

              <Check
                state={d.deleteEnabled ? "warn" : "ok"}
                label={
                  d.deleteEnabled ? "Clients can delete notes" : "Clients cannot delete notes"
                }
                detail={
                  d.deleteEnabled ? (
                    <>
                      The <code>delete_note</code> tool is enabled, and deletions propagate to every
                      synced device. Turn it off under Settings when you're not using it.
                    </>
                  ) : (
                    <>
                      The <code>delete_note</code> tool is disabled — the default.
                    </>
                  )
                }
              />
            </article>

            <article>
              <header>
                <strong>Who can reach your vault</strong>
              </header>
              <p class="muted">
                Every one of these grants full read/write access to the vault. Revoke anything you
                don't recognize — API keys on the Setup tab, OAuth clients on Status.
              </p>
              <table>
                <tbody>
                  <tr>
                    <td>API keys</td>
                    <td>{d.apiKeyCount}</td>
                  </tr>
                  <tr>
                    <td>Registered OAuth clients</td>
                    <td>
                      {d.oauthClientCount} of {d.maxOAuthClients} max
                    </td>
                  </tr>
                  <tr>
                    <td>Approved consents</td>
                    <td>{d.consentCount}</td>
                  </tr>
                  <tr>
                    <td>Live access tokens</td>
                    <td>{d.accessTokenCount}</td>
                  </tr>
                </tbody>
              </table>
              <small class="muted">
                Client registration is open by design — that's how MCP clients discover this server
                — so the count is capped and unused registrations are evicted after a day.
              </small>
            </article>

            <article>
              <header>
                <strong>Anonymous abuse throttle</strong>
              </header>
              <Check
                state={d.throttle.blockedSources > 0 ? "warn" : "ok"}
                label={
                  d.throttle.blockedSources > 0
                    ? `${d.throttle.blockedSources} source${d.throttle.blockedSources === 1 ? "" : "s"} currently blocked`
                    : "Nothing currently blocked"
                }
                detail={`${d.throttle.recentFailures} failed authentication attempt${d.throttle.recentFailures === 1 ? "" : "s"} from ${d.throttle.trackedSources} source${d.throttle.trackedSources === 1 ? "" : "s"} in the last ${d.throttle.windowMinutes} minutes.`}
              />
              <small class="muted">
                Only <i>failed</i> authentication counts toward the limit of {d.throttle.maxFailures}{" "}
                per {d.throttle.windowMinutes} minutes. Requests carrying a valid API key or OAuth
                token are never throttled, so a busy agent making hundreds of tool calls is
                unaffected — this exists purely to damp anonymous probing. Counters are in memory
                and reset when the server restarts.
              </small>
            </article>

            <article>
              <header>
                <strong>Network-exposed endpoints</strong>
              </header>
              <table>
                <thead>
                  <tr>
                    <th>Path</th>
                    <th>Requires</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <code>/api/mcp</code>
                    </td>
                    <td>OAuth access token or API key</td>
                  </tr>
                  <tr>
                    <td>
                      <code>/api/auth/*</code>
                    </td>
                    <td>Public (sign-in, OAuth, registration), per-route rate limits</td>
                  </tr>
                  <tr>
                    <td>
                      <code>/.well-known/*</code>
                    </td>
                    <td>Public — discovery metadata only</td>
                  </tr>
                  <tr>
                    <td>
                      <code>/api/health</code>
                    </td>
                    <td>Public — no vault data</td>
                  </tr>
                  <tr>
                    <td>
                      <code>/setup</code>
                    </td>
                    <td>
                      Open only while unclaimed and within {d.claimWindowMinutes} minutes of
                      server start
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <code>/oauth/consent</code>
                    </td>
                    <td>Admin session</td>
                  </tr>
                  <tr>
                    <td>These admin tabs</td>
                    <td>Admin session</td>
                  </tr>
                </tbody>
              </table>
              <small class="muted">
                Any other path under <code>/api/</code> returns a 404 rather than the app shell, so a
                misaddressed client fails loudly instead of parsing HTML as JSON.
              </small>
            </article>

            <article>
              <header>
                <strong>Always on</strong>
              </header>
              <ul>
                <li>
                  Every tool path is resolved and confined to the vault directory — absolute paths,{" "}
                  <code>..</code>, control and bidirectional characters, and{" "}
                  <code>.obsidian</code> internals are all rejected.
                </li>
                <li>
                  Symlinks are never followed, by the indexer or by any read, so a link planted in
                  the vault can't reach the rest of the filesystem.
                </li>
                <li>
                  Reads are capped — 10&nbsp;MB per file, 1&nbsp;MB per attachment, with line-range
                  windows for large notes — and binary content is refused rather than returned as
                  mangled text.
                </li>
                <li>
                  Your Obsidian credentials are encrypted at rest with{" "}
                  <code>ENCRYPTION_KEY</code>, passed to the sync CLI over stdin rather than the
                  command line, and scrubbed from captured output.
                </li>
                <li>
                  Admin actions and authentication failures are written to the server log.
                  Settings lists every place logs are written, including the one file the
                  sync client keeps on the data volume.
                </li>
              </ul>
            </article>
          </>
        )}
      </Show>
    </AdminShell>
  );
}
