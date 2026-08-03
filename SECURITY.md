# Security

ob-sync holds credentials and has full read/write access to a personal notes
vault, so security reports are taken seriously.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it through <https://changenode.com/contact/>, or use GitHub's private
[security advisory](https://github.com/ChangeNode/ob-sync/security/advisories/new)
form. Include what you found, how to reproduce it, and what an attacker could
achieve.

You'll get an acknowledgement, and a fix or an explanation of why it isn't one.

## What an instance is protecting

Each deployment is a single-user server holding:

- **Obsidian account credentials** (Obsidian Sync backend) or a **git access
  token** (git backend), AES-256-GCM encrypted with `ENCRYPTION_KEY`
- **A full copy of the vault**, including attachments
- **OAuth tokens and API keys** granting MCP clients read/write access to it

## Especially interesting areas

If you're looking, these are where a bug would hurt most:

- **`src/server/vault/paths.ts`** — the boundary between an LLM-supplied string
  and the filesystem. Traversal, symlink escapes, dot-directory access.
- **`src/routes/api/mcp.ts` and `src/server/mcp/auth.ts`** — token and API-key
  validation on the one network-exposed endpoint that reaches the vault.
- **`src/server/sync/conflict.ts`** — anything that lets git conflict markers
  reach the vault, since the model reads those files as content.
- **`src/server/crypto.ts` and credential storage** — the encryption protecting
  stored account credentials.
- **The claim window** (`src/server/claim.ts`) — a fresh instance accepts an
  admin account for 30 minutes after start, with no token. That is a deliberate
  trade, documented in the file; a way to *extend* or *reopen* that window
  without restarting the server would not be.

## Known and accepted

Stated so you don't spend time on them:

- **The claim window is deliberately unauthenticated.** During those 30 minutes
  the only protection on an unclaimed instance is being first to it. See
  `src/server/claim.ts` for the reasoning.
- **`@better-auth/oauth-provider` carries an open advisory**
  ([GHSA-p2fr-6hmx-4528](https://github.com/advisories/GHSA-p2fr-6hmx-4528),
  unbound resource indicators). No stable release fixes it yet. Impact here is
  limited by the deployment shape — one user, one resource — and it will be
  picked up when 1.7.0 ships stable.
- **The container runs as root.** Hardening this is tracked; it is a
  defence-in-depth gap rather than a live vulnerability.

## Reporting a problem with someone else's instance

Every deployment is independently operated. If you've found an issue with a
specific running server, contact whoever runs it — there is no central service.
