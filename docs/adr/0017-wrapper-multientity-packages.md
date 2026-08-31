---
title: Wrapper multi-entity package structure (three-layer pnpm workspace)
status: accepted
date: 2026-06-16
opened: 2026-06-16
supersedes: []
superseded_by: null
related_specs: [plugin-model, architecture]
related_adrs: [1, 18, 28, 32]
---

# ADR-0017 — Wrapper Multi-Entity Package Structure

## Status

Accepted (materialised: [phase-13-wrapper-multipackage-restructure](../plans/phase-13-wrapper-multipackage-restructure.md), completed 2026-07-10). The start condition, “after the main functions are in place,” was met when phase-12 was completed, and this was materialised together with the addition of the Codex adapter in [ADR-0032](0032-codex-adapter.md) F1.

Implemented package boundaries (2026-07-10):

- `@kaoiro/wrapper-core` (`wrapper/core`) — transport (`ServerLink` + approval/question wire types) / config loading and validation (`persona.ts`) / CLI argument parsing.
- `@kaoiro/agent-common` (`wrapper/agent-common`) — state machine + envelope generation (`state.ts`), the `EngineAdapter` interface, `PermissionBroker` / `QuestionBroker` (+ `PermissionDecision` / `QuestionDecision`), the common Tool description-layer skeleton (`ToolDescriptor`), and common event types (`AdapterEvent`, etc.).
- `@kaoiro/claude-code` (`wrapper/claude-code`) — renames the old `@kaoiro/wrapper` ([ADR-0023](0023-host-runner-architecture.md) D3). `AgentHost` / SDK adapter / file upload / inter-agent tools / CLI implementation / permission two-axis mapping table (placeholder for [ADR-0033](0033-permission-model-dual-axis.md) F2).
- `@kaoiro/codex` (`wrapper/codex`) — scaffold with only an unimplemented stub (implemented in phase-14).

Note: The “new `wrapper/pnpm-workspace.yaml`” proposed when this ADR was drafted was not adopted; the four packages were added to the existing workspace at the repository root (because pnpm workspaces cannot be nested). `wrapper/package.json` remains as a workspace-external fan-out shim.

## Context

The wrapper is currently a single package, `@kaoiro/wrapper`. In the future we want to add things besides Claude Code (Codex, and further **non-AI entities** such as DB and host-resource monitors). The ultimate goal is to “remotely manage diverse entities and visualise their state as characters.” [plugin-model](../specs/plugin-model.md) already separates adapters (per agent) from filters (agent-independent), and an adapter abstraction also exists in code in `wrapper/src/adapter.ts`. This ADR brings that structure down into physical package structure.

## Decision

Reorganise `@kaoiro/wrapper` into **multiple packages in a pnpm workspace**, divided into **three layers**:

- `wrapper/core` — **entity-independent**: transport / envelope shell + version / identity and persona / connection and state-reporting lifecycle / config / CLI framework.
- Common AI-agent layer (e.g. `wrapper/agent-common`) — state machine, permission, and streaming instructions, shared by claude-code/codex.
- Concrete adapters — `wrapper/claude-code` / `wrapper/codex`, and in the future `wrapper/<非 AI エンティティ>` (DB, host metrics, etc.).

Adapters include core as a `workspace:` dependency. The state machine, permission, and instruction concepts are AI-specific and are not mixed into core (so that non-AI entities do not have to carry AI concepts).

**The start timing is after the main functions are in place** (on 2026-07-10, fulfilment of the start condition was confirmed and phase-13 was decided in [ADR-0032](0032-codex-adapter.md) F1 together with the Codex adapter addition).

### Concrete package boundaries (2026-07-10 addendum, [ADR-0032](0032-codex-adapter.md) F1)

Package boundaries and responsibilities at the time of materialisation:

- **`wrapper/core` (`@kaoiro/wrapper-core`)** — entity-independent: transport / envelope shell + version / identity and persona / connection and state-reporting lifecycle / config / CLI framework (engine-independent parts).
- **`wrapper/agent-common` (`@kaoiro/agent-common`)** — common AI-agent layer: state machine, `EngineAdapter` interface, common Tool description layer ([ADR-0032](0032-codex-adapter.md) F5), permission broker, instruction conversion, and common event types. Shared by Claude / Codex.
- **`wrapper/claude-code` (`@kaoiro/claude-code`)** — concrete Claude Code CLI adapter (renamed from the current `@kaoiro/wrapper`, [ADR-0023](0023-host-runner-architecture.md) D3).
- **`wrapper/codex` (`@kaoiro/codex`)** — concrete Codex CLI adapter (implemented in phase-14).

## Consequences

### Positive

- Provides a place to add new entity types by adding adapters.
- The core = entity-independent boundary is physically guaranteed, allowing expansion toward the broader goal (management of non-AI entities).

### Negative

- Build/distribution ([ADR-0018](0018-runner-distribution.md)) and import paths must be reorganised.

### Neutral

- `wrapper/pnpm-workspace.yaml` already exists as a foundation.
- The server was originally close to entity-independent because it “retains and distributes contents without interpreting them.”

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| Only reorganise folders while keeping a single package | Makes independent adapter builds and distribution (ADR-0018) difficult |
| Two layers (core + adapters), with the AI state machine in core | DBs and monitors would have to carry AI concepts (state machine/permission/instruction) |
| Start immediately | Low priority; prioritise the main functions |

## Related

- spec: [plugin-model](../specs/plugin-model.md).
- Related ADR: [0001](0001-agent-sdk-integration.md); distribution is covered by [0018](0018-runner-distribution.md).
- Unresolved: details of the core boundary, state vocabulary for non-AI entities, and package naming (at implementation time). The broader goal (management and visualisation of entities in general) will be handled separately in a future vision / spec-elicitation.
- Origin: my-idea-brief (scratch note “split wrapper into claude-code/codex, etc.”).
