---
title: Muse ACP engine
description: Resident ACP host for Muse Code's experimental `muse acp`, its capabilities and its declared limits.
status: draft
last_updated: 2026-11-25
---

# Muse ACP engine

The `muse` engine requires Muse Code on `PATH`, logged in with
`muse login`. The wrapper launches `muse acp --trust-workspace` once (plus
`--model <id>` when a launch pick names a model), initializes one ACP
session (`session/new`, or `session/resume` for a cold resume) and uses
`session/prompt` for each queued turn. It does not launch `muse` per turn.

`muse acp` is experimental upstream. It speaks ACP version 1 over stdio and
translates to the same Muse Code host as `muse serve`. The gate that
enables it is open by default; the wrapper sets `MUSE_EXPERIMENTAL_ACP=on`
for the child only when the operator's environment does not set it either
way, so an operator who closed the gate keeps it closed. Approval flags are
refused by `muse acp`, so none are passed; the approval mode is chosen
through ACP.

The ACP client is the shared one in `wrapper/agent-common/src/acp/`. Muse
Code sends plain ACP session updates and no vendor extensions are consumed,
so there is no `muse/wire.ts` injection surface: the mapping in
`wrapper/muse/src/muse/events.ts` is the protocol's own vocabulary
(message and thought chunks, tool call rows and completions, plan entries,
`usage_update`).

## Tools

The kaoiro tools are served by the wrapper's ToolHost as an HTTP MCP server
on `127.0.0.1` and passed as `mcpServers` in `session/new`, with the per-run
bearer token in a header, never in the URL (see the
[Grok tool transport](grok-acp.md#tool-transport) for the shared checks).
Startup fails closed when the agent does not report `mcpCapabilities.http`.

Unlike Grok, startup does **not** wait for an authenticated `tools/list`:
Muse Code starts the session's MCP servers when a turn starts, so a
`tools/list` may legitimately not have happened yet when the session opens.
Whether the tools are usable is therefore only observable inside a turn.
This is a design reading of the upstream ACP documentation, not a live
measurement; it must be rechecked against a real `muse acp` build.

## Personality prompt

Muse's ACP surface documents no `session/new` system-prompt metadata
(compare [personality injection](personality-injection.md), where Claude
Code, Codex, Antigravity and Grok each have a named injection point). Until
a Muse injection point is documented or measured, the wrapper delivers
the server-composed persona and footer at the head of the **first turn
only**, ahead of the operator's text. This is provisional: the text is
visible in the session transcript, and a resumed session does not receive
it again. Replacing this with a native injection point is the first
follow-up when upstream documents one.

## Capabilities

The adapter supports text turns, conversation continuity while the wrapper
is resident, cancellation (`session/cancel`), operator permission requests
(ACP `session/request_permission`, answered by the common PermissionBroker
with the `allow_once` / `reject_once` option), user questions through the
kaoiro `ask_user_question` tool, normal peer messages, and context usage
from ACP `usage_update` (`ext.context`). Live model and effort switching
are supported when the session's config options offer a `model` and a
`thought_level` select: values are validated against those options and
applied with `session/set_config_option` before the next prompt (or at
once while idle). A rejected switch publishes `switch_error` once and
changes nothing. Cold resume is supported when the agent advertises
`sessionCapabilities.resume`.

Declared unsupported, each rejected explicitly rather than silently:

- Permission-mode switching and the two-axis permission selector. Muse's
  four ACP approval modes are not projected onto kaoiro's permission axes
  in this adapter, and a launch `permission_mode` fails the start.
- Attachments (`supports_attachments: false`).
- Session reset (`supports_session_reset: false`).
- Dashboard history replay on resume: the wrapper registers no hydration
  replayer, so a resumed agent starts with an empty dashboard history.
- The launch catalog probe: the runner offers the account `default` model
  entry until the session reports its own config options; there is no
  short-lived catalog probe for Muse yet.

## Login and failure modes

A host that is not logged in cannot open a session: `session/new` fails
with the upstream "log in to Muse before opening a session" error and the
wrapper start fails with it. Run `muse login` on the runner host. A build
with the ACP gate closed exits with code 5 before `initialize`; the
wrapper reports the child exit as a launch failure.
