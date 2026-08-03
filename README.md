# ob-sync

**Talk to your Obsidian vault from an AI assistant.**

ob-sync is a self-hosted MCP server for your Obsidian vault. It joins your vault
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
authored as `ob-sync`, so `git log --author=ob-sync` shows you exactly what it
did and any of it can be reverted.

> ob-sync is an independent, unofficial project. It is not affiliated with,
> endorsed by, or sponsored by Obsidian. "Obsidian" and "Obsidian Sync" are
> trademarks of their respective owners; they are used here only to describe
> what this software interoperates with.

## What your MCP clients can do

The tool surface mirrors the official Obsidian CLI's vault commands:

| Group | Tools |
| --- | --- |
| Files | `read_note`, `list_notes`, `list_folders`, `create_note`, `update_note`, `append_to_note`, `prepend_to_note`, `move_note`, `delete_note`* |
| Daily notes | `daily_note` (read / append / prepend / path, honors your vault's daily-note settings) |
| Search | `search_vault` (full-text over titles, headings, and bodies) |
| Properties | `read_properties`, `set_property`, `remove_property` |
| Tasks | `list_tasks` (all / todo / daily), `toggle_task` |
| Links & tags | `get_links` (backlinks / outgoing), `list_link_issues` (unresolved / orphans / deadends), `list_tags`, `notes_by_tag` |
| Vault | `get_vault_info`, `get_outline`, `word_count`, `random_note`, `unique_note` |

\* `delete_note` is disabled by default; enable it on the **Settings** tab.

Everything an MCP client writes lands in the synced vault folder and propagates
to your other devices — through Obsidian Sync (end-to-end encrypted, as always),
or as a commit pushed to your git remote.

## Deploy on Railway

> Deploying the published template rather than this repo? **[TEMPLATE.md, Part
> B](TEMPLATE.md#part-b--deploying-and-using-it)** is the end-to-end version
> with troubleshooting.


1. Create a new Railway service from this repo (or the template).
2. Attach a **volume** mounted at `/data` — this holds your vault copy,
   database, and sync state.
3. Set these variables on the service:
   - `ENCRYPTION_KEY` — 32 random bytes as base64 (`openssl rand -base64 32`)
     or hex (`openssl rand -hex 32`). Encrypts your stored Obsidian credentials
     at rest and derives the session secret, so it must be real random key
     material, not a passphrase. **Changing it later locks the stored
     credentials out.**
   - `DATA_DIR=/data`
4. Under **Settings → Networking**, generate a public domain, then redeploy.
   The OAuth issuer is derived from `RAILWAY_PUBLIC_DOMAIN` when the process
   starts, so a service that booted before it had a domain will advertise the
   wrong issuer until it restarts. (Setting `BASE_URL` explicitly also works.)
5. Open the service URL **within 30 minutes of the deploy** and follow the
   setup wizard:
   1. Choose your admin email/password — no token to look up.
   2. Choose how your vault syncs — **Obsidian Sync** or a **git repository**.
      This can't be changed later without starting over.
   3. Either sign in with your **Obsidian account** (MFA supported) and pick the
      remote vault — leaving the encryption password **blank** unless the vault
      is end-to-end encrypted, since Obsidian Sync defaults to managed
      encryption — or give the HTTPS clone URL, branch, and an access token
      scoped to that one repository.
6. The server starts a continuous sync daemon and drops you into the admin UI,
   which has four tabs:

   | Tab | What's there |
   | --- | --- |
   | **Setup** | The MCP endpoint URL, copy-paste setup for each client, and API keys |
   | **Status** | Sync health, vault stats, live log tail, connected OAuth clients |
   | **Settings** | The `delete_note` toggle, daily-note folder/format, and where logs are written |
   | **Security** | Live posture of this instance — see [Security model](#security-model) |

**Sizing the volume:** the vault copy includes synced attachments (images,
audio, PDFs, video), so size the volume for your vault plus headroom, not just
its markdown. You can narrow what syncs later with `ob sync-config --file-types`
inside the container. The sync client also keeps its own append-only log on the
volume, which grows without bound — the **Settings** tab shows its path and
current size.

## Git-backed vaults

Pick **Git repository** during setup and any HTTPS remote works — GitHub,
GitLab, Gitea, self-hosted. Give the clone URL, the branch, and a token scoped
to that one repo (on GitHub: a fine-grained PAT with *Contents: read and write*).

How it behaves:

- **Writes land on disk immediately**, then batch into one commit and push after
  a few seconds of quiet — configurable on the Settings tab, and forced at least
  every 30 seconds so a busy assistant can't defer it indefinitely.
- **Commits are attributable.** Each is authored `ob-sync <ob-sync@localhost>`
  with the tool names in the subject and the paths in the body, so
  `git log --author=ob-sync` is a complete record of assistant activity.
- **Conflicts never reach your notes.** Before merging anything the server runs
  `git merge-tree`, which performs the merge in git's object database and
  reports conflicts without touching the working tree. Concurrent edits to
  different notes — or to different parts of the same note — merge cleanly and
  keep both sides. A genuine overlap parks the assistant's commit on an
  `ob-sync/conflict-<timestamp>` branch, sets the vault to match the remote, and
  tells you on the Status tab. Nothing is discarded; `git merge <branch>`
  recovers it.
- **Attachments.** git handles large binaries poorly, so this suits
  markdown-heavy vaults. `git-lfs` is installed in the image, so LFS-backed
  repos work; if an LFS object is ever missing, reads fail loudly rather than
  serving you a pointer file dressed up as an image.

Requires git 2.38+ for `merge-tree` (the image ships 2.47). SSH remotes aren't
supported yet.

## Publish it as a Railway template

Full walkthrough — building the template, the deploy button, how kickbacks and
attribution work, and the support commitment — is in **[TEMPLATE.md](TEMPLATE.md)**.

The short version: a service from this repo, a volume at `/data`, and two
variables set with Railway's generator functions so every deployment gets its
own secrets.

| Variable | Value |
| --- | --- |
| `ENCRYPTION_KEY` | `${{secret(64, "abcdef0123456789")}}` |
| `DATA_DIR` | `/data` |

The `ENCRYPTION_KEY` generator produces 64 hex characters — exactly the 32 bytes
of key material the server requires. A plain `${{secret()}}` is rejected at boot:
it isn't valid base64 or hex.

Deployers bring their own vault — an Obsidian Sync subscription or a git repo —
and each deployment is a **single-user** instance — the first person to create an account claims it,
and sign-up closes permanently after that.

## Connect MCP clients

The MCP endpoint is `https://<your-app>/api/mcp` (Streamable HTTP). The
**Setup** tab shows all of this filled in with your own URL, with copy buttons —
what follows is the same thing for reference.

- **Claude (web, Desktop, Cowork)** — add it as a **custom connector**, not an
  `.mcpb` bundle. Bundles package *local* stdio servers; ob-sync is a remote
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
  claude mcp add --transport http ob-sync https://<your-app>/api/mcp
  ```

- **Codex** — add to `~/.codex/config.toml`, then `codex mcp login ob-sync`:

  ```toml
  [mcp_servers.ob-sync]
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
| Attachment read | 1 MB | `read_attachment` |
| File read (internal) | 10 MB | any text read; larger files are skipped by the indexer too |
| Request body | 4 MB | `/api/mcp` — the ceiling on a single `create_note`/`update_note` |

`read_note` returns `{totalLines, offset, count, hasMore}` alongside `content`,
so a long note is paged with `offset` rather than dumped in one response — a
465 KB note would otherwise be ~121k tokens in a single tool call.

Binary files are refused by the text read path (detected by content, not just
extension) and served by `read_attachment`, which returns images as viewable
image content and refuses anything over 1 MB with its size. Reading a JPEG as
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
