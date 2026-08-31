---
title: Phase 24 — Explicitly declaring Codex auth mode in runner config
description: Resolve the regression blocking Phase 23 dogfood re-reverification (23-9)—a missing codex binary on runner PATH makes `detectCodexAuthMode` fail, the catalog empty, and both buttons hidden—by adding an explicit runner-config path for `codex.auth_mode?: 'chatgpt' | 'apikey'`. Priority is explicit config > doctor detection > "unknown"; implicit inference from chatgpt_plan is forbidden. Preserve old config compatibility (unspecified retains the current doctor fallback).
status: done
phase: 24
depends_on: [23]
last_updated: 2026-08-02
---

# Phase 24 — Explicitly declaring Codex auth mode in runner config

## Goal

Resolve the direct cause that blocked Phase 23's dogfood re-reverification
(23-9): when the runner environment has no `codex` binary on PATH,
`detectCodexAuthMode` fails with ENOENT, the catalog becomes empty, and both
buttons (model / effort switch) are hidden. Add an explicit declaration path
for `codex.auth_mode?: 'chatgpt' | 'apikey'` in runner config and standardize
the priority as `explicit config > doctor detection >
"unknown"`.

Add the auth-mode decision priority to
[ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md#auth-mode-決定の-priority-phase-24-追補2026-07-16),
and record this regression and the Phase 24 dependency in the Risks / 23-9
note of the Phase 23 [plan](phase-23-resume-model-effort-restoration.md).

## Scope

**Add**:

- An optional `auth_mode?: 'chatgpt' | 'apikey'` field to
  `runner/src/config.ts::CodexConfig`, with closed-enum validation in
  `parseRunnerConfig`.
- An injectable policy resolver `resolveCodexAuthMode(input)` in
  `runner/src/codex-auth.ts` (async; the priority policy is pure and the
  default `detect` binding performs doctor I/O). Consolidate the priority
  policy for CLI startup and hot reload in the helper.
- Replace the branches in `runner/src/cli.ts::main` startup and `applyReload`
  with helper calls.
- Add a `codex.auth_mode` example to `runner/runner.config.example.json`.

**Out of scope**:

- Change to first-run auto-generation in `scripts/dogfood.sh` (risk of
  misdeclaring an API-key development host; tracked change is limited to the
  example).
- Update untracked `runner/runner.config.json` (after Fuji review passes,
  add auth_mode=chatgpt separately for the master's environment; not a commit
  target).
- Phase 23 effort/model restoration implementation (E-G is fully closed; no
  touch).

## Design decisions (Fuji dogfood diagnosis + corrected policy)

- **D1 priority policy**: `explicit config > doctor detection > "unknown"`.
  When explicit, never invoke `detectCodexAuthMode` (an invariant allowing
  operation without a codex binary on runner PATH).
- **D2 closed enum**: allowed `auth_mode` values are only `"chatgpt"` /
  `"apikey"`. Other values are rejected fail-fast by `parseRunnerConfig`
  (`ConfigError`).
- **D3 forbid implicit inference from `chatgpt_plan`**: an API-key runner may
  retain `chatgpt_plan` in config during an auth switch, so do not use it as
  evidence for `auth_mode`.
- **D4 old-config compatibility**: `auth_mode` is an optional addition. If an
  existing config lacks it, fall back to current doctor detection and use
  `"unknown"` if detection fails. No breakage.
- **D5 five hot-reload transitions**: the helper pins every transition (see
  the `resolveCodexAuthMode` docstring).
  1. next disabled → `"unknown"` (discard previous mode, do not call doctor)
  2. next explicit → adopt verbatim (do not call doctor)
  3. previous explicit → next absent → run doctor again
  4. previous off → next on (absent) → run doctor
  5. previous on (absent) → next on (absent) → retain previous mode (do not
     call doctor)
- **D6 thin CLI branching**: CLI startup + `applyReload` only call the helper.
  Pin the branches in helper unit tests (Fuji instruction 4: if directly
  testing main is difficult, extract an async pure/injectable resolver to
  codex-auth.ts or similar and unit-test startup/reload policy).
- **D7 continue not relaying doctor output / credentials**: Inside
  `detectCodexAuthMode`, do not relay `runCodexDoctor` stdout / stderr except
  extracting the `stored auth mode` field through `parseCodexAuthMode`.
  `resolveCodexAuthMode` also retains no doctor output (unchanged in Phase 24).
- **D8 security posture**: `auth_mode` is declaration metadata only for catalog
  selection; runner neither supplies nor changes credentials (OAuth token / API
  key, Codex credential store / environment). It is therefore not an
  escalation. A wrong declaration can diverge from real entitlements, and an
  explicit unsupported model / effort request can fail loudly in the SDK and
  reach the existing switch_error rollback (`turn_failed`). Whether the auth
  reality produces an invalid-credentials error depends on the runtime
  credential store / SDK implementation and cannot be concluded from config
  alone.
- **D9 no scripts/dogfood.sh change**: unconditionally adding
  `"codex":{"auth_mode":
  "chatgpt"}` to first-run auto-generation risks
  misdeclaring an API-key development host. Keep the tracked change to
  `runner.config.example.json` and have the operator edit per environment.

## Acceptance Criteria

- [x] Add optional `auth_mode?: "chatgpt" | "apikey"` to
      `runner/src/config.ts::CodexConfig` and closed-enum validation in
      `parseRunnerConfig`.
- [x] Export the injectable policy resolver `resolveCodexAuthMode(input)` from
      `runner/src/codex-auth.ts`, unifying startup and hot-reload paths with an
      `AuthModeResolveInput` interface (pure priority policy, default `detect`
      binding performs doctor I/O).
- [x] Replace `runner/src/cli.ts::main` startup (`await detectCodexAuthMode()`
      → `await resolveCodexAuthMode({...})`) and `applyReload` (the old
      three-branch if → helper call).
- [x] Add a tracked `codex.auth_mode` example to
      `runner/runner.config.example.json`.
- [x] Add startup + all hot-reload transition pins for `resolveCodexAuthMode`
      to `runner/test/codex-auth.test.ts` (Codex disabled / explicit chatgpt /
      explicit apikey / absent + doctor / forbidden inference from plan / five
      hot-reload transitions; related suite passes).
- [x] Add three `codex.auth_mode` closed-enum pins to
      `runner/test/config.test.ts`: accept `chatgpt` / `apikey`, fail-fast on an
      unknown value, and preserve old config compatibility (absent).
- [x] The existing Codex-auth-mode wrapper relay pin in
      `runner/test/supervisor.test.ts` has no behavior change in Phase 24 (the
      existing test continues to pass).
- [x] Docs: add the auth-mode decision-priority section to ADR-0035 and record
      this regression and Phase 24 dependency in the Risks / 23-9 note of the
      Phase 23 plan.
- [x] All package typechecks (protocol / core / agent-common / codex /
      claude-code / runner) clean; retain the existing Phase 23 fixes
      (D+E+F+G+R4-R6) without changes.
- [ ] End-to-end manual verification (dogfood): after adding
      `"codex": {"auth_mode": "chatgpt"}` to the master's untracked
      `runner/runner.config.json`, visually confirm after dogfood.sh restart
      that both Codex buttons (model + effort switch) appear. Also perform the
      Phase 23 23-9 dogfood (the full D+E+F+G+R4-R6+Phase 24 verification).

## Tasks

| id | subject | status | note |
|---|---|---|---|
| 24-1 | protocol/config: add closed-enum `auth_mode?` to `RunnerConfig.CodexConfig` | ✅ | Optional for old-config compatibility |
| 24-2 | Extract injectable policy resolver `resolveCodexAuthMode` in `codex-auth.ts` + use it from cli.ts | ✅ | Pure function for priority, default `detect` binding for doctor I/O. Thin CLI branches, helper unit tests provide pins |
| 24-3 | runner tests: config schema + resolver startup / all hot-reload transitions + recheck wrapper relay + resolve empty-catalog regression | ✅ | Related suites pass |
| 24-4 | Add an `auth_mode` example to `runner.config.example.json` (no `scripts/dogfood.sh` change) | ✅ | Avoid development-host misdeclaration |
| 24-5 | docs: new phase-24 plan + ADR-0035 auth-mode decision section + Phase 23 Risks/23-9 addition | ✅ | Do not force an addition to protocol.md |
| 24-6 | All package typechecks / tests / diff --check | ✅ | Confirm no Phase 23 code changes |
| 24-7 | Manual dogfood verification | ⏳ | Pending master real-device verification (after untracked config update) |

Status legend: ⏳ not started, 🟡 mostly done, ⚠ partial, ✅ done.

## Risks

- **UX degradation from an incorrect explicit declaration**: If the operator
  declares `apikey` and selects a chatgpt-only model (SOL, etc.), the SDK
  rejects it and the existing `switch_error
  rollback` (`turn_failed` reason,
  host.ts `#finishTurn`) recovers. Some invalid pairs are hidden in advance by
  Phase 23 E-G tier 4 (concrete-miss fail-closed). The remaining scenario where
  the button makes the choice appear available is accepted as an operator
  “try and verify” experience.
- **Do not deprecate the doctor path**: automatic detection remains useful when
  a codex binary is on PATH, so doctor detection stays as the fallback. ADR-0035
  explicitly recommends declaration as the preferred form.
- **Hot-reload five-transition semantics**: centralizing them in the helper
  narrows the CLI regression surface; resolver unit tests pin all transitions.
  Integration from “edit real file → watcher → applyReload” is not pinned
  (config-watcher.test.ts tests the watch loop itself). Keep this as a held
  regression surface of the existing hot-reload path; add an integration test in
  a separate patch if needed.
- **Default value in scripts/dogfood.sh auto-generation**: Do not include
  `auth_mode` in first-run auto-generation to avoid misdeclaring an API-key
  development host (Fuji instruction). Keep the tracked change to
  `runner.config.example.json` and have the operator edit per environment.
- **Untracked `runner/runner.config.json`**: Add `auth_mode=chatgpt` separately
  after Fuji review passes for the master's environment; do not commit it.
  Treat it as environment-local metadata (not credentials).
- **Security trust boundary**: `auth_mode` is declaration metadata for catalog
  selection only and contains no credentials. Inherit ADR-0035's existing trust
  boundary (“the credential itself is managed by the Codex CLI and is not put in
  runner config”). No escalation risk from a wrong declaration.

## Progress log

- 2026-08-02: closed by the master's decision after dogfood verification OK
  (status: done)
