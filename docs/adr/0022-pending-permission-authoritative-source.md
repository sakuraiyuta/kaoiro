---
title: Make state_change.ext the authoritative source for pending_permission — demote the permission_request envelope to an initial notification
status: accepted
date: 2026-06-22
opened: 2026-06-22
supersedes: []
superseded_by: null
related_specs: [protocol, threat-model]
related_adrs: [10, 11, 12, 21, 27, 32, 33, 34, 40, 41, 43, 44]
---

# ADR-0022 — Make `state_change.ext` the Authoritative Source for pending_permission

## Status

Accepted

## Context

With the permission dialog introduced in phase 3, if another `state_change` envelope arrives immediately after the dialog is displayed, the **dialog disappears and becomes unusable**. After 600 seconds, the wrapper broker times out and automatically denies the request, leaving the session stuck—a critical defect (issue #59).

The direct cause is that the clients (`dashboard/src/App.svelte`, `dashboard/src/lib/AgentDetail.svelte`) overwrite a bucket for each agent with the **latest single envelope**, so persistence is lost as soon as the `permission_request` envelope is overwritten by `state_change`.

There were three possible fixes:

| Option | Summary | Decision |
|---|---|---|
| A | Add a `pendingPermissions` store on the client to avoid depending on a single envelope | Rejected: effective in the short term, but reload restoration, synchronisation across multiple operators, viewer observation, and history consistency would re-trigger the problem. The structural cause is that the protocol does not fully represent the state, so a local client store is not a fundamental fix |
| B | The wrapper persistently attaches `pending_permission` to `state_change.ext` while waiting_permission, and the client derives it from ext | **Adopted**: consistent with ADR-0012 / ADR-0021, which make the protocol the single source of truth. It can be restored from a snapshot and is always synchronised across multiple clients |
| C | Queue state_change on the wrapper while waiting_permission and flush it after permission_resolved | Rejected: a fundamental state-machine change with high risk. It delays the client’s observation of progress |

## Decision

### F1: Make `state_change.ext.pending_permission` the authoritative source

The source of truth for a pending permission request is `state_change.ext.pending_permission`. `null` / unset means that nothing is pending. Its shape is `{ request_id, tool_name, input?,
truncated?, ts }` (equivalent to the payload of the `permission_request` envelope).

```json
{
  "type": "state_change",
  "state": "waiting_permission",
  "payload": {},
  "ext": {
    "pending_permission": {
      "request_id": "abc-123",
      "tool_name": "Bash",
      "input": { "command": "ls" },
      "ts": "2026-06-22T05:30:00Z"
    }
  }
}
```

### F2: Demote the `permission_request` envelope to an **initial notification**

Keep the `permission_request` envelope for protocol compatibility and to notify that a pending request has newly appeared, but it is no longer the source of truth. From now on, clients should read ext.

The wrapper guarantees synchronisation between the `permission_request` envelope payload and `state_change.ext.pending_permission` (the same `request_id` / `tool_name` / `input` / `truncated` / `ts`).

### F3: The wrapper persistently attaches it to ext

- Keep `#pendingPermission` state in `wrapper/src/host.ts`.
- `wrapper/src/permission.ts` notifies the host with `onPendingChange(pending)` when decide() starts, and clears it with `onPendingChange(null)` on resolve / timeout / close.
- When `#pendingPermission !== null`, the host’s `#statusExt()` includes `ext.pending_permission` in its return value. The ext persists even if another state change (thinking / tool_running / idle caused by session_init, etc.) occurs during `waiting_permission`.
- On `permission_resolved`, the host confirms `#pendingPermission = null` (the broker has already notified it) and then emits `state_change(tool_running)`. The ext naturally contains no pending request.

### F4: Viewer delivery is automatically covered by ADR-0021’s allow-list

Because `pending_permission` is in ext, ADR-0021’s rule that “viewers have ext removed for every type” prevents it from leaking to viewers. No new guard is needed. The `permission_request` envelope itself is also completely removed for viewers by ADR-0021 (replaced with a synthetic `state_change(waiting_permission)`).

### F5: Restore from a snapshot

The server’s `AgentStates` stores state_change as the latest envelope. Therefore, a snapshot for a newly joined client contains `ext.pending_permission`, restoring an unresolved permission as-is. Persistence such as DETS is unnecessary (the goal is survival during a session only; this is a separate concern from #49).

### F6: Move the broker timeout to the SDK default (unlimited)

ADR-0011 specified denial after 600 seconds without a response, but once the root cause was identified as the disappearance of pending state, the ten-minute automatic denial became primarily a **UX problem that misfires when a real user leaves the keyboard**. The SDK itself sets no timeout on canUseTool and waits for a response, so the broker default should match it:

- Remove `DEFAULT_PERMISSION_TIMEOUT_MS = 600_000` from `wrapper/src/permission.ts`. If `options.timeoutMs` / `config.permission_timeout_ms` is undefined, wait without a limit.
- Permit any finite timeout to be opted into through configuration / environment variables (configuration-surface work is separate issue #60; this ADR changes only code-side behaviour).
- Update the relevant section of ADR-0011 to refer to this ADR.

### F7: Switch the client to ext in one step

Do not retain a compatibility fallback. All clients (the dashboard) in-tree stop reading the `permission_request` envelope directly. The `permissionRequestOf` helper changes its role to `pendingPermissionFrom`, and derived views such as AgentDetail.svelte are unified around `envelope.ext.pending_permission`.

## Consequences

### Positive

- The dialog **does not disappear** on a `state_change` during waiting_permission (thinking / tool_running / idle from session_init, etc.), fixing the root cause of issue #59.
- Pending state is restored immediately through a snapshot after reload or reconnection.
- Operators viewing the system in separate tabs always see and synchronise the same dialog.
- Viewer leakage is automatically protected by ADR-0021’s allow-list (no additional guard).
- The unintended 600-second auto-denial disappears, making it natural to resume work after a long absence.

### Negative

- `state_change.ext` grows only while a permission is pending (because it can include up to 16 KB of `input`). `pending_permission` is removed from viewers, so the leakage risk remains within the same scope as ADR-0021.
- With the broker timeout unlimited, a persisted session for which the operator never responds leaves the canUseTool Promise unresolved and that turn does not advance on the wrapper side. This is the same “turn does not advance” state as the current denial, but wrapper shutdown forcibly denies it during `close()`.

### Neutral

- The `permission_request` envelope remains in the protocol, so an external client that currently depends on the envelope alone does not break (although new clients should use ext).
- DETS persistence is unnecessary (snapshot restoration is sufficient). If long-term storage becomes necessary, it can be added later using the same pattern as #49 (session_id pointer).

## Alternatives Considered

| Option | Why rejected |
|---|---|
| A: Add a pendingPermissions store on the client | Reload restoration, multiple-operator synchronisation, viewer observation, and history consistency would re-trigger the issue. The protocol’s incomplete state representation is the structural cause, so a local store would remain symptomatic treatment |
| C: Queue/flush state_change on the wrapper during waiting_permission | A fundamental state-machine change with high risk. It delays the client’s observation of progress and has a broader change surface than this ADR’s F3 (persistent attachment to ext) |
| Two-stage migration (with an ext fallback) | All clients are in-tree and there is no external compatibility requirement. Fallback code would become maintenance debt; a one-step switch is sufficient (#59 user decision) |
| Keep the broker timeout at 600 seconds | Once the root cause was identified as disappearing pending state, ten-minute automatic denial mainly misfires when a real user is away from the keyboard, creating a UX problem |

## Updates

- 2026-07-10: [ADR-0033](0033-permission-model-dual-axis.md) confirmed an addendum that preserves this ADR’s F1 (the principle that `state_change.ext.pending_permission` is the authoritative source) while adding the two-axis `sandbox` / `approval` fields to the payload. This extends the permission-model abstraction accompanying the addition of the Codex CLI adapter ([ADR-0032](0032-codex-adapter.md)). This ADR is not superseded; only the payload shape is extended by ADR-0033.

## Related

- specs: [protocol](../specs/protocol.md) (addendum for `state_change.ext.pending_permission`; demotes the `permission_request` envelope to an initial notification), [threat-model](../specs/threat-model.md) (viewer leakage is automatically covered through ADR-0021).
- ADRs: [0010](0010-protocol-precisification.md) (progressive-precision policy), [0011](0011-phase3-reliability-and-auth.md) (updates the broker-timeout rule in this ADR), [0012](0012-response-display-and-dashboard-scope.md) (protocol = single source of truth), and [0021](0021-role-information-disclosure-policy.md) (foundation for protecting viewers with an allow-list).
- Origin: [issue #59](https://github.com/sakuraiyuta/kaoiro/issues/59). Related follow-up: [#60](https://github.com/sakuraiyuta/kaoiro/issues/60) (make the broker timeout configurable; low priority).
