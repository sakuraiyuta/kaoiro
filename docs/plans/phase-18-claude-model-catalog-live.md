---
title: Phase 18 — Unify Claude Model-Catalog Live Verification and Bootstrap Default Floor
description: Reduce BOOTSTRAP to one default entry, unify the Claude live path around SDK verification, and implement the retry contract.
status: done
phase: 18
depends_on: []
last_updated: 2026-07-31
---

# Phase 18 — Unify Claude Model-Catalog Live Verification and Bootstrap Default Floor

## Goal

Implement [ADR-0037](../adr/0037-claude-model-catalog-live-refresh.md) and
restructure the Claude-side catalog so that it can follow new Anthropic models
(such as Sonnet 5) without manually updating the BOOTSTRAP snapshot. Reduce
BOOTSTRAP to the minimum floor of one `default` entry, and make SDK verification
the single source of truth for the `ext.models` path.

Split the implementation into three stages and separate PRs in this order:
SDK upgrade → wrapper changes → client UI support. Phase 18-2 verification
reconfirmed ADR-0037's premise (the default alias resolves to the account-
recommended model) on 2026-07-14; see the Context section of
[ADR-0037](../adr/0037-claude-model-catalog-live-refresh.md) for details.

## Acceptance Criteria

- [x] Upgrade `@anthropic-ai/claude-agent-sdk` in the `wrapper` package to the latest version (equivalent to 0.3.208 or later), and pass the existing test suite
- [x] Record the `supportedModels()` verification result (after the SDK upgrade), and reflect the `model_source` and effective model resolution when passing `model: "default"` in the Context section of [ADR-0037](../adr/0037-claude-model-catalog-live-refresh.md)
- [x] Q1 verification confirms that “`default` resolves to the account-recommended model” (report to the master if ADR-0037 needs reconsideration)
- [x] Reduce `BOOTSTRAP` in `wrapper/claude-code/src/catalog.ts` to one `default` entry, described without a specific model name using `display_name: "Default (recommended)"` + a neutral description (`effort_levels` remains FULL_EFFORT)
- [x] Implement automatic bounded retry (maximum 3 attempts) in `#refreshSupportedModels()`
- [x] Implement a one-shot toast-notification mechanism when the retry limit is reached (derive `ext.models_error` in 18-6 on the wire; implement client toast rendering in 18-10)
- [x] Implement a manual retry control message that the operator can trigger explicitly
- [x] Run persist-alias validation at startup; aliases absent from SDK verification fall back to `default` + emit a notification event
- [x] Place a “Fetch model list again” button inside the model switcher in `AgentDetail.svelte`
- [x] Complete the UI implementation for toast display and persist-alias fallback notification
- [x] Launch the reduced catalog (default only) normally in `LaunchDialog.svelte` (the existing `?? []` fallback should cover it)
- [x] Retry scenarios, persist-alias fallback scenarios, and selecting Sonnet 5 after init (assuming the SDK returns it) pass in wrapper unit / integration / e2e tests (carried through the 18-4/5/6/7/10/12 pins for integration; e2e externalized as Tier C, see the Playwright infrastructure issue in Followups)
- [x] Keep the relevant section (ADR-0037 reference section) of `docs/specs/plugin-model.md` updated with the finalized implementation

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 18-1 | Upgrade `@anthropic-ai/claude-agent-sdk` in `wrapper/package.json` to the latest version (equivalent to `^0.3.208`), and pass the existing test suite | ✅ | Completed 2026-07-14 (commit 93f0e68). Resolved 0.3.187 → 0.3.208; blast radius was only the SDK + 8 platform binaries. Breaking change: `CanUseTool` return changed to `Promise<PermissionResult \| null>`; narrow 7 test calls with `(await ...)!` (14 lines). src (catalog.ts / host.ts) unchanged per F7 |
| 18-2 | Verify the SDK resolution semantics of `model: "default"` empirically and add the result to Q1 | ✅ | Completed 2026-07-14 (alongside commit 93f0e68). Option A confirmed (`default` → `resolvedModel: "claude-opus-4-8[1m]"`). Bonus: demonstrated BOOTSTRAP drift (`sonnet[1m]` / `claude-opus-4-7` disappeared from the SDK; follows Sonnet 5), and detected 5 `ModelInfo` extension fields (`resolvedModel` / `supportsEffort` / `supportsAdaptiveThinking` / `supportsFastMode` / `supportsAutoMode`). Delete the open question in the 18-3 commit and move the empirical basis to the Context section of [ADR-0037](../adr/0037-claude-model-catalog-live-refresh.md) |
| 18-3 | Reduce BOOTSTRAP in `wrapper/claude-code/src/catalog.ts` to one default entry | ✅ | Completed 2026-07-14. Neutral description is `"Account-recommended model · resolved after session start"`; retain FULL_EFFORT for `effort_levels`. Delete `SONNET_EFFORT` as an orphan. Synchronized updates: `wrapper/claude-code/test/host.test.ts` (`initialStatusExt` → `["default"]`) / `runner/test/config.test.ts` (registered models → `["default"]`) / delete open question + add empirical basis to the Context section of [ADR-0037](../adr/0037-claude-model-catalog-live-refresh.md) / follow the relevant section of `docs/specs/plugin-model.md` |
| 18-4 | Implement automatic bounded retry (maximum 3 attempts) in `#refreshSupportedModels()` | ✅ | Completed 2026-07-14 (commit 626e2ec). Separate 3 state fields (`#modelsInflight` / `#modelsRetryCount` / `#modelsSucceeded`), module const `MAX_MODEL_REFRESH_RETRIES = 3`, and fix trial-cap = 3 semantics including init with docstring and test (`callCount === 3` pin). Add a retry trigger to `host.ts:999` (`result` message), driven by turn receipt symmetrically with `#refreshContextUsage()`. At cap, emit one diagnostic breadcrumb line with `process.stderr.write` (no per-retry noise). Align only state naming for 18-5 force refresh and do not add a reset method. Review confirmed fuji's focus (avoid busy loops / align 18-5 counter reset) |
| 18-5 | Add the control-message hook that triggers a manual retry | ✅ | Completed 2026-07-14 (commit 8f60b23). Five layers and 8 files cross-layer, fully additive (164 insertions / 0 deletions). Add `refresh_models` to the protocol control envelope and describe `{ agent_id }` (client→server) and `{}` (server→wrapper) in [protocol.md](../specs/protocol.md). Server `handle_in("refresh_models", ...)` mirrors set_model exactly (guard_against_reset_pending + empty key_checks on relay); require_operator on the relay provides the operator-only guarantee. Add `host.retrySupportedModels()` in 3 lines (`count=0; succeeded=false; void #refreshSupportedModels()`); the naming aligned in 18-4 can be reused directly. Tests: server 4 (operator relay / viewer forbidden / unknown_agent / reset-pending reject) + transport 2 (empty payload / forward-compat) + host 1 (pin a retry → refetch after the cap is silently reached with `callCount === 4`). Review cycle CLEAN at medium tier with 0 findings |
| 18-6 | Implement a one-shot toast-notification mechanism at the retry limit | ✅ | Completed 2026-07-14 (commit 787fe9c). Implement the wire; defer client toast rendering to 18-10. Add `models_error?: boolean` to `EnvelopeExt` (JSDoc states that `ext.models` retains the floor default; follow ADR-0037 F4 minimalism by adding only one field and no new event). Add a derive-always block to `#statusExt()`; the condition is `#modelsRetryCount >= MAX_MODEL_REFRESH_RETRIES && !#modelsSucceeded`. **Intentionally do not follow the one-shot pattern of sibling fields (`effort_reset` / `switch_error`)**; distinguish event vs state in a rationale comment and state that it should also be visible to a reconnected client (fuji's protected requirement). Three tests: throw-cap / null-return-cap (the derive exists to close 18-4's catch-only stderr gap) / success-absent (false-derive protection; assert absence in every envelope). Also pin the timing where count increments synchronously before await on the null-return path |
| 18-7 | Implement persist-alias validation + `default` fallback + notification event | ✅ | Completed 2026-07-14 (commit 3884bb9). Under fuji's supervision, limit scope to Part 1 (persist path); correct Part 2 (soft landing for setModel throw at `host.ts:701-708`) to **out of scope for F8 and a future separate task** (withdraw the soft-landing handoff added in 18-3). Reason: caller inspection established that the persist path (constructor L345, from queryOptions.model = spawn config / env / resume snapshot) and operator explicit setModel throw (L717-725) are **separate paths**; the A=graceful fallback / B=loud throw asymmetry is correct (persist can legitimately decay with SDK updates, while operator explicit floor-out is a dashboard-bug path and fails fast). Implementation: new `#persistedModel` snapshot field (separate because init overwrites `#model`), consume-once validation immediately after `#refreshSupportedModels()` succeeds; when absent from SDK verification, set `#model = "default"` + **paired `#modelSource = "default"` reset** (paired-provenance invariant caught by the review cycle) + fire `reason: "persist_alias_unknown"` in `#switchErrorOnce`. Follow F4 minimalism: do not modify the `ModelSource` enum (reuse existing `"default"`), keep `SwitchErrorExt.reason` an open string with **docstring addition only**, zero type changes. Three test pins (fallback / negative / null-guard), 173/173 green |
| 18-8 | Add / update wrapper unit tests | ✅ | Completed 2026-07-14 (traceability close, no independent commit). Each enumerated item is already carried by another phase-18 task: (a) BOOTSTRAP snapshot test updates → 18-3 (`initialStatusExt` expectation to `["default"]`, with the runner/test/config.test.ts register expectation in the same shape), (b) retry counter / limit / reset tests → 18-4 (`callCount === 3` throttle pin) + 18-5 (pin that `retrySupportedModels()` reset refetches after a silently reached cap), (c) persist-alias fallback tests → 18-7 (3 pins for fallback / negative / null-guard + paired-reset `model_source` assertion). Since other tasks' added tests cover the 18-8 scope completely, close it without independent implementation as a traceability-close decision (Q5 endorsed under fuji's 18-12 supervision) |
| 18-9 | Place a “Fetch model list again” button inside the model switcher in `AgentDetail.svelte` | ✅ | Completed 2026-07-14 (commit e035e79). Place it adjacent to the switch button (always provided, ADR-0037 F6), independent of menu open/close. Icon-only `↻` + `aria-label="モデル一覧を再取得"` + `title` (a11y). **Engine gate: `agentEngine === "claude-code"`** (Codex has a static catalog and no handler under ADR-0035; found and addressed by fuji review to prevent a dead button). Disable-until-ack with `refreshingModels $state` (prevent double-click until WS ack; catalog arrives in a later state_change's ext.models). Since rejection has no refresh-specific `switch_error` path, explicitly put it in `switchNotice { tone: "error", text: "モデル一覧の再取得に失敗: {reason}" }` (boundary hole caught by fuji review). `.cc-refresh` CSS mirrors `.cc-switch` + `:hover:not(:disabled)` + `:disabled { cursor: progress; opacity: 0.5 }`. `KaoiroConnection.refreshModels` in protocol.ts mirrors setModel and documents “Claude-only, engine gate required” in JSDoc. Three test pins (claude-code click send / codex hidden / reject switchNotice), 153/153 green |
| 18-10 | Implement toast display (retry failure / persist-alias fallback) | ✅ | Completed 2026-07-14 (commit 16174c5). Adopt granularity β: reuse the existing switchNotice and do not create an independent toast component. **Two-surface design** (close the switchNotice lifetime hole caught under fuji's 18-10 supervision): persistent state (`ext.models_error`) stays visible on the ↻ button with `class:cc-refresh-error={modelsError}`; the transient event uses a `sawModelsError` rising-edge tracker (literal mirror of L683 `sawEffortReset`, automatically reset on falling edge to protect by refiring at the second cap). For persist_alias_unknown, branch in the `switch_error` effect by reason and use `tone: "info"` + the automatic fallback text “The saved {req} is not in the current catalog, so starting with default,” excluding the old “model switch failed” phrasing. **Defensive engine gate**: `modelsError = $derived(env.ext?.models_error === true && agentEngine === "claude-code")`—the Codex host emits no models_error, but protect both class binding and effect against adapter bugs (test (d) drove the need for the gate as test-first evidence). Define the `.cc-refresh-error` CSS rule (`var(--danger, #c62828)` fallback) in the same diff using the UI paired-declaration heuristic (institutionalized in 18-9). Four test pins (models_error / negative / persist_alias info / Codex defensive), 157/157 green. Review medium tier CLEAN with 0 findings |
| 18-11 | Verify reduced-catalog behavior in `LaunchDialog.svelte` | ✅ | Completed 2026-07-14 (commit 944779b). Verification only; do not modify LaunchDialog.svelte itself. Add 2 tests: (1) pin spawn `{engine, model: "default", effort: "high"}` with the shrunk one-entry catalog, (2) pin field absence `not.toHaveProperty("model"/"effort")` through the `?? []` fallback path with an empty Codex catalog (production-reachable under ADR-0035 F1) (strictly inspect LaunchDialog:168-169 conditional-spread semantics). Following fuji's reachability × utility principle, omit the empty Claude case (unreachable in production) and cover the same code path with empty Codex. Retain the existing `claudeBootstrap` fixture (L118-129) as a multi-entry regression pin (the “artifact utility” principle). Review trivial-tier CLEAN with 0 findings |
| 18-12 | Add integration tests / e2e | ✅ | Completed 2026-07-14 (commit 91e1933). **Implement Tier A only; externalize e2e as Tier C**. Tier A: A1 = pin models_error toggle re-fire (resolve 18-10 Followup; use `$state` reactive helper in new `test/reactiveProps.svelte.ts` to use runes from the `.svelte.ts` extension, flow it through `mount(AgentDetail)`, and pin the four-step false→true→click→false→true transition so the second fire is genuinely observed after click injection). A2 = wrapper full retry cycle end-to-end (observe 3 failures → cap → `retrySupportedModels()` → fourth success with `callCount === 4` + `models_error` present→absent + `ext.models` replacement simultaneously). A3 = pin the healthy init → success catalog replacement sequence (floor → verified; `models_error` does not fire). Skip Tier B (protocol-chain mock-stitch) for marginal value (fuji decision: “mock stitching does not verify a true cross-layer and is false reassurance”). **Externalize Tier C (Playwright infrastructure, true cross-layer round-trip) as outside phase-18's standalone scope**, and list a candidate issue in Followups below. Trivial-tier review caught a **BUG high must-fix (test comment diverged from implementation)** → fixed by click injection, CLEAN |
| 18-13 | Keep the relevant section of `docs/specs/plugin-model.md` updated to the finalized implementation | ✅ | Completed 2026-07-14 (commit 3f79d9c). Refresh the ADR-0037 section (L117-148) to reflect implementation completion in Phase 18-3–18-12. Change future tense (“implement,” “notify”) → finalized present tense (“implemented,” “notify”), and add concrete values established by implementation (`"Account-recommended model · resolved after session start"` / `resolvedModel: "claude-opus-4-8[1m]"` / `MAX_MODEL_REFRESH_RETRIES = 3` / persist_alias_unknown client text), the 18-9/10 two-surface client design (`.cc-refresh-error` persistent class + `sawModelsError` rising-edge tracker), and the 18-9 retry-button defensive engine gate. Keep the trade-off / Codex deferral in present tense because it is continuing state (fuji endorsed). Preserve the division of SSoT: detail=ADR-0037 / summary=spec, with minimal duplication |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## Followups (in-phase but unfinished)

- **Handling cross-layer e2e infrastructure (Playwright)**: By the master's
  decision (2026-07-14), **adopt option B (continue with current per-layer unit +
  dogfood)**; do not introduce Playwright infrastructure or file an issue. Reason:
  each phase-18 layer has been individually verified with unit / integration tests
  (18-4/5/6/9/10/12), and operational wiring is guaranteed through dogfooding.
  Decide separately if e2e infrastructure becomes necessary in the future.
  **Reference record** (not started or externalized, but retained for when needed):
  candidate round trips are (1) LaunchDialog → spawn → wrapper init →
  `supportedModels()` → replace `ext.models` → dashboard reflection, (2) ↻ click →
  server relay → wrapper `retrySupportedModels()` → refetch → update `ext.models`,
  (3) `models_error` cap → toast + persistent class → manual retry → recovery.
  Deterministic testing requires inserting a fake SDK at the wrapper boundary (the
  real Anthropic API is flaky)
- ~~Test spanning the `models_error` toggle (false→true→false→true) in a single
  component instance~~ **Resolved by 18-12 A1** (flow through the `$state` reactive
  helper in new `dashboard/test/reactiveProps.svelte.ts` and its `.svelte.ts`
  extension into `mount(AgentDetail)`, pin the second fire genuinely with click
  injection. Close the most important gap handed off by fuji's 18-10 supervision in
  e2e (Tier A))
- The two debounce tests in `runner/test/config-watcher.test.ts` were confirmed in
  the 18-1 baseline as an existing flake / deterministic macOS red. Externalized to
  Gitea as an existing issue unrelated to Phase 18:
  [issue #112](https://github.com/sakuraiyuta/kaoiro/issues/112)
  (externalized 2026-07-14). Proposed fix: stop waiting for fixed `settle`, turn
  `onReload` into a promise, and replace it with a bounded polling wait for the
  condition
- Phase 18-2 Q1 verification detected 5 new extension fields in SDK-side
  `ModelInfo` (`resolvedModel` / `supportsEffort` / `supportsAdaptiveThinking` /
  `supportsFastMode` / `supportsAutoMode`). Current `#refreshSupportedModels()`
  copies only the existing 4 fields (`value` / `displayName` / `description` /
  `supportedEffortLevels`), leaving extension fields outside the projection.
  **Of these, `resolvedModel` was resolved on 2026-07-31**—pass it transparently
  through all 4 paths as `EngineModelInfo.resolved_model` and make catalog matching
  two-pass (the canonical side can have multiple matches, so return all matching
  rows; fail closed for effort by intersection; make the alias primary in the UI
  only when unique) ([ADR-0037](../adr/0037-claude-model-catalog-live-refresh.md)
  F9 addendum / F10 addendum of [ADR-0039](../adr/0039-engine-catalog-live-probe.md);
  specification in [plugin-model](../specs/plugin-model.md)). The remaining 4
  fields (`supportsEffort` / `supportsAdaptiveThinking` / `supportsFastMode` /
  `supportsAutoMode`) have not started, and whether to project them remains undecided
- The Phase 18-5 Elixir baseline confirmed a deterministic red in the
  inter_agent_message routing test in `wrapper_channel_test.exs`.
  **Completely orthogonal to the SDK / phase-18**, and a different test-isolation
  defect from config-watcher #112. Already filed in Gitea as
  [issue #111](https://github.com/sakuraiyuta/kaoiro/issues/111)
  (filed 2026-07-14 02:30; already detected while checking the #15 persona relay
  regression before my 18-5 session began). The Phase 18-5 baseline merely
  redetected it; it is not a Phase 18 regression

## Open Questions Blocking This Phase

None (Q1 (`claude-default-alias-sdk-semantic`) was confirmed as **option A** in
the 18-2 verification on 2026-07-14; delete the open question in the 18-3 commit
and reflect the empirical basis in the Context section of
[ADR-0037](../adr/0037-claude-model-catalog-live-refresh.md)).

## See Also

- Specs covered: [plugin-model](../specs/plugin-model.md), [protocol](../specs/protocol.md)
- Related ADRs: [ADR-0037](../adr/0037-claude-model-catalog-live-refresh.md) (decision for this phase), [ADR-0032](../adr/0032-codex-adapter.md) F4bc (`EngineCapability.supportedModels()` contract), [ADR-0034](../adr/0034-session-capabilities-advertisement.md) (session capability advertisement), [ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md) (Codex side remains unchanged)
- Previous phase: [phase-17-session-lifecycle-commands](phase-17-session-lifecycle-commands.md)
