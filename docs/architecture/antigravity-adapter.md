---
title: Antigravity adapter
description: Why kaoiro drives the Antigravity CLI over ACP and how the adapter owns its process and persona boundary.
status: provisional
last_updated: 2026-11-24
related: [protocol, plugin-model, claude-events, codex-app-server-events]
---

# Antigravity adapter

## Purpose

Explains why the Antigravity CLI (`agy`) is the substrate of the engine
`antigravity` and how the adapter owns its process and persona boundary.
The decisions are [ADR-0057](../adr/0057-antigravity-adapter.md) and
[ADR-0078](../adr/0078-antigravity-over-acp.md). The mapping from ACP
updates to [protocol state](../specs/protocol.md) and the turn lifecycle are
in [Antigravity events](../reference/engines/antigravity-events.md); the tool
and permission contract is in
[Antigravity tools and permissions](../reference/engines/antigravity-tools-permissions.md).
This architecture is paired with the
[Claude event contract](../reference/engines/claude-events.md) and
[Codex app-server events](../reference/engines/codex-app-server-events.md).

**Status: provisional** — the ACP behaviour it relies on was measured with
`agy` 1.5.14 on 2026-11-22 and 2026-11-23
([measurements](../evidence/antigravity/agy-1.5.14-acp-measurements-2026-11-22-setup-and-sessions.md),
[native acceptance](../evidence/antigravity/agy-1.5.14-acp-native-acceptance-2026-11-23.md)).
Supported authentication is defined by
[ADR-0077](../adr/0077-antigravity-authentication.md). `agy` updates itself,
so vendor drift remains a live risk.

## Why the CLI, over ACP

The [issue #181](https://github.com/sakuraiyuta/kaoiro/issues/181) premise
was the Antigravity **SDK**. It is Python-only, which conflicts with the TS
in-process hosting premise of
[ADR-0023](../adr/0023-host-runner-architecture.md) D3. The CLI `agy` is a
self-updating binary already installed on hosts that use Antigravity, and
`agy acp` serves the Agent Client Protocol on stdin and stdout: a session,
structured updates, a prompt response, cancellation, and an HTTP MCP server
per session. The adapter drives it as a child process, as the Grok adapter
does for its CLI, so no Python bridge is needed.

## One process per prompt

Every input runs on its own `agy acp` process, a *generation*: spawn,
`initialize`, `session/new` or `session/resume`, the model and level, the
kaoiro tools listed on the shared HTTP tool host, then one
`session/prompt`. The generation is retired once the input settles, and the
next one starts only after the previous process exited. The conversation
continues through `session/resume`. A permission change therefore needs
nothing but the next start: its launch flags are chosen per generation.

The cost is a start per turn, a median of 2.2 s for `session/new` and 2.7 s
for retire and resume with `agy` 1.5.14. In exchange, no process outlives
its input, and a background command ends with its generation at the latest
(the exceptions are in
[Antigravity tools and permissions](../reference/engines/antigravity-tools-permissions.md)).
A prompt that waits for background work stays open through the Stop hook,
up to 10 continuations.

## System-prompt equivalent (persona personality injection)

The server-pushed persona prompt (personality + footer, ADR-0029 F9) is
appended to `agy`'s system prompt when a conversation is created
(`session/new`); `session/resume` keeps it, so a later generation does not
send it again. `display_name_sync` updates the displayed name only; it does
not rewrite the persona prompt. Persona packs stay engine-independent
(ADR-0032 F3). The managed customization directory holds only the hook
registration.

## See Also

- [ADR-0057](../adr/0057-antigravity-adapter.md) and
  [ADR-0078](../adr/0078-antigravity-over-acp.md) — decisions
- [ADR-0032](../adr/0032-codex-adapter.md) / [ADR-0033](../adr/0033-permission-model-dual-axis.md)
- Vendor: https://antigravity.google/docs/cli/overview
