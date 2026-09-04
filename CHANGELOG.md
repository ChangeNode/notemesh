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

## Unreleased (1.1.0)

**Taking this update:** redeploy. Nothing else.

### Changed

- **Breaking** — `search_vault` can now be paged, and returns the same envelope
  as every list tool: `{ total, offset, count, hasMore, items }`, with a new
  `offset` argument. It used to return a bare `results` array capped at
  `limit` — default 20, at most 100 — with nothing to say the cut had happened,
  so a query matching 140 notes quietly answered with 100. The key `results`
  is now `items`. Limits are unchanged; clients cache the tool list, not
  result shapes, so nothing needs reconnecting.

- **Breaking** — `update_note` refuses to replace a note longer than one
  `read_note` window (2,000 lines or 100 KB) unless the call carries
  `expectedLines`, the `totalLines` that `read_note` reported; and when it is
  given, on any note, the write is refused if the count no longer matches.
  Nothing connected the read window to the write before: an assistant that
  read the first page of a long note, edited what it saw and replaced the note
  silently discarded the rest — and on the git backend pushed the loss to every
  device before anyone could notice. A short note cannot have been half-read,
  so its replace is unchanged. For changing part of a note, `edit_note` is now
  the right tool, and `update_note` says so.

- **Breaking** — the git backend's **Conflict resolution** setting is gone, and
  with it two of its three options. What remains is the one that was already
  the default: when your devices and the assistant change the same part of the
  same note at once, your version keeps the filename and the assistant's is
  saved beside it as a `(Conflicted copy notemesh …)` file, committed and pushed
  to every device, for you to resolve in Obsidian.

  The two removed options did not work the way they read. *Place conflicts on a
  branch* said the assistant's version would be "visible in a git client" — but
  the branch was never pushed, so it existed only inside the container, and
  recovering it meant a shell into the server. *Inline markers* wrote `<<<<<<<`
  into the note, which the assistant then read as content. Neither could be
  acted on from Obsidian, which is where you are.

  Also gone: the **Conflicting edits parked** state. The server used to stay in
  it until you restarted sync, even though a written copy leaves it with
  nothing to wait for — and it had no way to notice you had merged the copy in
  Obsidian, so it would have nagged forever. Handled conflicts are now listed
  on the Status tab as information, and the state is simply *running*.

  If you had picked one of the removed options, the stored setting is ignored;
  there is nothing to do.

- **Breaking** — `word_count` now means the same thing with and without a
  path. It used to count the whole file, frontmatter included, when given a
  note, and sum body-only words from the index when asked for the vault — so
  a note's own count never added up to the total. Both now count words in the
  body, and both report size in bytes on disk; the `characters` field is
  renamed `bytes` to say so, since it was already bytes on one of the two
  paths and characters on the other.

- **Breaking** — a note over **1 MB** is no longer indexed. It stays listed
  by `list_notes` (with `indexed: false`) and readable through `read_note`'s
  paging, and `get_vault_info` now reports how many such notes there are — but
  it is absent from search, tags, tasks and links. A megabyte of markdown is
  far past the point where tokenising it earns its keep, and a note that size
  was dominating every search it matched. The 10 MB ceiling on *reading* a
  note is unchanged, and is now also the ceiling on writing one: `create_note`,
  `update_note`, `append_to_note` and `prepend_to_note` refuse a result over it
  with a message naming the limit, so a note this server writes is always one
  it can read back.

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

### Added

- **The server can now tell the assistant that something is wrong.** The
  failures that matter most were silent — the volume filling, the sync daemon
  stopped on rejected credentials, the index failing to rebuild — and the
  operator found out by opening the dashboard, which is exactly what they do
  not do for weeks, while the assistant talks to the server every day. Every
  tool result now carries the server's alerts as extra text blocks after the
  payload, each beginning `NoteMesh:`. An alert is a state, not an event: it
  is present on every call while the condition holds and absent the moment it
  does not, with fixed wording and coarse numbers so a model that has already
  mentioned it sees nothing new. It sits outside the boundary fence, which is
  what makes it trustworthy — note text is always inside the markers, so an
  unfenced `NoteMesh:` block is the server by construction, and the boundary
  explanation now says so. The conditions: credentials rejected or no longer
  decryptable, sync in backoff (an error after fifteen minutes), no vault
  linked, the volume under 100 MB or 50 MB free, the index rebuilding, failed
  to rebuild, or holding notes too large to index, and the server reached at a
  different origin or over HTTPS while configured as http. At most three
  blocks; the last says how many more are on the Status tab. A git conflict
  the server resolved by writing a conflicted copy is delivered the same way,
  once per connector, naming the copy.

- **Disk headroom.** The server now watches its data volume rather than only
  drawing it. It warns in the log under 100 MB free and calls it critical under
  50 MB — once, when the line is crossed, not every minute — and a write that
  would leave less than the reserve (50 MB, or the index database's own size if
  larger, since SQLite needs room to rewrite itself) is refused with a message
  naming the volume and the fix. A write that fills the disk anyway, the
  index's included, comes back as that same message instead of the generic
  failure. `get_vault_info` reports `disk.availableBytes` and `disk.level`, and
  the Status tab colours its bar from the server's level instead of its own
  percentage rule. The thresholds are absolute on purpose: this is a markdown
  vault, and a percentage reads wrong on both a 0.5 GB Free volume and a 50 GB
  Pro one. Overriding them is #47, if anyone asks. Sync keeps running on a low
  disk; a failed pull already surfaces as a sync error.

- **`edit_note`** — change part of a note by naming the text to replace. Until
  now the only ways to change a note were to append, prepend, or replace the
  whole thing with `update_note`, so changing one sentence meant rewriting the
  note — impossible to do safely for a note long enough to be read in pages,
  and a whole-file commit on the git backend for a one-line change. The named
  text must occur exactly once, or the edit is refused with the line numbers
  of every occurrence; `line` then picks one, or `replaceAll` takes them all.
  Because the match is exact, a note that changed on another device since it
  was read simply fails to match, and nothing is written to the wrong place.

- **`preview_edit`** — what `edit_note` would do with the same arguments,
  without doing it: every occurrence with its line number and the text around
  it, how many the call would replace, and the refusal it would get if any.
  A caller that could not ask this had to read the note and count for itself,
  the step most likely to go wrong. It is offered to read-only credentials,
  since a dry run writes nothing and refusing it would push a caller toward
  doing the edit to find out. The two share one matching routine, so the
  preview cannot drift from the edit. With these two the server offers
  29 tools covering notes, attachments, daily notes, search, properties,
  tasks, links and tags.

- Every tool now declares MCP **annotations** — whether it only reads, whether
  it can discard content a person wrote, whether repeating it changes anything
  more — and every parameter carries a description. Clients that honour the
  hints (Claude does) may ask before a call marked destructive: `delete_note`,
  `update_note` and `move_note`. Property edits and task toggles are not
  marked, since sync history keeps every version. The five thinnest tool
  descriptions gained a sentence on when to reach for them, and the Tools tab
  shows the parameter descriptions and the destructive marker.

- A **Server Configuration** panel at the top of Settings, linking back to this
  deployment on Railway: *Check for updates* goes to the service, where an
  available update is applied, and *configure* goes to the project. Applying an
  update is the one routine task the dashboard cannot do for you, so it is worth
  one click rather than a hunt through Railway for the right service.

  Shown only when Railway's project and service IDs are present, which is how
  the app knows it is running there — self-hosted deployments see no panel
  rather than links that go somewhere wrong. Both open in a new tab, since the
  dashboard is a live view worth keeping.

### Fixed

- **Security** — one note can no longer add an unbounded number of rows to
  the index. A file made of nothing but tags, links or tasks used to add one
  row per item — on the order of a million from a single synced file at the
  old read cap. Each kind is now capped at 2,000 per note; the excess is
  dropped and the note is still indexed.

- **Security** — reading a note now binds the symlink check, the size cap,
  the binary and LFS sniffs and the read itself to a single open file
  descriptor. They used to be four separate opens by path, and a symlink that
  sync swapped into place between any two of them was followed by the next —
  into a search result or a tool response. The window was microseconds wide
  and needed a hostile file arriving through sync at exactly that moment, but
  it was the class of hole the code already claimed to close. The indexer's
  own read had the same shape and is fixed the same way, which also means the
  size and modified time it records now describe the bytes it indexed rather
  than whatever the path pointed at a moment earlier.

- `get_outline` and search now agree about what a heading is. They ran two
  copies of the same scan, and the copies had drifted: the outline read the
  whole file, frontmatter included, so a `#` comment in a note's YAML came
  back as a top-level heading that search had never indexed. One shared pass
  now feeds both, over the body only, and while it was being unified it
  learned three things neither copy knew — a heading underlined with `===`
  or `---`, a heading inside an HTML comment (not one), and a code block made
  by indentation rather than fences (not headings or tasks either). Nested
  list items indented by four spaces are still list items, not code.

- A `[[wikilink]]` or `#tag` inside inline code is no longer indexed. A note
  *about* Obsidian syntax used to invent links that then appeared as broken in
  `list_link_issues`; tags were spared only by an accident of the pattern. Code
  spans are now masked before either is extracted.

- The server now runs under an init process (`tini`) inside the container.
  Nothing changes on a healthy instance. On one whose git remote times out now
  and then — a flaky network, a slow host — each timeout could leave a dead
  helper process behind that was never cleaned up, because `node` as the
  container's first process does not reap orphans. Over weeks that quietly
  used up process slots until sync could no longer start a git command, and
  the dashboard had no way to say why. Redeploying picks this up.

- **Security** — revoking a connector now ends its access immediately. Revoking
  deleted the client, its tokens and its consent, which stopped connectors
  holding an opaque token at once. A connector holding a JWT kept working for
  the rest of that token's hour, because JWTs were verified by signature alone
  and nothing checked whether the client still existed. The dashboard said the
  connector was gone while the endpoint went on serving it.

  If you have ever revoked a connector and wondered whether it really stopped,
  this is why it might not have.

  One deliberate exception: a download link already handed to you for a large
  attachment keeps working for its 15 minutes. Those links are signed for a
  single file and meant to be opened by you in a browser, so they are not tied
  to the connector that produced them — no new ones can be minted after a
  revoke, and an old one reaches only the file it already named.

- The git setup step no longer assumes GitHub. **Username** is now required
  rather than optional, and the placeholder and help text no longer name one
  host. Left blank, it used to become `x-access-token` — GitHub's convention,
  which a deploy token or a Bitbucket app password rejects — and the failure
  arrived as a generic authentication error with nothing pointing at the field
  that had been skipped.

  Any HTTPS git host has always worked. Only the wizard suggested otherwise.

- The MCP endpoint now validates the `Origin` header, which the Streamable HTTP
  transport requires of every server: a request arriving with an origin that is
  not this instance is refused with 403. Requests without an `Origin` are
  unaffected — that is every real connector, since Claude and ChatGPT reach your
  server from their own infrastructure and browsers cannot omit the header.

  The guard this adds is against DNS rebinding, where a web page tricks a
  browser into treating your server as its own.

- Adding a connector before finishing the setup wizard no longer looks like a
  broken server. The MCP endpoint checked readiness before authentication, so an
  unconnected client got "service unavailable" and never the challenge that
  tells it authentication exists — no authorize button, and nothing pointing at
  the wizard as the reason. It now answers the challenge first, and reports
  not-ready only to callers that have authenticated, with a `Retry-After` so a
  client knows to come back rather than give up.

- ChatGPT connectors work with OpenID left on. The authorization server
  advertised `profile` and `email` but would not grant them to a client that
  registered itself, so ChatGPT asked for what the metadata promised and its own
  authorization refused it — `The following scopes are invalid: profile, email`.
  Connecting meant finding OIDC in an advanced settings panel and switching it
  off.

  Advertised and granted are now one list. Nothing in your vault is gated on
  those scopes; they exist so a connector can see which account it is attached
  to.

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
- Every write to the search index used to scan the whole full-text table to
  remove the note's previous entry, because the lookup was by path and FTS5
  cannot index a path — measured at nine times the cost of a keyed lookup on
  a 2,600-note vault, growing with the vault. The entry is now keyed by the
  note's own row id. Nothing to do: the index is rebuilt on the first boot
  after this update, which is what re-keys every existing row.
- The search index's readiness flag now goes false for the duration of every
  rebuild, not only the first, and the wipe at the start of a rebuild is a
  single transaction. Neither is visible yet — the flag is not consumed until a
  later change — but the boot-time rebuild that repairs every partial state is
  now pinned by a test, so it cannot be removed by accident.

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
