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

Two conventions worth knowing:

- **Action required** marks anything that needs you to do something after taking
  the update. Applying an update never edits your Railway variables or your
  volume, so a change that depends on either is called out rather than left as a
  bullet to spot.
- **Breaking** marks a change to the MCP tool surface — tool names, arguments,
  or the shape of what they return. Clients cache the tool list when they
  connect, so a client may need reconnecting.

## Unreleased

Nothing yet.

## 1.0.0 — 2026-08-06

First release.

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
