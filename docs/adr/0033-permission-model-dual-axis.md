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
released; the default approval_policy for exec is `never`). Therefore, the Codex
agent’s two axes are fixed at spawn, and `waiting_permission` never occurs for
Codex. Track upstream approval support in [open-questions/codex-exec-approval-upstream](../open-questions/codex-exec-approval-upstream.md).

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

### F3 — Codex uses the two axes directly (`approval` fixed to `never`)

The `wrapper/codex` adapter projects the `sandbox_mode` selected at spawn directly
to `ext.permission.sandbox`. `approval` is **fixed to `never`** — `codex exec`
forces approval_policy to `never` through a harness override (even
`-c approval_policy=...` is ineffective), and no path exists to return approval
through the SDK, so report the fact as-is in the envelope. Mid-session permission
changes (the equivalent of `set_permission_mode`) are also unsupported in Codex.

The resume path for restoring `sandbox` / `network_access` is consolidated in
[ADR-0014 F1 addendum “reapply three privilege axes on resume”](0014-session-resume-and-restore.md).
The F3 principle of “fixed at spawn” remains: values decided at fresh spawn only
propagate through the snapshot to restore / switch / reset resume operations; they
do not switch mid-session (the Codex adapter throws from `setPermissionMode`).

#### F3 Addendum: normalise effective `network_access` (phase-22 dogfood 藤 audit)

During phase-22 dogfood verification, a dashboard incident showed
`network_access` as `false` for a Codex agent (`sandbox=danger-full-access`) after
restart / resume, triggering an audit (藤 audit). The old `runner.log` showed that
`false` had already continued from before that restart, and **there is no direct
evidence that the current restore relay dropped `true`**. The root cause was a
**semantic mismatch** in which the raw toggle was propagated as effective:
`WrapperConfig.network_access` was copied without a sandbox branch into
`ext.effective.network_access` / whoami / the server DETS snapshot. The Codex SDK
passes `networkAccessEnabled` to enforcement only for `sandbox="workspace-write"`;
with `danger-full-access`, network is included in the sandbox (effectively enabled),
and with `read-only` it is always disallowed. Reporting the raw toggle in both
modes produced display and persistence that contradicted the effective state.

As an addendum, separate `network_access` into two concepts:

- **Spawn-config raw toggle** (`WrapperConfig.network_access`) — the value desired
  by the operator; meaningful only for the `workspace-write` sandbox
- **Effective value** (`ResolvedSnapshotExt.network_access`,
  `ext.effective.network_access`, whoami, and the server DETS snapshot) — the
  sandbox-aware normalised network state that is actually enforced

Implement the normalisation rule as one pure helper
`effectiveNetworkAccess(sandbox, toggle)` in `wrapper/codex/src/network_access.ts`,
and route both Host effective-status snapshots and the CLI startup resolved log
through the same helper (SSoT):

| sandbox | effective network_access |
|---|---|
| `danger-full-access` | `true` (network is included in full access) |
| `read-only` | `false` (network unavailable) |
| `workspace-write` | `configured` (reflect the raw toggle, default `false`) |

Host `#threadOptions()` (the SDK enforcement path) already correctly passes
`networkAccessEnabled` to the SDK only for workspace-write, so leave it unchanged.
This addendum corrects only the display / persistence layer; runtime behavior (the
actual set of permitted network calls) does not change.

**Legacy self-healing contract**: A persisted incorrect snapshot from before the
addendum (`{sandbox:danger-full-access, network_access:false}`) is normalised to
`effective=true` by the wrapper on the next resume, and `ext.resume_drift` emits
`{field:network_access, prev:false, now:true}` **once**. The next
`record_snapshot` updates the server DETS to `true`, resolving the drift thereafter.
Do not change runner / server Phase22 precedence (an explicit boolean in the
snapshot takes priority over the engine default) or the no-apply contracts for
fresh spawn / crash restart / rollback (the correction stays in the wrapper layer).

**Related implementation**: `wrapper/codex/src/network_access.ts` (helper, SSoT),
`wrapper/codex/src/host.ts` `#effectiveStatusSnapshot()` (replacement),
`wrapper/codex/src/cli.ts` startup resolved log (replacement), and
`protocol/src/index.ts` `ResolvedSnapshotExt` (doc-comment addendum). Tests are
`wrapper/codex/test/network_access.test.ts` (three-sandbox matrix) and
`wrapper/codex/test/host.test.ts` (one danger-full normalisation case / one legacy
self-heal drift case).

### F4 — Dashboard UI: engine-native operations + two-axis badge display

- **Display** (AgentCard / AgentDetail): unify on two-axis badges sourced from
  `ext.permission`, independent of engine.
- **Operations** (LaunchDialog / AgentDetail): show an engine-native selector.
  Claude = mode selector (six values); Codex = sandbox selector (three values) +
  network-access toggle when workspace-write. Include the two-axis conversion in
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
  AgentDetail currently only omits the mode switcher for Codex (ADR-0033 F3,
  set_permission_mode rejected), leaving the operator unable to tell whether this
  is unchangeable or an implementation omission. Add the explicit permanent label
  to Codex permission display. Link it to [codex-exec-approval-upstream](../open-questions/codex-exec-approval-upstream.md).
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
| Wire approvals by calling `codex app-server` (JSON-RPC) directly | Abandons the published SDK for an experimental protocol. High implementation cost and fragile against upstream changes; startup-fixed two axes are sufficient for the MVP. |

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
