---
title: Phase 13 — Materialize the Wrapper Multi-Package Structure
description: Implement the three-layer pnpm workspace from ADR-0017 and rename @kaoiro/wrapper to @kaoiro/claude-code. Preserve existing Claude behavior completely.
status: done
phase: 13
depends_on: [phase-12-runner-persona-trust-mode]
last_updated: 2026-07-10
---

# Phase 13 — Materialize the Wrapper Multi-Package Structure

## Goal

Materialize the “three-layer pnpm workspace for the wrapper: `core` +
`agent-common` + `claude-code` + `codex`” that [ADR-0017](../adr/0017-wrapper-multientity-packages.md)
had left on hold as Accepted (deferred), based on F1 of
[ADR-0032](../adr/0032-codex-adapter.md). This phase only moves physical
boundaries and completely preserves existing Claude behavior (the Codex
implementation is handled in the next phase).

## Acceptance Criteria

- [x] Split into three packages: `wrapper/core`, `wrapper/agent-common`, and
  `wrapper/claude-code` (`wrapper/codex` is only a stub scaffold in this phase).
  Implement the workspace by adding four packages to the repository root's
  `pnpm-workspace.yaml` (pnpm workspaces cannot be nested, so this changes the
  planned “create wrapper/pnpm-workspace.yaml”; retain `wrapper/package.json` as a
  non-member fan-out shim).
- [x] Rename the current `@kaoiro/wrapper` to `@kaoiro/claude-code`. Classify and
  move the existing `wrapper/src/*`.
- [x] Define the `EngineAdapter` interface in `wrapper/agent-common` (promote the
  `AgentHost` operation surface to an interface and statically enforce it with
  `AgentHost implements EngineAdapter`).
- [x] Move transport / persona / config / CLI argument parsing (engine-independent
  parts) to `wrapper/core`. Keep cli.ts itself on the `claude-code` side because
  its wiring to AgentHost is engine-specific (decide whether to extract an engine-
  neutral CLI shell when implementing the Codex CLI in phase-14).
- [x] All existing tests (263 across wrapper) pass 100% (split into core 49 /
  agent-common 52 / claude-code 162).
- [x] Update `require.resolve` in `runner/src/spawn.ts` to `@kaoiro/claude-code`
  (both dist / dev tsx paths), with the existing spawn behavior unchanged. All 79
  runner tests also pass.
- [x] Zero changes to dashboard / server / protocol packages (behavior unchanged
  from the outside).
- [x] Update `wrapper/README.md` to describe the new package structure (three
  layers + Codex scaffold).

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 13-1 | Scaffold four packages (`core` / `agent-common` / `claude-code` / `codex`) | ✅ | Add members to the repository root's `pnpm-workspace.yaml` because pnpm workspaces cannot be nested (changes the planned “create wrapper/pnpm-workspace.yaml”). Convert `wrapper/package.json` to a fan-out shim |
| 13-2 | Move transport / persona / config / CLI argument parsing to `wrapper/core` | ✅ | Also move the approval/question wire types (`PermissionDecisionMessage` / `QuestionResponseMessage`) to transport to eliminate the core→agent-common reverse dependency. Keep cli.ts on the claude-code side because its wiring is engine-specific |
| 13-3 | Move the state machine / permission broker / question broker / common event types to `wrapper/agent-common` | ✅ | Move `PermissionDecision` / `QuestionDecision` from host.ts to the broker side |
| 13-4 | Define the `EngineAdapter` interface in `wrapper/agent-common` | ✅ | `engine.ts`; statically enforce with `AgentHost implements EngineAdapter` |
| 13-5 | Prepare the common Tool description layer (JSON Schema + handler pair) skeleton in `wrapper/agent-common` | ✅ | `tooling.ts` (`ToolDescriptor` / `ToolResult`); foundation for moving inter-agent tools in phase-14 |
| 13-6 | Place Claude-specific implementation in `wrapper/claude-code` | ✅ | Move host / adapter / upload / history / inter_agent / cli. Implement the dual-axis mapping table through the ADR-0033 F2 values in `permission_axes.ts` (wire it to the envelope in phase-14) |
| 13-7 | Scaffold `wrapper/codex` package.json | ✅ | Only an unimplemented `CodexHost implements EngineAdapter` stub |
| 13-8 | Split all 263 existing wrapper tests along the new package boundaries and pass them all | ✅ | core 49 / agent-common 52 / claude-code 162 |
| 13-9 | Update the resolution target in `runner/src/spawn.ts` to `@kaoiro/claude-code` | ✅ | Both dist / dev (`KAOIRO_WRAPPER_DEV=1` tsx) paths + workspace dependency in `runner/package.json`; runner's 79 tests pass |
| 13-10 | Update `wrapper/README.md` to describe the new package structure | ✅ | Responsibilities and dependency graph for four packages (Mermaid) |
| 13-11 | Update ADR-0017 Status to materialised and note package-boundary details | ✅ | Also record the deviation to a root workspace |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## Followups (in-phase but unfinished)

None (this phase only moves boundaries and adds no implementation).

## Open Questions Blocking This Phase

None. This phase only moves boundaries; Q1–Q6 are all gates on the phase-14 side.

## See Also

- Specs covered: [plugin-model](../specs/plugin-model.md), [architecture](../specs/architecture.md)
- Related ADRs: [ADR-0017](../adr/0017-wrapper-multientity-packages.md) (materialization target), [ADR-0023](../adr/0023-host-runner-architecture.md) D3 (rename `@kaoiro/wrapper` → `@kaoiro/claude-code` in this phase), [ADR-0032](../adr/0032-codex-adapter.md) F1 (origin of this phase)
- Previous phase: [phase-12-runner-persona-trust-mode](phase-12-runner-persona-trust-mode.md)
- Next phase: [phase-14-codex-adapter](phase-14-codex-adapter.md)
