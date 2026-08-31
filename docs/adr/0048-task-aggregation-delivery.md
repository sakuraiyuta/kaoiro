---
title: task server Ag ation, Prog , Snapshot
status: accepted
date: 2026-08-04
opened: 2026-06-16
supersedes: []
superseded_by: null
related_specs: [protocol, subagent-tasks]
related_adrs: [19, 47]
---

# ADR-0048 — task's server aggregate, progress, snapshot

## Status

Accepted (2026.04) kaoiro issue #170).
[ADR-0019](0019-subagent-workflow-entity-and-task-envelope.md)
"active set maintenance and delivery of child tasks"
[subagent-tasks](../specs/subagent-tasks.md)

## Context

ADR-0019 informs subagent / workflow as parent child entity
-side retention model, frequency of progress update, and subsequent connection client
Snapshots were undecided.

Determination material: `snapshot` (join   push, `agent_id`)
last-write-wins, [protocol](../specs/protocol.md)). server only memory
(no.), the premise that disappears by restart is the same as the existing one. AgentDetail
dashboard There is a track record (kaoiro issue #174), and envel  quantity
I want to avoid uncontrolled increase.

## Decision

### F1: Flat task table + parent`agent_id`

server is not a parent agent entity collection,
Keep it as a flat task table, and each task refers to the parent `agent_id`.
Tasksly handles the life span management of parents and children, and tasks with different `task_type` (the future tasklist,
[ADR-0047](0047-task-envelope-schema.md) F4)
Parent agent for lifecycles (ADR-0019 F1)
destroy the task that is linked to when withdrawal.

### F2: `kind=updated`wrapper

Prog  update (`kind=updated`) depends on a certain interval + difference threshold on the issue side of the wrapper
Close `started` / `completed` will always be issued immediately. `usage`
Increase envel  by frequent updates and suppress dashboard loads (#174 lessons) with sources.
The interval and threshold of the object are defined at stage 1.

### F3: Subs   to connection with existing snapshot frame

`snapshot`(join   push)
send the task's active set. Snapshot
envel  The protocol add is minimal, and the last-write-wins
Contact Us

## Consequences

### Positive

- The implementation policy of retention and distribution can be determined, and can be set to stage 2 (Japanese term consolidation and relay).
- Simultaneously reduce the load of both the client and the hassle of the intermittent.
- Minimizes the addition of the protocol to use the existing framework of snapshot.

### Negative

- The progress meta (usage, etc.) of the client is from the latest value
Delay (consuming to the final value with `completed`).
- The pulling parameter is an implementation item on the wrapper side and between
(claude-code / codex)

### Neutral

- Reboot only with memory retention — the same as the existing entity.
- The cleaning timing of the task table follows the parent agent withdrawal.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
|Child collection under the parent agent entity|Parent reconnection/deletion process and child life management combine. different`task_type`It is difficult to live|
| `task_progress`every time|envel  is bulging in frequent update of usage and can reproduce the dashboard load (#174)|
|Snapshot envel |Constant traffic increases. push + last-write-wins|

## Related

-Stage: [subagent-tasks](../specs/subagent-tasks.md) (stage 2),
[protocol](../specs/protocol.md)
-> ADR: [0019](0019-subagent-workflow-entity-and-task-envelope.md)
[0047](0047-task-envelope-schema.md)
  [0021](0021-role-information-disclosure-policy.md)(viewer/operator
Information disclosure polycy — this addendum fail-closed default).
- Origin: open-question subagent-task-ag ation(2026-06-16)
ADR

## Addendum (issue #170, 2026 2009):

**Contact Us**`task` envel  live streaming, and snapshot `tasks` keys
(F3)****`viewer` will not be delivered to the roll.
After consultation with the master, Home decides, and three of them:

1. [ADR-0047](0047-task-envelope-schema.md) F3 progress meta
`summary` / `last_tool_name`
[ADR-0021](0021-role-information-disclosure-policy.md)
`log`/`result`
2. The purpose of issue #170 itself is "operator understands inActivities activity",
No requests for viewer.
3. ADR-0021 F2 fail-closed Default (Unknown type is not delivered to viewer)
is already bound to arrow-by-default.
Unfold it first and make it safer to leak.

**.**

- Live streaming: `AgentsChannel.sanitize_envelope_for/2` to `"task"` only
**Not Added**Home `log`/`result`/`hosts`
same path — type without explicit viewer permission clause
`:viewer, _ -> :drop` falls to the default value — to ride as it is,
ments to zero line changes (N3 Correction, ChJapanese term 2026 09: This
not "Fail-closed insurance for unknown type",
same main path as hosts/log/re t — dependent on server gate
result and not defensive fallback).
- snapshot: `AgentsChannel.handle_info(:after_join, socket)`
`TaskStates.snapshot()`
`tasks` key and always return `tasks: %{}` to viewer join.

addendum or new ADR to expand task visualization for future viewer
after the revision (not implicit extension on the sanitization side).

**Home**: kaoiro issue #170 implementation session (Home, 2026.09).
