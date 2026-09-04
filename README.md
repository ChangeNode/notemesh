# NoteMesh

**Talk to your Obsidian vault from an AI assistant.**

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/notemesh?referralCode=changenode&utm_medium=integration&utm_source=template&utm_campaign=generic)

NoteMesh is a self-hosted MCP server for your Obsidian vault. It joins your vault
as another sync client — either through [Obsidian
Sync](https://obsidian.md/sync) using Obsidian's official [headless sync
client](https://github.com/obsidianmd/obsidian-headless), or through **any git
remote** — so the server keeps a live, continuously-updating copy of your notes.
It then exposes that vault over
the [Model Context Protocol](https://modelcontextprotocol.io), so MCP clients
(Claude, Codex, ChatGPT, MCP Inspector, …) can search, read, and edit your notes.
Anything an assistant writes syncs back to your other devices the same way an
edit from your phone would.

Deploy it to [Railway](https://railway.com) and it's a private, single-user
server that only you can connect to.

**Requirements:** a place to run it, plus one way for the vault to reach the
server — either an Obsidian Sync subscription or a git repository holding your
vault. You pick which during setup.

With the git backend every change an assistant makes lands as its own commit,
authored as `notemesh`, so `git log --author=notemesh` shows you exactly what it
did and any of it can be reverted.

> NoteMesh is an independent, unofficial project. It is not affiliated with,
> endorsed by, or sponsored by Obsidian. "Obsidian" and "Obsidian Sync" are
> trademarks of their respective owners; they are used here only to describe
> what this software interoperates with.

## What your MCP clients can do

The tool surface mirrors the official Obsidian CLI's vault commands:

| Group | Tools |
| --- | --- |
| Files | `read_note`, `list_notes`, `list_folders`, `create_note`, `update_note`, `append_to_note`, `prepend_to_note`, `move_note`, `delete_note`* |
| Attachments | `list_attachments`, `read_attachment` (images, PDFs and other non-markdown files) |
| Daily notes | `daily_note` (read / append / prepend / path) — the folder and filename format come from your vault's own Daily Notes settings* |
| Search | `search_vault` (full-text over titles, headings, and bodies) |
| Properties | `read_properties`, `set_property`, `remove_property` |
| Tasks | `list_tasks` (all / todo / daily), `toggle_task` |
| Links & tags | `get_links` (backlinks / outgoing), `list_link_issues` (unresolved / orphans / deadends), `list_tags`, `notes_by_tag` |
| Vault | `get_vault_info`, `get_outline`, `word_count`, `random_note`, `unique_note` |

\* `delete_note` is enabled by default, and can be turned off on the **Settings**
tab. Deletions are recoverable: Obsidian Sync keeps version history, and a
git-backed vault keeps the file in the previous commit.

\* Obsidian Sync doesn't send the `.obsidian` config folder unless asked, so
linking a vault also runs `ob sync-config --configs core-plugin-data`, which
brings over `daily-notes.json` — the file `daily_note` reads for your folder and
filename format. Without it the tool would fall back to `YYYY-MM-DD` at the vault
root and quietly build a second set of dailies beside your real ones. Nothing to
configure here: change it in Obsidian and it follows on the next sync. A vault
linked before this existed, or a git repo without `.obsidian` committed, gets
the Obsidian defaults; the **Settings** tab says which of the two you have.

The **Tools** tab in the admin UI lists the same tools with their full
descriptions and parameters. That page asks the running server over the
protocol, so it is what your client is actually offered — this table is a
summary, and the tab is the answer.

Everything an MCP client writes lands in the synced vault folder and propagates
to your other devices — through Obsidian Sync (end-to-end encrypted, as always),
or as a commit pushed to your git remote.

## Deploy on Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/notemesh?referralCode=changenode&utm_medium=integration&utm_source=template&utm_campaign=generic)

The button is the whole path: the published template carries the volume, a
generated `ENCRYPTION_KEY`, the healthcheck and a public domain, so you land on
the setup wizard with nothing to configure.

**[TEMPLATE.md](TEMPLATE.md)** is the full guide — [Part
B](TEMPLATE.md#part-b--deploying-and-using-it) covers deploying and living with
it, including sizing the volume and troubleshooting; [Part
A](TEMPLATE.md#part-a--publishing-the-template) covers publishing a template of
your own.

## Git-backed vaults

Pick **Git repository** during setup and any HTTPS remote works — GitHub,
GitLab, Gitea, self-hosted. Give the clone URL, the branch, and a token scoped
to that one repo (on GitHub: a fine-grained PAT with *Contents: read and write*).

How it behaves:

- **Writes land on disk immediately**, then batch into one commit and push after
  a few seconds of quiet — configurable on the Settings tab, and forced at least
  every 30 seconds so a busy assistant can't defer it indefinitely.
- **Commits are attributable.** Each is authored `notemesh <notemesh@localhost>`
  with the tool names in the subject and the paths in the body, so
  `git log --author=notemesh` is a complete record of assistant activity.
- **Conflicts are checked for before anything is written.** The server runs
  `git merge-tree`, which performs the merge inside git's object database and
  reports conflicts without touching the working tree. Concurrent edits to
  different notes — or to different parts of the same note — merge cleanly and
  keep both sides, with no conflict handling involved at all.

  The only case git cannot settle is the same region of the same note changing
  on both sides at once. Then your devices' version keeps the real filename and
  the assistant's is saved beside it as `Note (Conflicted copy notemesh
  202608031958).md` — the same convention Obsidian Sync uses — committed and
  pushed so it reaches every device. You resolve it in Obsidian, and can ask
  your assistant to help. Conflict markers never enter the vault, nothing is
  discarded, and the server is never left waiting on you: a handled conflict is
  listed on the Status tab, not a state you have to clear.
- **Attachments.** git handles large binaries poorly, so this suits
  markdown-heavy vaults. `git-lfs` is installed in the image, so LFS-backed
  repos work; if an LFS object is ever missing, reads fail loudly rather than
  serving you a pointer file dressed up as an image.

Requires git 2.38+ for `merge-tree` (the image ships 2.47). SSH remotes aren't
supported yet.

## Tests

```bash
pnpm test
```

243 tests across nine files. Anything touching git runs against the real git
binary in throwaway repositories rather than mocks — the behaviour under test
*is* git's merge behaviour, so stubbing it would prove nothing.

| Area | Covers |
| --- | --- |
| Path resolution | Traversal, absolute paths, dot-directories, control and bidi characters, symlink escapes — each pinned to the specific guard that rejects it |
| Vault data | Read windowing and its byte ceiling, append/prepend block separation, frontmatter-aware prepend, overwrite and clobber refusals, attachment caps |
| Credential encryption | Round-trip, per-value IVs, tampered ciphertext/tag/IV rejection, key binding |
| Abuse throttle | Blocks probing at the threshold; never counts authorised traffic; ignores forwarding headers unless a proxy is known to be in front |
| Git sync | Version floor, remote probing, clone into empty/existing/foreign directories, auth-failure classification, binary-safe reads |
| Conflicts | Clean merges keeping both sides, the conflicted copy committed and pushed to the remote, the backend never entering a stuck state, byte-exact binary conflict copies, Obsidian naming |
| Obsidian sync | CLI argument-injection guards, secret redaction from captured output, MFA/auth detection, and ob's unreliable exit codes — driven through a stand-in binary on `OB_BIN` |

The security tests are mutation-checked: deleting a guard has to make specific
tests fail, or the test wasn't testing it.

## Connect MCP clients

The MCP endpoint is `https://<your-app>/api/mcp` (Streamable HTTP). The
**Setup** tab shows all of this filled in with your own URL, with copy buttons —
what follows is the same thing for reference.

- **Claude (web, Desktop, Cowork)** — add it as a **custom connector**, not an
  `.mcpb` bundle. Bundles package *local* stdio servers; NoteMesh is a remote
  Streamable HTTP server, which is what custom connectors are for. Configure it
  once at claude.ai → Customize → Connectors → *Add custom connector* → paste
  the endpoint URL, and it becomes available across your Claude surfaces. The
  OAuth flow redirects to your server; approve on the consent screen.

  **This requires a public HTTPS URL.** Anthropic's infrastructure makes the
  connection, not your machine, so `http://localhost:3000/api/mcp` will not work
  as a custom connector — deploy to Railway first and use that URL. (Claude Code
  and Codex run locally and *can* reach localhost, which is why they work
  against a dev server.)
- **Claude Code**:

  ```bash
  claude mcp add --transport http notemesh https://<your-app>/api/mcp
  ```

- **Codex** — add to `~/.codex/config.toml`, then `codex mcp login notemesh`:

  ```toml
  [mcp_servers.notemesh]
  url = "https://<your-app>/api/mcp"
  auth = "oauth"
  default_tools_approval_mode = "approve"
  ```

  `default_tools_approval_mode = "approve"` lets the tools run without
  approving each call. Worth setting: without it Codex prompts per call, and
  because its reported per-call timings are wall-clock, the seconds you spend
  approving are counted as tool latency — which reads as a slow server. A call
  left unapproved long enough also hits Codex's own timeout and can knock the
  whole tool schema out of its session.

- **Anything with a bearer token** — create an API key on the **Setup** tab and
  send it as `Authorization: Bearer <key>` (or `x-api-key: <key>`).

## How writes propagate (read this before testing)

The server keeps **its own replica** of your vault at `$DATA_DIR/vault`. MCP
write tools use synchronous filesystem writes, so a change is on the server's
disk before the tool returns — measured at ≤0.2 ms over 40 consecutive writes.

Reaching your *other* devices is a separate step: the `ob sync` daemon uploads
the change and each device downloads it. That round-trip is **seconds to
minutes** and batches multiple edits together.

This matters when verifying a write. If you check a different copy of the vault
— your desktop Obsidian vault, say — the change is legitimately absent until
sync delivers it, which looks exactly like a write that never flushed. Verify
against the path reported by `get_vault_info` (`vaultPath`), not another copy.

## Size limits

| Limit | Value | Applies to |
| --- | --- | --- |
| List results | 100 default, 500 max | `list_notes`, `list_folders`, `list_tags`, `notes_by_tag`, `list_tasks`, `list_link_issues` |
| Search results | 20 default, 100 max | `search_vault` |
| Note read window | 2,000 lines or 100 KB, whichever first | `read_note`, `daily_note` read, `random_note` |
| Attachment inlined | 1 MB | `read_attachment` — larger files come back as a 15-minute signed download URL |
| Note indexed | 1 MB | larger notes are listed (with `indexed: false`) and readable, but absent from search, tags, tasks and links |
| Note read or written | 10 MB | `read_note` pages through it; `create_note`, `update_note`, `append_to_note` and `prepend_to_note` refuse a result over the limit |
| Request body | 4 MB | `/api/mcp` — the ceiling on a single `create_note`/`update_note` |

`read_note` returns `{totalLines, offset, count, hasMore}` alongside `content`,
so a long note is paged with `offset` rather than dumped in one response — a
465 KB note would otherwise be ~121k tokens in a single tool call.

Binary files are refused by the text read path (detected by content, not just
extension) and served by `read_attachment`, which returns images as viewable
image content. Anything over 1 MB is not inlined; the result carries a
short-lived signed URL instead, which is a direct download for you rather than
something the model can see — MCP clients do not fetch links out of tool
results. Reading a JPEG as
text previously produced a 12 MB response of replacement characters.

## Security model

- Credentials stored depend on the backend. Obsidian Sync needs your **account
  password**, because the sync client re-authenticates with it. Git needs only a
  **scoped access token** for one repository, which you can revoke without
  touching anything else. Both are AES-256-GCM encrypted at rest.
- Single-user: exactly one admin account. Sign-up is open only while the
  instance is unclaimed **and** the process has been up for less than 30
  minutes; after that the server locks down and a restart is required to
  reopen the window. Once claimed, sign-up closes permanently.
- The server holds your Obsidian account credentials and the vault E2E
  password (AES-256-GCM encrypted with a key derived from `ENCRYPTION_KEY`) so
  the sync daemon can re-authenticate. Treat the Railway project as sensitive.
- The built-in OAuth 2.1 authorization server (Better Auth) supports PKCE and
  dynamic client registration; every client authorization requires your
  explicit approval while signed in as admin.
- MCP tool access is scoped (`vault:read` / `vault:write`); note deletion is an
  opt-in setting on top of that.
- Path traversal, symlinks, and the `.obsidian` config directory are blocked
  from all MCP file operations.
- Only *failed* authentication is throttled. A request carrying a valid API key
  or OAuth token is never rate-limited, so a busy agent is unaffected; the limit
  exists to damp anonymous probing.

The **Security** tab renders this as the live state of your instance rather than
prose: whether you're on HTTPS, whether client IPs are visible to the throttle,
how many keys/clients/tokens currently hold access, what's being blocked right
now, and which endpoints are exposed with what auth.

## Local development

```bash
pnpm install
cp .env.example .env   # fill in ENCRYPTION_KEY (openssl rand -base64 32)
pnpm dev
```

Visit `http://localhost:3000/setup`. Without an Obsidian account you can still
exercise the MCP endpoint: drop some `.md` files under `data/vault/`, mark the
instance configured (`sqlite3 data/app.sqlite "INSERT INTO settings (key,value)
VALUES ('vault_configured','true')"`), create an API key from the dashboard,
and point [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
at `http://localhost:3000/api/mcp`.

## Architecture

One Node process (SolidStart) plus one supervised child process:

- **SolidStart app** — admin dashboard, setup wizard, OAuth authorization
  server (Better Auth + oauth-provider plugin), and the MCP endpoint
  (`@modelcontextprotocol/sdk`, stateless Streamable HTTP).
- **`ob sync --continuous`** — the official Obsidian Headless client, spawned
  and supervised with backoff/re-auth detection. `HOME` is pointed at the
  volume so its session survives restarts.
- **SQLite** (`/data/app.sqlite`) — auth tables, OAuth clients/tokens, API
  keys, settings, and an FTS5 index over the vault (rebuilt by a chokidar
  watcher on every file change) powering search, links, tags, and tasks.

## Licence

Copyright &copy; 2026 [ChangeNode](https://changenode.com/) (Will Iverson). See [COPYRIGHT](COPYRIGHT).

NoteMesh is dual-licensed.

- **[AGPL-3.0](LICENSE)** for everyone. Free to use, modify, and self-host.
  Running your own instance triggers no obligation — it is single-user by
  design, so you are the only user of your service and you already have the
  source.
- **A commercial licence** if you want to offer NoteMesh to *other people* as a
  hosted service without publishing your source. See
  [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md).

Contributions require a CLA so that arrangement keeps working — see
[CONTRIBUTING.md](CONTRIBUTING.md).

Note that the Obsidian Sync backend spawns Obsidian's official headless client,
which npm publishes as `UNLICENSED` (proprietary, Dynalist Inc.). Nothing here
relicenses it: it is run as a separate process and installed from npm by
whoever deploys NoteMesh.
