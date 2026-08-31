---
title: Phase 23 — Reapplying model / effort / *_source on resume (P1)
description: Restore the model / effort / *_source punted from P0 in Phase 22 through the resume paths (initial restore / switch_session / reset_session) for both engines. Preserve “source never lies” semantics with a 5-case source-aware pair rule; Codex handles catalog-compatible reset and Claude drops invalid effort pairs on the wrapper side.
status: done
phase: 23
depends_on: [15, 17, 21, 22]
last_updated: 2026-08-02
---

# Phase 23 — Reapplying model / effort / *_source on resume (P1)

## Goal

Implement “P1 pair-aware apply for model / effort” from the
[ADR-0014 F1 addendum](../adr/0014-session-resume-and-restore.md). Reapply the
`model` / `effort` / `*_source` separated from the Phase 22 P0 scope from
`SessionPointers.snapshot` through both engines' resume paths (initial restore /
switch_session / reset_session). Resolve the loss of an operator's explicit
model / effort choice caused by demotion to the engine default, while never
stamping a lie into `ext.model_source` / `ext.effort_source` (preserve pair
semantics), by fixing the 5-case pair rule.

## Scope

**P1 apply targets**:

- Both engines (`claude-code` / `codex`): `model` / `model_source` /
  `effort` / `effort_source`

**Phase 22 P0 (unchanged)**:

- Codex: `sandbox` / `network_access`
- Claude: `permission_mode`

**Out of scope (future phase)**:

- Adding a schema-level malformed reason (`invalid_snapshot`, etc.) to
  `SessionResetErrorReason`—retain the current safe-default relaunch as in
  Phase 22 R2.
- Applying on fresh spawn / crash-restart / rollback—no application on those
  paths has the same semantics as Phase 22 P0.

## Design decisions (Fuji P1 discussion, 2026-07-16)

- **D1 symmetric apply targets for both engines**: Extend
  `APPLY_FIELDS_BY_ENGINE` in `applyResumeSnapshot` symmetrically and apply the
  model / effort pair on both sides. Codex account-default restoration and
  Claude operator-selected model restoration use the same path.
- **D2 five-case source-aware pair rule**:
  1. **Both absent** → unset the entire pair (the fresh session inherits the
     engine default).
  2. **value + source=default** → unset the entire pair (delegate to the SDK,
     do not pin explicitly). Pinning only the value while retaining the default
     source would make the source lie.
  3. **value + explicit source (launch / config / env)** → preserve verbatim
     (respect the explicit choice before resume).
  4. **value only (source absent, legacy)** → value + `source="config"` as
     transport provenance (rescue DETS records from before source tracking).
  5. **source only (value absent)** → unset the entire pair + warn on stderr
     (a semantic violation guarded by both the write-side gate and read-side
     sanitization; if reached, suspect a wrapper mis-stamping bug).
- **D3 refresh CLI source priority**: In both wrappers' cli.ts, when
  `config.model_source` is set, adopt it as the highest-priority
  `resolvedModelSource`. Next is `config.model` set → `"config"`, then an env
  tier default set → `"env"`, and finally both absent → `undefined`. Use the
  same pattern for effort. Prevent the source of Case 3 from a resume from
  being overwritten with `"config"`.
- **D4 Codex catalog compatibility (constructor reset)**: In the Codex host
  constructor, when **`this.#resumeSnapshot !== null` (resume path only)**,
  both `this.#model` and `this.#effort` are set, the catalog explicitly gives
  the matching model `effort_levels`, and those levels do not contain
  `this.#effort`, reuse the existing setModel behavior
  (`#effortResetPending=true`, `#effortResetOnce=true`). The existing mechanism
  in `#finishTurn` drops to `default_effort` on a successful turn and stamps
  `ext.effort_reset=true` one-shot. Delegate a missing model /
  unknown `effort_levels` to the SDK (do not engage reset); a genuine mismatch
  is caught when the SDK error reaches switch_error rollback in `#finishTurn`.
  **The fresh-spawn path (`#resumeSnapshot === null`) is outside this reset**:
  continue delegating launch-time operator choices to the SDK error path rather
  than overwriting them with an implicit reset outside the dashboard (see R1).
- **D5 Claude invalid effort pair drop (CLI filter)**: In Claude cli.ts, when
  `config.effort` is outside `CLAUDE_EFFORT_LEVELS`, drop **value / source
  together** + warn on stderr so the pair-rule intent is also enforced at the
  wrapper boundary. Runner does not know the engine's effort vocabulary, so
  perform this filter on the wrapper side (avoid increasing cross-package
  dependencies).
- **D6 independence from P0**: Pair-aware apply runs on the same apply path as
  Phase 22 P0 reapplication of Codex sandbox / network_access and Claude
  permission_mode. Its “absent → engine default” safe-fallback semantics are
  also the same as P0. P0 and P1 are evaluated separately; applying one does
  not affect drift display for the other (`ext.resume_drift` is independent per
  field).
- **R1 (confirmed Fuji first-review return-to-author)**: Limit the Codex
  constructor catalog reset to the **resume path**
  (`this.#resumeSnapshot !== null` guard). On fresh spawn, continue delegating
  to the SDK error / existing switch_error rollback (do not overwrite a
  launch-time operator choice with an implicit reset outside the dashboard).
  Add a fresh-spawn incompatible-effort regression pin.
- **R2 (confirmed Fuji first-review return-to-author)**: A pure-helper test
  cannot pin that each handler carries `config.model_source` /
  `effort_source` through applyResumeSnapshot to the wrapper, so add
  **initial-restore / live-switch / reset_session integration tests** to
  `supervisor.test.ts` (symmetric Codex/Claude, Case 3 preserve / Case 2 no
  default passthrough / Case 4 legacy `config` stamp / fresh no-apply). Crash /
  rollback already pin the `entry.parsed` carry path in Phase 22 P0 tests; P1
  fields follow the same carry path, so do not add an independent test and
  state the evidence in this plan.
- **R3 (confirmed Fuji first-review return-to-author)**: In both wrappers,
  extract pure helpers `resolveCodexSources` /
  `resolveClaudeSources` into `src/source_resolution.ts` and have the CLI call
  them, as a minimally invasive refactor. Unit-test priority branching and
  Claude invalid-effort pair dropping in `test/source_resolution.test.ts`
  (related suites pass). Close the gap where existing host tests injected host
  options directly and did not exercise CLI priority logic.

## Acceptance Criteria

- [x] Add optional fields `model_source?:
      ModelSource` / `effort_source?: ModelSource` to `WrapperConfig` in `protocol/src/index.ts`
      (transport for the runner-relayed resume snapshot pair).
- [x] Add `modelSource?` / `effortSource?` to `ParsedSpawn` in
      `runner/src/supervisor.ts`, and pass through `config.model_source` /
      `config.effort_source` in `resolveWrapperConfig`. `parseSpawn` does not
      populate them because SpawnMessage has no corresponding fields (the apply
      path alone populates them).
- [x] Add the 5-case pair rule (`computePair`) to
      `applyResumeSnapshot` in `runner/src/resume_snapshot.ts`, and apply
      `model` / `modelSource` / `effort` / `effortSource` as a pair on both
      engines. Leave Phase 22 P0 reapplication of Codex sandbox /
      network_access and Claude permission_mode unchanged.
- [x] Refresh source priority for `resolvedModelSource` /
      `resolvedEffortSource` in `wrapper/codex/src/cli.ts`
      (config.model_source > config > env > undefined). Leave the existing
      startup-summary stderr output unchanged.
- [x] Add a catalog-compatible reset block to the constructor in
      `wrapper/codex/src/host.ts`. When **`this.#resumeSnapshot !== null`
      (resume path only)**, both `this.#model` and `this.#effort` are set, the
      catalog has `effort_levels` for the matching model, and it does not
      contain `this.#effort`, set `#effortPending=null` /
      `#effortResetPending=true` / `#effortResetOnce=true`. The existing state
      transition is reused, so no additional `#finishTurn` change is needed.
      The fresh-spawn path (`#resumeSnapshot === null`) is outside this reset;
      launch-time choices continue through the SDK error path.
- [x] Refresh source priority for `resolvedModelSource` /
      `resolvedEffortSource` in `wrapper/claude-code/src/cli.ts`. When
      `config.effort` is outside `CLAUDE_EFFORT_LEVELS`, set both
      `resolvedEffort` / `resolvedEffortSource` to undefined and warn on stderr
      (pair drop).
- [x] Cover the 5-case pair rule in `runner/test/resume_snapshot.test.ts`
      (Case 3, Case 1, Case 2, Case 4, Case 5, mixed pairs, and simultaneous P0
      + P1 apply for both engines). Do not modify the existing Phase 22 P0 tests.
- [x] Add a P1 catalog-reset regression pin to
      `wrapper/codex/test/host.test.ts` (no reset when compatible; on mismatch,
      one-shot effort_reset + effort omitted from ThreadOptions; no reset when
      the model is absent—delegate to the SDK). The related Codex suite passes.
- [x] Add a P1 pair-aware pin to `wrapper/claude-code/test/host.test.ts`
      (resume source=launch stamps effective and drift is empty). The related
      claude-code suite passes.
- [x] Docs: add “P1 pair-aware apply for model / effort” to the ADR-0014 F1
      addendum. Defer protocol.md / phase-dependency graph updates until they
      arise naturally from another phase (the only fields changed here are
      WrapperConfig transport fields).
- [x] Typecheck (protocol / runner / 4 wrapper packages) clean,
      `mix format --check-formatted` out of scope because the server is
      unchanged, and `git diff --check` clean.
- [ ] End-to-end manual verification (dogfood): restart, restore the previous
      session's operator-selected model / effort, confirm
      `ext.model_source` / `ext.effort_source` match their pre-resume values,
      and in the Codex catalog-update scenario confirm the effort_reset badge
      appears once and then falls to default_effort from the next turn onward.
      Master real-device verification is pending.

## Tasks

| id | subject | status | note |
|---|---|---|---|
| 23-1 | protocol: `WrapperConfig.model_source?` / `.effort_source?` | ✅ | types-only |
| 23-2 | runner: add the 5-case pair rule to `applyResumeSnapshot` + extend `ParsedSpawn` + `resolveWrapperConfig` passthrough | ✅ | Add `computePair` helper |
| 23-3 | runner: comprehensive 5-case pair-rule tests | ✅ | Symmetric engines + mixed pairs + simultaneous P0/P1 |
| 23-4 | wrapper/codex/cli: refresh source priority | ✅ | config.model_source first |
| 23-5 | wrapper/codex/host: constructor catalog-compatible reset | ✅ | Connect to existing effortReset one-shot |
| 23-6 | wrapper/claude-code/cli: refresh source priority + invalid effort pair drop | ✅ | Drop value/source together + stderr warning |
| 23-7 | wrapper regression pins (Codex catalog reset + Claude pair) | ✅ | ThreadOptions gate / effort_reset one-shot / empty drift |
| 23-8 | docs: ADR-0014 F1 addendum “P1 pair-aware apply” | ✅ | 5-case pair rule + Codex reset + Claude pair drop |
| 23-R1 | Limit Codex host constructor catalog reset to resume + fresh non-regression pin | ✅ | Fuji first-review must-fix. `this.#resumeSnapshot !== null` guard; add a regression where incompatible effort on fresh spawn does not fire reset |
| 23-R2 | Add P1 integration tests to runner supervisor.test.ts | ✅ | Fuji first-review must-fix. Symmetric Codex/Claude initial restore / switch / reset; Case 2/3/4 + fresh no-apply |
| 23-R3 | Extract CLI source resolution into pure helpers + unit tests | ✅ | Fuji first-review must-fix. `source_resolution.ts` (helper) + `source_resolution.test.ts` in both wrappers (related suites pass) |
| 23-D1 | Codex host constructor display-hint fallback for the resume_snapshot default pair | ✅ | Fuji dogfood regression fix. Restore the (value, source="default") pair only when config/option is absent; pin pair consistency (source-only is out of scope) |
| 23-D2 | Make the effort gate in Codex `#threadOptions` symmetric | ✅ | Symmetric with the model gate, non-pin with `effortSource !== "default"` |
| 23-D3 | Claude AgentHost constructor default-pair hint fallback + effort-catalog revalidation | ✅ | Fuji dogfood regression fix. Drop pair + warn on stderr outside CLAUDE_EFFORT_LEVELS |
| 23-D4 | Claude run() Options gate: do not pass model/effort when source="default" | ✅ | Fuji dogfood regression fix. Continue passing operator setModel/setEffort (source="config") |
| 23-D5 | Runner integration assertion: preserve the `config.resume_snapshot` pair in Case 2 | ✅ | Case 2 logic unchanged; add resume_snapshot retention assertion to existing supervisor.test.ts |
| 23-D6 | Regression pins for both hosts | ✅ | At initial idle, pin hint restoration / supports_effort_switch=true / SDK Options non-pin / Case 3 SDK pin / Claude invalid effort pair drop; related suites pass |
| 23-D7 | Docs: ADR-0014 F1 addendum “launch pin vs display hint” responsibility split + restore phase-23 plan status | ✅ | Document the dogfood regression and fix |
| 23-R4 | Keep `#persistedModel` null in Claude hint fallback | ✅ | Fuji third-review semantic must-fix. Do not include the historical SDK-default hint in `persist_alias_unknown` validation |
| 23-R5 | Correct bootstrap default-entry wording in ADR/plan | ✅ | Fuji third-review factual-docs must-fix. `claudeBootstrapCatalog()`'s default entry has `FULL_EFFORT`; the actual button-hidden condition is runner live catalog without default alias and model=null |
| 23-R6 | Directly prove the Claude button regression with a realistic catalog fixture | ✅ | Fuji third-review coverage must-fix. With `config.claude_engine_catalog` lacking default + a hint model entry with effort_levels, assert hint restoration → `session_capabilities.supports_effort_switch=true` + active-entry effort_levels non-empty, and pin no `persist_alias_unknown` from R4 |
| 23-E1 | Codex catalog pure helper `effortLevelsForModel(catalog, model)` (final: exact hit → real default → intersection for null / concrete miss fail-closed) | ✅ | Fuji dogfood re-regression corrected policy 3 / F1's three tiers + G1's concrete-miss fail-closed. Do not add a synthetic default entry |
| 23-E2 | Route Codex host `supports_effort_switch` through helper.length | ✅ | True for non-empty intersection with model=null; false remains for unknown-auth empty catalog |
| 23-E3 | Codex catalog tests: comprehensive per-plan intersections | ✅ | plus/apikey/free/go/unknown + missing fail-closed + preserve order |
| 23-E4 | Codex host test: model null capability true + unknown false pin | ✅ | Account-default path and fail-closed, 2 pins |
| 23-E5 | Finalize dashboard effortLevels derivation as three-tier + concrete-miss fail-closed (F1/G1) | ✅ | (1) concrete exact hit → (2) real default entry → (3) key unreported + no real default: intersection / (4) concrete miss + no real default: [] fail-closed. No engine-name branch |
| 23-E6 | UI tests: exact priority / real-default fallback / null intersection / concrete-miss fail-closed / missing fail-closed | ✅ | Retain missing effort_levels on the Haiku entry in the claudeBootstrap fixture (contract `host.test.ts:1349`); pin dashboard three-tier lookup rescued by real default |
| 23-E7 | Docs: ADR-0014 F1 addendum three-tier lookup (confirmed in F1, concrete-miss fail-closed added in G1) + why union was rejected + no synthetic default | ✅ | Synchronize phase-23 plan status with pending dogfood re-verification |
| 23-F1 | Three-tier lookup fix + fixture revert (Fuji fourth-review must-fix) | ✅ | Revert Haiku levels in claudeBootstrap fixture (restore `host.test.ts:1349` contract); make Codex helper and dashboard exact → real default → intersection three-tier; document real vs synthetic default in ADR; pin real-default fallback / concrete miss / exact missing / Codex null paths; related suites pass |
| 23-G1 | Do not fall back to intersection on concrete miss (Fuji fifth-review must-fix) | ✅ | Add “concrete key exact miss + no real default → [] fail-closed” to Codex helper and dashboard. A future/stale concrete model is not guaranteed to be among catalog candidates; limit intersection to model=null (account-default) path. Synchronize final docs (ADR/plan), related suites pass |
| 23-9 | manual dogfood verification | ⏳ | Master verification pending (D+E+F+G+R4-R6 + re-reverification after the [Phase 24](phase-24-codex-auth-mode-explicit.md) fix. Root cause of both buttons being hidden—empty catalog when codex binary is absent from runner PATH—is resolved by Phase 24) |

Status legend: ⏳ not started, 🟡 mostly done, ⚠ partial, ✅ done.

## Risks

- **Avoiding a lying source**: Case 2 (default source) and Case 5 (source only)
  of the five-case pair rule are the most delicate. Pinning the value in Case 2
  would make the next source appear as “default” while looking like an explicit
  choice, so unset both and delegate to the SDK. Case 5 assumes a wrapper
  mis-stamping bug that can still occur after both write-side and read-side
  gates; use defensive drop + warning.
- **Effort mismatch from Codex catalog updates**: Constructor reset connects to
  the effort_reset one-shot. The integration test passes, but if the catalog
  snapshot and the real SDK catalog diverge on a device, the SDK error is caught
  by the existing switch_error rollback in host.ts `#finishTurn`.
- **Claude effort-catalog drift**: `CLAUDE_EFFORT_LEVELS` is a static constant
  in source. If the upstream SDK adds a level, the CLI filter drops the value /
  source. Update `CLAUDE_EFFORT_LEVELS` as part of releases, as in the existing
  Phase 15 contract.
- **Legacy DETS record (`model_source` / `effort_source` dropped by
  server-side sanitization)**: Case 4 (value only) stamps `"config"` as
  transport provenance, so it does not fall into Case 5. The wrapper handles
  rescue of old records explicitly.
- **P1 apply colliding with an operator choice**: If the same agent_id on
  another host calls set_model immediately before restore, Case 3 restores the
  SessionPointers snapshot when it has already been written; if the write has
  not happened, the Phase 22 crash-restart race applies and restores one
  generation earlier. Inherit the ADR-0014 F1 addendum's statement that drift
  visibility is not guaranteed.
- **More manual dogfood paths**: Prepare one Codex and one Claude agent with an
  operator-selected model + effort, then visually verify model / effort restore
  and ext.model_source / ext.effort_source after a dogfood.sh restart. Extend
  the Phase 22 privilege-axes procedure to model / effort.
- **Insufficient separation between launch pin and display hint (resolved in
  D1-D7)**: In the initially pushed Phase 23 implementation (23-1–23-R3), the
  runner apply of Case 2 (source=default) unset config.model / config.effort.
  As a side effect, the previous-session values did not reach the wrapper
  host's initial `#model` / `#effort`, Codex stamped
  `supports_effort_switch=false` in `initialStatusExtFromCatalog(catalog, model=null)`, and the dashboard effort-switch button was gated off. Dogfood
  exposed three symptoms together (Codex model “waiting for confirmation” /
  Codex effort not restored / effort buttons hidden on both engines,
  2026-07-16). The actual condition for the Claude button to be hidden is when
  the runner-transported live catalog (`config.claude_engine_catalog`, ADR-0039
  F9 addendum) lacks the default alias and model=null, so neither
  `models.find(m.value === $currentModel)` nor the `... === "default"` fallback
  resolves and `effortLevels=[]` (this cannot be reproduced with the bootstrap
  alone, which has a default entry with full effort_levels; the production
  contract observed in dogfood is the runner live-catalog path).
  **The runner apply's Case 2 unset is correct as a launch-pin semantic**, so
  leave it unchanged and **consume the (value, source="default") pair from
  `options.resumeSnapshot` as a display hint in the wrapper host constructor**
  to resolve it (D1/D3). To preserve SDK-delegation semantics, add a symmetric
  `source !== "default"` gate to the SDK Options paths in both wrappers (D2/D4).
  Keep Claude `#persistedModel` null during hint restoration because it is used
  to validate explicit spawn/env/Case3 aliases against the SDK-measured catalog;
  this closes the hole where a historical SDK-default hint absent from the
  current catalog would emit persist_alias_unknown switch_error (Fuji third
  review R4). See the “launch pin vs display hint responsibility split” section
  of ADR-0014 F1.
- **Both buttons hidden when codex binary is absent from runner PATH and catalog
  is empty (resolved in Phase 24)**: During the re-re-re-re dogfood (23-9), Fuji
  observed “`Codex auth mode detection failed; model catalog will be empty`” in
  `runner.log`. `runner/src/codex-auth.ts::detectCodexAuthMode` depends on
  `execFile("codex", ["doctor",...])`; on a host where runner's PATH lacks the
  codex binary (the typical environment-dependent dogfood case), ENOENT yields
  auth mode = "unknown" → `resolveCodexCatalog` returns an empty array → the
  wrapper receives `codex_auth_mode="unknown"` + `catalog=[]` →
  `initialStatusExtFromCatalog` stamps `supports_model_switch=false` /
  `effortLevelsForModel([], model).length = 0` → both buttons are hidden. The
  Phase 23 E-G two-tier lookup assumed a non-empty catalog, so tiers 3/4 cannot
  rescue an empty catalog; this is a separate problem. Split the fix into
  [Phase 24](phase-24-codex-auth-mode-explicit.md)
  (`runner/src/config.ts::CodexConfig` gains `auth_mode?: 'chatgpt' | 'apikey'`,
  and priority `explicit config > doctor detection > "unknown"` resolves the
  catalog without dependence on runner PATH). Until Phase 24 is complete,
  23-9 dogfood remains pending; after it, re-verify D+E+F+G+R4-R6+Phase 24
  together in dogfood.
- **Exact effort_levels lookup and model-representation mismatch (resolved in
  E1-E7 + F1)**: Dogfood re-observed a scenario that hint restoration cannot
  rescue—**the previous session ended before a turn completed, so its snapshot
  was not stamped**—and a scenario where **the specific ID returned by the
  Claude runner probe does not exactly match the bootstrap "default" alias**
  (2026-07-16; symptoms: Codex effort button hidden when effort was unspecified
  / Claude button hidden everywhere). The root cause was that wrapper-host /
  dashboard `effort_levels` lookup only did a complete exact match; when the
  model was unreported or the alias mismatched, it silently returned empty and
  gated off the button. **Reject adding a synthetic `"default"` entry to the
  Codex catalog** (it pollutes responsibility by displaying “default” in the
  model-switch menu and allowing an explicit `setModel("default")`). **Reject
  presenting the union of catalog effort_levels** (it violates ADR-0035's
  no-silent-downgrade rule by showing effort invalid for the current model).
  Final rule (three tiers fixed in F1, concrete miss fail-closed added in G1):
  adopt **three-tier lookup** plus **concrete-miss fail-closed** in both the
  wrapper helper and dashboard derivation:
  (1) **concrete key exact hit** → that model's effort_levels (if missing,
  return []; do not fall back);
  (2) **exact miss / key unreported** with a real `value="default"` alias
  entry (the engine-declared official alias; never synthesize one) → those
  levels;
  (3) **key unreported (null/undefined) and no real default** → intersection
  across all entries, fail-closed (if even one is missing, return []);
  (4) (Fuji G1) **concrete key + exact miss + no real default** →
  `[]` fail-closed. There is no guarantee that an unknown/future/stale concrete
  model is among the catalog candidates, so intersection cannot be claimed
  “always valid”; hide the button safely.
  Claude bootstrap has a real default entry, so tier 2 resolves it (a coexisting
  Haiku entry with missing levels does not affect it). The Codex catalog currently
  has no real default entry and may not gain a synthetic one, so account default
  (model=null) uses tier 3 (chatgpt+plus: common low..max for SOL/TERRA/LUNA,
  excluding LUNA ultra). An empty catalog from auth mode="unknown" remains
  `[]` fail-closed through tier 3. Do not branch on engine name. **Real vs
  synthetic default**: a real default is the official alias included in the
  engine's supportedModels() response and is meaningful in the model-switch
  menu; a synthetic one is locally fabricated and forbidden. See the
  “three-tier effortLevels lookup” section of ADR-0014 F1.

## Progress log

- 2026-08-02: closed by the master's decision after dogfood verification OK
  (status: done)
