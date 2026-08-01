# Obsidian Vault MCP Server

A self-hosted MCP server for your Obsidian vault, deployable to
[Railway](https://railway.com) in one click. It keeps a live copy of your vault
on the server using the official
[Obsidian Headless](https://github.com/obsidianmd/obsidian-headless) sync
client, and exposes it to MCP clients (Claude.ai, Claude Code, ChatGPT, MCP
Inspector, …) over Streamable HTTP with OAuth 2.1 or API keys.

**Requirements:** an [Obsidian Sync](https://obsidian.md/sync) subscription.

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

\* `delete_note` is disabled by default; enable it from the dashboard.

Everything an MCP client writes lands in the synced vault folder and propagates
to your other devices through Obsidian Sync (end-to-end encrypted, as always).

## Deploy on Railway

1. Create a new Railway service from this repo (or the template).
2. Attach a **volume** mounted at `/data` — this holds your vault copy,
   database, and sync state.
3. Set these variables on the service:
   - `SETUP_TOKEN` — any random string (Railway can generate one). Gates the
     first-boot setup wizard so a stranger can't claim your fresh instance.
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
5. Open the service URL and follow the setup wizard:
   1. Paste the `SETUP_TOKEN` and choose your admin email/password.
   2. Sign in with your **Obsidian account** (MFA supported).
   3. Pick the remote vault. Leave the encryption password **blank** unless the
      vault uses end-to-end encryption — Obsidian Sync's default is managed
      encryption, which has no password.
6. The server starts a continuous sync daemon and the dashboard shows its
   status, logs, connected clients, and API keys.

**Sizing the volume:** the vault copy includes synced attachments (images,
audio, PDFs, video), so size the volume for your vault plus headroom, not just
its markdown. You can narrow what syncs later with `ob sync-config --file-types`
inside the container.

## Publish it as a Railway template

To let other people deploy their own instance with one click:

1. Railway dashboard → workspace **Settings → Templates → New Template**.
2. **Add New** → source: this GitHub repo (append `/tree/<branch>` to pin a
   branch).
3. Right-click the service → **Attach Volume**, mount path `/data`.
4. In **Variables**, use Railway's generator functions so every deploy gets its
   own secrets — never ship fixed values:

   | Variable | Value |
   | --- | --- |
   | `SETUP_TOKEN` | `${{secret(32)}}` |
   | `ENCRYPTION_KEY` | `${{secret(64, "abcdef0123456789")}}` |
   | `DATA_DIR` | `/data` |

   The `ENCRYPTION_KEY` generator produces 64 hex characters — exactly the
   32 bytes of key material the server requires. (A plain `${{secret()}}` would
   be rejected: it isn't valid base64 or hex key material.)
5. Settings tab: healthcheck path `/api/health` (also read from `railway.json`).
6. **Create Template**, then publish it to get the shareable deploy URL and
   button markdown.

Deployers still need their own Obsidian Sync subscription, and each deployment
is a **single-user** instance — the first person to present the `SETUP_TOKEN`
claims it, and sign-up closes permanently after that.

## Connect MCP clients

The MCP endpoint is `https://<your-app>/api/mcp` (Streamable HTTP).

- **Claude.ai** — Settings → Connectors → *Add custom connector* → paste the
  endpoint URL. The OAuth flow redirects to your server; approve access on the
  consent screen.
- **Claude Code**:

  ```bash
  claude mcp add --transport http obsidian https://<your-app>/api/mcp
  ```

- **Anything with a bearer token** — create an API key on the dashboard and
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

## Security model

- Single-user: exactly one admin account, created once via the token-gated
  setup wizard; subsequent sign-ups are rejected.
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
