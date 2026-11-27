---
title: Child task envelopes
description: Child task lifecycle envelopes, operator-only delivery, and legacy checklist compatibility.
status: accepted
last_updated: 2026-11-28
related: [protocol]
---

# Child task envelopes

### Source data (SDK messages)

They appear in the parent session's `query()` message stream. For details, see
[agent-sdk-events](../engines/claude-events.md).

| Message | type/subtype | Main fields |
|---|---|---|
| Start | system / task_started | `task_id`, `description`, `subagent_type`, `task_type`, `workflow_name`, `tool_use_id`, `skip_transcript` |
| Progress | system / task_progress | `subagent_type`, `usage{total_tokens,tool_uses,duration_ms}`, `last_tool_name`, `summary` |
| End | system / task_notification | `status` (completed/failed/stopped), `summary`, `usage` |

`sdkMessageToTask` in `wrapper/claude-code/src/adapter.ts` derives these into a
`task` envelope (implemented on 2026-08-09 in issue #170). For the handling of
undocumented fields found by measurement (`task_started.prompt` /
`task_notification.output_file`) and the fourth subtype `task_updated`, see the
addenda to [agent-sdk-events](../engines/claude-events.md),
[ADR-0047](../../adr/0047-task-envelope-schema.md), and
[ADR-0019](../../adr/0019-subagent-workflow-entity-and-task-envelope.md): all are
intentionally unwired and out of scope. For terminal fallback and `raw_status`
when `task_notification.status` carries a value other than the three known
ones, also see the addendum to
[ADR-0047](../../adr/0047-task-envelope-schema.md).

### Dedicated envelope type `task`

Task lifecycle flows through the **dedicated envelope type** `task` (ADR-0019
F2). The parent's `state_change` remains its own unchanged `KaoiroState`. The
schema is settled in [ADR-0047](../../adr/0047-task-envelope-schema.md):

- One type, `task`, plus `payload.kind` (`started` / `updated` / `completed`).
- Required: parent `agent_id` / `task_id` / `task_type` / `status`.
- Optional progress metadata: `subagent_type` / `workflow_name` / `description` /
  `usage` / `last_tool_name` / `summary` / `skip_transcript`.
- `task_type` is an extensible enum. Measured SDK values are `local_agent` /
  `local_workflow` / `local_bash` (they differ from ADR-0047 F4's illustrative
  `subagent`/`workflow`, but raw SDK values pass through without a renaming layer;
  see that ADR's addendum).
  Receivers fall back to a generic display for unknown values.

[Event types and payloads](events.md#types-and-payload-v0-settled) includes it
as a settled extension (with the same `version`). The wrapper throttles
`kind=updated` by interval plus change
threshold (`started` / `completed` are immediate,
[ADR-0048](../../adr/0048-task-aggregation-delivery.md) F2). The implementation
uses three seconds plus either a token delta of at least 500 or a tool-name
change (`MIN_TASK_UPDATE_INTERVAL_MS` /
`TASK_UPDATE_TOKEN_DELTA_THRESHOLD` in `wrapper/claude-code/src/host.ts`). The
**first** `updated` for a `task_id` (with no preceding throttling record) is
always emitted immediately regardless of both interval and threshold (the
cold-start branch of `#shouldEmitTaskUpdate`), so the operator does not wait the
first three seconds for progress immediately after launch.

### Reserved legacy checklist pair

[ADR-0079](../../adr/0079-retire-agent-checklist-projection.md) retired the
per-agent checklist from v2026.11.26.1. Reserve both `task_id: "tasklist"`
and `task_type: "tasklist"`. The server rejects either one-sided match and
requires `kind: "updated"` and `status: "running"` for the pair. It validates
legacy `items` and `omitted` as before, including the 50-item limit,
256 UTF-8 bytes per item, 16,384 bytes of JSON for `items` and the ordinary
ingress bounds. Valid legacy envelopes advance session identity and pending
boundary markers under the existing admission rules, then receive a bare
success acknowledgement without task storage, history or fan-out.
The dashboard also ignores this pair in live input and join snapshots from
older servers. See [the v0 exception](versioning.md#retired-checklist-projection).

### Reconnect replay

Wrapper transport resends active child tasks with a fresh sequence number
after socket rejoin. The cache holds at most 5,000 entities and 6,000,000
bytes of JSON. If it fills, the wrapper evicts the least recently updated
entries and emits a bounded warning on stderr. Server-side task storage
enforces its own bounds.

### Recipient: operator only

Live delivery of the `task` envelope and the `tasks` key in snapshots (stage 2)
are **operator-only** and are not delivered to viewers
([ADR-0048](../../adr/0048-task-aggregation-delivery.md) addendum,
[ADR-0021](../../adr/0021-role-information-disclosure-policy.md)).

### Concurrency and lifecycle

- Concurrency = `task_started` (+1) / `task_notification` (-1): a flat count of
  top-level tasks only (no nesting is followed).
- The notified states are the **coarse lifecycle** running / completed / failed /
  stopped plus progress metadata (ADR-0019 F3). Fine-grained subagent states
  (eight states) are out of scope.
- `skip_transcript` (ambient/housekeeping) is notified, but distinguishable by
  its flag.

## Constraints

- **MUST**: Do not affect the parent agent's `state_change` (`KaoiroState`).
- **MUST**: The dedicated envelope type is a reserved extension; leave the
  protocol `version` unchanged
  ([ADR-0010](../../adr/0010-protocol-precisification.md) /
  [ADR-0015](../../adr/0015-protocol-version-stamping.md)).
- **SHOULD**: Make `skip_transcript` tasks distinguishable by their flag.

## See Also

- Related specs: [events](events.md),
  [agent-sdk-events](../engines/claude-events.md)
- ADR: [0019](../../adr/0019-subagent-workflow-entity-and-task-envelope.md)
  (entity model and transport),
  [0047](../../adr/0047-task-envelope-schema.md) (envelope schema),
  [0048](../../adr/0048-task-aggregation-delivery.md) (server aggregation and delivery)

## Related protocol topics

See [Protocol documentation](../../README.md#protocol-documentation) for the
full topic index.

- [Envelope contract](envelope.md).
- [Event types and payloads](events.md).
- [Subagent visibility](../../architecture/subagent-visibility.md).
