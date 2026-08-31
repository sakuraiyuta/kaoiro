---
title: authoritative source for pending permission to state change.ext — the first notification
status: accepted
date: 2026-06-22
opened: 2026-06-22
supersedes: []
superseded_by: null
related_specs: [protocol, threat-model]
related_adrs: [10, 11, 12, 21, 27, 32, 33, 34, 40, 41, 43, 44]
---

# authoritative source for pending permission`state_change.ext`Note

## Status

Accepted

## Context

The permission dialog introduced in Phase 3 is displayed on the display .
`state_change` When envelope  arrives**The dialog disappears and unoperable**and
Auto deny with wrapper timeout after 600 seconds → fatal
Issue #59)

direct cause is client (`dashboard/src/App.svelte`,
`dashboard/src/lib/AgentDetail.svelte`) is the latest envelope  for each agent
`permission_request` envelope
Lose persistence when overwritten with `state_change`.

The revision policy was 3 proposals:

||||
|---|---|---|
| A |Client side`pendingPermissions`Set up a store envelope  independently|rejected: short term is valid, but reigns with reload recovery, multiple operator observationhronization, viewer observation, history matching. Because protocol is not fully expressing state, it is not rooted in client-side local stores|
| B |wrapper is waiting permission`state_change.ext`Note`pending_permission`and the client isHome from ext| **permission**ADR-0012 / ADR-0021 Recoverable with snapshot, always hronize across multiple clients|
| C |wait permission on the wrapper side`state_change`queue and permission resolved after flash|rejected: risky by fundamental changes in state machines. Client observation of advanced information is delayed|

## Decision

### F1: `state_change.ext.pending_permission`authoritative source

The truth of the permission request in pending is `state_change.ext.pending_permission`.
`null`/ No pending if not set. Shape`{ request_id, tool_name, input?,
truncated?, ts }`(`permission_request`equivalent to payload of envelope ).

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

### F2: `permission_request`envelope **First notification**

For the purpose of maintaining protocol compatibility and notifying events that "pending has been newly issued"
`permission_request` leave envelope , but the truth of state is no longer. More
The client reads ext.

`permission_request` payload and `state_change.ext.pending_permission`
guaranteesthe relevant entryhronization on the wrapper side (the same `request_id` / `tool_name` /
`input` / `truncated` / `ts`).

### F3: wrapper will last to ext

- `wrapper/src/host.ts` has `#pendingPermission` state.
- `wrapper/src/permission.ts` is `onPendingChange(pending)`
`onPendingChange(null)`
Clear.
- when host `#statusExt()` is `#pendingPermission !== null`
`ext.pending_permission` `waiting_permission`
state change (such as idle by thinking / tool running / session init)
ext lasts even if it happens.
- `permission_resolved` check `#pendingPermission = null`
emit `state_change(tool_running)`
ext does not contain pending.

### F4: viewer delivery auto cover with ADR-0021 allow-list

ADR-0021
"Remove ext" does not leak to viewer. No new guard required.
`permission_request` The envelope  itself is completely removed with ADR-0021
(subst ted to `state_change(waiting_permission)`).

### F5: Snapshot Restore

`AgentStates` of the server puts state change as the latest envelope .
`ext.pending_permission`
but unresolved permission is restored as it is. DETS, etc.
No necessity (only the survival in the session is the purpose, another interest from #49).

### F6: Change timeout to SDK default (un ed)

ADR-0011 stipulated "deny" in 600 seconds, but the root cause pending
Auto deny for more than 10 minutes has been lost.
UX is the main cause. The SDK does not have timeout on canUseTool
Wait until the response is received, so broker defaults to it:

`DEFAULT_PERMISSION_TIMEOUT_MS = 600_000`
Cancel `options.timeoutMs` / `config.permission_timeout_ms` undefined
If it is unlimited wait.
- AnyTime timeout can be opt-in with config/environment variables (settings)
The maintenance is another issue #60, and this ADR only changes the behavior of the code.
- ADR-0011 is updated by reference to this ADR.

### F7: Clients switch to ext

Do not leave any compatible fallback. in-tree
`permission_request` does not read envelope  directly. <1
helper transfers the role to `pendingPermissionFrom`, such as AgentDetail.svelte
Derivatives are also unified via `envelope.ext.pending_permission`.

## Consequences

### Positive

- waiting permission in state change(thinking / tool running /
session init**The dialog does not disappear**(issue #59
Neji).
- pending is immediately restored via snapshot when reloading and reconnection.
- The same dialog is always displayed anddisplayhronized between operators that are opened in a separate tab.
- The viewer leak is automatically protected by the allow-list of ADR-0021.
not required.
- 600 seconds unintended auto-deny disappears and UX will resume operation after long release
Be natural.

### Negative

- Maximum `input` size is pending
16KB). `pending_permission` itself is removed from viewer
ADR-0021
- Enable timeout to return the decision
Persistent sessions are not resolved by canUseTool Promise and wrapper
The turn does not proceed on the side. This is the same as that of the current deny "not progressing"
state, but force deny at `close()` at the end of the wrapper.

### Neutral

- `permission_request` envelope  remains in protocol, so the
This envelope  is not broken even with a single dependency (but new clients via ext)
Recommended).
- No need for DETS persistence. If long-term storage is required
#49 (session id pointer)

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
|A: New pendingPermissions store on client side|Reload recovery, multiple operators observationhronization, viewer observation, history, and reign. The local store stays in the relevant entryptomatic therapy because protocol does not fully express state|
|C: queue/flash the state change in waiting permission with wrapper|state The risk of fundamental changes in the machine. Client observation of advanced information is delayed. This ADR's F3 (sustained to ext) has wider changes|
|2 phase transition (ext fallback Yes)|All clients are in-tree and non-ex  compatible. fallback Code is a maintenance debt. (#59 user)|
|Fixed timeout (600 seconds)|If the root cause was pending disappeared, the auto deny for 10 minutes is misfired with a regular user's takeoff UX Mainly|

## Updates

- 2026 -10: The [ADR-0033](0033-permission-model-dual-axis.md) tries to add `sandbox`/`approval` biaxial fields to payload while maintaining the F1 (`state_change.ext.pending_permission` authoritative source principle) of this ADR. Extension of the permission model abstract accompanying additional codex CLI adapter ([ADR-0032](0032-codex-adapter.md)). This ADR is not supersede and is extended with ADR-0033 only.

## Related

- specs: [protocol](../specs/protocol.md)(`state_change.ext.pending_permission`
`permission_request` envelope
[threat-model](../specs/threat-model.md)
via auto cover).
- ADR: [0010](0010-protocol-precisification.md),
[0011](0011-phase3-reliability-and-auth.md)
[0012](0012-response-display-and-dashboard-scope.md)
(protocol = single source principle of truth), [0021](0021-role-information-disclosure-policy.md)
(base to protect the viewer leak with allow-list).
- Origin: [issue #59](https://github.com/sakuraiyuta/kaoiro/issues/59).
> follow-up: [#60](https://github.com/sakuraiyuta/kaoiro/issues/60)
(broker timeout setting, low priority).
