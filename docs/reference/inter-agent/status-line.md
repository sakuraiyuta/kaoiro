---
title: Agent status line
description: The self-reported status line of each agent - writing and reading it, the wire forms, the change log and its retention, the store and its failure model, and what the dashboard shows.
status: provisional
last_updated: 2026-10-04
related: [directory, messages]
---

# Agent status line

An agent writes one markdown text about what it is doing, with
`set_status_line`. Operators and viewers see it on the agent's card and can open
the change log. Other agents see the start of it in `list_agents` and can read
the whole of it with `read_status_line`. The text is written by the agent
without operator approval, so every reader treats it as information and never
as an instruction.

## Writing a line

`set_status_line` takes one string. The server stores it as the calling
agent's line; the agent id is the socket's own and a payload `agent_id` is never
read, so an agent can only write its own line.

The text is checked in this order (`KaoiroServer.MarkdownText`, shared with any
other store of operator- or agent-authored markdown):

1. Not a string, or not valid UTF-8: `invalid_status_line`.
2. `\r\n` and a lone `\r` become `\n`.
3. A C0 control other than `\n` and `\t`, or DEL: `status_line_invalid_characters`.
   This runs before the trim, so a vertical tab at an edge is rejected and not
   trimmed away.
4. The text is trimmed. An empty result clears the line.
5. More than 16,384 bytes (UTF-8, after normalization and trim):
   `status_line_too_large`, with `max_bytes` and `bytes` in the reply.

A clear is an entry of the change log (`text: null`) and takes a sequence
number like any other write. The success reply carries no text: `{status_line:
{bytes, truncated, updated_at}}` for a line, `{status_line: null}` for a
clear.

The common footer ([personality](../configuration/personality.md)) tells every
agent to write a line when it starts and when it finishes work, to put the gist
first, and to leave out secrets, credentials and personal information.

## Reading a line

| Reader | Surface | What it gets |
|---|---|---|
| Agent | `list_agents` entry, `status_line` | The head only: `{head, truncated, bytes, updated_at}`. The key is omitted for a cleared or absent line and while the store is unavailable. |
| Agent | `read_status_line` (`status_line_get`) | The full latest text, `{agent_id, text, bytes, updated_at}`, or `{agent_id, status_line: null}`. No history. |
| Viewer, operator | Card and change log | See [Dashboard](#dashboard). |

The head is at most 512 bytes of the text, cut on a grapheme boundary
(`KaoiroServer.MarkdownHead`); `truncated` says the text is longer. An empty
head with `truncated: true` means even the first grapheme did not fit.

`read_status_line` applies the same membership rule as `list_agents`
(`DirectoryEligibility`): an agent with a live entry, or a directory-only entry
that names a persona. The rule applies before the 32-entry cap on directory-only
entries, and the requester may read its own line. Any other id, existing or not,
answers `unknown_agent`. Both tools are in the Claude default auto-allow set
([inter-agent tool authorization](../security/inter-agent-tool-authorization.md));
`set_status_line` is the one non-read-only entry there, because its effect is
bounded to the caller's own line.
A Claude peer whose config sets an explicit `allowed_tools` list does not get
that set and must list both tools itself
([runbook](../../operations/server-update-and-rollback.md#47-peers-with-an-explicit-allowed_tools-list)).

## Change log and retention

The store keeps the latest entries of each agent, newest first, up to the
retention: 1 to 100, default 20. `KAOIRO_STATUS_LINE_RETENTION` sets the
default at boot ([server configuration](../configuration/server.md)); an
operator can store a pick from the dashboard, which takes precedence and is
reported with its source (`stored`, `env` or `default`). Lowering the retention
prunes every agent at once. Deleting an agent removes its record at once.
Revoking its token alone does not: the record is dropped by the denylist sweep
at the next start of the store.

## Wire forms for dashboard clients

| Direction | Event | Payload | Who |
|---|---|---|---|
| server to client | `status_line_snapshot` | `{agents: {<id>: row}, snapshot_incomplete?: true}`, pushed after the closed set of join snapshot frames | operator, admin: every row; viewer: rows of agents in its own role-filtered snapshot |
| server to client | `status_line` | one row plus `agent_id`, on every committed write and clear | filtered per recipient by the visibility rule |
| server to client | `status_line_settings` | `{retention, source, min, max}` | operator, admin |
| client to server | `status_line_history` | `{agent_id}`; reply `{entries: [...]}` newest first, each entry with the full `text` (or `null` for a clear), `seq`, `bytes`, `updated_at` | viewer, operator, admin |
| client to server | `set_status_line_retention` | `{retention}`; reply is the settings payload | operator, admin |

A set row is `{seq, head, truncated, bytes, updated_at}`. A cleared row is
`{seq, cleared: true, updated_at}`: a clear is a stamped row so a client can
reject an older line that arrives after it. A client applies a live event only
when `(updated_at, seq)` is newer than the row it holds.

`snapshot_incomplete: true` with an empty map is sent when the store is
unavailable or the frame would exceed the transport budget. The client then
draws no row at all; it never shows "unset", which would be a claim about the
agent.

`status_line_history` checks, in order: the payload shape, the id format, the
role (a role other than viewer, operator or admin gets `forbidden`), the
protocol version warning (operator-capable roles only, so a viewer or
unauthenticated socket never makes the server log), visibility for a viewer,
and the store. A hidden id and a nonexistent id both answer `unknown_agent`.
A reply that would not fit the transport budget is refused with
`status_line_history_too_large`. `set_status_line_retention` accepts an integer
in range only; an out-of-range value, a non-integer or an absent key returns
`invalid_status_line_retention`. All of these events follow
[versioning](../protocol/versioning.md).

### Visibility

A viewer sees a line only for an agent in its own role-filtered snapshot: the
agent has a live entry and `ViewerAgentProjection` does not drop its latest
envelope. One predicate (`StatusLineVisibility`) serves the snapshot, the live
event, the history request and the detection of an agent that has just become
visible. `AgentStates` runs that detection on every `put`; when an agent goes
from hidden to visible, the announcer broadcasts its committed row (a stamped
clear too), reading the published table only.

A dropped announcement is not retried. The line reaches viewers again by the
next hidden-to-visible change, by the agent's next write, or by a viewer rejoin
(the snapshot carries it). A failing announcement means the Endpoint is down,
which disconnects every client, and the rejoin repairs the rows.

## Dashboard

The agent card shows the head, at most three lines, drawn as markdown in the
inline profile (below), with a note when the line is longer than the head or
draws more than three lines. The row is one button, so nothing pressable may
sit inside it: a link is drawn as underlined text, and pressing it anywhere on
the row opens the change log, where it is a real link. The row uses the
foreground colour at the body-small size, with a border in the card's state
colour on its left edge and a faint tint of that colour.

The member detail view shows the same head at the top of its scrolling column,
with the full profile (headings, lists, tables and real links), its time, and,
when the head was cut, the note. It reads the line the dashboard already holds,
so it follows live writes without a request. One button, 続きを読む, opens the
change log wherever the agent has written or withdrawn a line:

| Line | Panel | 続きを読む |
|---|---|---|
| set | head and time | yes, cut or not |
| cleared | 未設定 | yes |
| never written | 未設定 | no |
| unknown (no snapshot, or an incomplete one without this agent) | no panel | no |

With no way to open the log (an embed without an opener) there is no button in
any state.

The change log dialog renders only the latest entry in full on open. An older
entry shows its time and its first line, cut to 160 code points and drawn in the
inline profile like the card, and is rendered in full when expanded, so opening
the dialog parses one entry in full however long the log is.

Markdown written by an agent is rendered under one fixed policy
(`untrustedMarkdown.ts`, shared with any other renderer of text written by
someone else), in two profiles. The full profile (the dialog and the detail
view):

- raw HTML is shown as the text the author wrote;
- only `http` and `https` links stay links, with `rel="noopener noreferrer
  nofollow"` and `target="_blank"`; any other scheme keeps its label as text;
- an image is never loaded: it becomes a link to its URL;
- blockquote or list nesting deeper than 32, or a parser failure, shows the
  source as text with a note;
- a second sanitizer pass strips whatever the first would let through.

The inline profile (the card) is stricter: it flattens every block into
phrasing content and has its own sanitizer instance.

- bold, emphasis, strike and code keep their elements; a heading is bold text, a
  list item a line starting with a bullet or its number, a table a line of cells
  joined by bars, a quote its content, and a rule nothing;
- a link whose address is `http` or `https` is drawn as underlined text in a
  span; any other link keeps just its label, as in the dialog; no anchor is
  ever emitted;
- an image is its alt text alone, and raw HTML is shown as the text the author
  wrote;
- the sanitizer allows only `strong`, `em`, `code`, `del`, `br` and `span`, the
  one class `md-link` and only on a span, and no `data-*` or `aria-*` attribute;
- the output holds no newline beside a break, so the three-line clamp counts
  the lines that are drawn.

### A head the server cut

A head cut at 512 bytes may stop inside markup. Drawn as it is, it would show raw
syntax (`**`, `[x](`) or a link to a half address that still opens
(`https://gith`). `StatusLines.view()` therefore trims a head whose `truncated`
is true (`truncatedMarkdown.ts`; a complete line is drawn as written) to the
longest start of it that draws only what the full line draws, and both the card
and the panel read the trimmed head. The note says the text continues.

- The block structure and the extent of every closed inline construct come from
  the lexer that draws the text, so the trim and the renderers cannot disagree
  about them. Hand rules cover only what the lexer leaves as text: a delimiter
  that has not been closed, a bracket, a trailing escape, an entity prefix, a
  partial block marker, a table or a definition still being typed.
- An address, which is anything the lexer gives an `href` (a link, an image, a
  bare URL, an email, a definition), that reaches the end of the head is cut,
  never kept: the rest of it is unknown.
- When nothing precedes the first unfinished construct, its text is kept and its
  markup dropped (a cut bold headline is drawn plain, a link keeps its label).
  The text ends at an unclosed backtick, because the full line may hold code
  there, and the block is cut instead when dropping a delimiter would make the
  text draw a link the full line does not (a `www.` address joined across the
  dropped character, an address in an unfinished link label).
- Carriage returns become line feeds and tabs four spaces before the lexer reads
  the head. A failure inside the trim shows the empty-head sentence below, never
  the untrimmed head.
- A head with nothing left to draw (it starts with a table, a bare URL, a link
  destination, an angle-bracket autolink, an unclosed code span, an empty fence,
  or holds only reference definitions) shows the fixed sentence `(冒頭が長いため省略)`, an
  element of the dashboard in its own class (`.omitted` in the panel,
  `.status-omitted` on the card; dim and italic), never passed through the
  markdown path. The server's empty head for a first grapheme larger than 512
  bytes shows it too.

What the trim cannot do, because a start of the text does not hold what comes
after it: a delimiter that the full line shows as literal text can be hidden
(counted by the oracle, about 1.4% of cuts on the fuzz corpus); a reference
link whose definition follows the head, a footnote-style definition and a table
without leading pipes draw their brackets as text. None of these draws an
address. `truncatedMarkdownOracle.test.ts` judges the trim by the renderers at
every grapheme cut and is the alarm for a `marked` upgrade.

The operator's retention control lives in the settings drawer.

## Store and failure model

State lives in two places, both owned by `KaoiroServer.AgentStatusLines`.

- **DETS** (`KAOIRO_AGENT_STATUS_LINES_PATH`, default file
  `agent_status_lines.dets`): `{:retention, n}` and one object per agent holding
  its entries, newest first. A mutation replaces one object, so a failed write
  leaves the object whole, old or new.
- **ETS**, `:protected`, one row per agent with only the latest entry and its
  head. Frequent readers (`list_agents`, the join snapshot, the announcer) read
  it by name on every call and never wait behind a write. A missing table reads
  as unavailable, never as "no line".

A write is committed in this order: the DETS object, then the sync, and only
on success the ETS row, the reply and the broadcast. A failed write, or any
raise or exit from a DETS step, latches the store dirty. While dirty, writes,
`read_status_line`, `status_line_get` and the history return
`status_line_unavailable`, and the dashboard and `list_agents` keep serving the
last committed rows. There is no automatic recovery.

### Start

`init/1` runs once per process:

1. It must be the only opener of its DETS name; a name that is already open stops
   init with `status_line_table_already_open` and is left alone.
2. The revoked ids are read once from the token denylist. An unreadable denylist
   stops init and is never treated as empty.
3. The file is opened. A file that is not a DETS file at all is moved aside to
   `<path>.corrupt-<UTC>-<n>` (a hard link, then unlink, so an earlier backup is
   never replaced) and a fresh file is opened; the stored retention pick is lost
   with it. Any other open error (`file_error`, `type_mismatch`, an unknown
   one) stops init and leaves the file as it was.
4. Every stored record is checked with the rules a write passes. A record that
   the write path would not have stored - an entries value that is not a proper
   list, a text with a control character, untrimmed, with a CR, empty, or over
   the limit, out-of-order sequence numbers - is dropped with a warning and
   deleted from the file; it is never repaired in place.
5. Revoked and deleted agents are swept, the log is pruned to the retention,
   and one sync writes the repairs. The sync runs even when nothing needed
   repair. If it fails, the store starts dirty and publishes the rows as read.
6. The rows are built in a temporary ETS table and the table is renamed to its
   public name, so the public name exists only for a complete view.
7. When the Endpoint is already up (a child restart, not the first boot), every
   row and the settings are announced.

A failure before the rename exposes nothing. A failure after it (for example in
the announcement) can leave the complete view readable until the owner exits;
owner calls then answer unavailable.

### Operations

While the store is dirty, `set_status_line` and `read_status_line` return
`status_line_unavailable`, and the cards and `list_agents` keep the last
committed lines. The startup log line gives the agent and entry counts, the file
size, the retention and its source, the number of invalid records dropped and
the dirty flag. Recovery is a restart of the child after the cause is fixed; see
[the runbook](../../operations/server-update-and-rollback.md#46-status-line-store-recovery).

## Related

- [Peer directory](directory.md) for the `list_agents` entry.
- [Channels](../protocol/channels.md) for the dashboard events.
- [Server configuration](../configuration/server.md) for the paths and the
  retention variable.
