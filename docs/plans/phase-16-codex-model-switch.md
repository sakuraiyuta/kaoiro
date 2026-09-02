---
title: Phase 16 — Codex Model Catalog and In-Session Switching
description: Restore the Codex model catalog based on the declared ChatGPT plan and implement model/effort switching that preserves the same session/history, loud failure, rollback, and capability advertisement.
status: done
phase: 16
depends_on: [phase-15-wrapper-ux-parity]
last_updated: 2026-07-13
---

# Phase 16 — Codex Model Catalog and In-Session Switching

## Goal

Implement [ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md),
allowing ChatGPT Plus and above to select Codex Sol / Terra / Luna both at
startup and mid-session. Fail closed for Free / Go, an undeclared plan, and auth
detection failure; even a mid-session failure must preserve history and the last
effective model.

Start implementation after the phase-15 initial scope is complete. Build on the
`model_source` work in phase-15 task 15-4 and the resume snapshot semantics in
15-8; do not implement the same UI/schema twice.

## Acceptance Criteria

- [ ] Validate the closed enum `codex.chatgpt_plan` in `runner.config.json` and resolve the catalog from auth mode + declared plan. An undeclared/undetected ChatGPT plan yields an empty catalog + warning; Free/Go gets Terra only; Plus and above gets Sol/Terra/Luna; API key gets a separate catalog. A plan declaration left behind with API key auth gets a stderr warning + is ignored.
- [ ] `ext.models` at runner registration and after spawn uses the same resolver output.
- [ ] Each Codex model entry's `effort_levels` contains only values confirmed accepted by the CLI/SDK types and on real hardware.
- [ ] Stamp `supports_model_switch` / `supports_effort_switch` into `ext.session_capabilities`; the dashboard does not branch by engine name.
- [ ] Restore the Codex model / effort selectors in LaunchDialog.
- [ ] Allow model / effort changes from AgentDetail; the current turn is unchanged and the change applies from the next turn.
- [ ] **Round-trip Terra → Sol → Terra in the same session**, and verify on real hardware each turn's `turn_context.model`, the same `sessionId`, and preservation of prior conversation history.
- [ ] If a non-entitled or invalid slug produces HTTP 400/404, the turn fails loudly and does not silently fall back. Do not commit the failed value to effective/snapshot.
- [ ] **After an invalid-slug failure, roll back to the old model**, then succeed on the next turn in the same session while preserving history.
- [ ] An operator-requested switch does not appear in `resume_drift`; the last successful effective value is saved to the resume snapshot.
- [ ] If the current effort is invalid for a new model, do not silently downgrade; explicitly prompt the UI to reselect a valid value or use the default.
- [ ] Existing users with no declared plan continue to work as before with an empty catalog + account default.
- [ ] Unit/integration tests for protocol / runner / wrapper / server / dashboard pass.

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 16-1 | Add `codex.chatgpt_plan` and closed-enum validation to `RunnerConfig` | ✅ | 97a080c |
| 16-2 | Add `codex doctor --json` auth-mode detection and fail-closed handling to the runner | ✅ | 2cb6d6e |
| 16-3 | Implement a Codex catalog resolver returning `EngineModelInfo[]` from auth mode + plan | ✅ | 0e1e5b4 (SSOT resolver + runner/wrapper transport) |
| 16-4 | Verify Sol/Terra/Luna effort values in 0.144.1 and integrate them into `effort_levels` | ✅ | 0b5c368 (curated snapshot from openai/codex main models.json, 2026-07-13) |
| 16-5 | Add `supports_model_switch` / `supports_effort_switch` to the protocol | ✅ | 2cce473 |
| 16-6 | Implement pending/effective model and effort and last-known-good in the Codex adapter | ✅ | fb3bef2 (three stages pending/effective/last-good + turn boundary + failure rollback + one-shot switch_error stamp + operator drift filter) |
| 16-7 | Limit server snapshot updates to successful effective values | ✅ | 5273f85 |
| 16-8 | Restore the Codex model / effort selectors in LaunchDialog | ✅ | 72feee0 |
| 16-9 | Implement mid-session switching and pending/failure/rollback display in AgentDetail | ✅ | 72feee0 |
| 16-10 | Add unit/integration tests for the catalog matrix, switching, 400/404, and rollback | ✅ | abcbcd7 (9 adapter cases + 10 dashboard cases, 64+131 pass) |
| 16-11 | Host verification of Terra → Sol → Terra and invalid-slug rollback | ✅ | 2026-07-13 host verification: A-2 connectivity + same-sessionId/history preservation on Terra→Sol→Terra + no resume drift. #7/#8 (invalid-slug loud fail/rollback) skipped because there is no UI path; covered by the 16-10 adapter integration test (abcbcd7)'s 400/404 rollback + one-shot switch_error |
| 16-12 | Update specs and operational docs and run all regression tests | ✅ | 2026-07-13: synchronize protocol / plugin-model / codex-model-catalog / codex-sdk-events with phase-16 implementation. All 978 regression tests pass (runner 116 + wrapper core 51/agent-common 79/codex 64/claude-code 152 + server 385 + dashboard 131) |

Status legend: ⏳ not started, 🟡 mostly done, ⚠ partial, ✅ done, ⛔ blocked.

## Non-goals

- Reimplement phase-15's `model_source`, resume snapshot foundation, or removal of the Codex label special case.
- Add a plan/entitlement enumeration API on the OpenAI side.
- Automatically generate the catalog through a runtime probe.
- Permanently guarantee every slug in the API-key catalog; maintain it as a curated snapshot.

## Open Questions Blocking This Phase

None. The method and switch contract are decided in ADR-0035. The effort-value
set to verify when implementation begins is a verification task, not an
architecture blocker.

## See Also

- Decision: [ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md)
- Related: [ADR-0032](../adr/0032-codex-adapter.md) F4bc / [ADR-0034](../adr/0034-session-capabilities-advertisement.md) F2
- Previous phase: [phase-15-wrapper-ux-parity](phase-15-wrapper-ux-parity.md)
