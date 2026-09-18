---
title: Antigravity adapter architecture
status: implemented
last_updated: 2026-09-18
description: Why kaoiro drives Antigravity through agy, and how the adapter owns a turn, customization, bridge, and watchdog lifecycle.
---

# Antigravity adapter architecture

## Why kaoiro drives the CLI

kaoiro's Antigravity engine is a TypeScript wrapper around the `agy` CLI, not
the Python SDK. The SDK was Python-only when this adapter was chosen, whereas
the runner and wrappers are Node processes. Headless `agy` provides a
newline-delimited JSON stream that the adapter can convert to the common
engine state machine without a second hosting runtime. The decision and its
alternatives are recorded in [ADR-0057](../adr/0057-antigravity-adapter.md).

The CLI is self-updating. Its observed behaviour is therefore not a permanent
vendor guarantee: dated observations and their limits live in
[the CLI contract evidence](../evidence/antigravity/cli-contract.md). The
current wrapper-facing event contract lives in
[the event reference](../reference/engines/antigravity-events.md).

## Turn lifetime and ownership

`AntigravityHost` owns one `agy` child per submitted turn. The first `init`
event supplies the conversation id; later children receive that id with
`--conversation`. A child is not a resident control plane: the wrapper closes
its stdin, terminates it for interruption, and treats an exit without a
terminal `result` as a failed turn. The host serializes its turn queue, so one
conversation is not driven by concurrent children.

Before a turn, the host creates (on first use) and rewrites a private
customization directory. It contains the persona rule, the PreToolUse hook,
and a bridge skill. The child receives both the agent working directory and
the customization directory through `--add-dir`; the customization directory
is not a workspace for the model to edit. The host verifies the generated
files and the registered hook before using them. It removes its directory on
close and sweeps only stale directories carrying its ownership marker at
startup.

The host also refreshes the model catalog with `agy models`. A failed probe
does not replace the static catalog snapshot. Display-name synchronization is
state-only; it does not rewrite the persona text until the next turn rewrite.

## Bridge and permission boundary

Headless `agy` does not provide kaoiro's MCP integration. The adapter instead
passes a private socket path and nonce to a wrapper-owned CLI bridge. The
generated rule tells the model to invoke that bridge through `run_command`.
The PreToolUse hook is the authorization boundary: it recognizes the strict
bridge command grammar and otherwise delegates to the Antigravity gate.

The detailed command classification, advisory sandbox limit, permission
switching, and recovery meaning are the
[tools and permissions reference](../reference/engines/antigravity-tools-permissions.md).
This separation matters: a successful CLI tool invocation is not evidence
that the CLI sandbox enforced a restriction.

## Watchdog and failure ownership

The host uses one `TurnWatchdog` for both inactivity and tool wall-clock
limits. The watchdog starts only for an admitted turn, observes parsed tool
`ACTIVE` / `DONE` / `ERROR` transitions, and requests interruption before a
fail-stop if the child does not settle within the abort grace. Stream activity
can extend the inactivity timer but never the absolute tool deadline.

The default inactivity limit is 30 minutes; the default tool limit is ten
minutes. Both are wrapper environment settings, not CLI flags. A tool timeout
is reported through the existing failed-turn path with `error_detail` set to
`tool_timeout`; it does not introduce a new wire event. Lifecycle logs omit
raw tool input. Exact defaults, environment names, and event mappings are in
the [event reference](../reference/engines/antigravity-events.md).

## Boundaries

The adapter accepts text turns only and advertises no attachment or
context-usage capability. Its sandbox value is advisory: enforcement comes
from the wrapper gate and the permission broker, not from a demonstrated CLI
sandbox. The adapter can advertise runtime permission switching only after a
successful permission-sync negotiation and only when all three launch ceilings
were supplied by the runner. These are current implementation constraints,
not claims about all `agy` versions.

## Related pages

- [Antigravity event reference](../reference/engines/antigravity-events.md)
- [Antigravity tools and permissions](../reference/engines/antigravity-tools-permissions.md)
- [Antigravity CLI contract evidence](../evidence/antigravity/cli-contract.md)
- [ADR-0057](../adr/0057-antigravity-adapter.md)
