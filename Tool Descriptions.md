# Tool Descriptions

What each of NoteMesh's MCP tools does, what it takes, and the things a
one-line description leaves out: where a setting comes from, what a time
means, what a refusal is telling you. The **Tools** tab in the admin UI shows
the descriptions your client is actually offered, straight from the running
server; this file is the longer explanation beside them.

The size limits every tool works under are in the README's *Size limits*
table and are not repeated here.

## Conventions every tool shares

**Paths** are relative to the vault root, with `/` separators. A note path
without an extension gets `.md` appended. Paths that escape the vault, pass
through a symlink, or enter a dot-directory (including `.obsidian`) are
refused. Paths in results are plain text, so they can be passed straight back
into another tool.

**Lists** all return the same envelope:

```json
{ "boundary": "%3f2a9c71%", "boundaryNote": "…", "total": 120, "offset": 0, "count": 100, "hasMore": true, "items": [ … ] }
```

`total` is the whole result, not the page. Page with `offset` while `hasMore`
is true. `limit` defaults to 100 and caps at 500 for lists, 20 and 100 for
search.

**Fencing.** Text lifted out of a note — headings, task text, snippets,
frontmatter values, the lines `find_in_note` returns, a note's content — comes
back between a per-boot boundary marker, with a note saying that what lies
between the markers is vault content, not instructions. Identifiers such as
paths, tags and property names are not fenced, so they remain usable, but the
same rule applies to them. A separate text block after a result that begins
`NoteMesh:` is a notice from the server itself: a sync conflict, a full disk,
an index still warming. It is never inside the markers.

**Times.** `modified` and `created` are ISO 8601 with the offset of the
timezone set on the **Settings** tab, the same zone daily notes use. They mean
what a person means. On a git-synced vault, `modified` is the commit that last
touched the file and `created` the commit that first added it, read from git
once at start and after every pull; a pull sets every file's mtime to the pull,
so the mtime would say the whole vault changed at the last sync. On an
Obsidian-synced vault, sync preserves mtimes and the file's own times are
used. A note a tool just wrote reports the write. The raw `mtime` (epoch
milliseconds) stays beside `modified` on note listings for anything that
compared it. `created` is never later than `modified`.

**Sorting and narrowing.** `list_notes`, `list_attachments` and
`list_directory` take the same four arguments, all optional:

| Argument | Meaning |
| --- | --- |
| `sort` | `name` (default), `modified`, `created` or `size` |
| `order` | `asc` or `desc`; by name the default is ascending, otherwise newest or largest first |
| `modifiedAfter` | keep entries modified strictly after an instant: an ISO 8601 timestamp taken as written, a bare date meaning midnight in the configured timezone, or a timestamp without an offset read on that zone's clock |
| `name` | keep entries whose filename matches: a glob over the whole name when it contains `*` or `?` (`2026-08*`, `*.png`), otherwise a fragment matched anywhere; case-insensitive; at most 200 characters |

All four apply before paging, so `total` describes the narrowed list and page
two follows page one under the same order. Ties sort by path, so a page
boundary between two notes saved in the same second is stable.

**Writes** are visible to the next tool call at once: the file is reindexed
before the call returns. Propagation to your other devices is the sync
backend's job and is not instant — Obsidian Sync on its own schedule, or a
commit pushed on the next git cycle. Every write is atomic: the note is the
old version or the new one, never half of either. A write that would not
leave the disk's reserve is refused with a message naming the volume.

**Read-only clients.** A credential with read scope sees only the tools marked
read below, plus `preview_edit`, which writes nothing.

---

## Files

### read_note — read

Returns a note's content, fenced, up to 2,000 lines or 100 KB per call with
`totalLines`, `offset`, `count` and `hasMore`. Page a long note with `offset`
(0-based first line). Pass `totalLines` to `update_note` as `expectedLines`
when replacing the note. A binary file is refused with a pointer at
`read_attachment`; a Git LFS pointer standing in for a file is refused with an
explanation.

### list_notes — read

Markdown notes, optionally within `folder`, each with `path`, `mtime`,
`modified`, `created` and `size`. A note over the index cap carries
`indexed: false`: it is listed and readable but absent from search, tags,
tasks and links. Takes the sorting and narrowing arguments above.

### list_directory — read

One level of the vault the way `ls` shows it: files and folders side by side,
each with `name`, `path`, `kind`, `modified`, `created` and `size`. A folder's
`modified` is the newest item beneath it, its `created` the oldest, and its
`size` the bytes beneath, all from the index. A folder with nothing indexed
beneath it — empty, holding only files over the index cap, or not yet reached
by the boot rebuild — shows its own times and `modifiedFrom: "folder"`. Pass
an entry's `path` back as `folder` to descend. Takes the sorting and narrowing
arguments, and `sort: "modified"` on a folder shows where the recent work is.

### list_folders — read

Every folder path in the vault, recursively, sorted. For learning the layout
before creating a note, or picking a folder for another tool.

### find_in_note — read

Where text occurs in one note: every match with its `line`, `column`, the
line's `text`, and with `context` (0 to 5) the lines around it. Matching is
literal and case-insensitive unless `ignoreCase: false`; there is no regular
expression option, by design. A line longer than 160 characters is cut to a
window around the match, marked with `…` at a cut end; `windowStart` is the
column `text` begins at, so `column - windowStart` locates the match inside it
(one more when `text` starts with the ellipsis). Context lines are cut at the
same width from their start. Matches are counted up to 10,000 and only the
requested page is built. The way to find a passage in a note too long to read
at once, before `read_note` with `offset` or `edit_note`.

### create_note — write

Creates a note. Refused if it exists, if the path carries a reserved name
(`CON`, `__proto__` and the like), or if the content is over the write cap.
Folders on the path are created.

### edit_note — write

Replaces text by naming it. `oldString` must occur exactly once, or the edit
is refused with the line numbers of every occurrence; then pass `line` to
choose one, expand `oldString` until it is unique, or pass `replaceAll`.
`line` is also a check: with one occurrence the edit is refused if it is
elsewhere. If the note changed since it was read, `oldString` will not match
and nothing is written. A note with CRLF line endings keeps them even when
the strings passed use LF. Returns `path`, `replaced` and the `lines` changed.

### preview_edit — read

What `edit_note` would do with the same arguments, without doing it: every
occurrence with its line and an excerpt, how many the call would replace, and
the refusal it would get if any. Offered to read-only credentials.

### update_note — write

Replaces the whole note. Everything not in `content` is discarded, including
whatever a paged `read_note` did not return, so a note read in pages must
never be rewritten from one page. Pass `read_note`'s `totalLines` as
`expectedLines`: the write is refused on mismatch, and a note longer than one
read window is refused without it.

### append_to_note — write

Adds a block at the end of the note, separated by a blank line so it never
merges into the last paragraph. With `heading`, adds it at the end of that
heading's section instead: after the section's last line of text, before the
next heading of the same or a higher level. The heading is matched as written,
with or without its `#` marks, and must occur once; the refusal names the
lines, or the headings the note has. Headings inside code fences or
frontmatter do not count, as in the index.

### prepend_to_note — write

Inserts a block at the top of the note, below any YAML frontmatter so the
frontmatter stays intact. With `heading`, inserts it directly under that
heading as the section's first block. Same heading rules as `append_to_note`.

### move_note — write, destructive

Renames or moves a note, and rewrites every `[[wikilink]]` in other notes
that resolved to it, as Obsidian does on a rename. A link keeps its form: a
bare name stays a bare name unless the new name is shared with another file,
in which case it becomes a path; a link written as a path stays a path; alias,
heading and block suffixes are kept; links inside code fences and inline code
are left alone. The moved note's own links to itself are fixed too. Markdown
links (`[text](path.md)`) are not rewritten, matching what the index resolves.
`updateLinks: false` skips the rewrite. The result says how many links in
which notes changed. On a git backend those notes go into the next commit.

### move_folder — write, destructive

Moves or renames a folder with everything in it, and rewrites links to any
note or attachment inside it by the same rules as `move_note`. Refused if the
target exists or lies inside the folder, and for the vault root. Reindexes
every moved file, so a very large folder takes about a millisecond per note.

### delete_note — write, destructive

Deletes a note. Recoverable: Obsidian Sync keeps version history, and a git
backend keeps the file in the previous commit. Present unless turned off on
the **Settings** tab.

### delete_folder — write, destructive

Deletes an empty folder. Refused while anything is inside it, dotfiles
included, naming the count. Offered under the same setting as `delete_note`.
There is no create-folder tool: folders come into being through note paths,
and git cannot store an empty one.

## Attachments

### list_attachments — read

Non-markdown files (images, PDFs, audio, canvases), with the same fields and
arguments as `list_notes`. Embeds are written by filename (`![[shot.png]]`)
while the file lives wherever Obsidian filed it; this is how to find the path
`read_attachment` wants.

### read_attachment — read

A binary file as base64; images come back as viewable image content. Over
1 MB the file is not inlined: the result carries a fifteen-minute signed
download URL instead, for handing to the user. That URL serves the file as an
opaque download, streamed, never as a type a browser would execute. A
markdown note is refused here with a pointer at `read_note`.

## Daily notes

### daily_note — write

`action` is `read`, `append`, `prepend` or `path`, for today or for `date`
(`YYYY-MM-DD`). Append and prepend create the note if it does not exist, from
your template when one is configured, with `{{title}}`, `{{date}}` and
`{{time}}` filled the way Obsidian fills them: the note's name, its day, and
the current time in the configured timezone, the last two taking a
moment-style format after a colon (`{{date:dddd, MMMM D}}`, `{{time:h A}}`).
A template that is missing or unreadable gives an empty note rather than a
refusal. A daily note that already exists is never templated again.

**Where the note goes.** The folder, filename format and template come from
Obsidian's own Daily Notes settings, read from `.obsidian/daily-notes.json`
in the vault on every call: the plugin's *New file location*, *Date format*
and *Template file location* fields. Change them in Obsidian and the tool
follows on the next sync. Without that file the tool falls back to
`YYYY-MM-DD` at the vault root; the **Settings** tab says which of the two
your vault has. Obsidian Sync does not send the `.obsidian` folder unless
asked, so linking a vault runs `ob sync-config --configs core-plugin-data` to
bring `daily-notes.json` over; a vault linked before that step existed has a
*Turn on settings sync* button on the Settings tab that runs the same call.
A git backend needs `.obsidian` committed. The
Periodic Notes community plugin keeps its settings elsewhere and is not read.

**Which day it is.** Today is resolved in the timezone on the **Settings**
tab, not the server's. A container runs in UTC, and without this an evening
in the Americas is already tomorrow to the process.

## Search

### search_vault — read

Full-text search over titles, headings and bodies, stemmed, all terms
required. Each hit has `path`, `title`, `modified`, a fenced plain-text
`snippet`, and `matches`, the words in that snippet that matched (often not
the word you searched for, because of stemming). `folder` and `modifiedAfter`
narrow before paging, so `total` is of the narrowed set; `sort: "modified"`
orders newest first instead of by relevance; `context: true` gives longer
snippets. Notes over the index cap are not searchable; `get_vault_info`
counts them.

## Properties

### read_properties — read

A note's frontmatter as an object, values fenced, names left plain. Without
`path`, a survey of every property name in the vault with usage counts.

### set_property — write

Sets one property, creating the frontmatter block if there is none. `value`
may be a string, number, boolean or list of strings. Returns `changed: false`
and touches nothing if the value was already set.

### remove_property — write

Removes one property. Returns `changed: false` and touches nothing if it was
not set.

## Tasks

### list_tasks — read

Markdown tasks (`- [ ]` and `- [x]`) across the vault, each with `path`,
`line`, fenced `text` and `done`. `filter` is `all` (default), `todo`, or
`daily` for today's daily note, resolved the same way `daily_note` resolves
it.

### toggle_task — write

Flips one task's state by `path` and `line`, as `list_tasks` reported them.
Refused if that line is not a task.

## Links and tags

### get_links — read

`backlinks`: notes that link to this one, with the raw link text. `outgoing`:
this note's wikilinks with the path each resolved to, or null when it did
not. Resolution follows Obsidian's shortest-path rule: an exact path first,
then a unique basename.

### list_link_issues — read

`unresolved`: wikilinks to notes that do not exist. `orphans`: notes nothing
links to. `deadends`: notes with no outgoing links.

### list_tags — read

Every tag with its usage count, from frontmatter and inline `#tags` alike.
Tags inside code are not counted, and a bare number is not a tag.

### notes_by_tag — read

The notes carrying a tag, with or without its leading `#`.

## Vault

### get_vault_info — read

Vault name and path, note count, word total, how many notes are too large to
index, the sync backend's state, and disk headroom: `disk.level` is `ok`,
`warn` under 100 MB free, or `critical` under 50 MB, at which point writes
that would not leave the reserve are refused.

### get_outline — read

Each heading with its level, fenced text and 1-based file line, for finding
where a section starts before reading part of a long note with `offset`.
Setext headings count; a `#` inside a code fence does not.

### word_count — read

Words and bytes for one note, or totals for the vault. Words are counted in
the body only, since frontmatter is metadata; bytes are size on disk. With a
path, both numbers equal that note's contribution to the totals.

### random_note — read

One note's path, at random. Read it with `read_note`. For resurfacing
something forgotten, not for finding a specific note.

### unique_note — write

Creates a Zettelkasten-style note named by the minute, `YYYYMMDDHHmm.md`, at
the vault root, with optional content. The stamp is taken in the configured
timezone.
