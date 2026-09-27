---
title: Phase 1 — Single Wrapper + State Machine
description: Host the Agent SDK in a TypeScript wrapper and derive and verify the state of one agent.
status: done
phase: 1
depends_on: [phase-0-project-setup]
last_updated: 2026-09-27
---

# Phase 1 — Single Wrapper + State Machine

## Goal

Host the Claude Agent SDK in a TypeScript wrapper and verify that the state of one Claude Code
agent can be reliably derived into the state machine defined by the
[protocol](../reference/protocol/state-machine.md#state-machine-state-set-v0-draft).

## Acceptance Criteria

- [x] Derive idle/thinking/tool_running/waiting_permission/waiting_input/done/error
      from the SDK message sequence (confirmed in a live run)
- [x] Treat permission waiting as pending through `PreToolUse`/`canUseTool` (ask path
      confirmed firing 2026-06-11, issue #1; see [agent-sdk-events](../reference/engines/claude-events.md#permission-callback-canusetool))
- [x] Read the persona and stable ID from the wrapper's initial configuration
- [x] Verify that state follows live behavior (confirmed with minimal text/color output)

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1-1 | Confirm SDK details from the official docs | ✅ | Finalized in [agent-sdk-events](../reference/engines/claude-events.md) |
| 1-2 | Adapter (SDK messages → common envelope) | ✅ | `wrapper/src/adapter.ts` (`sdkMessageToEvents`). Real SDK types → `AdapterEvent`. Unit-tested |
| 1-3 | Implement the state machine | ✅ | `wrapper/src/state.ts` (`deriveStates`/`reduceStates`). Unit-tested |
| 1-4 | Load persona and stable ID configuration | ✅ | `wrapper/src/persona.ts` (`loadConfig`/`parseConfig`). Unit-tested |
| 1-5 | SDK host wiring + live-run confirmation | ✅ | `wrapper/src/host.ts` (`query`/streaming/`interrupt`/`canUseTool`) + `cli.ts`. Confirmed in a live run that state follows behavior, including live driving of `waiting_permission` (2026-06-11, issue #1; below) |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## Followups (in-phase but unfinished)

None. Live driving of `waiting_permission` was confirmed 2026-06-11 (issue #1):
`canUseTool` fires for an operation escalated to ask (verification note:
[agent-sdk-events](../reference/engines/claude-events.md#permission-callback-canusetool)).

## Open Questions Blocking This Phase

None (resolved by [ADR-0010](../adr/0010-protocol-precisification.md)).

## See Also

- Specs: [protocol](../architecture/message-topology.md),
  [agent-sdk-events](../reference/engines/claude-events.md),
  [architecture](../architecture/system-overview.md),
  [extensions](../architecture/extensions.md)
- ADRs: [0001](../adr/0001-agent-sdk-integration.md),
  [0003](../adr/0003-persona-identity-persistence.md)
- Previous: [phase-0-project-setup](phase-0-project-setup.md)
