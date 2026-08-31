---
title: Phase 3 Reliability and Certification Agreement (seq permission / correlation / )
status: accepted
date: 2026-06-11
opened: 2026-06-11
supersedes: []
superseded_by: null
related_specs: [protocol, architecture]
related_adrs: [2, 5, 10, 12, 13, 14, 21, 22, 24, 27, 42]
---

# ADR-0011 — Phase 3 Reliability and Certification Agreement (seq / permission correlation / )

## Status

Accepted

## Context

Phase 3
protocol-reliability open-question(issue #4) 2 Items are promoted to ADR
2 items (seq/event ID, permission request)
and timeout default)
wrapper([ADR)2](0002-local-wrapper-websocket-topology.md))
User access control stub([ADR 5](0005-access-control-oauth-stub.md))
There was a need to confirm the concrete approach (user decision 2026-06-11).

## Decision

1. **se seq**: wrapper `seq` ( 
a single-point integer for each startup) to all envel s. Order
`(agent_id, seq)` + `ts`. **server's latest state judgment
Keep last-write-wins — seq with wrapper restart
It is not used for overwriting judgment to move back. version remains "0"
(Add forward compatible key).
2. **permission request collides with correlation ID**: On request payload
`request_id` (ra) generation, unique in the session)
`permission_decision` returns the same `request_id`. **Default when not responding
Same as the SDK for unlimited wait** (Promise hold until response)
[ADR-0022](0022-pending-permission-authoritative-source.md)
default to migration). opt timeouts can be opt-in in the wrapper setting, in which case
fail-closed deny. The session will continue when deny. state in pending
The truth is given to `state_change.ext.pending_permission`
   ([ADR-0022](0022-pending-permission-authoritative-source.md))。
3. **wrapper authentication is an agent id **: Server Settings
`agent_id:token` wrapper presents when connection
Unmatched rejection. SQLite is not introduced (return policy 2026-06-11).
4. **User access control stub is user  + role**: Server Settings
Enumerate `token:role`. role is `viewer`(View only)/
`operator` (2 steps) ADR 5
The whitelist is linked to the OAuth installation (theJapanese term is the identifier of the present).

## Consequences

### Positive

- Simplicity of the display path while having a cloth stone (seq) to audit log and replay
last-write-wins
- The approval flow correlates correctly with request id thrust (no response behavior)
[ADR-0022](0022-pending-permission-authoritative-source.md)
Default = Migrated to unlimited wait).
- Effective anti-t  at the entrance of exe (meaning the remote tool execution)
(operator role)

### Negative

- Token management (wrapper number + number of users) starts with env configuration.
- You need to reconnect the user  → account when you migrate OAuth.

### Neutral

- RBAC RB implementation (ADR 5 line) will continue to be in the future.
- seq’s consumer (duplicate elimination and audit) will be implemented in the future phase.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
|without seq (last-write-wins only)|Problems with future audits and replays|
|permission No timeout|Agent stops indefinitely|
|1 wrapper |Removing all units at the time of leakage, loosening the content of ADR 2 (per wrapper)|
|mail self declaration whitelist|Non-verified and s rated|
