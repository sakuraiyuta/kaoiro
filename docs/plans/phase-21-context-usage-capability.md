---
title: Phase 21 — Capability-izing Context Usage Display and Retracting Codex Estimated Usage
description: Introduce ext.session_capabilities.supports_context_usage and switch the UI to capability-only gating. Add init/model-switch triggers and guards on Claude; stamp capability=false and remove the dead helper on Codex.
status: done
phase: 21
depends_on: [20]
last_updated: 2026-07-16
---

# Phase 21 — Capability-izing Context Usage Display and Retracting Codex Estimated Usage

## Goal

Implement [ADR-0040](../adr/0040-context-usage-capability.md). Keep the existing
`ext.context` inline shape unchanged while establishing UI gating on the
three-state (absent / false / true) capability
`ext.session_capabilities.supports_context_usage`. Claude adds capability=true
and init/model-switch triggers; Codex stamps capability=false and removes dead
code. Retract the old fixed wording, “retrieved after the first response.”

## Acceptance Criteria

- [x] Add optional `supports_context_usage?: boolean` to
      `SessionCapabilitiesExt` in `protocol/src/index.ts`. Extend the open
      schema like the existing 5 fields, and document the tri-state contract
      (absent / false / true) in JSDoc.
- [x] Add the three-state contract for `supports_context_usage` to the
      session_capabilities section of `docs/specs/protocol.md` L134-145
      (distinguish absent during rolling upgrade from explicit false, and explain
      why Claude=true / Codex=false).
- [x] `wrapper/claude-code/src/host.ts`:
  - Add `supports_context_usage: true` to `initialStatusExt()`.
  - Add `#contextInflight` / `#contextRefreshPending` /
      `#contextGeneration` fields.
  - Rewrite `#refreshContextUsage()`: inflight guard + generation guard + dedup
      + close guard + finally re-kick.
  - Add `#refreshContextUsageForInit()`: one retry with init + 100ms backoff,
      bounded so it does not cross close/generation.
  - Fire `#refreshContextUsageForInit()` immediately after `#applyInitMeta`.
  - After successful `setModel`, do `#contextGeneration++` + `#context=null` +
      `#emitState` + async re-fetch.
- [x] Update `wrapper/claude-code/test/host.test.ts`:
  - Add `supports_context_usage: true` to the existing `initialStatusExt` /
      capabilities matcher.
  - Add 4 tests: refresh immediately after init, bounded init retry, dedup, and
      setModel generation management (197 tests pass in total).
- [x] Add `supports_context_usage: false` to
      `initialStatusExtFromCatalog` in `wrapper/codex/src/host.ts`.
- [x] Remove the dead `threadEventToUsage` from `wrapper/codex/src/adapter.ts`.
      Also remove its export from `wrapper/codex/src/index.ts` and the related
      test from `wrapper/codex/test/adapter.test.ts`.
- [x] Update `wrapper/codex/test/host.test.ts`: add
      `supports_context_usage: false` to the capability matcher and add an
      all-envelope check that “Codex never stamps `ext.context`” (80 tests pass
      in total).
- [x] Retract “reflect usage (tokens) into ext” from the `usage` description at
      L48 and `turn.completed` state derivation at L84 of
      `docs/specs/codex-sdk-events.md`; instead advertise
      `ext.session_capabilities.supports_context_usage=false`.
- [x] Add Codex handling of `ext.context` (directly attached by the adapter,
      see ADR-0040) to `docs/specs/plugin-model.md` L32-37.
- [x] `dashboard/src/lib/protocol.ts`:
  - Add `supports_context_usage?: boolean` to `SessionCapabilities`, with a
      JSDoc note for the three-state UI contract.
  - In the `sessionCapabilitiesFrom` parser, retain booleans only and drop
      malformed values (equivalent to fail-closed absent).
- [x] `dashboard/src/lib/AgentDetail.svelte`:
  - Rewrite the context row as a capability-driven three-state branch
      (true+value / `true+null` / false).
  - Hide the row itself for `undefined` (rolling-upgrade support).
  - Retract the old fixed wording “retrieved after the first response”; use
      “retrieving” for true+null.
- [x] Add parser tests for tri-state retention + malformed drop to
      `dashboard/test/protocol.test.ts`.
- [x] Add `dashboard/test/contextUsageDisplay.integration.test.ts` (5 tests):
      inspect the 4 states (true+null / true+value / false / absent) by mounting
      AgentDetail, and test consistency without branching on engine name.
- [x] Update the fresh-idle test fixture in
      `dashboard/test/modelSwitch.integration.test.ts` to
      `supports_context_usage: true`, and assert removal of the old fixed
      wording “retrieved after the first response” (191 tests pass in total).
- [x] Leave the Elixir-side `wrapper_channel.ex` / `agents_channel.ex` unchanged
      (ext is opaque; existing viewer-confidentiality tests are shape-insensitive
      and therefore non-regression).

## Progress

| Task | Status | Details |
|---|---|---|
| 21-1 | ✅ | Add capability field to protocol.ts + synchronize docs/specs/protocol.md (commit e2f63a7) |
| 21-2 | ✅ | Claude wrapper: capability stamp + 3 triggers (init [initial+retry] / result / model-switch) + 5 guards (inflight / pending re-run / generation / dedup / close) + 4 tests (commit 9bf4581) |
| 21-3 | ✅ | Codex wrapper: capability=false stamp + dead helper removal + spec docs synchronization (commit 2e66794) |
| 21-4 | ✅ | UI: engine-neutral three-state gating + 6 tests (commit 0604ff5) |
| 21-5 | ✅ | ADR-0040 + phase-21 plan (commit fd6dd60) |
| 21-6 | ✅ | Fuji turn-5 review follow-up: R1 (remove stale context on partial model-switch failure) + R2 (tighten dedup test) + R3 (throw-based init retry test) + wording correction in the plan |

## Post-implementation

The behavior of Claude's `getContextUsage()` immediately after init is a
reasonable estimate based on d.ts measurement, and the expected return value
with `totalTokens > 0` remains a candidate for separate real-device dogfood
verification (ADR-0040 D6). If Codex upstream finalizes `token_count` /
compaction telemetry, ADR-0040 may be superseded based on this phase's design.

## References

- [ADR-0040](../adr/0040-context-usage-capability.md) — design decision for this phase
- [ADR-0034](../adr/0034-session-capabilities-advertisement.md) F3 — capability-only decision principle
- Original conversations: `fb40967b` (implementation orchestration), `f4834340` (kickoff review)
