---
title: Extension of common abstract of permission model to two axis of sandbox × approval
status: accepted
date: 2026-07-10
opened: 2026-07-10
supersedes: []
superseded_by: null
related_specs: [protocol, plugin-model]
related_adrs: [22, 32, 34, 38, 41, 43]
---

# ADR-0033 — Extend permission model common abstract to two axis of sandbox × approval

## Status

Accepted ([phase-14-codex-adapter](../plans/phase-14-codex-adapter.md)) The envel  schema and Claude image table and UI vocabulary have been confirmed with 2026 SDK-10 real SDK validation andlic-elicitation (previous open-questions Q2/Q3 is resolved and closed).

## Context

The permission model abstract of the current wrapper / server / dashboard is a single axis that follows the `permissionMode` (default/acceptEdits/bypassPermissions/plan/dontAsk/auto) of the Claude Agent SDK, exposed to `ext.permission_mode` of [protocol](../specs/protocol.md), and authoritative source of `ext.pending_permission` was established in `state_change.ext`. [0022-pending-permission-authoritative-source](0022-pending-permission-authoritative-source.md)

When adding a codex CLI adapter with [ADR-0032](0032-codex-adapter.md), there is a required that matches the common abstract to the fact that the Permission model of Codex is biaxial (the value set is demonstrated in the type definition of `@openai/codex-sdk` 0.144.1):

- **sandbox_mode**: `read-only` | `workspace-write` | `danger-full-access`— writeability and scope to file system (OS level sandbox).
- **approval_policy**: `untrusted` | `on-request` | `on-failure` | `never`— A policy to request approval for each operation. Initial ADR`granular`does not exist in the SDK.

Claude is a single-axis mode, so it is more expressive to express it in two-axis because it is not possible to distinguish between "Is it good to do shell?" and "Is it good to do file edit?". To crush a single-axis preset (`default / accept-edits / yolo`, etc.), the common abstract itself is expanded to two-axis to lose the expressive power of the Codex biaxial.

**Constraints (2026 -10)**: `@openai/codex-sdk` has a new spawn of `codex exec` every turn and closes stdin without prompt.**There is no route to apply operator approval to the SDK during execution**(feature flag `exec_permission_approvals` is under development = not released, the default approval policy of the exec is `never`). Thus, the two axis of the codex agent is fixed when spawn, and the `waiting_permission` state does not occur in Codex. [open-questions/codex-exec-approval-upstream](../open-questions/codex-exec-approval-upstream.md)

## Decision

### F1 — envel  schema’s biaxial expansion (`ext.permission`)

The `ext.permission = {sandbox, approval}` of the agent-level is newly established and the current `ext.permission_mode` is succeeded. `pending_permission` (record per approval request)**not**— Codex does not issue pending permission (contextAbout Uss), and Claude has `state_change.ext` along with `permission` and `pending_permission`.

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

Enumeration (without a copy layer):

- `sandbox`: `read-only` | `workspace-write` | `danger-full-access`
- `approval`: `untrusted` | `on-request` | `on-failure` | `never`
(`on-failure` deprecated alias of `on-request` in upstream 0.144)
kaoiro wrapper does not emit, but for compatibility with the SDK type
left in enum)

**depre  plan (D-A)**: `ext.permission_mode` sends `ext.permission` between the release window and deletes it in the next release (same as the personas legacy field of [ADR-0031](0031-runner-persona-trust-mode.md)). dashboard only reads `ext.permission` from this phase.

### wrapper/claude-code

The `permissionMode` 6 value of the Claude Agent SDK → the image to the two-axis has the image table in the `wrapper/claude-code` adapter. By normalizing the SDK output with wrapper, and then putting it in envel., wrapper and dashboard should be handled only two axis without conscious of the engine vocabulary. Photo**approximation for display**The value passed to the SDK is the mode itself:

| Claude mode | sandbox | approval |S  doc|
|---|---|---|---|
| `default` | workspace-write | untrusted |"prompts for dangerous operations"|
| `acceptEdits` | workspace-write | on-request |file edit Auto approval, etc. confirm at model request|
| `plan` | read-only | on-request |Tool without execution and read only|
| `bypassPermissions` | danger-full-access | never |All Bypass|
| `dontAsk` | workspace-write | never |"deny if not pre-approved"|
| `auto` | workspace-write | on-request |Authorization by the classifier (request itself occurs)|

### F3 — Codex uses two axis directly (approval is`never`Fixed)

The `wrapper/codex` adapterJapanese termifies the `sandbox_mode` selected when spawn. `approval`**`never` Fixed**— `codex exec` forces approval policy to `never` with harness override (`-c approval_policy=...` is also disabled), and the path to which the authorization is applied via SDK does not exist, so put the fact in envel . `set_permission_mode` is not supported by Codex.

`sandbox` / `network_access` restore path is aggregated to [ADR-0014 F1 Supplementary supplement “Three-axis reapplication at resume”](0014-session-resume-and-restore.md). This F3’s “spawn time-fixed” principle is maintained, and the value determined when fresh spawn is bound to restore/switch/reset resume operations via snapshot, not to switch to mid-session (Codex adapter throws `setPermissionMode`).

#### F3: Effective`network_access`normalization (phase-22 dogfood Home audit)

phaseing phase-22’s dogfood validation, `network_access` of Codex agent (`sandbox=danger-full-access`) was audited on dashboard after restart / resume. (Fuji audit) `runner.log` is followed by `false`**There is no direct evidence that this restore relay dropped `true`**Home root cause israwagated as "raw toggle"**semantic mismatch**So, the implementation of raw toggle of `WrapperConfig.network_access` was expressed as it was in `ext.effective.network_access` / whoami / server DETS snapshot without sandbox. To pass `networkAccessEnabled` only when `sandbox="workspace-write"`, `danger-full-access` will always be unauthorised in `read-only`. Report raw toggle in both modes**Inconsistency state**Display and persistence.

`network_access` to the next two concepts**separation**To:

- **spawn config raw toggle**(`WrapperConfig.network_access`) — the desired value specified by the operator. `workspace-write` Sandbox has only meaning
- **effective**(`ResolvedSnapshotExt.network_access`, `ext.effective.network_access`, whoami, server DETS snapshot) — network state that is normalized and actually enforced to sandbox-aware

The normalization rule is a single implementation to `wrapper/codex/src/network_access.ts` as pure helper `effectiveNetworkAccess(sandbox, toggle)`, and both host effective-status snapshot and CLI startup resolved log callsites pass the same helper (SSoT):

| sandbox | effective network_access |
|---|---|
| `danger-full-access` | `true`(network is in full access)|
| `read-only` | `false`(network)|
| `workspace-write` | `configured`toggle`false`) |

Host's `#threadOptions()` (S enforcement enforcement route) was unchanged because it was originally correct in the implementation of workspace-write only `networkAccessEnabled` to the SDK.**display / Persistent layer only**the runtime behavior (which is actually allowed network calls) will not change.

**Legacy Self-Repair Agreement**: Persistent error snapshot (`{sandbox:danger-full-access, network_access:false}`) is normalized to `effective=true` on the next resume and `{field:network_access, prev:false, now:true}` on `ext.resume_drift`**Only once**Contact Us dr DETS is updated to `true` in the following `record_snapshot`.  engine / server-side Phase22 precedence (snapshot explicit boolean is preferred by engine default) and fresh spawn / crash restart / rollback no-apply contract**Not changed**wrapper layer.

**Pets**: `wrapper/codex/src/network_access.ts` (helper, SSoT), `wrapper/codex/src/host.ts` `#effectiveStatusSnapshot()` (subst tion), `wrapper/codex/src/cli.ts` startup resolved log (subst tion), `protocol/src/index.ts` `ResolvedSnapshotExt` (doc comment supplement). test is `wrapper/codex/test/network_access.test.ts` (3 sandbox matrix) and `wrapper/codex/test/host.test.ts` (danger-full normalization / legacy self-heal drift each 1 case).

### F4 — dashboard UI is engine-native operation + biaxial badge display

- **display**(AgentCard / AgentDetail): Unified by engine in a biaxial badgeBadge from `ext.permission`.
- ****(Launch engine / AgentDetail) Claude = mode select (6 value), Codex = sandbox select (3 value) + network access toggle at workspace-write. Labels for each option are biaxially converted (e.g. "acceptEdits — write: workspace / approval: on-request equivalent").
- initial cross- edit preset shortcut (default / edit-friendly / yolo, etc.)****: There are only 3-6 combinations for each engine, and the preset layer can be increased only for image maintenance (2026.-10.-elicitation, the former Q3 close).

#### F4 supplement (2026-11-11, Namemetrical for phase-15)

It was found that the permission UX remains aNamemetric between the engine in the actual operation verification after phase-14 was completed. As Home (Codex agent), there are two points that "Codex biaxial efficacy and host-fixed modes can not be read by UI" and "Plan mode and sandbox are mixed, and it is not distinguished from work intentions and efficacy". Enhance the F4 UI contract with the following items: [phase-15-wrapper-ux-parity](../plans/phase-15-wrapper-ux-parity.md)

- **AgentDetail Claude switcher**: The Claude mode select of F4 has already been displayed in `PERMISSION_MODE_AXES` to the candidate (`.axes-hint` of `AgentDetail.svelte`).  **mode label**Permanently set a valid badge (`Contact: sandbox / Application: approval`). Allow operators to see the current valid permission without opening the candidate menu.
- **Codex “Approval: never” permanent badge**: The AgentDetail of the Codex agent does not emit the current mode switcher (reject ADR-0033 F3, set permission mode), and the operator cannot determine whether it is unchanged or not implemented. In addition, "Approval: never (host-fixed, upstreamLabelss)" is permanently set as an explicit label on the permission display of the Codex agent. link [codex-exec-approval-upstream](../open-questions/codex-exec-approval-upstream.md)
- **Launch  Home Claude permission mode**: The current Launch  can only select the sandbox select for Codex, and you can only select the mode on the AgentDetail side after Claude. Added mode select (default / plan / acceptEdits / dontAsk / auto / bypassPermissions) when mode=claude-code. Allows you to specify the desired mode at startup, and establishes the Sexmetry that "you can decide the permission at startup".
- **Plan mode and sandbox**: Current Claude's Plan mode expresses "work intention (plan only, tool execution)", but the two-axis projection can be crushed to `sandbox: read-only / approval: on-request`. As a supplement, the permission frame of AgentDetail**Two-frame s of work intention (mode) and sandbox**display. When the operator selects Plan mode, the effective sandbox becomes read-only.

#### F4 Compensation: Reference to difference detection at resume

In phase-15 D8, the resolved snapshot (model / sandbox / approval / network access / effort) of the previous session at resume and the value that host is forced to envel., and if there is a difference, the framework that is exposed with the stderr warn + AgentDetail badge is introduced. The envel  schema extension crosses both this ADR and [ADR-0032](0032-codex-adapter.md) F4bc, so the detailed design is handled by phase-15 plan. This F4 supplement is determined only in the principle of “Display of differences is done in the same frame as the permission biaxial UI and unified by the Principle neutral badge”.

### F5 — ADR-0022

`state_change.ext.pending_permission` maintains authoritative source principles in this ADR. This ADR does not supersede ADR-0022 by adding `sandbox`/`approval` to its payload shape. [0022-pending-permission-authoritative-source](0022-pending-permission-authoritative-source.md)

## Consequences

### Positive

- Codex The permission concept of Claude/Codex can be expressed in a single envel  schema (`ext.permission`), without losing the expressive power of the two axis.
- dashboard permissions**display**simplify without engine  . The operation UI is engine-native, but the engine adapter is not included in the dashboard.
- Codex's OS-level sandbox is the first-class representation on envel  and the safety model of Codex looks like the operator.

### Negative

- The `ext.permission_mode` 1 release windowHome period, the wrapper sends both fields.
- Claude 6 mode → biaxial mapping for display**Close**and mode's subtle semantics (such as auto classifier approval) will not fall into two axis. Compensate with labels.
- Codex authorization experience does not exist until `exec_permission_approvals` of upstream is stable (tracked with [open-questions/codex-exec-approval-upstream](../open-questions/codex-exec-approval-upstream.md)).

### Neutral

- `permission_request` The role of envel  (ADR-0022 F2 has been disqualified) is not changed in this ADR. The biaxial field is alsoJapanese termhronized in envel..
- viewer delivery is auto-covered with allow-list of ADR-0021.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
|Act preset common abstract (`default / accept-edits / auto-shell / plan-only / yolo`) Single axis|Codex The expression of two axis is crushed into a single axis, and the semantics mapping table is eventually the openest of open-question. preset  ing cost is also large|
|Exposure to the UI (Claude 6 mode and Codex biaxial)|dashboard Home permission**display**is a different set for each engine, and envel  schema / server validation is the engine UI.|
|Round the codex side into a single axis`permissionMode`Install schema|Codex loses the expressive power of the two axis and the safety model of the OS sandbox is not visible in envel |
| `sandbox` / `approval`pending permission|Codex does not issue pending permission (the authorization flow itself cannot be provided by exec), so the location of the permissionstate of Codex disappears. agent-level`ext.permission`Home|
|cross-  preset|There are only 3-6 different combinations for each engine. In Codex, most presets can be crushed to the same|
| `codex app-server`(JSON-RPC)|The published SDK is discarded and depends on experimental protocol. Implement cost large · Upstream  ile by changing. MVP is a fixed two-axis|

## Related

- Source: [ADR-0022](0022-pending-permission-authoritative-source.md) (ext extension while maintaining authoritative source principles).
- Origin: [ADR-0032](0032-codex-adapter.md) F2 (extension of the permission abstract accompanying Codex adapter).
- : [phase-14-codex-adapter](../plans/phase-14-codex-adapter.md), [phase-15-wrapper-ux-parity](../plans/phase-15-wrapper-ux-parity.md) (F4 supplementation and D8 resume differential detection).
- Open questions: [codex-exec-approval-upstream](../open-questions/codex-exec-approval-upstream.md) (tracking upstream approval). Q2 (envel  schema) / Q3 (UI vocabulary) is resolved to 2026.-10.
- engine ADR: [ADR-0034](0034-session-capabilities-advertisement.md) (expansion of engine neutralization pattern by session capability). attach / question dialog()
-CO:s: [protocol](../specs/protocol.md) (`ext.permission` supplement), [plugin-model](../specs/plugin-model.md).
