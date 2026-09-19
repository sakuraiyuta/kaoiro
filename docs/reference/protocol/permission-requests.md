---
title: Permission request contract
status: accepted
last_updated: 2026-09-19
description: The set_permission wire contract -- request validation, relay, and acknowledgement.
---

# Permission requests

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

## Related protocol topics

- [Envelope contract](envelope.md).
- [Permission state](permission-state.md).
- [Permission synchronization and audit](permission-sync-audit.md).
- [Message topology](../../architecture/message-topology.md).
- [Model and effort state](model-effort.md).
- [Session capabilities](capabilities.md).
- [Session lifecycle](session-lifecycle.md).
- [State machine](state-machine.md).
- [Attachment wire contract](attachments.md).
- [Attachment rendering by engine](../engines/attachment-rendering.md).
- [Runner control and launch](runner-control.md).
- [Task and tasklist envelopes](tasks.md).
- [Persona delivery](persona-delivery.md).
