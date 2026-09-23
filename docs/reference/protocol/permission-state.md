---
title: Permission state contract
status: accepted
last_updated: 2026-09-19
description: The ext.permission two-axis model and the requested/submitted/effective state machine for a permission change.
---

# Permission state

#### Two-axis `ext.permission` (2026-07-10, [ADR-0033](../../adr/0033-permission-model-dual-axis.md))

- `ext.permission`: `{ sandbox, approval, enforcement? }`, attached to `state_change`
  - `sandbox`: `"read-only" | "workspace-write" | "danger-full-access"`
  - `approval`: `"untrusted" | "on-request" | "local" | "on-failure" | "never"`
    (`local` is Antigravity-only; `on-failure` is an upstream deprecated
    alias and kaoiro wrappers do not emit it)
  - `enforcement` (ADR-0057 F4/F4c): `"os" | "mode" | "advisory"` — how the
    sandbox axis is actually enforced, so the dashboard never branches on
    engine name; only `"advisory"` (Antigravity) renders a permanent badge

The Claude adapter has a six-mode → two-axis mapping table (ADR-0033 F2,
display approximation) and stamps `enforcement: "mode"`. The Codex adapter
projects its spawn sandbox_mode and fixed `approval: "never"` because exec
has no approval flow (ADR-0033 F3), stamping `enforcement: "os"` (its
sandbox is the real OS sandbox). The Antigravity adapter stamps
`enforcement: "advisory"` because its `--sandbox` flag was measured to have
no effect; the wrapper enforces the cell by inspecting tool arguments,
never by the OS (ADR-0057 F4).

Antigravity `local` is an advisory command-shape allowlist between
`on-request` and `never`: read tools, in-workspace writes outside `.git`,
restricted read-only shell commands, and explicitly classified observational
Git commands may proceed without a dialog. Unknown syntax, `.git` writes,
commit, merge, remote/network commands, package installation, destructive
commands, and any compound command with a non-allowed segment ask the
operator. Git path operands must resolve inside the agent cwd; nonexistent
in-cwd paths are accepted because they only fail with `ENOENT`. Revision
syntax is limited to `HEAD`, `HEAD~n`, branch-like names, two-dot/three-dot
ranges, and `<revision>:<path>`; that last path is checked independently and
ambiguous syntax asks. Pre-existing repository or global configuration can
still name helpers such as `diff.external`, `core.fsmonitor`, or a clean filter
used by `git add`, and remains within the operator's trust boundary rather than
this advisory classifier's guarantee. `git add` is included because it updates
the index without running hooks. Its scope remains repository-relative:
invoking `git add -A` or `git add .` from a repository subdirectory can stage
paths beyond the agent cwd.

**Deprecation of `ext.permission_mode`**: `ext.permission` is the successor.
Emit both fields for one release window, then remove `permission_mode` in the
next release (ADR-0033 F1, D-A). New clients read only `ext.permission`.

#### Requested, submitted, and effective state

Codex coalesces repeated `turn_context` records only when the execution turn ID
and all observed policy axes agree. Compaction may emit such repeats; conflicting
observations remain unconfirmed.

A blocked Codex dispatch publishes `waiting_permission` without starting the SDK turn.
After 30 seconds it cancels that never-started instruction, reports
`permission_gate_blocked` to its sending peer, and returns to `waiting_input`.
Interrupt and close also cancel a waiting instruction without a start acknowledgement.
Cancellation, timeout, session reset, and rejoin do not clear the permission block.
The operator can reapply the same raw sandbox/network values to allocate a newer
revision; after reconciliation the sender can resend the cancelled instruction.
No automatic resend occurs.

`ext.permission_control` (`PermissionControlExt`) is the latest request and its
progress. It is independent of approval-broker `ext.pending_permission` and
model/effort `ext.switch_error`:

```ts
{
  revision: number,
  requested: PermissionConfiguration,
  constraints: PermissionConstraints,
  status: "pending" | "applying" | "applied" | "failed" | "unknown",
  submitted?: PermissionSubmission,
  effective?: PermissionObservation,
  last_effective?: PermissionObservation,
  reason?: string,
  rolled_back_to?: PermissionConfiguration
}
```

`PermissionSubmission` is `{revision, requested, execution_id}`.
`PermissionObservation` extends it with `{session_id, turn_id, permission,
network_access}`; `permission` is the existing `PermissionAxesExt`.
In `applying`, `applied`, and `unknown`, the submission must match the control's
own revision and raw requested pair. An applied state also requires effective
evidence with the same revision, requested pair, and execution_id as submitted.
`pending` and `failed` may carry evidence for a different selection: a pending
successor, a rejected successor with its predecessor's evidence, or a detected
request/submission mismatch. The observation adds the engine identities; it does
not replace the immutable submission. Never combine the server's requested pair
with a wrapper execution_id to manufacture evidence of what that exec captured.
`execution_id` is a wrapper-generated correlation ID for one exec; `session_id`
and `turn_id` are engine-observed identities. `turn_id` is optional and omitted
ONLY by an advisory engine that has no per-turn identifier (Antigravity resumes
by conversation and emits no turn id, ADR-0057 F4c); Codex and Claude Code keep
it required, and manufacturing one from a session id or a wrapper token stays
forbidden. Because the engine that may omit it is the wrapper's self-reported
one, the server relaxes the audit-event shape to accept a missing `turn_id`
only when that engine is Antigravity, rejecting the omission for every other
engine (issue #359 M1). Requested/submitted values retain
raw network configuration. Expected network access is normalized: full access
is true, read-only is false, and workspace-write uses the configured toggle.
Confirm this against the new policy record, including its workspace-write
network field; if it differs, report the observed value and the mismatch.
Never copy an observed full-access true into the raw toggle for a later
workspace-write selection.

Revision zero is reserved for the wrapper's initial raw launch baseline; it is
not an operator command. Before accepting the first operator patch, the server
must persist that baseline in PermissionSettings, bound to the agent and engine.
It is a real prior next-execution selection even if no exec has run, but is not
an effective observation. Before the first execution, publish that baseline with
`status=pending`, no submitted/effective observation, and no permission audit
transition. A supporting wrapper sends the control state on every state change.
For engines without this capability, the legacy startup display is unchanged.

| Event | State of latest request | Effective publication |
|---|---|---|
| Request accepted before the next exec | `pending` | Keep a known current observation, if any; no optimistic promotion. |
| Exec captures this revision | `applying` | Move prior observation to `last_effective`; current permission is unknown. |
| This exec's policy is confirmed | `applied` | Publish this observation to `effective`, `ext.permission`, and the sandbox/network fields in `ext.effective`. |
| Definitive rejection before application or observed policy mismatch | `failed`, with `reason` | A `rolled_back_to` pair is allowed only when pre-application rejection is established; do not invent an observation. |
| Exec outcome or policy cannot be established | `unknown`, with `reason` | Omit current effective permissions. Historical evidence stays in `last_effective`. |
| General `turn.failed` after policy confirmation | Remain `applied` | Retain the observation. Permission is not a model-selection rollback. |

The table describes a request with no newer successor. If revision B arrives
while A runs, the top-level request is B/pending while `submitted` and a known
`effective` may describe A. A's eventual result cannot settle or erase B. Retain
A's submission and request binding until its outcome is handled; comparing pair
values alone does not distinguish A from B. A delayed observation for a finished
execution may update historical evidence, never the current execution's badge.
An idle session retains its last confirmed policy until the next exec starts.

For Codex, confirmation must read `sandbox_policy` and `approval_policy` from
**this execution's** rollout `turn_context`. Capture a pre-execution file boundary
and existing turn identity, then accept only a new correlated record. Neither
`turn.started` (which carries no turn ID or permission fields -- reconfirmed
at SDK 0.156.1 via an offline loopback capture, issue #399, unchanged from
0.153.4) nor a prior tail record is confirmation. Handle delayed/partial writes and
session changes without promoting stale evidence. A policy mismatch is a loud
failure with the actually observed policy, not a silent substitution. An
approval value other than the fixed `never` is a contract violation; do not
continue dispatch until reconciled. The effective claim is an observation of
the engine's policy, not a proof that every OS isolation primitive succeeded.

**Mismatch representation.** A detected mismatch after submission uses
`status:"failed", reason:"policy_mismatch"`, with `rolled_back_to` absent.
Keep the server-authorized selection as `next`; stop dispatch until the operator
reconciles it. Preserve the actual submission and any actual observation in
`submitted` and `effective`, respectively. Do not rewrite them to match the
authorized pair, substitute historical evidence as current, or use `unknown`
to carry a submission that disagrees with the top-level selection. If no
observation exists, omit `effective`; do not fabricate one to fill the record.

For example, the server accepted read-only at revision 8, but exec `e8` captured
workspace-write and its turn_context confirmed that policy. This complete sync
payload carries the discrepancy and keeps revision 8 blocked:

```ts
const authorized = { sandbox: "read-only", network_access: false };
const submitted = {
  revision: 8,
  requested: { sandbox: "workspace-write", network_access: true },
  execution_id: "e8",
};
const sync = {
  version: "0",
  control: {
    revision: 8,
    requested: authorized,
    constraints: { approval: "never", enforcement: "os" },
    status: "failed",
    reason: "policy_mismatch",
    submitted,
    effective: {
      ...submitted,
      session_id: "s1",
      turn_id: "t8",
      permission: {
        sandbox: "workspace-write", approval: "never", enforcement: "os",
      },
      network_access: true,
    },
  },
  next: { revision: 8, requested: authorized },
};
```

Once policy is confirmed, subsequent API failure does not roll it back. Only a
definitive rejection before application can set `rolled_back_to`; missing
observation never does. No automatic transition may widen permissions. Even
when the previous policy is narrower, it is not effective without observation
or proof of rejection before application. An unknown result preserves the
requested next configuration; it does not authorize resending user input or
creating a new turn automatically. A new operator selection may supersede it.

Clients render unknown as unknown, not as the previous observed badge. They may
show `last_effective` with an explicit historical label. `whoami` uses the same
observation/status distinction. Busy execution does not disable the picker;
network editing is offered for workspace-write. When
`permission_switch_axes` is advertised, the dashboard offers each sandbox,
network, or approval picker only when that axis arm is well formed. Sandbox and
approval options above `max` are disabled and labelled rather than hidden; a
false network ceiling disables enabling network while preserving the narrowing
true-to-false action. A missing or malformed arm keeps that axis launch-fixed
and hides its picker. When the whole field is absent, the legacy unclamped
sandbox/network controls remain available while approval stays host-fixed.
These client clamps mirror the authoritative server and wrapper gates; they do
not replace either gate.
Client ack/state updates cannot reduce the latest known revision or restore
pending after that revision settled. The server projects its authoritative
latest request to operator snapshots/live state so reloads and other clients
see pending requests even before a wrapper report arrives. Viewers receive no
permission control details under the existing ext removal rule.

Fixed adapter constraints are required in every control state, including the
initial revision-zero baseline: Codex sends `constraints:{approval:"never",
enforcement:"os"}`. These fields survive omission of `ext.permission`; they
state the configured contract, not an observation of an unstarted exec. For an
engine whose approval is launch-fixed (Codex), render the host-fixed approval
label from constraints and render sandbox and network as unknown until observed. If an observation contradicts a constraint,
show the observed value and a contract-violation error rather than concealing it
behind the fixed label.

The dashboard must not infer Claude mode switching from absent permission data.
Show the six-mode picker when `supports_permission_mode_switch` is true, even
before any mode metadata exists; show the current mode as unknown until reported.
An explicit false hides the picker. Only when the capability is absent may a
legacy wrapper qualify through affirmative mode metadata (`enforcement:"mode"`
or a valid legacy `permission_mode`). In every case, contrary enforcement in
either ext.permission or control constraints hides the picker. An absent
capability and absent mode metadata never authorize it; do not substitute an
engine-name allowlist or invent a default observed mode.

The Claude adapter must publish the capability through initialStatusExt and
retain it in subsequent status envelopes, independently of SDK initialization.
This requirement starts with the constructed host's first status: a pre-host
state_change with empty ext legitimately hides the picker. An older Claude
wrapper without the new capability also hides it until affirmative mode metadata
arrives; upgrade that wrapper to make the picker available before its first turn.
This producer must ship with the dashboard gate, so launching or restoring
without an explicit mode and without sending input still leaves a usable mode
picker. The existing command's validation, authorization and SDK mode semantics
remain unchanged. The independent
sandbox/network picker requires supports_permission_switch. Keep its network
row with an unknown label while observation is unavailable; do not gate the row
through Claude mode-switch availability. Updating these consumers is required
before the supporting capability is enabled end to end. Older dashboard clients
with the absence-as-mode fallback must be refreshed for this rollout; disabling
their new picker alone does not correct their legacy fallback.

## Related protocol topics

- [Envelope contract](envelope.md).
- [Permission requests](permission-requests.md).
- [Permission synchronization and audit](permission-sync-audit.md).
- [Permission control (two-axis model)](../../architecture/security-boundaries.md#permission-control-two-axis-model).
- [Model and effort state](model-effort.md).
- [Session capabilities](capabilities.md).
- [Session lifecycle](session-lifecycle.md).
- [State machine](state-machine.md).
- [Attachment wire contract](attachments.md).
- [Attachment rendering by engine](../engines/attachment-rendering.md).
- [Runner control and launch](runner-control.md).
- [Task and tasklist envelopes](tasks.md).
- [Persona delivery](persona-delivery.md).
