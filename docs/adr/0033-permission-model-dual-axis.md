---
title: Extend the common permission-model abstraction to two axes: sandbox × approval
status: accepted
date: 2026-07-10
opened: 2026-07-10
supersedes: []
superseded_by: null
related_specs: [protocol, plugin-model]
related_adrs: [22, 32, 34, 38, 41, 43]
---

# ADR-0033 — Extend the common permission-model abstraction to two axes: sandbox × approval

## Status

Accepted (implementation is [phase-14-codex-adapter](../plans/phase-14-codex-adapter.md)).
The envelope schema, Claude mapping table, and UI vocabulary were finalised by
real SDK verification and spec elicitation on 2026-07-10 (old open-questions Q2/Q3
resolved and closed).

## Context

The current permission-model abstraction in wrapper / server / dashboard directly
follows the Claude Agent SDK’s single-axis `permissionMode`
(default/acceptEdits/bypassPermissions/plan/dontAsk/auto), exposed as
`ext.permission_mode` in [protocol](../specs/protocol.md). [ADR-0022](0022-pending-permission-authoritative-source.md)
established `state_change.ext` as the authoritative source for
`ext.pending_permission`.

Adding a Codex CLI adapter in [ADR-0032](0032-codex-adapter.md) requires aligning
the common abstraction with the fact that Codex has two permission axes (the value
set was demonstrated in the type definitions of `@openai/codex-sdk` 0.144.1):

- **sandbox_mode**: `read-only` | `workspace-write` | `danger-full-access` —
  whether and how far the file system may be written (OS-level sandbox).
- **approval_policy**: `untrusted` | `on-request` | `on-failure` | `never` —
  whether to request approval for each operation. The `granular` assumed in the
  initial ADR draft does not exist in the actual SDK.

Claude’s single-axis mode cannot distinguish whether shell commands and file edits
may be performed without asking, so two axes provide greater expressiveness.
Flattening the model into single-axis presets (`default / accept-edits / yolo`,
etc.) would lose Codex’s two-axis expressiveness; therefore extend the common
abstraction itself to two axes.

**Constraint (verified 2026-07-10)**: `@openai/codex-sdk` starts a new
`codex exec` process for every turn and closes stdin immediately after writing the
prompt, so **there is no path to return an operator approval to the SDK while it is
running** (feature flag `exec_permission_approvals` is under development = not
released; the default approval_policy for exec is `never`). This fixes approval
to `never`; it does not prevent changing sandbox or network configuration between
executions. `waiting_permission` never occurs for Codex. Track upstream approval
support in [open-questions/codex-exec-approval-upstream](../open-questions/codex-exec-approval-upstream.md).

## Decision

### F1 — Extend the envelope schema to two axes (`ext.permission`)

Create agent-level `ext.permission = {sandbox, approval}` as the successor to
current `ext.permission_mode`. **Do not duplicate the axes** inside
`pending_permission` (the record for each approval request). Codex emits no
pending_permission due to the constraint in Context, and for Claude the same
`state_change.ext` carries `permission` and `pending_permission` side by side, so
duplication would be redundant:

```json
{
  "type": "state_change",
  "state": "waiting_permission",
  "ext": {
    "permission": { "sandbox": "workspace-write", "approval": "untrusted" },
    "pending_permission": {
      "request_id": "abc-123",
      "tool_name": "Bash",
      "input": { "command": "ls" },
      "ts": "2026-07-10T05:30:00Z"
    }
  }
}
```

Enum values (Codex vocabulary as-is, with no mapping layer):

- `sandbox`: `read-only` | `workspace-write` | `danger-full-access`
- `approval`: `untrusted` | `on-request` | `on-failure` | `never`
  (`on-failure` was downgraded to a deprecated alias of `on-request` in upstream
  0.144. The kaoiro wrapper will not emit it, but it remains in the enum for
  compatibility with the SDK type.)

**Deprecation plan (D-A)**: Emit `ext.permission_mode` alongside
`ext.permission` for one release window, then remove it in the next release (the
same convention as the personas legacy field in [ADR-0031](0031-runner-persona-trust-mode.md)).
The dashboard reads only `ext.permission` starting in this phase.

### F2 — Keep the Claude six-mode mapping inside wrapper/claude-code

Keep the mapping from all six Claude Agent SDK `permissionMode` values to the two
axes as a mapping table inside the `wrapper/claude-code` adapter. Normalise SDK
output in the wrapper before putting it in the envelope, so server and dashboard
handle only the two axes without knowing engine vocabulary. The mapping is an
**approximation for display**; pass the mode itself to the SDK as before:

| Claude mode | sandbox | approval | Rationale (SDK doc) |
|---|---|---|---|
| `default` | workspace-write | untrusted | Prompts for dangerous operations |
| `acceptEdits` | workspace-write | on-request | Automatically approves file edits; asks when the model requests other actions |
| `plan` | read-only | on-request | No tool execution; read-only |
| `bypassPermissions` | danger-full-access | never | Bypasses everything |
| `dontAsk` | workspace-write | never | Rejects anything not pre-approved without asking |
| `auto` | workspace-write | on-request | A classifier performs approval (a request itself still occurs) |

### F3 — Codex uses the two axes directly (approval fixed to `never`)

Codex accepts operator-requested changes to `sandbox` and `network_access`
through `set_permission`. A running `codex exec` retains its captured
configuration. Requests received while busy are accepted; the next execution
captures the latest requested configuration, regardless of whether its input
came from the operator, an inter-agent message, or the instruction queue. The
session ID and history are retained. The wrapper does not interrupt a turn to
apply a permission change.

Keep three distinct values:

- **Requested**: the latest operator selection, persisted with a server-issued
  revision. A command acknowledgement confirms acceptance, not application.
- **Submitted**: the immutable configuration and revision captured for one exec.
  A newer request does not mutate it.
- **Effective**: the policy observed in that execution's `turn_context`, including
  `sandbox_policy` and `approval_policy`. Neither constructing argv nor receiving
  `turn.started` establishes effective permissions. A prior turn's record is not
  evidence for the current execution; absent or uncorrelated evidence is unknown.

`approval` remains **fixed to `never`**. The exec harness overrides the approval
policy, and the SDK cannot deliver an operator approval while the process runs.
It is not an input to `set_permission`. See
[codex-exec-approval-upstream](../open-questions/codex-exec-approval-upstream.md).

Reuse ADR-0035's `requested`, `effective`, and `rolled_back_to` vocabulary, but
not its model-failure rollback rule. Once the current `turn_context` confirms a
policy, a later `turn.failed` does not roll it back. Only a definitive rejection
before application may report `rolled_back_to`. Observation failure remains
`unknown`, not evidence that the previous policy resumed. No automatic transition
may widen permissions. Even a narrower previous value must not be displayed as
effective without observation or proof that rejection preceded application.
There is no confirmation UI for widening; both widening and narrowing are
operator-only and recorded in the
[ADR-0055 lifecycle timeline](0055-compaction-resume-and-lifecycle-log.md).
Its existing best-effort durability is unchanged; the command ack does not
promise an audit fsync.

The normative command, synchronization, persistence, and observation contracts
are in [protocol](../specs/protocol.md#permission-changes-at-an-execution-boundary).
`PermissionSettings` retains requested configuration separately from the last
observed effective snapshot in `SessionPointers`. Resume uses the latter and
synchronizes the former before the first execution. A failed or pending request
must never masquerade as an effective resume snapshot. Intentional changes do
not produce `resume_drift`; an unintended substitution still does. Unobserved
sandbox/network fields are temporarily excluded from drift comparison even
without an operator request; compare them once current observation exists. This
does not change undefined-versus-known drift for other fields or legacy engines.

#### Network configuration and effective access

The raw `network_access` toggle is meaningful to the SDK for `workspace-write`.
Preserve it independently of the sandbox-aware effective value:

| sandbox | effective network_access |
|---|---|
| `danger-full-access` | `true` |
| `read-only` | `false` |
| `workspace-write` | raw configured toggle, default `false` |

`effectiveNetworkAccess` in `wrapper/codex/src/network_access.ts` is the shared
normalization rule for display and snapshots. The SDK enforcement path passes
`networkAccessEnabled` only for `workspace-write`. A full-access observation of
`true` must not overwrite the raw toggle and silently enable networking on a
later switch to `workspace-write`.

Legacy snapshots with inconsistent effective values normalize on resume and
report `resume_drift` once; the next confirmed snapshot repairs persistence.
Snapshots do not recover a lost raw toggle. Without a `PermissionSettings`
record, initialize the raw configuration from wrapper launch configuration and
publish that baseline rather than reverse-mapping an effective value.

The existing runner/server snapshot precedence remains: on a snapshot-applying
resume, an explicit boolean in the snapshot, including `false`, takes priority
over the engine default. A present snapshot with an absent/invalid privilege
field falls back to the safe engine default. The runner's no-apply paths for
fresh spawn without apply_resume_snapshot, crash restart, and rollback remain
unchanged; permission_sync is a separate next-execution selection step, not an
expansion of applyResumeSnapshot to those paths. See
[ADR-0014's resume contract](0014-session-resume-and-restore.md).

The normalization regression coverage is in
[network_access.test.ts](../../wrapper/codex/test/network_access.test.ts)
(the three-sandbox matrix) and
[host.test.ts](../../wrapper/codex/test/host.test.ts)
(normalization and legacy snapshot self-healing).

### F4 — Dashboard UI: engine-native operations + two-axis badge display

- **Display** (AgentCard / AgentDetail): unify on two-axis badges sourced from
  `ext.permission`, independent of engine. During an unobserved execution,
  `permission_control.constraints` retains fixed approval/enforcement metadata;
  sandbox/network remain explicitly unknown. Permission absence never authorizes
  the Claude mode picker; require affirmative mode metadata.
- **Operations** (LaunchDialog / AgentDetail): show an engine-native selector.
  Claude = mode selector (six values); Codex = sandbox selector (three values) +
  network-access toggle when workspace-write. Mid-session sandbox/network controls
  require `supports_permission_switch=true`; absence or false hides them. Accept
  selections while busy and show pending/submitted/unknown separately from
  observed permissions. Do not optimistically update effective badges. Include
  the two-axis conversion in
  each option label (for example, “acceptEdits — write: workspace / approval:
  on-request equivalent”).
- Do **not** adopt the initially considered cross-engine preset shortcuts
  (default / edit-friendly / yolo, etc.): there are only 3–6 selectable
  combinations per engine, and the preset layer would only increase mapping
  maintenance (decided in 2026-07-10 spec elicitation, old Q3 closed).

#### F4 Addendum (2026-07-11, symmetry for phase-15)

Operational verification after phase-14 found that the permission UX remained
asymmetric between engines. From the experience of もも (Codex agent), the two
most significant issues were that the Codex effective values and host-fixed
constraint were unreadable in the UI next to Claude’s single-axis mode, and that
Plan mode and sandbox were displayed together so work intent and effective write
scope could not be distinguished. Strengthen the F4 UI contract as follows.
Implement it in [phase-15-wrapper-ux-parity](../plans/phase-15-wrapper-ux-parity.md) D2.

- **Show effective values in the Claude switcher in AgentDetail**: the F4 Claude
  mode selector already displays two-axis conversion on candidates through
  `PERMISSION_MODE_AXES` (`AgentDetail.svelte` `.axes-hint`). Also keep an effective
  value badge (`書込: sandbox / 承認: approval`) permanently on the current
  mode label after selection, so the operator can understand current effective
  permissions without opening the candidate menu.
- **Permanent “approval: never (host-fixed, upstream constraint)” badge on Codex**:
  sandbox/network switching does not enable approval switching. Source the label
  from control constraints while ext.permission is absent. Link the fixed
  approval label to [codex-exec-approval-upstream](../open-questions/codex-exec-approval-upstream.md).
- **Add a Claude permission_mode selector to LaunchDialog**: currently only
  Codex shows a sandbox selector and Claude can select a mode only after launch in
  AgentDetail. Add a mode selector (default / plan / acceptEdits / dontAsk / auto /
  bypassPermissions) when engine=claude-code, with a two-axis conversion tooltip
  on each candidate. Pass the desired mode at launch to make “choose permissions
  at launch” symmetric between engines.
- **Display Plan mode and sandbox in two parallel frames**: current Claude Plan
  mode represents work intent (planning only, no tool execution), but its two-axis
  mapping collapses to `sandbox: read-only / approval: on-request`. Display
  AgentDetail permissions in parallel frames for **“work intent (mode)”** and
  **“effective write scope (sandbox)”**, so the operator understands that selecting
  Plan mode makes the effective sandbox read-only.

#### F4 Addendum: mention configuration-diff detection on resume

As phase-15 D8, introduce a framework that puts the previous session’s resolved
snapshot (model / sandbox / approval / network_access / effort) and the values
forced by the current host into the envelope on resume; if they differ, expose an
stderr warning + AgentDetail badge. Since the envelope schema extension spans both
this ADR and [ADR-0032](0032-codex-adapter.md) F4bc, handle detailed design in the
phase-15 plan. This F4 addendum fixes only the principle that diff display uses the
same frame as the two-axis permission UI and an engine-neutral badge.

### F5 — Relationship to ADR-0022

Preserve the principle from [ADR-0022](0022-pending-permission-authoritative-source.md)
that `state_change.ext.pending_permission` is the authoritative source. This ADR
adds `sandbox` / `approval` to that payload shape as an addendum; it does not
supersede ADR-0022.

## Consequences

### Positive

- Preserve Codex’s two-axis expressiveness while representing Claude / Codex
  permission concepts in one engine-neutral envelope schema (`ext.permission`).
- Dashboard permission **display** is unified without engine branches (implement
  only two-axis badges). Operation UI remains engine-native, but the engine
  adapter returns the option set, so engine knowledge does not leak into the
  dashboard.
- Codex’s OS-level sandbox becomes a first-class envelope value, making its safety
  model — “sandbox can constrain actions even without approval” — visible to the
  operator.

### Negative

- During the one-release parallel period for `ext.permission_mode`, the wrapper
  sends both fields.
- The Claude six-mode → two-axis mapping is a **display approximation**; detailed
  mode semantics (such as classifier approval in auto) do not fit on two axes.
  Labels provide the context.
- Codex’s approval experience does not exist until upstream
  `exec_permission_approvals` becomes stable (tracked in
  [open-questions/codex-exec-approval-upstream](../open-questions/codex-exec-approval-upstream.md)).

### Neutral

- The role of the `permission_request` envelope (downgraded to an initial
  notification in ADR-0022 F2) does not change here. The two-axis fields are also
  synchronised inside the envelope.
- Viewer delivery is automatically covered by ADR-0021’s allow-list (ext is
  completely removed for viewers).

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| Maintain a common action-preset abstraction (`default / accept-edits / auto-shell / plan-only / yolo`) as one axis | It flattens Codex’s two-axis expressiveness into one axis, and the semantic mapping table becomes an open-question sink. Preset naming also has a high agreement cost. |
| Expose engine-specific vocabulary directly in the UI (Claude six modes beside Codex’s two axes) | Dashboard permission **display** becomes a different set per engine, and envelope schema / server validation fills with engine branches (a separate issue from making operation UI engine-native — display is unified on two axes). |
| Flatten Codex to one axis and keep the existing `permissionMode` schema | Loses Codex’s two-axis expressiveness and hides its OS sandbox safety model from the envelope. |
| Put `sandbox` / `approval` inside pending_permission (the initial ADR draft) | Codex emits no pending_permission (the approval flow cannot be provided through exec), leaving nowhere to put Codex’s permission state. Unify it at agent-level `ext.permission`. |
| Cross-engine preset shortcut layer (old Q3 temporary policy) | Only 3–6 combinations are selectable per engine, so it adds mapping maintenance; most presets collapse to the same setting in Codex. |
| Wire approvals by calling `codex app-server` (JSON-RPC) directly | Abandons the published SDK for an experimental protocol. High implementation cost and fragile against upstream changes; an approval transport is outside this decision. |

## Related

- Source addendum: [ADR-0022](0022-pending-permission-authoritative-source.md)
  (preserve the authoritative-source principle while extending ext).
- Origin: [ADR-0032](0032-codex-adapter.md) F2 (permission abstraction extension
  for adding the Codex adapter).
- Implementation: [phase-14-codex-adapter](../plans/phase-14-codex-adapter.md),
  [phase-15-wrapper-ux-parity](../plans/phase-15-wrapper-ux-parity.md) (F4 addendum
  and D8 resume diff detection).
- Open questions: [codex-exec-approval-upstream](../open-questions/codex-exec-approval-upstream.md)
  (upstream approval tracking). Old Q2 (envelope schema) / Q3 (UI vocabulary)
  were resolved and closed on 2026-07-10.
- Related ADR: [ADR-0034](0034-session-capabilities-advertisement.md) (extend the
  engine-neutralisation pattern through session capabilities; determine attach /
  question-dialog availability from session capabilities rather than engine name).
- Related specs: [protocol](../specs/protocol.md) (`ext.permission` addendum),
  [plugin-model](../specs/plugin-model.md).
