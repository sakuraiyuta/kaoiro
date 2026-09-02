---
title: Phase 22 — Reapplying the Three Privilege Axes on resume (P0)
description: Elevate SessionPointers.snapshot to the SSOT and restore Codex sandbox/network_access and Claude permission_mode through restore/switch/reset paths. A runner-central pure helper authoritatively overwrites engine-related fields, while fresh spawn/crash-restart/rollback retain no-apply semantics.
status: done
phase: 22
depends_on: [15, 17, 21]
last_updated: 2026-07-16
---

# Phase 22 — Reapplying the Three Privilege Axes on resume (P0)

## Goal

Implement “reapplying the three privilege axes on resume” from the
[ADR-0014 F1 addendum](../adr/0014-session-resume-and-restore.md). Resolve the
gap that included the incident where, after restarting with dogfood.sh, a
resumed Codex agent's `danger-full-access` / `network_access=true` was demoted
to `workspace-write` / `false`. Elevate `SessionPointers.snapshot` from a
drift-display-only artifact to the **SSOT for restoring effective settings**,
and have a runner-central pure helper overwrite `ParsedSpawn` with snapshot
values on every resume path: restore / switch_session / reset_session.

## Scope

**P0 apply targets**:

- Codex: `sandbox` / `network_access`
- Claude: `permission_mode`

**P0 sanitize targets** (the known 7 fields passed through to the wrapper for
drift calculation):

- `model` / `model_source` / `effort` / `effort_source` / `permission_mode`
  / `sandbox` / `network_access`

**P1 punt**: runner application of `model` / `effort` / `*_source`. This is
separated into another phase because it involves cli.ts derivation of
`modelSource` / `effortSource`.

## Design decisions (Fuji D1-D5, R1-R2)

- **D1 helper shape**: Do not introduce a mode enum; use one pure helper,
  `applyResumeSnapshot(parsed, snapshot, engine)`. **Do not apply** it to fresh
  spawn / crash restart / rollback (the caller does not pass a snapshot). If an
  explicit override UI is added in the future, extend the priority API (not in
  this phase).
- **D2 absent semantics**: If the snapshot object itself is absent, no-op
  (backward compatibility with the old server; retain `entry.parsed`). If a
  snapshot is present but an engine-related field is absent/invalid, **safely
  demote to the engine default** (Codex: `workspace-write` / `false`, Claude:
  `default`). **Do not retain the old danger value**. **Retain explicit
  `false`** (do not use truthy checks).
- **D3 crash-restart race**: P0 continues with `entry.parsed`. No guarantee is
  made that resume_drift is visible (if runner's resumeSnapshot is also stale,
  drift can be empty). Claude permission_mode is corrected by the after_join
  PermissionModes push; Codex privilege is mid-session immutable, so there is
  no issue for the current target. Model / effort race is P1.
- **D4 drift semantics**: Keep fields not applied by the engine filter in the
  sanitized `resume_snapshot` and preserve engine-neutral drift calculation.
  Claude sandbox has meaning as a permission_mode mapping, so do not remove it
  from drift targets. Drop malformed / unknown values + warn on stderr; an
  operator envelope notification is out of scope.
- **D5 field scope**: Sanitize only the known 7 fields. P0 applies only Codex
  sandbox/network and Claude permission_mode.
- **R1 canonical key normalization (confirmed as a Fuji first-review
  return-to-author must-fix)**: Server sanitization must not depend on map
  enumeration order; scan known fields in a fixed order. When both atom and
  string keys for one field are present, **prefer the string key** (wire
  canonical); otherwise read the atom key. If both values differ, explicitly
  record the adopted side with `Logger.warning`. Output keys are **always
  canonical strings**—close the hole where Phoenix JSON relay collapses
  `sandbox: ...` and `"sandbox" => ...` and leaves the winner undefined. The
  priority is unconditional string-first (if the string side is invalid, drop
  the whole field and do not fall back to the atom)—a deterministic pin.
- **R2 whole-malformed shape handling (confirmed as a Fuji first-review
  return-to-author must-fix)**: Never inherit old privileged values when
  `validateResolvedSnapshot(raw)` returns null for a present-but-non-object
  shape.
  - **switch_session**: fail-loud reject with `#fail(agentId, "error")`. Validate
    before deleting/adding the F4 lock (`#activeSessions`), so a rejection does
    not change the lock.
  - **reset_session**: The existing `SessionResetErrorReason` closed vocabulary
    (`agent_busy` `unsupported_session_reset` `session_reset_pending`
    `runner_unavailable` `spawn_failed` `rollback_failed` `timeout`) has no
    schema-level malformed equivalent, so **demote through a safe-default
  relaunch** (`nextSnapshot = {}` → applyResumeSnapshot demotes to the
    engine default) + stderr warning. Do not inherit privileged values from
    old `entry.parsed`. Adopt this within Fuji R2's allowance for a
    “safe-default relaunch when the API makes a dedicated reason difficult.”
    If semantic additions (`invalid_snapshot` reason, etc.) are needed later,
    make them a separate phase.

## Acceptance Criteria

- [x] Add optional `resume_snapshot?: ResolvedSnapshotExt` to
      `ResetSessionCommand` in `protocol/src/index.ts`. No change is needed to
      `SwitchSessionMessage`, which already relays it.
- [x] Add a closed-enum + boolean sanitizer to `record_snapshot/2` in
      `server/lib/kaoiro_server/session_pointers.ex`. Keep only the known 7
      fields, drop malformed fields + `Logger.warning`, and no-op on a
      non-map snapshot (defensive drop). **R1: normalize to canonical string
      keys**—fixed-order scan + string priority + atom fallback, warn on
      differing duplicates, and unconditional string-first priority.
- [x] Add `|> maybe_put_resume_snapshot(agent_id)` to the
      `handle_in("session_reset")` broadcast in
      `server/lib/kaoiro_server_web/channels/agents_channel.ex`. Reuse the
      existing helper (the same one as build_restore_payload / switch_session).
- [x] Create `runner/src/resume_snapshot.ts` with the pure helpers
      `validateResolvedSnapshot(raw)` and
      `applyResumeSnapshot(parsed,
      snapshot, engine)`.
      `validateResolvedSnapshot` guards closed enums / booleans / non-empty
      strings and returns null for non-objects. `applyResumeSnapshot` no-ops for
      snapshot=null, overwrites P0 fields from the SSOT by engine, and demotes
      absent/invalid values to the engine default.
- [x] Route the resume_snapshot path in `parseSpawn` in
      `runner/src/supervisor.ts` through `validateResolvedSnapshot`. Continue
      to fail-loud reject the entire spawn for a non-object shape (preserve
      existing behavior).
- [x] Fire `applyResumeSnapshot(parsed, parsed.resumeSnapshot, parsed.engine)`
      in the resume branch of `handleSpawn` in
      `runner/src/supervisor.ts`. Do not apply it in the fresh-spawn branch.
- [x] In `#completeSwitchSession` of `handleSwitchSession` in
      `runner/src/supervisor.ts`, validate + apply payload.resume_snapshot and
      update `entry.parsed`. If the payload has no snapshot, fall back to the
      existing `entry.parsed.resumeSnapshot`. **R2: fail-loud reject a
      whole-malformed shape with `#fail(agentId, "error")` before the F4 lock**
      (do not inherit old privileged values).
- [x] In `handleResetSession` in `runner/src/supervisor.ts`, validate + apply
      payload.resume_snapshot, update `entry.parsed`, then strip
      resumeSessionId + child.kill. Leave #relaunchForReset unchanged so it
      consumes `entry.parsed`; rollback retains the `entry.parsed` already
      applied at reset. **R2: use a safe-default relaunch for a whole-malformed
      shape** (`nextSnapshot = {}` → engine-default demotion) + stderr warning
      (do not inherit old privileged values).
- [x] Preserve the existing passthrough in `resolveWrapperConfig` in
      `runner/src/supervisor.ts`. Add a comment stating the invariant that
      upstream sanitization is guaranteed.
- [x] Add integration tests to `runner/test/supervisor.test.ts` (Codex / Claude
      initial-restore apply, fresh-spawn no-apply, switch_session apply,
      reset_session apply, entry.parsed inheritance on rollback / crash-restart,
      explicit `network_access=false` retention, engine-default demotion with an
      empty snapshot, **R2 whole-malformed switch fail-loud / reset
      safe-default, and an integration pin for individually malformed fields**).
      The related runner suite passes.
- [x] Add a regression pin to `wrapper/codex/test/host.test.ts`
      (danger-full-access → ThreadOptions, workspace-write + network=true,
      explicit network_access=false, empty resume_drift). The related Codex
      suite passes.
- [x] Add a regression pin to `wrapper/claude-code/test/host.test.ts`
      (permission_mode=bypassPermissions gives allowDangerouslySkipPermissions,
      empty resume_drift). The related claude-code suite passes.
- [x] Add a write-side sanitize test to
      `server/test/kaoiro_server/session_pointers_test.exs` (**R1: canonical
      string-key normalization / atom + string duplicate priority /
      invalid-string priority drop / valid string + invalid atom priority**).
      The related server suite passes. Update existing atom-key expectations to
      canonical string-key expectations.
- [x] Add a reset-broadcast snapshot-inclusion test to
      `server/test/kaoiro_server_web/channels/agents_channel_test.exs` (the
      presence of `resume_snapshot` switches with snapshot presence).
- [x] Docs: add a “reapplying the three privilege axes on resume” section to
      the ADR-0014 F1 addendum, and consolidate ADR-0033 F3 / ADR-0036 F2 as
      references to ADR-0014. Add `resume_snapshot?` to the `reset_session`
      schema in `docs/specs/protocol.md`.
- [x] Typecheck (protocol / runner / 4 wrapper packages) clean,
      `mix format --check-formatted` clean for the target files,
      svelte-check with 0 errors and 0 warnings, and `git diff --check` clean.
- [x] End-to-end manual verification (dogfood): after restart, the Codex agent
      restores with danger-full-access + network=true, and the Claude agent with
      bypassPermissions; `ext.effective` and `ext.resume_snapshot` match and
      `ext.resume_drift` is empty. Passed master real-device verification.

## Tasks

| id | subject | status | note |
|---|---|---|---|
| 22-1 | protocol: `ResetSessionCommand.resume_snapshot?` | ✅ | types-only |
| 22-2 | server: SessionPointers.record_snapshot sanitizer | ✅ | Logger.warning per drop |
| 22-3 | server: include snapshot in the reset_session broadcast | ✅ | Reuse existing `maybe_put_resume_snapshot` |
| 22-4 | runner: `resume_snapshot.ts` (pure helper) | ✅ | New file, pure-helper table test |
| 22-5 | runner: route parseSpawn's resume_snapshot path through sanitization | ✅ | Keep fail-loud rejection |
| 22-6 | runner: apply in handleSpawn's resume branch | ✅ | Fresh branch unchanged |
| 22-7 | runner: apply in handleSwitchSession | ✅ | Fallback based on payload snapshot presence |
| 22-8 | runner: apply in handleResetSession | ✅ | Update entry.parsed before pendingReset |
| 22-9 | runner: resolveWrapperConfig invariant comment | ✅ | Passthrough unchanged |
| 22-10 | runner: integration tests | ✅ | 5 paths + safety pins |
| 22-11 | wrapper regression pins (Codex + Claude) | ✅ | ThreadOptions / SDK options / empty drift |
| 22-12 | docs: ADR-0014 F1 addendum + ADR-0033/0036 references + protocol.md | ✅ | Consolidated ADRs |
| 22-R1 | server: normalize SessionPointers sanitizer to canonical string keys | ✅ | Fuji first-review must-fix. Fixed-order scan + string priority + atom fallback, 4 priority tests added, existing atom-key expectations changed to canonical strings |
| 22-R2 | runner: whole-malformed snapshot handling for switch/reset | ✅ | Fuji first-review must-fix. Switch: `#fail(error)` + validation before F4 lock; reset: safe-default relaunch + stderr warning, no old privileged-value inheritance. Added 4 integration tests |
| 22-13 | manual dogfood verification | ✅ | Passed master real-device verification |

Status legend: ⏳ not started, 🟡 mostly done, ⚠ partial, ✅ done.

## Risks

- **Privilege-persistence semantic impact**: behavior that previously demoted to
  the engine default after restart now restores the “last effective value.”
  This only propagates the contract already adopted by ADR-0036 F2 for /new /
  /clear to all restore / switch / reset paths; it does not introduce a new
  privilege escalation. However, “an agent that once allowed danger remains in
  danger after restart.” The operator UI already always shows the permission
  badge, so no additional UI change is needed.
- **Malformed snapshot escalation**: close it with double validation (server
  write + runner read). Drop + warn values that do not belong to the closed
  enums.
- **False stamp from a compromised authenticated wrapper**: closed-enum
  validation cannot prevent forgery of a valid enum. Inherit the existing
  design choice that the server trusts the wrapper's effective snapshot. The
  higher-level measure is integrity of the wrapper execution host
  (specs/threat-model.md T1).
- **Legacy DETS record (snapshot = nil)**: apply becomes a no-op and the spawn
  uses the engine default. resume_drift is empty (both sides unset). It fills
  naturally within one release window.
- **Crash-restart race**: if a mid-session set_permission_mode occurs just
  before a crash and does not reach entry.parsed, the next restart restores one
  generation earlier. No resume_drift guarantee is made because runner's
  resumeSnapshot is also stale. This is consistent with existing crash
  semantics (the immediately preceding transaction is lost).
- **Unspecified winner for atom/string duplicate keys (resolved in R1)**:
  Phoenix JSON relay collapsed atom and string keys to one output key while the
  winner depended on enumeration order. R1 changes this to **fixed-order
  normalization to canonical string keys + string-first priority**, making it
  deterministic. An invalid string drops the field rather than falling back,
  so priority always points one way.
- **Inheritance of old privileged values from a whole-malformed snapshot
  (resolved in R2)**: if validate=null inherited privileged values from old
  entry.parsed, attacker-controlled or buggy payloads could restore the danger
  value from before the operation. R2 uses fail-loud for switch and a
  safe-default relaunch (empty snapshot → engine default) for reset, cutting the
  old-value inheritance path.
- **Backward compatibility of the `ResetSessionCommand` schema change**:
  `resume_snapshot?` is optional, so an old runner simply ignores it. No
  breaking change.
- **No schema-level malformed reason in `SessionResetErrorReason`**: reusing
  `spawn_failed` for a whole-malformed reset would misstate its meaning, while
  silent dropping could induce a timeout and contradict Fuji D3/D2. Demote with
  a safe-default relaunch and warn on stderr (explicitly allowed by Fuji R2).
  If a reason such as `invalid_snapshot` is needed later, file a separate phase
  for the three changes to the protocol type + server lock handling + runner
  sendResetResult.
- **P1 model / effort separation**: immediately after restore, the engine
  default (Codex account default) may be used. Explain to the operator that an
  “account default” label may temporarily appear in the UI; resolve it in P1.
