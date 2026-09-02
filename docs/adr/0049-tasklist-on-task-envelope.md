---
title: Carrying Tasklist (todo) on the task envelope
status: accepted
date: 2026-08-04
opened: 2026-08-04
supersedes: []
superseded_by: null
related_specs: [protocol, subagent-tasks, codex-sdk-events]
related_adrs: [47]
---

# ADR-0049 — Carrying Tasklist (todo) on the task envelope

## Status

Accepted (2026-08-04, decided in consultation with マスター; kaoiro issue #178).
This is the first application of the `task_type` extension planned by F4 of
[ADR-0047](0047-task-envelope-schema.md).

## Context

kaoiro issue #178. We want the operator to see on the dashboard the contents and
progress of the todo list managed by the agent itself (Claude Code's Tasklist and
Codex's `todo_list`). This is a separate axis from #170 (subagent/workflow
activity visibility): show the breakdown of the agent's own todo items, not
whether child tasks are running.

The basis for the decision is that source events from both engines arrive as
**whole-list updates** (Claude Code's todo update and Codex SDK 0.144.1's
ThreadItem `todo_list` — `items[]: {text, completed}`,
[codex-sdk-events](../specs/codex-sdk-events.md); the current Codex adapter drops
it). ADR-0047 makes `task_type` an extensible enum and explicitly plans a tasklist
addendum.

## Decision

### F1: Carry it on type `task` and deliver the whole list by replacement

Do not create a separate type; carry it as `task_type: "tasklist"` on type `task`.
Make a tasklist a **single entity per agent** (do not make each item an entity),
and carry the entire todo list in the optional `items` field (item text + item
status). Replace the whole list on update (last-write-wins), directly matching the
shape of the source event.

### F2: Only the parent agent's own todo list

Limit the scope to what can be observed from the parent session's stream. Do not
collect a subagent's todo list — reading a child transcript is the path that
[ADR-0019](0019-subagent-workflow-entity-and-task-envelope.md) rejected as
“heavy” for v0; retain the same decision.

### F3: Target both Claude Code and Codex engines

Stop discarding Codex ThreadItem `todo_list` and convert it into the same envelope.
Map the `completed` boolean to an item status (Codex has no equivalent of
in_progress, so tolerate differences in item-status granularity between engines).

### F4: Set details in a protocol addendum during implementation

Define the vocabulary for `items` item status, use of `kind` (centered on `updated`, since
whole-list replacement is primary), and application of throttling
([ADR-0048](0048-task-aggregation-delivery.md) F2) to tasklists by adding them to
the reserved `task` row in the protocol when implementation starts
(`version` unchanged). UI presentation (position and collapse behavior) is a
client responsibility and is recorded in issue #178.

## Consequences

### Positive

- Without increasing the type count, ride on the same envelope and server
  aggregation as #170 (the flat task table / snapshot frame of
  [ADR-0048](0048-task-aggregation-delivery.md)).
- The source events of both engines (whole-list updates) match the wire shape, so
  the wrapper does not need to calculate item diffs.

### Negative

- Item-level granularity (symmetry with #170's child-task display) is lost; item
  event history cannot be followed.
- Item-status granularity differs between engines (Codex has only the completed
  boolean).

### Addendum (2026-08-14): Claude's source changed to tool triggers + durable files

The default of Claude Agent SDK 0.3.228 changed from the old `TodoWrite` whole-list
payload to `TaskCreate` / `TaskUpdate` / `TaskList`. The Claude wrapper records the
tool_use IDs of these Task* tools and, after the corresponding tool_result, reads
`~/.claude/tasks/<session_id>/*.json` as the trigger. Reconstruct and replace the
whole snapshot from `subject` and `status`. Do not read before execution because
the source file has not yet been updated at the assistant's tool_use point. For
unresolved joins, reconcile and discard once at terminal result / conversation
reset / interrupt; also discard on close without reading, so it is not carried over
to the same tool_use ID on the next turn.

`TodoWrite` remains in the SDK's public tool union and is observed in the
compatibility path with `CLAUDE_CODE_ENABLE_TASKS=0`. Its input remains a whole-list
replacement as before, so the wrapper applies it directly from the assistant
message without a durable-directory read or tool_result join. Warn on invalid input
and do not send the stale list as current. Thus, on the Claude side, F1's premise
that “the source event itself is the whole list” no longer holds: source-file
enumeration and schema validation are added to the wrapper. The wire remains
whole-list LWW as before, so item diffs are not brought into the server/dashboard.

This directory is not part of the SDK's public contract. For read/JSON/schema
errors, including a missing directory, do not send a stale list; warn and make the
failure visible. Confirm an empty list only when the existing session directory
contains zero JSON task files. Unknown future `Task*` names are warned about once
per name. Explicitly exclude background-task `TaskOutput` / `TaskStop`, read-only
tasklist `TaskGet`, and bare `Task` as known non-targets; warn once and classify new
siblings so a future tool rename is not silently missed.

Although measurement shows that compact does not change session_id, if fork/rebind
changes session_id and a known tasklist exists, immediately reread the new session
directory. Do not redeliver identical content; replace it when different,
including with an empty list. If the source cannot be read, replace the old
session's list with an empty list and leave a warning, so a different session's list
does not remain visible. Do not read on initial init. Resume restores effective
settings, not a tasklist-restore contract, so accept the residual behavior that the
tasklist is not displayed again after resume until a task tool_use occurs.

### Neutral

- The tasklist entity's lifetime and cleanup follow the other tasks and the parent
  agent's departure (ADR-0048 F1).

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| Make each todo item a task entity | Requires item-diff calculation in the wrapper and is asymmetric with Codex (completed only); it also does not match the source event shape |
| Create a separate envelope type | Increases the type enum and goes against ADR-0047's single-type policy |
| Include subagent todo lists | Requires reading child transcripts and is heavy (the same decision as ADR-0019) |

## Related

- Specs: [protocol](../specs/protocol.md) (reserved `task` row),
  [subagent-tasks](../specs/subagent-tasks.md), and
  [codex-sdk-events](../specs/codex-sdk-events.md) (`todo_list` source event).
- Related ADR: [0047](0047-task-envelope-schema.md) (task envelope schema and
  `task_type` extension point).
- Origin: settle the HITL questions of kaoiro issue #178 through consultation with
  マスター (UI decisions such as the display destination are recorded in the issue).
