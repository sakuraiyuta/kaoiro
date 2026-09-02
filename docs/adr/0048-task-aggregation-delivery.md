---
title: Server aggregation, progress throttling, and snapshots for tasks
status: accepted
date: 2026-08-04
opened: 2026-06-16
supersedes: []
superseded_by: null
related_specs: [protocol, subagent-tasks]
related_adrs: [19, 47]
---

# ADR-0048 — Server aggregation, progress throttling, and snapshots for tasks

## Status

Accepted (2026-08-04, decided in consultation with マスター; kaoiro issue #170).
This settles the concrete details of the server requirement from
[ADR-0019](0019-subagent-workflow-entity-and-task-envelope.md) to “maintain and
deliver the active set of child tasks,” a prerequisite for Phase 2 of
[subagent-tasks](../specs/subagent-tasks.md).

## Context

ADR-0019 has already decided to notify subagents / workflows as child entities
with a parent, but the server-side retention model, progress-update frequency,
and snapshot delivery to clients connecting later were undecided.

The basis for the decision is the existing reconnection resynchronization:
`snapshot` (pushed immediately after join, last-write-wins per `agent_id`,
[protocol](../specs/protocol.md)). The server keeps data only in memory (no
persistence), which has the same restart-loss premise as existing behavior. There
is also a history of dashboard input becoming heavy because AgentDetail logs grew
large (kaoiro issue #174); uncontrolled growth in the number of envelopes should
be avoided.

## Decision

### F1: Flat task table with a parent `agent_id` reference

The server retains child tasks in a flat task table rather than as a collection
under the parent agent entity, with each task referring to its parent `agent_id`.
This keeps parent and child lifetime management independent and allows tasks with
different `task_type` values (future tasklists and
[ADR-0047](0047-task-envelope-schema.md) F4) to share one table. Because the
lifecycle is bound to the parent session (ADR-0019 F1), discard linked tasks when
the parent agent leaves.

### F2: Throttle `kind=updated` at the wrapper publisher

Throttle progress updates (`kind=updated`) at the wrapper publisher using a fixed
interval plus a change threshold. Do not throttle `started` / `completed`; always
publish them immediately. Control envelope growth and dashboard load from
frequent `usage` updates (#174's lesson) at the source. Set the concrete interval
and threshold during Phase 1 implementation.

### F3: Send the current set to later connections in the existing snapshot frame

Provide the current set to clients connecting later by including the active task
set in the existing `snapshot` frame (pushed immediately after join) and sending
it in one batch. Do not create a periodic snapshot envelope. This minimizes
protocol additions and rides directly on the existing last-write-wins semantics.

## Consequences

### Positive

- The implementation policy for retention and delivery is fixed, allowing Phase 2
  (server aggregation and relay) to begin.
- Because throttling occurs at the publisher, it reduces load on both server and
  client at once.
- Using the existing snapshot frame minimizes protocol additions.

### Negative

- Because of throttling, progress metadata seen by the client (such as usage)
  may lag the latest value (it converges to the final value at `completed`).
- Throttling parameters become wrapper implementation details, requiring care to
  align publication granularity across engines (claude-code / codex).

### Neutral

- Retention is memory-only and disappears on restart — the same premise as
  existing entities.
- Clean up the task table when the parent agent leaves.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| Child collection under the parent agent entity | Couples parent reconnection/deletion handling to child lifetime management, and makes it harder to co-locate different `task_type` values |
| Stream `task_progress` unchanged every time | Frequent usage updates inflate envelopes and can recreate dashboard load (#174) |
| Periodic snapshot envelope | Increases steady-state traffic; the existing join-time push + last-write-wins is sufficient |

## Related

- Specs: [subagent-tasks](../specs/subagent-tasks.md) (Phase 2) and
  [protocol](../specs/protocol.md) (existing snapshot semantics).
- Related ADRs: [0019](0019-subagent-workflow-entity-and-task-envelope.md)
  (source of the responsibility decision),
  [0047](0047-task-envelope-schema.md) (envelope schema), and
  [0021](0021-role-information-disclosure-policy.md) (viewer/operator
  disclosure policy — the fail-closed default applied by this addendum).
- Origin: promote the open question subagent-task-aggregation (filed 2026-06-16)
  to this ADR.

## Addendum (issue #170, 2026-08-09): task delivery is operator-only

**Decision.** Live delivery of the `task` envelope and the `tasks` key (F3) in a
snapshot are **operator-only**; never deliver them to the `viewer` role. The
decision was made by こはく after consultation with マスター, for three reasons:

1. The progress metadata in F3 of [ADR-0047](0047-task-envelope-schema.md)
   (`summary` / `last_tool_name`, etc.) is content-bearing information beyond a
   coarse lifecycle and is close to the granularity of `log` / `result`, which
   [ADR-0021](0021-role-information-disclosure-policy.md) has restricted to
   operators.
2. The purpose of issue #170 itself is for “the operator to understand internal
   activity”; there is no request for viewers.
3. ADR-0021 F2's fail-closed default (do not deliver unknown types to viewers)
   already favors narrow-by-default. Expanding later is safer than expanding
   first and causing a leak.

**Implementation.**

- Live delivery: **do not add** a `"task"`-specific branch to
  `AgentsChannel.sanitize_envelope_for/2`. It follows the same path as existing
  operator-only types such as `log` / `result` / `hosts`: types without an
  explicit viewer-allow clause fall into the default `:viewer, _ -> :drop`
  branch, so the requirement is met with zero changed lines (N3 correction,
  クロエ 2026-08-09: this is not “a fail-closed safeguard for unknown types”; it
  is the primary path itself, the same one as hosts/log/result — a result that
  depends on the server gate, not a defensive fallback).
- Snapshot: when `role == :operator`,
  `AgentsChannel.handle_info(:after_join, socket)` puts `TaskStates.snapshot()`
  under the `tasks` key; a viewer join always returns `tasks: %{}`.

If task visualization is expanded to viewers in the future, revise this addendum
or create a new ADR first (do not implicitly broaden the sanitizer).

**Origin**: kaoiro issue #170 implementation session (あお, 2026-08-09).
