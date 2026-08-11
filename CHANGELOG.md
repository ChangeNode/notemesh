# Changelog

## How updates reach you

Railway template updates are **opt-in**. When a change lands on this repo's root
branch, Railway detects it and notifies everyone running the template; each
person chooses whether to apply it, and when. Nothing is pushed to a running
deployment.

That makes this file the entire basis for that decision, so entries are written
for it: what changes for you, and whether you have to do anything. Railway does
not read this file or require any particular format — it just recommends keeping
one — so the format here is [Keep a Changelog](https://keepachangelog.com), and
versions follow [semantic versioning](https://semver.org).

### Every release opens with what it costs you

Redeploying is almost always the whole job, so each entry starts with one line
saying so, and you can stop reading there:

> **Taking this update:** redeploy. Nothing else.

That is the default because of how the server is built, not by luck. Your
volume survives a deploy, so the vault and the database are untouched. The
search index is derived from the vault and rebuilt from scratch on every boot,
so changes to how notes are parsed or indexed apply on their own. Schema changes
are additive and run themselves. And no update will ever add a required
variable, because an update cannot set one for you.

When something does need you, the line says that instead, and the detail
follows:

> **Taking this update:** ⚠️ **Action required** — see below.

Two labels appear inside entries:

- **Action required** — you have to do something after redeploying. Applying an
  update never edits your Railway variables or your volume, so anything
  depending on either is called out rather than left as a bullet to spot.
- **Breaking** — a change to the MCP tool surface: tool names, arguments, or
  the shape of what they return. Not work for you, but your *clients* cache the
  tool list when they connect, so one may need reconnecting.

If a release is quiet, that is the information. The intent is that the rare
entry needing your attention cannot get lost among routine ones.

## Unreleased

**Taking this update:** redeploy. Nothing else.

### Changed

- Note text that reaches an assistant is now marked as content rather than
  instruction in more places. Headings (`get_outline`), task text
  (`list_tasks`), frontmatter values (`read_properties`) and search snippets are
  wrapped in a per-boot random marker, and every list result carries the
  sentence explaining what the marker means.

  Your vault is not only what you wrote in it — a clipped article, a shared
  folder or a pasted email can carry text aimed at the assistant reading it, and
  it arrives looking exactly like your own notes. This is worth being plain
  about: it helps a model tell data from orders, but a model that ignores the
  marker is the one it was meant to guard against. What actually bounds the
  damage is that no tool here can send anything anywhere — there is no email, no
  web request, no webhook for an injected instruction to call.

  Paths, titles, tags and property names are deliberately left unmarked so they
  can be passed straight back into the next call; the explanation names them
  instead.

- **Breaking** — `get_outline` now returns `{ headings: [...] }` and
  `read_properties` returns `{ properties: {...} }`, each alongside the marker
  and its explanation, where both previously returned the bare value. Clients
  cache the tool list, not the result shape, so nothing needs reconnecting.

### Fixed

- Clients that probe the MCP endpoint with `GET` before anything else can now
  discover that it needs authenticating. It previously answered a bare `405`
  with no challenge, so such a client concluded the server offered no
  authentication it understood and never showed a sign-in option — Codex reports
  this as `Auth: Unsupported`. The `POST` path was correct all along; nothing
  ever got far enough to ask it.

  If Codex or ChatGPT would not offer you an authorize button, this is likely
  why.

- OAuth discovery now advertises only the scopes this server actually gates on,
  `vault:read` and `vault:write`, and the unauthenticated challenge names them
  directly. It previously also advertised `openid` and `offline_access`, which
  the MCP specification says a protected resource should not do — a refresh
  token is the client's business, not the vault's.

  Visible if you connect with Codex, which prefers a server's advertised scopes
  over its own configuration: the approval prompt asked for two permissions that
  had nothing to do with your notes.

- The dashboard no longer reports a healthy sync over a daemon that cannot log
  in. Revoking or resetting your Obsidian credentials leaves the sync client
  running — it reconnects every 30 seconds and fails to authenticate each time,
  rather than exiting — and the re-authentication check only ran when the client
  exited. So the Status tab kept showing "Watching for changes" under a green
  light while nothing had synced since the credentials changed.

  It now notices while the client is still running, and the tab shows **Needs
  re-authentication** with the re-auth form, as it already did for every failure
  that ends the process.

  Worth knowing if you have ever changed your Obsidian password: an instance in
  this state has been quietly not syncing, and the dashboard said otherwise.

### Internal

Nothing here changes what your instance does. It is recorded because this file
is what you decide from, and "no reason to hurry" is worth being able to read
rather than infer from a diff.

- ESLint added, with the browser/server import boundary enforced in the editor
  rather than only at build time. Clearing its first run removed some dead code
  and moved a static list to `<For>`; no behaviour changed.
- A transitive dependency advisory (`nanoid`) cleared. It was build tooling and
  never present in the deployed image.

## 1.0.0 — 2026-08-06

**Taking this update:** nothing to take — this is the first release. Deploying
it is covered in the [README](README.md#deploy-on-railway).

A self-hosted MCP server that joins your Obsidian vault as another sync client
and exposes it to AI assistants. One deployment per person.

**Vault sync — pick one at setup**

- **Obsidian Sync**, through Obsidian's official headless client. Needs an
  Obsidian Sync subscription; the server stores your account password encrypted
  so it can re-authenticate.
- **Any git remote** over HTTPS. No subscription, and every change an assistant
  makes lands as its own commit authored `notemesh`, so `git log
  --author=notemesh` shows exactly what it did and any of it can be reverted.
  Configurable conflict strategy and push/pull timing.

**What assistants can do**

27 tools covering notes, attachments, daily notes, full-text search, frontmatter
properties, tasks, links and tags. `delete_note` is on by default and can be
turned off on the Settings tab — deletions stay recoverable either way, from
Obsidian Sync's version history or the previous git commit.

Attachments over 1 MB come back as a short-lived signed download URL rather than
being refused.

**Connecting**

OAuth 2.1 with PKCE and dynamic client registration, so Claude Desktop,
claude.ai, Claude Code, Codex and MCP Inspector can connect by URL alone. API
keys are available for clients that cannot complete a browser sign-in.

**Admin UI**

Setup wizard, live sync status and log tail, the full tool list read from the
running server, API keys, settings, and a Security tab reporting this
deployment's actual posture rather than a description of it.

**Security**

Credentials encrypted at rest with AES-256-GCM. Vault paths are refused if they
escape the vault, follow a symlink, or reach the `.obsidian` config directory.
Scopes are enforced — a connector approved read-only cannot write. Anonymous
request volume is bounded; the operator's own traffic is not. Note content
returned to an assistant is fenced in a per-boot marker, since a synced note can
carry instructions aimed at whatever reads it — see
[SECURITY.md](SECURITY.md#notes-are-untrusted-input) for what that is and is not
worth.

**Requirements**

A Railway volume mounted at `/data`, sized two to three times your vault, and an
`ENCRYPTION_KEY`. See the [README](README.md#deploy-on-railway).
