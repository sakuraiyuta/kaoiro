---
title: Task and tasklist envelopes
description: The dedicated task envelope for subagent/workflow lifecycle, its task_type = "tasklist" addendum for an agent's own todo, and their operator-only delivery.
status: accepted
last_updated: 2026-09-19
related: [protocol]
---

# Task and tasklist envelopes

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
  see that ADR's addendum). Future additions such as task lists are possible.
  Receivers fall back to a generic display for unknown values.

[protocol](../../specs/protocol.md) includes it as a settled extension (with the same
`version`). The wrapper throttles `kind=updated` by interval plus change
threshold (`started` / `completed` are immediate,
[ADR-0048](../../adr/0048-task-aggregation-delivery.md) F2). The implementation
uses three seconds plus either a token delta of at least 500 or a tool-name
change (`MIN_TASK_UPDATE_INTERVAL_MS` /
`TASK_UPDATE_TOKEN_DELTA_THRESHOLD` in `wrapper/claude-code/src/host.ts`). The
**first** `updated` for a `task_id` (with no preceding throttling record) is
always emitted immediately regardless of both interval and threshold (the
cold-start branch of `#shouldEmitTaskUpdate`), so the operator does not wait the
first three seconds for progress immediately after launch.

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
since SDK 0.3.228 is the `TaskCreate`/`TaskUpdate`/`TaskList` tool triggers ([ADR-0049](../../adr/0049-tasklist-on-task-envelope.md)
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

- Related specs: [protocol](../../specs/protocol.md), [agent-sdk-events](../engines/claude-events.md)
- ADR: [0019](../../adr/0019-subagent-workflow-entity-and-task-envelope.md)
  (entity model and transport),
  [0047](../../adr/0047-task-envelope-schema.md) (envelope schema),
  [0048](../../adr/0048-task-aggregation-delivery.md) (server aggregation and delivery)

## Related protocol topics

- [Envelope contract](envelope.md).
- [Event types and payloads](events.md).
- [Channels and directional messages](channels.md).
- [Versioning policy](versioning.md).
- [Message topology](../../architecture/message-topology.md).
- [Permission requests](permission-requests.md).
- [Permission state](permission-state.md).
- [Permission synchronization and audit](permission-sync-audit.md).
- [Model and effort state](model-effort.md).
- [Session capabilities](capabilities.md).
- [Session lifecycle](session-lifecycle.md).
- [State machine](state-machine.md).
- [Attachment wire contract](attachments.md).
- [Attachment rendering by engine](../engines/attachment-rendering.md).
- [Runner control and launch](runner-control.md).
- [Wrapper configuration](../configuration/wrapper.md).
- [Subagent visibility](../../architecture/subagent-visibility.md).
- [Persona delivery](persona-delivery.md).
