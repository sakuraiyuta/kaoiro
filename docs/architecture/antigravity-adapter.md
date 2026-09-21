---
title: Antigravity adapter
description: Why kaoiro drives the Antigravity CLI and how the adapter owns its process and persona boundary.
status: provisional
last_updated: 2026-09-18
related: [protocol, plugin-model, claude-events, codex-exec-events]
---

# Antigravity adapter

<!-- markdownlint-disable MD033 -->

## Purpose

Establishes the **measured** behaviour of the Antigravity CLI (`agy`) in
headless print mode as the substrate of the third engine `antigravity`
([ADR-0057](../adr/0057-antigravity-adapter.md)), and defines its derivation
to kaoiro state ([protocol](../specs/protocol.md)). Paired with
[agent-sdk-events](../reference/engines/claude-events.md) (Claude) and
[codex-sdk-events](../reference/engines/codex-exec-events.md) (Codex).

**Status: provisional** — every claim below marked *(measured)* was observed
on 2026-09-04 with `agy` 1.1.26 (x86-64 Linux, OAuth personal login) on the
development host (the binary self-updated from 1.1.8 to 1.1.26 at the start
of the session, so vendor drift is a live risk and the adapter records the
version it measured against), using `--print` / `--output-format stream-json` runs in a
scratch directory. Claims marked *(unverified)* come from the vendor
changelog or docs and must be re-measured before relying on them. Promote
to `accepted` after the phase-34 Stage A dogfood.

## Why the CLI and not the Python SDK

The issue #181 premise was the Antigravity **SDK**. It is Python-only
(`google-antigravity` 0.1.16, no Node/TS SDK exists), which conflicts with
the TS in-process hosting premise of [ADR-0023](../adr/0023-host-runner-architecture.md)
D3. The CLI `agy` (Go binary, self-updating, already installed on hosts that use
Antigravity) exposes a single NDJSON event stream in headless mode that maps
onto kaoiro's state machine at least as well as `codex exec` does, so the
adapter drives the CLI as a child process and no Python bridge is needed.
The SDK route stays available as a future alternative
(`LocalAgentConfig(system_instructions=…, mcp_servers=[…])`,
`ask_user(handler=…)` policies) but is out of scope.

### System-prompt equivalent (persona personality injection)

`<dir>/.agents/rules/AGENTS.md` is created lazily before the first turn from
the server-pushed persona prompt (personality + footer, ADR-0029 F9) plus
the kaoiro operating preamble (working directory, bridge usage). It is
rewritten before every epoch spawn (issue #377 Stage 2: one `agy` process
per several turns, not per turn) and read by that epoch's spawn.
`display_name_sync` updates the displayed name only; it does not rewrite the
persona prompt. Persona packs stay engine-independent (ADR-0032 F3).

## See Also

- [ADR-0057](../adr/0057-antigravity-adapter.md) — decisions
- [phase-34-antigravity-adapter](../plans/phase-34-antigravity-adapter.md) — implementation plan
- [ADR-0032](../adr/0032-codex-adapter.md) / [ADR-0033](../adr/0033-permission-model-dual-axis.md)
- Vendor: https://antigravity.google/docs/cli/overview ,
  https://antigravity.google/docs/sdk/overview , bundled
  `~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/*.md`
