# Contributing to ob-sync

Bug reports, questions, and pull requests are all welcome.

## Support questions

If you deployed the Railway template, ask through the **Template Queue** on
Railway rather than opening an issue here — that reaches the maintainer directly
and is the supported channel. GitHub issues are for defects and proposals.

## Before writing code

Open an issue first for anything substantial. This is a small project with
opinionated internals — particularly the sync backends and the conflict
handling — and it's better to agree on an approach than to review a large
change that took a different one.

## The Contributor Licence Agreement

ob-sync is dual-licensed: AGPL-3.0 for everyone, plus a commercial licence for
anyone who wants to host it as a service without the source-disclosure
obligation. See [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md).

That only works if one party can license the whole codebase under both sets of
terms. By default you keep copyright in your contribution, which would mean your
code could ship under the AGPL but **not** under a commercial licence — and a
project in that state can't honour either promise. So contributions need a CLA
granting the maintainer the right to license your work under both.

This is asked for up front rather than later because it cannot be fixed
retroactively: relicensing already-merged work means tracking down every past
contributor for permission, and one unreachable person is enough to poison it
permanently. Projects have died of this.

Practically: for a first pull request you'll be asked to confirm the CLA. If
that isn't something you want to do, that's a completely reasonable position —
open an issue describing the problem instead and it can be implemented
independently.

## Development

```bash
pnpm install
pnpm dev          # http://localhost:3000
pnpm test         # 243 tests
pnpm typecheck
```

Tests are expected with a change. The suite runs against real git binaries and
real filesystems rather than mocks, so new tests should generally do the same —
see `src/server/sync/conflict.test.ts` for the pattern.

Things worth knowing before touching the internals:

- **The vault is just a directory.** The indexer and the 25 MCP tools import
  nothing from the sync layer. Keep it that way — it's what made adding a second
  backend cheap.
- **Anything reaching a note is a security boundary.** Paths from an MCP client
  are untrusted input; see `src/server/vault/paths.ts` and its tests.
- **Never let git conflict markers into the vault.** The assistant reads these
  files and will treat `<<<<<<<` as content. `merge-tree` decides conflicts
  without touching the working tree, and that ordering is deliberate.
