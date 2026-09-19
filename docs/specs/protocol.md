---
title: Common event protocol
description: Common event envelopes v0, state machines, and persona identity shared by wrapper, server, and client.
status: accepted
related: [architecture, plugin-model, claude-events, personas, security-threat-model, subagent-tasks, protocol-inter-agent]
---
<!-- markdownlint-disable MD033 -->

# Common event protocol (v0)

## Purpose

Moved to [Message topology](../architecture/message-topology.md#purpose).

## Definition

### Terms and hierarchy

Moved to [Envelope contract](../reference/protocol/envelope.md#terms-and-hierarchy).

### Design intent

Moved to [Message topology](../architecture/message-topology.md#design-intent).

### Envelope v0

Moved to [Envelope contract](../reference/protocol/envelope.md#envelope-v0).

#### Two-axis `ext.permission` (2026-07-10, [ADR-0033](../adr/0033-permission-model-dual-axis.md))

With the Codex adapter ([ADR-0032](../adr/0032-codex-adapter.md)), represent the
common permission abstraction at agent level as two-axis `ext.permission` (do
not duplicate axes inside `pending_permission`; ADR-0033 F1):

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

#### `ext.engine` (2026-07-10, [ADR-0032](../adr/0032-codex-adapter.md) F4a)

Moved to [Envelope contract](../reference/protocol/envelope.md#extengine-2026-07-10-adr-0032-f4a).

#### `ext.model_source` / `ext.effort_source` (2026-07-11, [ADR-0032](../adr/0032-codex-adapter.md) F4bc addendum, phase 15)

Source vocabulary indicating how model/effort values were chosen. Because it
communicates provenance, **preserve an explicit source even after SDK
confirmation**.

- Value: `"launch" | "env" | "config" | "default"` (`ModelSource` type)
  - `launch` — SpawnMessage.model / SpawnMessage.effort.
  - `env` — engine-specific environment (`KAOIRO_CLAUDE_CODE_DEFAULT_MODEL` /
    `KAOIRO_CODEX_DEFAULT_MODEL`).
  - `config` — `model` / `effort` in `kaoiro.config.json`.
  - `default` — no explicit value; delegate to the engine account / SDK default.
- Resolution priority: `launch > env > config > default`.
- Startup stamp: **when explicitly supplied**, stamp `model` and
  `model_source=launch|env|config` immediately (optimistic stamp, phase-15
  [15-4b/4c]). An SDK report rewrites neither: the pick keeps the spelling it
  was given (an alias `opus[1m]` is reported back as `claude-opus-5[1m]` and
  stays `opus[1m]`), and replacing the source with `default` would falsely
  claim an account default.
- **When unspecified**: stamp neither `model` nor `model_source` at startup;
  the first SDK report emits `model` with `model_source="default"`.
- **Engine-side switch away from an explicit pick** (issue #363, Claude
  `model_refusal_fallback`): the engine's latest report (init, context usage,
  or a session-scope fallback notice) is compared with the pick. Another
  spelling of the pick (equal string, or the catalog resolves both to one id)
  is the same model and shows nothing; an undecidable comparison (catalog not
  yet loaded) is held and judged once the catalog lands — a fallback notice
  is authoritative on its own. A report that is a different model is
  DISPLAY-ONLY: the top-level `ext.model` / whoami `model` show the running
  model with `model_source: "fallback"` (`DisplayedModelSource`), while
  `ext.effective` — and therefore the resume snapshot — keeps the explicit
  pick and its source, so a relaunch re-sends the operator's model (explicit
  `model` beats the CLI's resumed session state; measured on SDK 0.3.258).
  The wrapper also emits a one-shot `switch_error{reason:"sdk_fallback",
  requested:<pick>, rolled_back_to:<running>}`, a transcript system line,
  and a stderr diagnostic, and re-emits `state_change` whenever a report or
  the catalog moves the displayed model, not only at the next transition.
  `"fallback"` never appears in `ext.effective`; the runner pair rule and
  the server snapshot sanitizer do not accept it. A subagent-only fallback
  (`scope: "local"`) is logged and changes nothing.
  An explicit `set_model` supersedes the divergence and persists as
  `config` as before.
- Effort follows the same *startup* semantics (`ext.effort_source`): without
  an explicit startup value the wrapper does not know the SDK default and
  waits for its report. Unlike model, effort has no engine-side
  fallback-divergence display — `#applyModelFallback` never touches
  `#effort`/`#effortSource`, and `effort_source` stays typed `ModelSource`,
  not `DisplayedModelSource`.

#### `ext.session_capabilities` (2026-07-11, [ADR-0034](../adr/0034-session-capabilities-advertisement.md) F1/F2)

An envelope field expressing feature availability per session. It absorbs
differences (auth mode, plan tier, wrapper implementation) that engine names
cannot represent.

- Shape (`SessionCapabilitiesExt`):
  - `supports_attachments: boolean` — whether attachments are accepted (false disables the Composer attach button and shows a “not supported in this session” tooltip).
  - `attachment_types?: ("image")[]` — optional attachment restriction. **Absent preserves legacy behavior with no type restriction**; when present, only listed types are allowed. SDK block names are not exposed. Codex advertises `supports_attachments: true, attachment_types: ["image"]`, limiting picker/paste/drop to images; Claude omits the field and accepts all legacy types.
  - `supports_user_input_dialog: boolean` — availability of `ask_user_question`.
  - `user_input_modes?: string[]` — conditions when dialog firing is limited to a mode or sandbox (empty/absent = unconditional).
- **Stamp timing**: from the first `state_change` immediately after spawn (do not wait for a session-init event; Codex `thread.started` may not occur before the first turn, so waiting would show a false fail-closed default).
- Unstamped means conservatively “feature unavailable” (fail-closed); UI decisions use only this field.
- `supports_model_switch: boolean` — whether mid-session `set_model` is accepted (phase 16, [ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md) F4).
- `supports_effort_switch: boolean` — whether mid-session `set_effort` is accepted. UI shows/hides model and effort selectors from each boolean, never from engine name (ADR-0034 F3).
- `supports_permission_switch?: boolean` — accepts the engine-neutral `set_permission` control and implements its synchronization/observation contract below. Absent or false means unsupported. Codex advertises true only when the contract is implemented end to end; Claude and Antigravity Stage A do not. This is independent of Claude's six-mode selector.
- `supports_permission_mode_switch?: boolean` — accepts the existing six-value `set_permission_mode` command. Claude advertises true from its first state_change, including an idle spawn/restore with no configured or observed permission_mode, and retains it after SDK metadata arrives. Codex and Antigravity Stage A do not advertise true. This describes command availability, not the effective mode or fixed permission constraints. The absent-capability compatibility rule below is the explicit exception to the general unstamped-capability rule.
- `supports_session_reset: boolean` / `session_reset_modes?: ("new" | "clear")[]` — whether the operator can run `session_reset` and which modes are available. This is separate from exposing the agent's `request_session_reset` tool, which both engines now register behind per-call operator approval — Claude through canUseTool, Codex through the wrapper-side gate inside the bridge tool call (ADR-0043, 2026-09-14 amendment).
- `supports_context_usage: boolean` — whether this session provides an authoritative context-window snapshot in `ext.context` (phase 21, [ADR-0040](../adr/0040-context-usage-capability.md)). UI has three states:
  - **absent** — unstamped capability from an old wrapper during rolling upgrade; hide the context row rather than treating it as unsupported.
  - **explicit `false`** — adapter cannot provide an exact snapshot (currently Codex); show “unsupported”.
  - **explicit `true`** — adapter promises to stamp `ext.context`; show a meter when it arrives and a loading placeholder before then.
- Claude is `true`: SDK `getContextUsage()` can return exact `totalTokens`/`maxTokens`/`percentage` (best-effort even immediately after init; failures leave “loading”). Codex is `false`: `turn.completed.usage.input_tokens` is per-turn input only and shrinks on compaction, excluding reasoning/output, so it is not context usage (see [codex-sdk-events](../reference/engines/codex-exec-events.md)).

#### `ext.resume_snapshot` / `ext.effective` / `ext.resume_drift` (2026-07-11, [ADR-0032](../adr/0032-codex-adapter.md) F4bc + [ADR-0033](../adr/0033-permission-model-dual-axis.md) F4 addendum, phase 15)

Envelope extensions for D8 (resume drift detection), detecting unintended model
or permission substitutions on the resume path.

- `ext.resume_snapshot` (`ResolvedSnapshotExt`): the **last effective values** in
  the source session—`model`, `model_source`, `effort`, `effort_source`,
  `permission_mode`, `sandbox`, `network_access`, and `approval` (Antigravity's
  launch-fixed approval axis, [ADR-0057](../adr/0057-antigravity-adapter.md)
  F4c; unset means absent).
  **Important**: use the last effective values, not spawn values. If an operator
  changed model, effort, permission mode, or sandbox/network mid-session, snapshot
  the latest confirmed values so an intentional change does not trigger a resume drift.
- `ext.effective` (`ResolvedSnapshotExt`): effective values, same shape. For
  switchable permissions, sandbox/network fields require a current observation;
  omit them while the current execution's policy is unknown.
- `ext.resume_drift` (`ResumeDriftExt`): per-field differences between the two
  snapshots as `Array<{field, prev, now}>`; an empty array means no difference,
  absent means a fresh spawn rather than a resume.
- On a difference, the wrapper warns on stderr and AgentDetail shows a drift badge.

#### `ext.pending_model` / `ext.pending_effort` / `ext.switch_error` / `ext.effort_reset` (2026-07-13, [ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md) F1–F3, phase 16)

Represent the pending/effective/rollback stages of a mid-session model or effort
switch in the envelope. **The current turn is unchanged; apply from the next
turn** ([ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md) F1).

- `ext.pending_model?: string` — value requested by `set_model` but not yet
  applied as the next turn's `turn_context.model`; promote it to
  `ext.effective.model` and clear `pending_model` at the next turn. AgentDetail
  shows `pending: <display_name>`.
- `ext.pending_effort?: string` — same semantics for effort.
- `ext.effective` (phase 16) also carries the **current effective model/effort**
  during the session, promoting pending values at the next turn boundary and
  retaining them on subsequent `state_change` events.
- `ext.effort_reset?: boolean` — when the old effort is not in the new model's
  `effort_levels`, report that it was reset to `default_effort` instead of
  silently downgrading ([ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md)).
  UI states that the old effort was unavailable.
- `ext.switch_error?: {kind: "model" | "effort", requested: string, reason: string, rolled_back_to?: string}` — one-shot report when the post-switch turn
  fails loudly (400/404, etc.); clear it at the next turn boundary (one stamp,
  ADR-0035 F3). `rolled_back_to` is the previous pinned last-known-good value
  (normally the prior turn's effective value). UI reports failure and rollback;
  never put the failed value in effective or resume snapshots (phase-16 16-7).
  The one exception is `reason: "sdk_fallback"` (issue #363, see the model
  bullet above): there `requested` is the still-held explicit pick and
  `rolled_back_to` is the model actually running now — the reverse direction
  from every other reason.

**Operator drift filter for `resume_drift`** (phase-16 addendum, [ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md) F2): do not include
model/effort changes intentionally made by an operator mid-session (intentional
change is not drift). Consult the adapter's `modelRollbackPinned` flag and
switch history; emit drift only for an unintended substitution immediately
after resume.

### Permission changes at an execution boundary

**Contract: accepted; capability-gated rollout.** `set_permission` changes an
engine's sandbox/network/approval configuration for the next execution. Codex
implements it using fresh options for each `codex exec` while retaining its
session ID. Antigravity implements it as of ADR-0057 F4c Stage B0, mutating its
per-turn advisory gate and clamping every axis to a host-local launch ceiling
(below). The operation is not Claude's `set_permission_mode`: its six values
encode intent/classifier/approval semantics, map only approximately to sandbox,
and cannot express network access. No reverse mapping from a sandbox pair to a
Claude mode is defined.

#### Request, relay, and acknowledgement

Client to server:

```json
{"version":"0","agent_id":"host.agent","sandbox":"workspace-write","network_access":false}
```

At least one of `sandbox`, `network_access`, or `approval` is required; the rest
may be omitted. Sandbox accepts only `read-only`, `workspace-write`, or
`danger-full-access`; network access is a strict boolean, including `false`;
approval accepts `untrusted`, `on-request`, `local`, or `never` (the observed-only
`on-failure` is not a switch target). Reject `null`, empty patches, and unknown
fields (`actor`, `revision`) as `invalid_payload`. The `approval` axis is accepted
only for an engine that advertises it mutable in
`session_capabilities.permission_switch_axes` (Antigravity, ADR-0057 F4c); Codex
keeps approval launch-fixed to `never` and rejects an `approval` patch as
`unsupported_permission_switch`.

Each axis is clamped to the launch ceiling the wrapper advertises in
`session_capabilities.permission_switch_axes`
(`{sandbox?:{max}, network_access?:{max}, approval?:{max}}`) — a host-local
operator bound the server cannot widen (ADR-0057 F4c Stage B0). A patch that
would move an axis past its ceiling is rejected with `exceeds_launch_ceiling`,
and an axis whose spec is missing or malformed is launch-fixed
(`unsupported_permission_switch`). When `permission_switch_axes` is absent
entirely the legacy contract holds: sandbox and network switch freely and
`approval` is forbidden. Permissive order is `untrusted < on-request < local <
never` for approval, `read-only < workspace-write < danger-full-access` for
sandbox, and `false < true` for network access; the wrapper re-checks the same
ceiling fail-closed.

Server validation order is live operator/admin authorization, payload/size,
agent identity, reset exclusion (before the connection/capability checks that
follow — a pending reset rejects even a disconnected or capability-less agent
the same way), current connection, current metadata readiness, capability, the
launch-ceiling clamp (`exceeds_launch_ceiling`), and raw baseline
availability. Before the current connection has
reported its first capability metadata, return `permission_not_ready`. Once that
metadata is present, a missing/false supports_permission_switch means
`unsupported_permission_switch`, not a transient wait. Busy states are accepted.
No new request is accepted against an offline or unsupported wrapper. Existing accepted requests survive reconnect.
The error body is `{reason}` with `SetPermissionErrorReason`: `forbidden`,
`invalid_payload`, `unknown_agent`, `agent_unavailable`,
`unsupported_permission_switch`, `permission_not_ready`,
`session_reset_pending`, `revision_exhausted`, `persistence_failed`, or
`exceeds_launch_ceiling` (a requested axis past the advertised launch ceiling,
issue #359).

The server merges the patch into the latest next-execution **raw** configuration
in one serialized store operation, assigns a positive safe-integer revision,
and persists it before relay and acknowledgement. Revision allocation survives
restart and never reuses a number, including after deletion of one agent's
settings; exhaust the safe-integer domain by rejecting, not wrapping. A revision
binds one immutable requested pair. Send the complete pair to `wrapper:<id>`:

```json
{"version":"0","revision":17,"sandbox":"workspace-write","network_access":false}
```

`agent_id` is removed; `version` and `revision` come from the server. The wrapper
validates the complete message independently. Duplicate revisions are no-op;
older revisions cannot replace newer requests. A repeated value under a new
revision is still a distinct request. Server acceptance replies:

```json
{"revision":17,"status":"pending","requested":{"sandbox":"workspace-write","network_access":false}}
```

This acknowledges the saved request, not delivery, SDK application, or an audit
fsync. Relay is retried by authoritative synchronization after a reconnect, not
by assuming that the initial broadcast reached the wrapper. A persistence failure
must not relay or acknowledge acceptance. Permission and reset acceptance must
serialize their exclusion: neither can pass a check and commit across the other.

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
`turn.started` (which carries no turn ID or permission fields in SDK 0.153.4)
nor a prior tail record is confirmation. Handle delayed/partial writes and
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

#### Persistence, join synchronization, and resume

`PermissionSettings` is separate from `SessionPointers.snapshot`. It retains raw
next-execution selection, latest request/progress, in-flight revision bindings,
and the authenticated user ID/time for operator requests. The server owns
revision allocation and request records; wrapper reports can update observations
only for matching accepted/submitted revisions on the current connection. A
retired wrapper cannot commit a stale observation.

The wrapper requests `permission_sync:{engine}` in its channel join payload
(`PermissionSyncJoinRequest`); the server replies `permission_sync:true` when
this contract is supported (`PermissionSyncJoinReply`). The engine value uses
the existing EngineKind enum and prevents cross-engine settings replay; it does
not replace capability checks. This negotiation precedes host construction and
does not depend on a state_change capability advertisement.
After **every** negotiated wrapper join, the server sends `permission_sync`:

```ts
{version: "0", control: PermissionControlExt | null,
 next: {revision: number, requested: {sandbox, network_access}} | null}
```

`null/null` explicitly means no saved settings. Both fields are null together or
non-null together. Inside a non-null control, absent optional fields must be
**omitted**, never sent as JSON `null`. This includes `submitted`, `effective`,
`last_effective`, `reason`, and `rolled_back_to`; omission is legal only where
the `PermissionControlExt` arm permits it. A required field cannot be omitted,
and a forbidden field cannot be sent even as `null`. The explicit empty sync is
the exception for the two top-level fields, not a null convention for nested
records. Apply the same omission rule to live control publications.

Seed empty settings from the wrapper's raw launch baseline, not from normalized
`ext.effective`. Otherwise `next` is the saved next-execution selection.

**Rejection before application.** At request acceptance, the server must bind
the then-current accepted `next` selection (revision and raw pair) into that
request's ledger entry as its recovery target. On a definitive pre-application
rejection, retain failed control for the rejected request, restore `next` from
that recorded target, and derive the wire `rolled_back_to` pair from the same
server record. The wrapper's reported rollback pair is never the source of
either value. Do not search for the highest lower revision: it may itself have
been rejected. Ledger pruning must preserve recovery targets still referenced
by unresolved requests. For the first request, the target is the persisted
`{revision:0, requested:<launch baseline>}`. Do not allocate a new revision or
claim an effective observation merely to restore that selection.

For example, A (revision 1) is the accepted next selection, followed by three
requests rejected before application:

| Request | Recovery target bound when accepted | Next after rejection | Latest control |
|---|---|---|---|
| B, revision 2 | A, revision 1 | A, revision 1 | B/failed, rolled_back_to = A's pair |
| C, revision 3 | A, revision 1 | A, revision 1 | C/failed, rolled_back_to = A's pair |
| D, revision 4 | A, revision 1 | A, revision 1 | D/failed, rolled_back_to = A's pair |

Neither B nor C becomes C's or D's recovery target. A block on revision 1 is
not cleared merely because failed control advances to revision 4: clearing
requires `next.revision > blocked.revision`, reflecting a newer server-accepted
selection, whether delivered by live relay or sync.

If an existing entry has no acceptance-time recovery binding, preserve its
current `next` selection and derive any pre-application rejection's
`rolled_back_to` from that same selection; do not infer a missing predecessor
or claim a fresh effective observation.

**Join projection.** Apply these rules after every negotiated join, including
server restart, wrapper restart, and same-process rejoin:

| Stored control | Control sent in sync |
|---|---|
| `pending` | Keep `pending` and any permitted evidence. |
| `applying` | Send `pending`; omit `submitted` and `effective`, retaining any `last_effective`. |
| `applied` | Send `pending`; omit `submitted` and `effective`, retaining the confirmed observation as `last_effective`. |
| `unknown` | Keep `unknown` with its bound `submitted` and `reason`; omit `effective` and `rolled_back_to`. |
| `failed` | Keep `failed`, its reason and permitted evidence; retain a server-derived rollback pair only for a definitive pre-application rejection. |

Unknown requests remain `next` and remain blocked across restart/rejoin; do not
round them to pending or replay them without operator reconciliation. A mismatch
also keeps its authorized `next` and its failed block. A pre-application rejection
uses its ledger-derived recovery target instead. Applied selections are
reasserted on process restart, with historical evidence rather than a claim of
fresh application.
Reasserting a saved widening request is delayed execution of the authenticated
operator selection, not permission to choose a wider policy autonomously.

Synchronization is a readiness barrier, including the explicit empty response.
Buffer messages received before host construction. Process the authoritative
sync before any initial/replayed/queued input can create an exec. On rejoin,
keep an already running exec unchanged and gate its successor until sync.
A same-process rejoin must not turn a cached observation into a fresh application;
a fresh process starts with historical evidence only and must observe its exec.
An old server that does not support this handshake cannot enable the capability;
a wrapper that has already accepted permission changes must not resume dispatch
without synchronization merely because the new connection is silent. Scope sync
to the current channel join, and do not let a delayed sync overwrite a newer live
revision already accepted on that join.

Resume/restore/switch/reset initially use only last-observed effective fields in
`SessionPointers`; sync then supplies the raw requested selection before exec.
Crash restart also needs sync: it may reuse the runner's older launch config.
A legacy snapshot without raw settings cannot recover a latent network toggle.
The live wrapper's launch configuration is the explicit baseline in that case.
Delete removes per-agent PermissionSettings (not the revision allocator or audit
history); an engine change must not replay another engine's settings.

A current confirmed permission observation updates only the relevant snapshot
fields and preserves unrelated model/effort fields. It must still be recorded
when model/effort is pending or failed; the model switch's whole-snapshot skip
must not discard independently observed permissions. Conversely, generic state
snapshots must not overwrite permission fields with pending, unknown, or stale
values. Persisted snapshots remain last observed even while current permission
is unknown. Intentional sandbox/network changes are excluded from resume drift;
unintended host substitutions remain visible.

**Drift comparison while observation is pending.** When permission_control is
present but has no current effective observation, exclude only `sandbox` and
`network_access` from resume_drift comparison. This is an observation-readiness
filter, not an intentional-change filter: it also applies to a resumed agent
that has never received set_permission and remains idle before its first turn.
On a fresh current observation, compare both fields against the resume snapshot.
For each field, exclude an intentional difference only when that observation is
bound to this exec's submitted selection, the selection has a positive revision
allocated for an accepted operator request, and the observed field matches the
selection's sandbox-aware normalized value. Use the submitted selection for
this execution, not a newer pending `next` selection. Revision zero is only a
launch baseline and cannot establish operator intent. A mismatch remains
eligible for drift and must also report a policy violation even if it happens
to equal the resume snapshot.

For the selection's expected network value, use
`effectiveNetworkAccess(submitted.requested.sandbox, submitted.requested.network_access)`
from [network_access.ts](../../wrapper/codex/src/network_access.ts), the
normalization source of truth in
[ADR-0033](../adr/0033-permission-model-dual-axis.md#network-configuration-and-effective-access).
Compare this expectation with the observed effective value. Do not renormalize
stored snapshot values or contradictory observations during comparison: doing
so would hide legacy snapshot drift or an observation mismatch.

Recover this attribution from the authoritative selection delivered by
permission_sync after relaunch; it must not depend on a process-local
operator-switched set. Do not permanently exempt either permission field after
a request: validate the execution binding and value match for each observation.
All other fields and engines without this
control keep the existing rule that undefined versus a known value is drift.
The same field-specific pause applies during each later unobserved exec; it must
not suppress model/effort drift while waiting for permission observation.

Implementation checks must cover resume without any operator request before
its first exec (no permission drift), a first observation with an unexpected
sandbox/network value (drift), and an unrelated model/effort difference during
that wait (still drift). Also cover an accepted pending selection followed by
snapshot-applying relaunch and sync: its matching first observation produces no
intentional permission drift, while an unexpected value still does. Include
revision-zero observations and overlapping submitted A / pending B to ensure
neither the launch baseline nor another execution's request masks drift.
Dashboard checks must cover the initial unobserved
Codex state: fixed approval/enforcement present, no Claude picker, and visible
unknown sandbox/network values.
Also cover Claude spawn and restore without an explicit/stored mode and without
running a turn: the first status advertises mode switching, the picker is usable,
and the current mode remains unknown. Verify the capability survives SDK metadata
arrival, explicit false overrides legacy mode metadata, and capability absence
alone exposes neither picker.

#### Permission lifecycle audit

Extend ADR-0055's `SessionLifecycleEvents` timeline, not a separate stderr-only
log. `session_lifecycle` remains a versioned control event; it is not an envelope
`type`. The permission events carry closed, typed `details`:

| Kind | Producer | Details |
|---|---|---|
| `permission_requested` | Server after accepting an operator request | `{revision, requested, actor:{kind:"user",id}, previous?}` |
| `permission_applied` | Wrapper after a new selection's policy is observed | The `PermissionObservation` fields, plus optional `previous` observation. |
| `permission_failed` | Wrapper for a definitive rejection or an unconfirmed/mismatched application | `{revision, requested, reason, execution_id?, rolled_back_to?}` |

`previous` is a historical `PermissionObservation`, absent when unknown. Do not
emit applied solely for replaying an already applied revision; fresh observation
still updates current state. Deduplicate matching revision/kind outcomes across
reconnect; a transition from unknown to subsequently observed may add applied.
The server joins observations to its stored request, resolves previous from
its own accepted observations, and authenticates their agent/current connection.
It never trusts a wrapper-supplied audit actor or a wrapper-produced
permission_requested. Keep in-flight request bindings long
enough for A's result when B is already pending. Rejected client payloads do not
create a permission_requested record.

Validate kind-specific details at ingress, store append, and boot load, and
preserve them in `list_session_events`. `trigger` remains exclusive to
`compact_boundary` (absent/null for permission events). Require finite safe
revisions and bounded identifiers/reasons: IDs at most 256 UTF-8 bytes, reason
at most 256 UTF-8 bytes, with no prompt, tool input, credentials, or raw SDK error.
The existing ISO timestamp and transport frame limits still apply. Unknown
execution outcomes use a reason such as `observation_unavailable` without
`rolled_back_to`; the event name alone does not establish rejection/rollback.

Record narrowing and widening without confirmation UI or peer notification.
The existing retention, operator-only pull access, and best-effort asynchronous
write policy remain. An audit write failure does not reverse or block an
accepted command, and its ack is not an audit-fsync receipt. This timeline is
not a guaranteed durable security journal.

### Types and payload (v0 settled)

Moved to [Event types and payloads](../reference/protocol/events.md#types-and-payload-v0-settled).

#### Wrapper-owned stderr error diagnostics

Moved to [Event types and payloads](../reference/protocol/events.md#wrapper-owned-stderr-error-diagnostics).

### `task_type: "tasklist"` addendum (issue #178, ADR-0049 F4)

In addition to the general `task` rules, an agent's own todo is always the single entity
`{ agent_id, task_id: "tasklist", task_type: "tasklist" }`. The reserved word is bidirectional:
when `task_type` is `tasklist`, `task_id` must be `tasklist`, and vice versa.
The server rejects either mismatch. This prevents child task IDs from being used for this
entity and prevents child tasks from using the reserved ID.

The payload is `{ kind: "updated", status: "running", items, omitted? }`.
`items` is a whole-list snapshot of `{ text: string, status: "pending" | "in_progress" | "completed" }`,
with the latest snapshot replacing the whole list (LWW). Do not send `kind: "completed"`
when all items are complete. `items: []` is a valid replacement meaning that the current
todo is empty; retain the entity until its parent wrapper leaves. The dashboard must not
show a float for an empty list (avoiding a meaningless `0/0`), but must not delete the
entity from state.

The wrapper sends at most 50 items in source order, normalizing each `text` to at most
256 UTF-8 bytes and the `items` JSON to at most 16,384 bytes. If later source items exist,
it must include `omitted: { count, completed }`, so the operator can see that the detail is
partial and how many items are complete overall. The server defensively validates the same
limits and rejects violations; normal over-limit input is made displayable by wrapper normalization.

`tasklist` is outside the three-second/token/tool-name throttle used for child-task
`kind=updated`. Todo changes have no later token/tool signal to flush, so that throttle
could permanently lose updates. The wrapper de-duplicates only consecutive snapshots with
identical content and sends changed snapshots immediately. Claude Code's default source
since SDK 0.3.228 is the `TaskCreate`/`TaskUpdate`/`TaskList` tool triggers ([ADR-0049](../adr/0049-tasklist-on-task-envelope.md)
addendum); `TodoWrite`, which maps `content` and the three-valued status directly, remains
only the `CLAUDE_CODE_ENABLE_TASKS=0` compatibility fallback. `activeForm` is Claude-local UI text; the wire item
settled by ADR-0049 contains only text and status, so it is not sent. Showing it later
requires a protocol extension rather than an implicit field addition. Codex
`todo_list.completed: boolean` maps `false -> pending` and `true -> completed`.
Both cover only the parent thread's list. On socket reconnect, wrapper transport resends
active `task` entities with a fresh seq, so they can be restored even after the old channel
terminates and purges the server task table, without tasklist content de-duplication blocking it.
The resend cache is capped at `5,000` entities / JSON `6,000,000` bytes. This prevents
crashed/killed child tasks that never send `completed` from remaining forever; on overflow,
the least recently updated child entities leave the cache and the wrapper warns on stderr.
The parent `tasklist` snapshot is retained while any other eviction target exists. This is
a local-memory bound for reconnects, not a substitute for server-side TaskStates ingress/byte
bounds across multiple wrappers.

### Directional message types (v0 settled)

Moved to [Channels and directional messages](../reference/protocol/channels.md#directional-message-types-v0-settled).

### Planned wrapper cycle (issue #256)

The server reserves an in-memory `PlannedDisconnects` intent immediately before sending the
runner command on only three paths: operator or agent-self `session_reset`, live
`resume_session` (`switch_session`), and operator `restart` for a live agent. Each agent has
one `{transition_id, kind, phase, timer, targets}` entry. `targets` is the union of the
disconnect-time snapshot and senders bounced with `peer_reconnecting` during the planned
window. One target is a `{conversation_id, peer_id}` pair for one synthetic envelope; the
union is capped at 50. Conflicting lifecycle operations are rejected as `agent_busy`. A
reset that fails between intent allocation and runner send silently cancels the matching
`SessionResets` lock.

An owner-checked wrapper terminate advances the phase `announced → disconnected`, takes a
read-only snapshot of open-conversation peers, and sends IA `error.code=reconnecting`.
Tracked bounces take priority and only remaining slots are filled from the snapshot; skipped
pairs are recorded with their count and targets in a warning. In either phase, only a later
join whose non-empty `transition_id` exactly matches closes the intent and sends an error-free
`reconnected` inform to the same target union. The text says only that the peer is reachable,
not that a physical reconnection occurred; a mismatched token is never a return.
On intent timeout or terminal failure, if `AgentStates` is still `disconnected`, send
`error.code=disconnected` to the entire target union regardless of prior ordinary marks.
If an old or rollback wrapper is live, close the planned window with `reconnected` to the
same union instead of silently leaving bounced senders. `spawn_failed` means the rollback
wrapper started successfully, so keep the intent until a matching rollback join or timeout,
separate from issue #248 failure notification and connectivity; `rollback_failed` closes it
terminally.

IA to an active planned target is bounced as `peer_reconnecting` in preflight, before
ConversationStates, panes, or the delivery ledger. Active detection and adding
`{conversation_id, sender}` to the target union are atomic in one GenServer call; no bounce
is returned before recording the target. A registered pair consumes no new slot. After 50
slots, a new pair is rejected as `peer_reconnecting_capacity` without changing state and
does not promise a close notice. The wrapper reports a terminal `isError=true` tool failure:
the message was not accepted, no close notice will arrive for this attempt, and it may be
resent later with the same `conversation_id`. The common wrapper layer maps only admitted
`peer_reconnecting` to structured `peer_error.code=reconnecting` and waits for `reconnected`
without escalating; delivery gaps outside the planned window are issue #257.

Planned terminals mark and deliver only the bounded target union and never claim ordinary
targets later. Ordinary claims for unexpected disconnect retain the 50-conversation cap;
conflicts outside the planned window are issue #257.

Operator `stop` does not start a planned cycle and is not blocked by an active intent as
`agent_busy`. After role, size, and host-ownership guards it cancels the active intent,
sends terminal `disconnected` to its target union, then relays stop. Stop/restart first
validate `AgentId.host_id_from(agent_id) == host_id` before any intent mutation and reject a
mismatch as `agent_not_owned`; ordinary unexpected-disconnect claim rules are unchanged.

Rolling deploy proceeds **runner/wrapper first, server second**. Before the new server emits
restart `request_id` and `peer_reconnecting`, the runner must replace the wrapper config's
restart token and the wrapper must understand structured peer-error guidance. Reversing the
order leaves IA to that agent bounced as `peer_reconnecting` for up to 60 seconds while the
old runner cannot carry the transition token into relaunch and the old wrapper cannot clear
the receiver's reconnecting state.

**Permission flow**: On `canUseTool`, the wrapper sets `state_change.ext.pending_permission`
and sends a compatibility `permission_request` envelope (the type table above), keeping the
Promise pending until `permission_decision`. The ext field remains authoritative, so it
survives intervening `state_change` events (thinking, tool_running, or session-init idle)
([ADR-0022](../adr/0022-pending-permission-authoritative-source.md)).
No response means **wait indefinitely** by default, matching the SDK (no timeout; finite
timeouts are wrapper opt-in, with configuration in issue #60). A deny still keeps the
session alive. The server only relays instruction and approval **without interpreting their
contents**, remaining agent-independent. Delivery is not guaranteed: relay to a disconnected
wrapper is lost and the requester restores `ext.pending_permission` from the next join snapshot.

**Reconnect resynchronization**: After disconnect, the client simply rejoins the channel;
`snapshot` / `task_snapshot` / `delivery_snapshot` resynchronize all projections. The three
frames replace independently, and join start clears all three previous projections. If the
connection breaks midway, old and new generations are not mixed; only the received prefix is
shown. No diff tracking or resend request is needed (last-write-wins per agent_id). Ordering
and de-duplication use `seq` ([ADR-0011](../adr/0011-phase3-reliability-and-auth.md)).
At join, the latest state and recent reply-log history (the server's **in-memory ring buffer**,
[ADR-0012](../adr/0012-response-display-and-dashboard-scope.md)) are sent, restoring logs on
reload/reconnect. History is memory-only, but after a server restart the wrapper hydration
handshake rebuilds it automatically (see "Projection hydration and restart resilience",
[ADR-0051](../adr/0051-history-restart-resilience.md); server-side disk persistence issue #24
remains rejected). The **source of truth for reply history is the wrapper host's composite
SSOT** (engine transcript + IA sidecar); the ring buffer is a rebuildable projection. During
replay, the wrapper reads the session transcript directly, maps `user`/`assistant` rows to
`log` envelopes and the IA sidecar to `replay_ia`, then overwrites server display history via
`history_reset` → replay ([ADR-0014](../adr/0014-session-resume-and-restore.md) phase-2, #50).
The direct read is required because the SDK does not re-yield prior history into the
`query()` stream on resume.

#### Projection hydration and restart resilience ([ADR-0051](../adr/0051-history-restart-resilience.md))

- **Hydration verdict**: The wrapper channel **join response** contains
  `hydration: { replay_required: boolean, replay_id? }`. The server decides from the
  per-boot volatile AgentStates status (`unhydrated` / `in_flight(replay_id, channel_owner)` /
  `hydrated`) and returns a server-generated `replay_id` when required. The wrapper starts
  replay only after the verdict and uses that ID consistently for `history_reset`, `replay_ia`,
  and `history_replay_complete`. Only an absent verdict (old server) falls back to legacy
  startup replay with a wrapper-generated ID. There is no dedicated S→W event: reconnect is
  a new join and the verdict always arrives in the join response.
- **Completion and retry**: `history_replay_complete` performs the CAS transition (see the
  event table). If the channel disconnects while `in_flight`, return to `unhydrated` and ask
  again on the next join. A fresh session (no session ID or transcript) uses an empty replay
  (`history_reset` followed immediately by complete).
- **Invalidating hydrated state**: The server discards hydration only for operator-initiated
  transitions carrying `resume_session_id` (`restore` resume branch or `resume_session`) and
  sets the next verdict to `replay_required: true`. `/new`, `/clear`, fresh restore, and a
  runner-autonomous crash restart do not invalidate it. See [ADR-0051](../adr/0051-history-restart-resilience.md) D2.
- **Ingress-stamp wire shape**: The server ingress-order tuple is encoded in JSON as the
  **two-integer array `[us, seq]`**. The same shape is used by top-level envelope
  `ingress_stamp`, acceptance-ack replies, wrapper sidecar rows, and `replay_ia` items.
  Receivers strictly validate two integers and discard out-of-shape values fail-closed.
- **Projection epoch**: Join `history` push payloads carry `projection_epoch`, an opaque UUID
  assigned at AgentStates initialization. On mismatch, the client discards its old baseline
  (display logs, clearWatermarks, replay markers, unread state) and merges only authoritative
  history with live envelopes received on this connection. Matching epochs retain the old
  merge; absent (old server) falls back to legacy behavior ([ADR-0051](../adr/0051-history-restart-resilience.md) D4).
  The live-buffer window runs only from each connection-generation join until that connection's
  first `history` push. Each new join drops the prior buffer and replay marker; live envelopes
  after the window closes are not buffered, preventing disconnected rows from reappearing on
  the next epoch mismatch (Fujino 30-10 must-fix M1).
- **`replay_ia` batch boundary**: The wrapper splits each push to **1,000,000 JSON bytes** or
  less and sends all chunks for one `replay_id` before `history_replay_complete`. A sidecar row
  that cannot fit alone is dropped fail-closed; otherwise Phoenix rejects the frame, complete
  never arrives, and every join resends the same row (Fujino 30-10 must-fix M4 / round-two should).
- **Per-pane projection contract**: Live IA display and replay restoration use the same per-pane
  upsert API. Live acceptance is ordered as validate (including every check that can reject,
  such as participant/quota) → assign ingress stamp → upsert both sender and receiver panes →
  push to the peer. See [directory event contracts](../reference/inter-agent/directory.md#event-contracts).

### Session visibility semantics (#106 / ADR-0036 F3 restoration, 2026-07-24)

`/new` and an external session switch only fsync their start point in `SessionStarts`; they
do not change log/IA display or `ClearWatermarks`. In addition to its SessionStarts record,
`/clear` makes `SessionResets.confirm_connection/2` adopt `{order, display}` via
`ClearWatermarks.record/3` and reduces that agent's `AgentStates` history to one marker row.
The peer pane hides IA through a per-pane `ClearWatermarks` filter, comparing the cutoff
with the ingress stamp persisted on IA ([ADR-0051](../adr/0051-history-restart-resilience.md)
D3-4). The durable `InterAgentHistory` DETS ledger was removed by that ADR; the wrapper
host's IA sidecar is authoritative. Operator `clear_history` (#48) remains a separate API
that broadcasts `history_cleared` to purge logs from other sessions of the current session.

Live clients update `/clear` from `session_reset_completed.clear_watermark`; the reload
path uses server-side `merged_histories` as SSOT. Neither `/new` nor `/clear` broadcasts
`history_reset` (resume replay only). Without a start point, operator `clear_history` warns,
leaves the watermark unchanged, and retains IA (never fall back to deleting current-session
IA). Existing `ClearWatermarks` DETS rows survive migration so hidden IA is not exposed
again; pre-M6 ISO-only rows remain until the next real clear.

### File-upload wire

These incremental operations let an operator pass dashboard attachments (image, text, PDF,
or Office) to an agent. The protocol surface of record is the directional message table
above, the `attach_rejected` / `instruction_rejected` envelope types, and the binary frame
layout below. Feature details are collected in [file-upload](file-upload.md), with rationale
in [ADR-0025](../adr/0025-file-upload-wire-and-wrapper-rendering.md).

**Transport**: Keep the existing single Channels transport
([ADR-0009](../adr/0009-client-transport.md)); do not add another socket or HTTP POST upload.
The server neither interprets nor persists upload bytes and transparently relays them to the
`wrapper:<agent_id>` channel (no disk access, [ADR-0020](../adr/0020-dashboard-battery-included-client.md) F3).

**Order**: `attach_open` × N → `attach_chunk*` (parallel allowed) → `attach_close` × N
→ `instruction(attachment_ids=[...])`. On instruction receipt the wrapper verifies every
`attachment_id` completed `attach_close`; incomplete uploads are rejected with
`instruction_rejected{reason="timeout"}` or a corresponding reason.

**`attach_chunk` payload format** (MVP layout inside a V2 binary-frame payload):

The Phoenix V2 binary serializer receives a WebSocket binary-opcode frame and passes the
bytes below to server `handle_in("attach_chunk", {:binary, payload}, socket)` as a
`{:binary, binary()}` tuple (V2 tuple form; do not confuse with V1). phoenix.js automatically
creates the binary frame when an `ArrayBuffer` is passed directly to
`channel.push("attach_chunk", arrayBuffer)`; a Blob must first be converted with
`arrayBuffer()`.

```text
<u32 upload_id_len><upload_id utf8><u32 chunk_index><chunk_bytes>
```

- `upload_id_len`: big-endian unsigned 32-bit UTF-8 byte length of `upload_id`.
- `upload_id`: UTF-8 string, a client-assigned ID unique within the session.
- `chunk_index`: big-endian unsigned 32-bit, zero-based.
- `chunk_bytes`: remaining bytes of the chunk.

Concurrency and chunk size are client-defined (MVP recommendation: 64 KB per chunk,
[ADR-0025](../adr/0025-file-upload-wire-and-wrapper-rendering.md) F14).

The V2 frame header (`<<kind::8, join_ref_size::8, ref_size::8, topic_size::8,
event_size::8, ...>>`) is handled by Phoenix. Each size field is 8-bit, so join_ref, ref,
topic, and event are each at most 255 bytes (well above kaoiro's
`wrapper:<agent_id>` / `attach_chunk`).

**Transport safety**: The server enforces an 8 MB frame limit for DoS protection; the
20-in-flight-uploads cap (`MAX_INFLIGHT_UPLOADS`) is wrapper-side, not server-enforced.
Phoenix defaults `max_frame_size` to `:infinity`, so endpoint configuration sets it
explicitly:

```elixir
# server/lib/kaoiro_server_web/endpoint.ex
socket "/wrapper", KaoiroServerWeb.WrapperSocket,
  websocket: [max_frame_size: TransportLimits.max_frame_bytes()],  # 8 MB
  longpoll: false
```

Leaving `:infinity` would let one 128 MB frame allocate 128 MB in a receiving process and
risk OOM. The wrapper makes the final decision on per-file size (128 MB), allowed MIME,
count (10 per instruction), and TTL (unreferenced or incomplete chunks are GC'd after five
minutes) ([file-upload](file-upload.md), ADR-0025 F4/F6/F7/F13).

**Delivery gate**: `attach_open` / `attach_chunk` / `attach_close` /
`attach_rejected` / `instruction_rejected` are all **operator-only** (allow-list,
[ADR-0021](../adr/0021-role-information-disclosure-policy.md)); remove them entirely for viewers.

**Fit-to-SDK responsibility**: The wrapper absorbs the gap between the 128 MB protocol
limit and hard SDK limits (exact image/document block values are confirmed by a pre-
implementation spike) using image downsize, PDF page extraction, text truncation, and
Office → markitdown → text. Image and PDF fitting can fail and reject with a dedicated
reason (`unfittable_image` / `unfittable_pdf`); oversized text is always fit by
tail-truncation instead (`TEXT_SDK_BYTE_LIMIT`, 1 MB) and never rejects, so
`text_too_large` — declared in the wire enum for other producers — does not currently
fire from this wrapper.

### Session resume and restoration

Wrapper restoration (continuing context after process loss) and recalling an existing session
use one mechanism: **resume** with an existing `session_id` ([ADR-0014](../adr/0014-session-resume-and-restore.md)).
This adds resume mode to issue #22's `client -> server -> runner (boot service) -> wrapper`
path. Restore commands (spawn-with-resume) and session enumeration are defined with the
issue #22 runner specification ([ADR-0023](../adr/0023-host-runner-architecture.md)) and
settled in the runner table below ([#66](https://github.com/sakuraiyuta/kaoiro/issues/66)).
The earlier phase-0 protocol change only added top-level `session_id` to the envelope; the
wrapper reports it and the server stores the `(agent_id, host, cwd, session_id)` pointer.

### Runner control messages (v0 settled, [#66](https://github.com/sakuraiyuta/kaoiro/issues/66))

The runner resident on each host ([ADR-0023](../adr/0023-host-runner-architecture.md))
connects to the server on the dedicated `runner:<host_id>` topic, separate from the direct
`wrapper:<agent_id>` data path. It registers the host, reports liveness, and controls the
wrapper lifecycle (spawn / stop / restart / session enumeration), including resume. Messages
use the existing **Channels event** mechanism; no envelope `type` is added.

| Direction | Event | Payload |
|---|---|---|
| runner → server | `register` | `{ host_id, cwd_allowlist, allowed_personas? \| blocked_personas? \| personas?, capabilities?, engines?, build_revision?, build_dirty?, build_version?, build_channel? }`. Sent once at connection to declare the cwd allowlist and persona trust mode. Exactly one of `allowed_personas`, `blocked_personas`, or none (accept-all) may be set; multiple values are invalid ([ADR-0031](../adr/0031-runner-persona-trust-mode.md)). Legacy `personas` is deprecated and interpreted as an ID allowlist; `name`/`sprite_set` are ignored because server SoT owns them ([ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md)). `engines` carries per-engine launch catalogs for the LaunchDialog cascade ([ADR-0032](../adr/0032-codex-adapter.md) F4bc). Capabilities are `"claude-code" \| "codex" \| "antigravity"`; old `"claude"` is normalized for one release then rejected ([ADR-0032](../adr/0032-codex-adapter.md) F4a, [ADR-0057](../adr/0057-antigravity-adapter.md) F1). Each `capabilities` item and `engines[].id` is at most 64 UTF-8 bytes; each `engines[].models[].value` and `engines[].models[].display_name` is at most 256 UTF-8 bytes. `build_revision`/`build_dirty` identify the git artifact and `build_version`/`build_channel` identify its CalVer project version and channel (issue #288, [ADR-0056](../adr/0056-project-calver-build-version.md)); each pair may be omitted for pre-feature compatibility, but a pair must be complete and values must be in-domain. `build_version` is `"unknown"` or `YYYY.M.PATCH`: a four-digit year, month `1` through `12`, and one to six decimal patch digits. When the version/channel pair is present with `channel: "release"`, the revision/dirty pair is also required, and it must be a known 40-hex revision with `dirty: false`; the version must be a known CalVer value. Any incomplete, out-of-domain, or contradictory release identity is rejected as `invalid_build_info`. |
| runner → server | `heartbeat` | `{ host_id }`. Liveness notification. |
| runner → server | `sessions` | `{ host_id, cwd, sessions: [{ session_id, summary?, mtime? }], engine? }`. Response to `enumerate_sessions`; minimal JSONL metadata, **operator-only** (T2, [ADR-0014](../adr/0014-session-resume-and-restore.md)). Echoes the requested engine so dashboards discard stale results ([ADR-0032](../adr/0032-codex-adapter.md) F8). |
| runner → server | `spawn_result` | `{ host_id, agent_id, ok, reason?, request_id? }`. Failure reasons are `already_running` / `cwd_not_found` / `session_not_found` (T3 validation under cwd failed, [#101](https://github.com/sakuraiyuta/kaoiro/issues/101)) / `error`. Echo `request_id` from `spawn`/`switch_session`; the server applies it only when matching the stored transition (phase-27 / [#150](https://github.com/sakuraiyuta/kaoiro/issues/150)). Old runners omit it and the server silently drops correlation. |
| server → runner | `spawn` | `{ agent_id, persona, cwd, server_url?, token?, initial_prompt?, resume_session_id?, resume_snapshot?, apply_resume_snapshot?, engine?, model?, effort?, permission_mode?, sandbox?, network_access?, approval?, request_id? }`. **Operator-only**. The runner supplies `server_url` from its config when omitted; `initial_prompt` is the wrapper's first turn. `model`/`effort` are LaunchDialog values ([ADR-0032](../adr/0032-codex-adapter.md) F4bc). Claude `permission_mode` is persisted at spawn so explicit spawn wins; Codex/Antigravity `sandbox`/`network_access` are fixed launch permissions, and Antigravity's `approval` is likewise launch-fixed ([ADR-0033](../adr/0033-permission-model-dual-axis.md), [ADR-0033](../adr/0033-permission-model-dual-axis.md) F3, [ADR-0057](../adr/0057-antigravity-adapter.md) F4c). `request_id` is the server session-transition correlation echoed as wrapper `transition_id`; `resume_session_id` selects resume. `agent_id` and `token` are server-issued, not client input ([ADR-0024](../adr/0024-agent-instance-identity-and-spawn-auth.md) D3/D4). `engine?: "claude-code" \| "codex" \| "antigravity"` selects the wrapper package and is checked against registered capabilities ([ADR-0032](../adr/0032-codex-adapter.md) F1, [ADR-0057](../adr/0057-antigravity-adapter.md) F1). `apply_resume_snapshot?: true` requests fresh-restore without a resume ID (phase-25, [ADR-0030](../adr/0030-agent-directory-and-explicit-restore.md) D8 / [ADR-0014](../adr/0014-session-resume-and-restore.md) F1). |
| server → runner | `stop` | `{ agent_id }`. **Operator-only**. Validate the client host binding before intent mutation; cancel any planned intent and deliver terminal `disconnected` to tracked peers before relay (issue #256). |
| server → runner | `restart` | `{ agent_id, request_id? }`. **Operator-only**. Validate host binding first. New servers assign a non-empty request ID for planned live-agent restarts; new runners map it to wrapper `transition_id` after relaunch, while omission preserves old behavior (issue #256). |
| server → runner | `enumerate_sessions` | `{ agent_id?, cwd, engine? }`. **Operator-only**. Requests resume candidates under `cwd`, scoped to one engine (default `claude-code`, [ADR-0032](../adr/0032-codex-adapter.md) F8). The server strips `host_id`, fills `cwd` from SessionPointers when omitted, and forwards a runner shape where `cwd` always exists; `agent_id` remains only for detail-view requests. Client must provide at least `cwd` or `agent_id`; both are accepted, with explicit `cwd` taking precedence. |
| server → runner | `switch_session` | `{ agent_id, resume_session_id, request_id?, resume_snapshot? }`. **Operator-only**. Replaces the resume target of a live agent without changing agent_id/cwd. Runner transfers the F4 lock and restarts the wrapper, rechecking T3 and F4; failures use `spawn_result` ([ADR-0014](../adr/0014-session-resume-and-restore.md)). `request_id` distinguishes the new connection; `resume_snapshot` carries the server's current SessionPointers snapshot (phase-15 D8). |
| server → runner | `refresh_engine_catalog` | `{ engine, request_id, force? }`. **Operator-only** request to re-probe the LaunchDialog engine catalog ([ADR-0039](../adr/0039-engine-catalog-live-probe.md) Option E). It is keyed by `(host, engine)`, not agent; `force` bypasses TTL. Only Claude currently probes live; Codex advertises statically ([ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md) F1). |
| runner → server | `catalog_result` | `{ host_id, engine, request_id, ok, reason?, models_count? }`. Completion report for `refresh_engine_catalog`, forwarded to operators. Failure reasons are `auth_failed` / `spawn_failed` / `cli_error` / `invalid_output` / `timeout` / `unsupported_engine`; `models_count` is only a toast signal and the catalog arrives in the runner's normal `hosts` broadcast ([ADR-0039](../adr/0039-engine-catalog-live-probe.md)). |

**Authentication**: The runner connects with per-host tokens (a server-configured
`host_id:token` list, extending ADR-0011's per-entity token principle). host_id is fixed in
configuration and is not server-assigned; this is separate from per-agent wrapper tokens
([ADR-0011](../adr/0011-phase3-reliability-and-auth.md)).

**Version**: Runner messages also carry flat outer `version` (currently `"0"`)
([ADR-0015](../adr/0015-protocol-version-stamping.md)); adding message types keeps the same
version for forward compatibility.

There are two `version` stamping authorities. Messages whose payload is **assembled** by
server or runner (`register` / `heartbeat` / `sessions` / `spawn` / `spawn_result` /
`switch_session` / `reset_session` / `session_reset_result` / `catalog_result`) are stamped
at assembly. In pass-through routes where the server strips only `host_id` from client
payload (`enumerate_sessions` / `refresh_engine_catalog` / `stop` / `restart`),
`relay_to_runner/4` warns about the client value and normalizes `version` to `"0"`.
Dashboard pushes also all carry `version` through the single `pushVersioned` funnel (issue
#208 onward). Runners warn on mismatch, including omission, and accept best-effort (ADR-0015).

`restart` still lacks a dashboard push producer, but implementation will use the funnel above
and therefore stamp `version` automatically. See "version inventory" below for coverage.

**Safety** (spawn is effectively remote code execution): accepting spawn / resume /
resume_session / stop / restart is **operator-only**. Runner T3 verifies that the resume
session exists under the agent-bound cwd; `switch_session` rechecks the target in the same
immutable cwd. The cwd is restricted to the runner `cwd_allowlist` (#22, T1).

**Duplicate-start prevention** uses two layers: existing server-owner fencing plus a
runner-local lock ([ADR-0014](../adr/0014-session-resume-and-restore.md) F4). The runner
rejects a spawn race with `spawn_result.reason = already_running`. A wrapper join for an
`agent_id` that already has a live owner is also explicitly rejected, making accidental
double starts visible instead of silently applying last-write-wins ([ADR-0024](../adr/0024-agent-instance-identity-and-spawn-auth.md) D5).

### WrapperConfig fields relayed by the runner (issues #181 and #292)

`WrapperConfig` (protocol/src/index.ts) is the runner's per-spawn config
handoff to the wrapper process it launches — a process-boundary data
structure, not a `runner:<host_id>` channel message like the table above.
Most of its 30 fields mirror the `spawn` payload verbatim
(`resolveWrapperConfig`, runner/src/supervisor.ts); this section documents
only the fields that instead come from `runner.config.json`'s per-engine
blocks, since nothing else in this spec names `WrapperConfig`.

- `codex_backend?: "exec" | "app-server"` — runner-local `codex.backend`,
  resolved to `"exec"` when omitted and relayed only for Codex launches. The
  wrapper validates the closed enum. It is not accepted from `spawn` or a
  resume snapshot and is not a wire capability. Reload affects subsequent
  wrapper lifetimes, including resumes; existing wrappers retain their backend.

- `codex_extra_models` / `antigravity_extra_models` (`EngineModelInfo[]`)
  — the operator's `codex.extra_models` / `antigravity.extra_models`
  declaration (runner.config.json), already merged by the runner's
  `buildRegister` into the launch catalog it advertises. Relayed so the
  wrapper applies the SAME merge to its own catalog resolution — `ext.models`,
  effort-switch availability (Codex only), and `setModel` validation must
  all recognise a declared model too, not only the register's launch-time
  list. Absent / empty on either field means no declarations for that
  engine. See [Codex model settings](../operations/codex-model-settings.md#d-kaoiros-own-extra_models-declaration-issue-292) (D) and
  runner/README.md's "Codex 設定" / "Antigravity configuration" sections
  for the declaration syntax and merge semantics.

- `antigravity_cli_path` / `antigravity_probe_timeout_ms` — runner-local
  values derived from `antigravity.cli_path` / `antigravity.probe_timeout_ms`.
  They are not accepted from a server `spawn` payload and introduce no
  server/dashboard error vocabulary. The wrapper snapshots them at launch;
  path resolution or probe failure is reported only by an existing bounded,
  redacted local diagnostic.

### Client → server launch control (#22, [ADR-0024](../adr/0024-agent-instance-identity-and-spawn-auth.md))

Launch-UI requests from the dashboard operator are relayed by the server to
`runner:<host_id>` (see the runner control table). **Persona is a type; agent_id is an
instance**. Multiple spawns with the same character are represented by one persona and
different agent IDs (D1).

`version` follows the directional-message rules above: in stage-1 client → server rows it is
a common outer key, and appears in a payload column only for producer-specific notes. The
version inventory below is normative for all routes.

| Direction | Event | Payload |
|---|---|---|
| client → server | `spawn` | `{ host_id, persona, cwd, name?, initial_prompt?, resume_session_id?, engine?, model?, effort?, permission_mode?, sandbox?, network_access?, approval? }`. **Operator-only**. LaunchDialog values are passed through to runner; `persona` is an ID resolved against the host declaration. The server allocates `agent_id` and issues the per-agent token (plan A, D3/D4; [ADR-0024](../adr/0024-agent-instance-identity-and-spawn-auth.md)); runner supplies `server_url` from config. Optional `name` overrides the per-instance display name (agent_id/persona.id unchanged, at most 64 grapheme clusters and 256 UTF-8 bytes, with no control characters). `resume_session_id` selects resume and seeds cwd in SessionPointers. `engine` must be advertised by the host ([ADR-0032](../adr/0032-codex-adapter.md) F1, [ADR-0032](../adr/0032-codex-adapter.md) F1, [phase-14-codex-adapter](../plans/phase-14-codex-adapter.md)). |
| client → server | `launch_defaults` | `{ version }`. **Operator-only** request for LaunchDialog's per-persona previous effort ([issue #88](https://github.com/sakuraiyuta/kaoiro/issues/88)); it is computed synchronously by the server and never relayed to runner. ADR-0015 still requires the version stamp, with mismatch/absence warned and accepted best-effort. Reply status is Phoenix `ok`, body `{ defaults: { "<persona_id>": "<effort>" } }`. The server joins AgentDirectory and SessionPointers at read time; for each persona choose the highest `effort_revision`, the sole candidate, or one common value, and omit conflicting preferences. Invalid entries are dropped fail-closed; LaunchDialog falls back silently to `default_effort`. |
| client → server | `stop` / `restart` | `{ version, host_id, agent_id }`. **Operator-only**. Verify exact host binding and reject mismatches as `agent_not_owned`; stop comes from the dashboard end button and derives host_id from agent_id. A future restart producer will use `pushVersioned` and receive the stamp automatically (issue #208). |
| client → server | `restore` | `{ agent_id }`. **Operator-only**. Re-spawn a disconnected agent with the same ID and resume pointer (ADR-0014). Missing pointer/cwd returns `no_session`; a live agent returns `not_disconnected`. |
| client → server | `resume_session` | `{ agent_id, session_id }`. **Operator-only**. Select a resume target while retaining agent_id/cwd (ADR-0014 resume-swap). Live agents use runner `switch_session` (kill → relaunch); disconnected agents use `spawn`. Session IDs match `[A-Za-z0-9-]{1,128}`; missing/invalid values return `missing_session_id` / `invalid_session_id`, and missing cwd returns `no_session`. |
| client → server | `enumerate_sessions` | `{ version, host_id, cwd }` or `{ version, host_id, agent_id }`. **Operator-only** request for resume candidates. The server fills cwd from SessionPointers when omitted; neither field returns `invalid_cwd`, and a pointer without cwd returns `no_session`. |
| client → server | `refresh_engine_catalog` | `{ version, host_id, engine, request_id, force? }`. **Operator-only** LaunchDialog refresh. The server checks role, host_id, and payload size, then relays the remaining fields opaquely to `runner:<host_id>`; runner validates engine/request_id/force ([ADR-0039](../adr/0039-engine-catalog-live-probe.md)). |
| server → client | `hosts` | `{ hosts: { "<host_id>": { personas, cwd_allowlist, capabilities?, engines?, build_revision?, build_dirty?, build_version?, build_channel?, registered_at } }, hosts_incomplete?: true }`. A **map keyed by host_id**, pushed on host changes and immediately after join. `personas` is the host trust policy applied to the server persona pool, not raw runner IDs ([ADR-0031](../adr/0031-runner-persona-trust-mode.md)). `hosts_incomplete: true` means complete host entries were omitted to fit the transport frame budget. Build identity fields pass through runner `register` (issues #218/#288, [ADR-0053](../adr/0053-build-identity.md), [ADR-0056](../adr/0056-project-calver-build-version.md)); `build_version` uses the same `"unknown"` or `YYYY.M.PATCH` grammar (four-digit year, month `1` through `12`, one to six decimal patch digits). The dashboard shows the runner's CalVer/channel in the host selector and retains mismatch warnings without blocking. **Operator-only** ([ADR-0021](../adr/0021-role-information-disclosure-policy.md)). |
| server → client | `runner_sessions` | Forwarded runner `sessions` response to `enumerate_sessions`. **Operator-only**. |
| server → client | `spawn_result` | Forwarded `{ host_id, agent_id, ok, reason?, request_id? }`. **Operator-only**. |
| server → client | `catalog_result` | Forwarded runner result. **Operator-only**; the successful catalog itself arrives in the runner's subsequent `hosts` broadcast. |

**Spawn authentication path**: Spawn is unified through the runner (resident or one-shot
`kaoiro-runner spawn …`). Trust starts with the per-host runner token
([ADR-0023](../adr/0023-host-runner-architecture.md)) plus the per-agent token issued and
injected by the server at spawn; pre-registering per-agent tokens is unnecessary
([ADR-0024](../adr/0024-agent-instance-identity-and-spawn-auth.md) D2/D4). Token issuance
and lifetime are defined by ADR-0024. Full runner-less direct `node wrapper` support is [#71](https://github.com/sakuraiyuta/kaoiro/issues/71).

### Versioning policy

Moved to [Versioning policy](../reference/protocol/versioning.md#versioning-policy).

### Version inventory (issue #208)

Moved to [Versioning policy](../reference/protocol/versioning.md#version-inventory-issue-208).

#### Client → server (stage 1, completed in #208)

Moved to [Versioning policy](../reference/protocol/versioning.md#client-server-stage-1-completed-in-208).

#### Server → wrapper (stage 1, completed in #208)

Moved to [Versioning policy](../reference/protocol/versioning.md#server-wrapper-stage-1-completed-in-208).

#### Server → runner (stage 1, completed in issues #171/#172)

Moved to [Versioning policy](../reference/protocol/versioning.md#server-runner-stage-1-completed-in-issues-171172).

#### Runner → server (complete; outside #208 scope)

Moved to [Versioning policy](../reference/protocol/versioning.md#runner-server-complete-outside-208-scope).

#### Wrapper → server (stage 2, completed in issue #260; wrapper identity in issue #288 Stage 3)

Moved to [Versioning policy](../reference/protocol/versioning.md#wrapper-server-stage-2-completed-in-issue-260-wrapper-identity-in-issue-288-stage-3).

#### Server → client (stage 2, completed in issue #260; wrapper identity in issue #288 Stage 3)

Moved to [Versioning policy](../reference/protocol/versioning.md#server-client-stage-2-completed-in-issue-260-wrapper-identity-in-issue-288-stage-3).

#### Permanent carve-out — `attach_chunk`

Moved to [Versioning policy](../reference/protocol/versioning.md#permanent-carve-out-attach_chunk).

#### Receiver validation

Moved to [Versioning policy](../reference/protocol/versioning.md#receiver-validation).

#### Non-map payload handling

Moved to [Versioning policy](../reference/protocol/versioning.md#non-map-payload-handling).

### Identity and persona (must)

 - `agent_id` is a stable ID fixed in configuration; do not use volatile runtime IDs.
 - `session_id` identifies an SDK conversation and is independent of agent_id (one agent to
   many sessions). The server keeps only the last session_id per agent as the default resume
   target; the host runner enumerates all candidates ([ADR-0014](../adr/0014-session-resume-and-restore.md)).
 - `persona` (ID, display name, sprite) is selected by wrapper initial configuration; the user
   assigns personas to hosts/processes.
 - Server and client persist display and mood keyed by `agent_id` (and `persona.id`).
 - Details are in [ADR-0003](../adr/0003-persona-identity-persistence.md); future rendering
   kinds (static diff, animation, 3D) may be added to `persona` ([ADR-0004](../adr/0004-client-rendering-staged.md)).

### State-machine state set v0 (draft)

Core of practical goal (A), derived from Agent SDK messages. See [agent-sdk-events](../reference/engines/claude-events.md)
for the SDK's **settled message/callback contract and derivation mapping**.

| State | Meaning | Source (SDK) | Future expression |
|---|---|---|---|
| `idle` | Started, no work yet | `SDKSystemMessage` (init) | Normal |
| `sending` | Instruction sent, waiting for response | Wrapper-derived on instruction acceptance (outside SDK, #32) | Sent |
| `thinking` | Model is generating | `SDKAssistantMessage` (text/thinking) | Thinking |
| `tool_running` | Tool is running | `SDKAssistantMessage` (tool_use) → `SDKUserMessage` (tool_result) | Focused |
| `waiting_permission` | Waiting for tool permission | `canUseTool` call with Promise pending | Waiting for operator |
| `waiting_question` | Waiting for AskUserQuestion answer | `canUseTool` (`toolName === "AskUserQuestion"`) with Promise pending, [ADR-0027](../adr/0027-askuserquestion-envelope.md) | Offering choices |
| `waiting_input` | Turn complete, waiting for next instruction | After `SDKResultMessage`, waiting for streaming input | Waiting |
| `done` | Instant of turn completion | `SDKResultMessage` (success) | Happy (→ `waiting_input`) |
| `error` | Error/retry | `SDKResultMessage` (error_*/is_error) | Concerned |
| `disconnected` | Wrapper connection lost; `ext.disconnect?` identifies a validated origin/reason pair when the disconnect was terminal | Server-derived | Unknown/absent |

Control (gap 1) is also settled: streaming input (`AsyncIterable<SDKUserMessage>`),
`Query.interrupt()`, and `canUseTool` complete within one Query ([agent-sdk-events](../reference/engines/claude-events.md)).

```mermaid
stateDiagram-v2
  [*] --> idle
  idle --> sending
  waiting_input --> sending
  sending --> thinking
  sending --> tool_running
  thinking --> tool_running
  tool_running --> waiting_permission
  waiting_permission --> tool_running
  tool_running --> waiting_question
  waiting_question --> tool_running
  tool_running --> thinking
  thinking --> done
  thinking --> error
  tool_running --> error
  sending --> error
  done --> waiting_input
  error --> waiting_input
  idle --> disconnected
  thinking --> disconnected
  tool_running --> disconnected
  waiting_input --> disconnected
  sending --> disconnected
  disconnected --> idle
```

### Persona asset distribution

HTTP API resolving `persona.sprite_set` to images. [ADR-0008](../adr/0008-persona-asset-distribution.md)
initially covered sprites only; [ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md)
expanded it on 2026-07-05 to persona-pack zip distribution, a server aggregate SoT, and
auto-watch. It is independent of Channels and not gated by `:serve_dashboard` (public API).
Asset layout and format are defined by [personas](personas.md); the pack schema is
[persona-pack-format](../reference/personas/pack-format.md).

- `GET /api/personas` — manifest JSON:

```json
{
  "version": "<16hex>",
  "personas": {
    "<sprite_set>": {
      "name": "<display name>",
      "pack_version": "<semver>",
      "description": "<optional 1-line>",
      "states": {
        "<state>": {
          "url": "/personas/<sprite_set>/<state>.png?v=<12hex>",
          "hash": "sha256:<64hex>"
        }
      }
    }
  }
}
```

- `version` is the aggregate version derived from asset contents; clients refetch sprite URLs
  only when it changes (incremental sync).
- `name` / `pack_version` / `description` come from the persona pack `manifest.json`
  ([persona-pack-format](../reference/personas/pack-format.md)). `personality.md` is not exposed by this API;
  it is pushed only during the WS wrapper handshake (see "Personality prompt delivery").
- Hashed `url` forms are immutable with `cache-control: public, max-age=31536000, immutable`;
  URLs without `?v=` are `no-cache`.
- Only files listed in the manifest are served; unknown paths return 404.
- A missing sprite falls back to the `idle` image. `disconnected` has no image (MUST NOT in
  personas.md) and is shown as grayscale idle. Missing manifests or unlisted sprite sets fall
  back to sprite-less rendering (CSS face in the reference implementation).
- **Auto-watch**: the server watches the intake directory with Elixir `FileSystem`, detects zip
  additions/updates/deletions, and rebuilds the manifest ([ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md) F6); no manual restart is needed.

### Personality prompt delivery (ADR-0029)

Under [ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md), the personality
prompt is pushed from the server aggregate SoT (`personality.md` in the persona pack) to the
wrapper during the WS handshake.

- **Reject unknown persona.id at wrapper join**: when accepting `wrapper:<agent_id>`, the server
  checks the persona ID from the agent-token mapping against the manifest. IDs absent from the
  manifest are refused (enforcing no stray personas,
  [ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md)
  F3).
- **after_join push**: server pushes the following message to the wrapper:

  | Direction | Type | Payload | Notes |
  |---|---|---|---|
  | server → wrapper | `persona_prompt` | `{ prompt }` | Sent once after wrapper join. `prompt` is persona-pack `personality.md` plus the server-joined common footer ([ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md) F5). The wrapper injects it unchanged with SDK `systemPrompt.append` ([persona-personality-injection](persona-personality-injection.md)); no hot-swap push occurs during the session (F9). |

- **Fail-closed when server is unreachable**: the wrapper cannot complete spawn until it
  receives `persona_prompt`, including dev/local operation where a minimal server runs in
  [ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md)
  F10).

### Client transport

Moved to [Channels and directional messages](../reference/protocol/channels.md#client-transport).

### Connection authentication (v0 settled, [ADR-0011](../adr/0011-phase3-reliability-and-auth.md))

Moved to [Authentication and authorization](../reference/security/authentication-authorization.md#connection-authentication-v0-settled-adr-0011).

## Constraints

- MUST: `agent_id` is stable. MUST: state derivation is wrapper-side.
- MUST: `agent_id` uses `[A-Za-z0-9._-]`, 1–256 characters.
- MUST: client connections use only Phoenix Channels (`vsn=2.0.0`).
- MUST: receivers ignore unknown envelope keys (forward compatibility).
- MUST: `instruction` / `permission_decision` / `interrupt` are operator-only.
- MUST: permission waits are **unlimited** by default, matching the SDK (Promise remains
  pending). Finite timeout is wrapper opt-in and then fails closed with deny ([ADR-0022](../adr/0022-pending-permission-authoritative-source.md), issue #60).
- MUST: while `waiting_permission`, pending state persists in `state_change.ext.pending_permission`,
  the authoritative source; `permission_request` is only the initial notification
  ([ADR-0022](../adr/0022-pending-permission-authoritative-source.md)).
- MUST: `log` / `result` envelopes are delivered only to operator role ([ADR-0012](../adr/0012-response-display-and-dashboard-scope.md)).
- MUST: `agents:lobby` uses an **allow-list**. Viewers receive only `state_change` (with `ext`
  removed) and `agent_deleted`; all other events/types are removed ([ADR-0021](../adr/0021-role-information-disclosure-policy.md)).
  `permission_request` is replaced for viewers by synthetic `state_change(waiting_permission)` to keep the grid consistent.
- MUST: file-upload operations (`attach_open` / `attach_chunk` / `attach_close` /
  `attach_rejected` / `instruction_rejected` / `instruction.attachment_ids`) are **operator-only**
  for both delivery and acceptance ([ADR-0021](../adr/0021-role-information-disclosure-policy.md) /
  [ADR-0025](../adr/0025-file-upload-wire-and-wrapper-rendering.md)).
- MUST: the server neither interprets nor persists upload bytes; it transparently relays them
  without disk access ([ADR-0020](../adr/0020-dashboard-battery-included-client.md) F3).
- MUST: attachment rendering (image/document/text block choice and Office conversion) is
  **wrapper-internal**. Protocol, client, and server do not use Anthropic API terms
  ([file-upload](file-upload.md), [ADR-0025](../adr/0025-file-upload-wire-and-wrapper-rendering.md) F1).

## Open Questions

None; protocol reliability was settled by [ADR-0011](../adr/0011-phase3-reliability-and-auth.md).

## See Also

- Related specs: [architecture](../architecture/system-overview.md),
  [plugin-model](plugin-model.md), [personas](personas.md),
  [subagent-tasks](subagent-tasks.md),
  [file-upload](file-upload.md)
- ADRs: [0001](../adr/0001-agent-sdk-integration.md),
  [0003](../adr/0003-persona-identity-persistence.md),
  [0008](../adr/0008-persona-asset-distribution.md),
  [0009](../adr/0009-client-transport.md),
  [0010](../adr/0010-protocol-precisification.md),
  [0011](../adr/0011-phase3-reliability-and-auth.md),
  [0012](../adr/0012-response-display-and-dashboard-scope.md),
  [0014](../adr/0014-session-resume-and-restore.md),
  [0015](../adr/0015-protocol-version-stamping.md),
  [0016](../adr/0016-error-body-relay.md),
  [0019](../adr/0019-subagent-workflow-entity-and-task-envelope.md),
  [0021](../adr/0021-role-information-disclosure-policy.md),
  [0022](../adr/0022-pending-permission-authoritative-source.md),
  [0023](../adr/0023-host-runner-architecture.md),
  [0025](../adr/0025-file-upload-wire-and-wrapper-rendering.md)
