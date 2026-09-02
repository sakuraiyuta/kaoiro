---
title: Treat subagent/workflow as child entities with a dedicated envelope type
status: accepted
date: 2026-06-16
opened: 2026-06-16
supersedes: []
superseded_by: null
related_specs: [protocol, agent-sdk-events, subagent-tasks]
related_adrs: [10, 15, 47, 48]
---

# ADR-0019 — Treat subagent/workflow as Child Entities with a Dedicated Envelope Type

## Status

Accepted

## Context

The Claude Code being wrapped can use the Task tool to start a subagent / local workflow and run an “AI team” internally. At present kaoiro does not visualise this internal activity at all. `wrapper/src/adapter.ts`’s `sdkMessageToEvents` discards every `type:"system"` message except `subtype==="init"`, and therefore drops task-related messages.

Meanwhile, the SDK message stream of the parent session contains dedicated messages for start/progress/end (verified, [agent-sdk-events](../specs/agent-sdk-events.md)):

- `system/task_started` — start. `task_id` / `description` / `subagent_type` / `task_type` / `workflow_name` / `tool_use_id` / `skip_transcript`
- `system/task_progress` — progress. `subagent_type` / `usage` / `last_tool_name` / `summary`
- `system/task_notification` — end. `status` (completed/failed/stopped) / `summary` / `usage`

We want to pick these up and deliver them to the client, increasing the resolution of goal (A), “understanding progress and state” (showing “how many and what” an agent is currently running). The issues are (1) what kind of entity to treat a subagent as, and (2) how to place it in the protocol.

## Decision

- **Entity model (F1)**: subagents / workflows are “independent entities as visual representations,” but are treated as **child entities tied to the parent agent** in terms of identity / transport. Each task is linked by a reference to its parent (`agent_id`), and its lifecycle is bound to the parent session.
- **Transport (F2)**: establish a **dedicated envelope type** representing the task lifecycle, and send start / update / completion as individual events. Keep the parent agent’s `state_change` as the parent’s own `KaoiroState`; do not piggyback child-task information on it.
- **State granularity (F3)**: limit notified states to a **coarse lifecycle** (running / completed / failed / stopped + progress metadata). Fine-grained subagent states (such as thinking, eight states) are not emitted on the parent stream and are out of scope (there is room to extend this in the future via a `getSubagentMessages` path).
- **Notification granularity (F4)**: pass the client a list of running tasks (`task_id` + type/name + `status` + progress metadata). Derive the concurrent count from `task_started` (+1) / `task_notification` (-1), and keep aggregation flat at the top level only.
- **Data range (F5)**: carry progress (`usage` / `last_tool_name` / `summary`) as well.
- **Separation of responsibilities**: wrapper / server is responsible for notifying the client of “existence and state.” The client decides how to visually represent subagents / workflows (following the existing ownership of persona → sprite → expression, and the A/B separation in [overview](../specs/overview.md)).
- The formal name / schema details of the new envelope type were established in [ADR-0047](0047-task-envelope-schema.md) (a single type, `task`, + `payload.kind`). This is an addition to the **reserved types** ([ADR-0010](0010-protocol-precisification.md)), so leave the protocol `version` unchanged ([ADR-0015](0015-protocol-version-stamping.md)).

## Consequences

### Positive

- The AI-team activity run internally by an agent becomes visible, increasing the resolution of goal (A).
- The dedicated type keeps it loosely coupled to the parent state, so the meaning of `state_change` does not become unstable.

### Negative

- The server takes on responsibility for maintaining and delivering the child task active set (the aggregation method is established in [ADR-0048](0048-task-aggregation-delivery.md)).
- The number of envelope types increases.

### Neutral

- Only the coarse lifecycle is observable. Fine-grained states remain as room for future extension.
- The protocol keeps the same `version` because this is a reserved-type addition. Receivers ignore unknown types (forward compatibility).

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| Independent top-level entities on an equal footing with personas | Their lifecycle is bound to the parent, `task_id` is local to the parent, and observable state is coarse; this would promise too much |
| Include a subagents array in the parent `state_change` `ext` | Couples it to the parent state and requires a separate trigger for updates when only a subagent changes |
| Notify only the concurrent count | Cannot show “which ones are running,” and fails the requirement to identify type/name |
| Notify eight fine-grained states via `getSubagentMessages` | Requires loading each transcript and is heavy for v0; a coarse lifecycle is sufficient |

## Related

- specs: [subagent-tasks](../specs/subagent-tasks.md) (feature specification), [protocol](../specs/protocol.md) (type and payload), and [agent-sdk-events](../specs/agent-sdk-events.md) (source messages).
- Related ADRs: [0010](0010-protocol-precisification.md) (reserved-type policy), [0015](0015-protocol-version-stamping.md) (version unchanged), [0047](0047-task-envelope-schema.md) (envelope schema), and [0048](0048-task-aggregation-delivery.md) (server aggregation and delivery).
- Origin: my-idea-brief (scratch note “notify the client when subagents/workflows start, including their count and type”).

## Addendum (issue #170, 2026-08-09): `task_updated` Is Out of Scope for F3

**Background.** During the phase-1 implementation, rereading the type definitions for the real SDK (`@anthropic-ai/claude-agent-sdk@0.3.220`) revealed an undocumented fourth subtype, `system/task_updated`, in addition to the three subtypes (`task_started` / `task_progress` / `task_notification`) listed in Context. The `status` values are broader than F3’s four coarse values (running/completed/failed/stopped): (pending/running/completed/failed/killed/paused).

This raised the concern that if an intermediate state such as `status: killed` is passed through `task_updated` before the terminal notification (`task_notification`), the concurrent-task count might become incorrect by missing the terminal event.

**Decision.** On the master’s instruction, instead of inferring from the type definitions, an expendable script was used to capture the real stream and measure it (procedure and raw data are in the “Task (subagent/workflow) messages” section of [agent-sdk-events](../specs/agent-sdk-events.md)). Result: through all four paths—natural completion, `stopTask()`, interrupt, and stopping via `backgroundTasks()`—`task_notification` is always emitted regardless of whether `task_updated` is traversed (SDK 0.3.220, 2026-08-09 capture). Based on this measurement:

- Keep `task_updated` out of v1. (Do not expand F3’s four-value coarse model.) `sdkMessageToTask` in `wrapper/claude-code/src/adapter.ts` returns `null` for `task_updated`, and the caller (`AgentHost`) only leaves it in the log as an unknown subtype; it has no involvement whatsoever in concurrent-task counting (fail-visible—do not leave a path where an unknown shape can corrupt the count).
- If `task_updated` is incorporated in the future, revise this ADR or create a new ADR first (do not silently reinterpret it as equivalent to `task_progress`/`task_notification`).

**Origin**: kaoiro issue #170 implementation session (ao, 2026-08-09).
