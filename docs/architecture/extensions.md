---
title: Extensions
description: The adapter and filter extension points, their common event boundary, and the package structure that keeps core agent-independent.
status: accepted
last_updated: 2026-09-19
related: [protocol, adapter-contract, claude-model-catalog]
---
<!-- markdownlint-disable MD033 -->

# Extensions

## Purpose

Defines two extension points (adapters / filters) and the common event boundary
into which both are inserted. Overall composition is in
[architecture](system-overview.md).

## Definition

### Two extension points — design them separately

| Extension point | Role | Nature |
|---|---|---|
| **Adapter (per agent)** | Startup/control, native output → common-event translation and state derivation, reverse transformation of instructions | Dedicated interface holding process lifecycle and protocol translation. Claude Code version is an Agent SDK implementation ([ADR-0001](../adr/0001-agent-sdk-integration.md)) |
| **Filter (supplemental processing)** | Add properties to normalized common events (emotion, cost, hazard detection) | Agent-agnostic, ordered pipeline |

- Support for a future Codex, etc. is inserted as an **adapter** → **2026-07-10
  update**: The Codex adapter became an implementation target in
  [ADR-0032](../adr/0032-codex-adapter.md) and was implemented in
  [phase-14-codex-adapter](../plans/phase-14-codex-adapter.md).
- Filters operate only on common events, so the same filter sequence can be
  reused with any agent.
- This separation is essential to making “core = agent independent” work.
- Examples of additional properties: `ext.cost` (cumulative USD cost, #8,
  attached to result) and `ext.model` / `ext.context` / `ext.rate_limits`
  (attached to state_change when an adapter can observe them). Because the
  filter sequence is unimplemented, adapters attach these fields directly.
  Context usage remains engine-specific; model and rate-limit snapshots can
  come from more than one adapter. Move generalizable `cost`, etc. into
  agent-agnostic filters when the filter mechanism is introduced.
  - **Codex treatment of `ext.context`**
    ([ADR-0040](../adr/0040-context-usage-capability.md), phase-21): The Codex
    adapter does **not stamp** `ext.context` (because
    `turn.completed.usage.input_tokens` is only per-turn input and not context
    utilization; it does no estimated projection either). Instead it explicitly
    stamps `ext.session_capabilities.supports_context_usage=false`; UI decides
    “unsupported” only from capability (engine-name branching is prohibited,
    [ADR-0034](../adr/0034-session-capabilities-advertisement.md) F3). Claude
    stamps the same field `true`.

### Common event boundary

The boundary into which adapters and filters are inserted is itself the common
event / envelope ([protocol](../specs/protocol.md)).

```
[Agent native] --(Adapter: SDK→common)--> [Common event v0]
  --(Filter chain)--> [Server(状態保持)] --> [Client]
```

### Package structure and entity extension

The adapter/core separation is made a physical boundary as **three layers of
pnpm-workspace packages** ([ADR-0017](../adr/0017-wrapper-multientity-packages.md),
materialized by [phase-13-wrapper-multipackage-restructure](../plans/phase-13-wrapper-multipackage-restructure.md),
and settled in [ADR-0032](../adr/0032-codex-adapter.md) F1): entity-independent
core (`wrapper/core`) / AI-agent common layer `wrapper/agent-common` (state
machine, permission, instruction, `EngineAdapter` interface, common Tool
description layer) / concrete adapters (`wrapper/claude-code`,
`wrapper/codex`, `wrapper/antigravity` ([ADR-0057](../adr/0057-antigravity-adapter.md) F1),
and future databases, host monitors, etc.). State machine,
permission, and instruction are AI-specific and do not go in core. The eventual
aim is to visualize the state of diverse entities as characters, not just AI
(the broader aim is covered separately in vision).

`EffectiveStatusSnapshot` in `agent-common` is SoT for effective-configuration
projection in both AI adapters. Each host assembles `resolved: ResolvedSnapshotExt`
and engine-neutral `permission` once from engine-specific state; a common helper
projects them into the respective wire shapes of `state_change.ext` and
read-only `whoami`. It is a boundary preventing status fields being implemented
twice per adapter and omitted from one; unknown fields are omitted from both
paths.

## Constraints

- MUST: Filters may touch only `payload` / `ext`; do not over-depend on the outer
  envelope (`version`, `agent_id`, `ts`, `type`, `state`).

## See Also

- Related specs: [architecture](system-overview.md), [protocol](../specs/protocol.md)
- ADRs: [0001](../adr/0001-agent-sdk-integration.md), [0037](../adr/0037-claude-model-catalog-live-refresh.md)
