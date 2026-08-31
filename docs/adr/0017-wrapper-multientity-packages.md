---
title: wrapper multi-entity package structure (3 layers pnpm workspace)
status: accepted
date: 2026-06-16
opened: 2026-06-16
supersedes: []
superseded_by: null
related_specs: [plugin-model, architecture]
related_adrs: [1, 18, 28, 32]
---

# ADR-0017 — wrapper multi-entity package structure

## Status

Accepted (materialised: [phase-13-wrapper-multipackage-restructure](../plans/phase-13-wrapper-multipackage-restructure.md), 2026.-10 completed). When phase-12 is completed, materialise was added to [ADR-0032](0032-codex-adapter.md) F1.

Implemented Package Boundaries (2026 -10):

- `@kaoiro/wrapper-core` (`wrapper/core`) — transport (`ServerLink` + approval/question wire type) / config read/verify (`persona.ts`) / CLI argument analysis.
- `@kaoiro/agent-common` (`wrapper/agent-common`) — state machine + envelope  generation (`state.ts`), `EngineAdapter` interface, `PermissionBroker` / `QuestionBroker` (+ `PermissionDecision` / `QuestionDecision`), common tool description layer skeleton (`ToolDescriptor`), common event type (`AdapterEvent`, etc.).
- `@kaoiro/claude-code` (`wrapper/claude-code`) — renamed the former `@kaoiro/wrapper` ([ADR-0023](0023-host-runner-architecture.md) D3 execution). `AgentHost` / SDK adapter / file upload / inter-agent tools / CLI body / biaxial image table ([ADR-0033](0033-permission-model-dual-axis.md) F2 placeholder).
- `@kaoiro/codex` (`wrapper/codex`) — not implemented stub only scaffold (implemented in phase-14).

Note: This ADR does not contain wrapper/pnpm-workspace.yaml at the time of drafting, and add 4 packages to the existing workspace of repo root (pnpm workspace is not nested). `wrapper/package.json` remains as fan-out shim of non-workspace members.

## Context

Current wrapper is a single package `@kaoiro/wrapper`. Claude Code
(Codex, DB, host resource monitor, etc.)**Non-AI Entity**).
The final goal is to “remote management of diverse entities and visualize state as a character”
Comment [plugin-model](../specs/plugin-model.md)
The filter (agent-independent) is separation, and the `wrapper/src/adapter.ts` is also an abstract adapter
On the code. This ADR falls into a physical package structure.

## Decision

`@kaoiro/wrapper`**Multi-package of pnpm workspace****3 layers**Note
Share:

- `wrapper/core` — **Entity Independence**: Transport / Envel  Outer Frame +version /
identity / persona / connection / state report lifecycle / config / CLI frame.
- AI agent common layer (e.g. `wrapper/agent-common`) — state machine, permission,
streaming instruction. claude-code/codex
`wrapper/claude-code``wrapper/codex`
`wrapper/<the relevant entry AI Note>`

The adapter takes the core as `workspace:` dependencies. The state machine, permission, and instruction
AI-specific and not mixed into the core (because non-AI entities do not bear the AI concept).

**The start timing is the main function**(Decided phase-13 implementation with [ADR-0032](0032-codex-adapter.md) F1).

### [ADR-0032](0032-codex-adapter.md) F1)

package boundary and responsibility at materialise:

- **`wrapper/core` (`@kaoiro/wrapper-core`)**— Entity Independence: Transport/Envel  Outer Frame+version/Identity/persona/connection/state Reporting Lifecycle/config/cli Framework ( CLI Independence).
- **`wrapper/agent-common` (`@kaoiro/agent-common`)**— AI agent common layer: state machine, `EngineAdapter` interface, common tool description layer ([ADR-0032](0032-codex-adapter.md) F , permission broker, instruction conversion, common event type. Claude / Codex
- **`wrapper/claude-code` (`@kaoiro/claude-code`)**[ADR-0023](0023-host-runner-architecture.md) D3
- **`wrapper/codex` (`@kaoiro/codex`)**— Codex CLI specific adapter (implemented in phase-14).

## Consequences

### Positive

- You can add new entities to your adapter.
- Core-entity non-dependent is bound to physical boundary and can be extended to a wide target (non-AI management).

### Negative

- Re ation of build/ bution ([ADR-0018](0018-runner-distribution.md))/import route is required.

### Neutral

- `wrapper/pnpm-workspace.yaml` already exists.
- The server is originally close to entities non-dependent in "Retention and delivery without interpreting the contents".

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
|Only folder rethe relevant entryation remains single package|Independent build and distribution of adapters (ADR-001)|
|Apply AI state machine to core with two layers (core + adapter)|DB/Mon , etc. shoulder AI concept (state machine/permission/instruction)|
|Get Started|Low priority. Prioritize Key Features|

## Related

- spec: [plugin-model](../specs/plugin-model.md).
-CO ADR: [0001](0001-agent-sdk-integration.md)
  [0018](0018-runner-distribution.md).
- Unresolved: Name the state vocabulary and package of the core line pull details and non-AI entities
(when implemented). Vision /
-elicitation
- Origin: my-idea-efef (run and write wrapper into claude-code/codex, etc.)
