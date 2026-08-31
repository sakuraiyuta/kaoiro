---
title: Notification of subagent/workflow with parent entity and dedicated envel  type
status: accepted
date: 2026-06-16
opened: 2026-06-16
supersedes: []
superseded_by: null
related_specs: [protocol, agent-sdk-events, subagent-tasks]
related_adrs: [10, 15, 47, 48]
---

# ADR-0019 — subagent/workflow child entity and dedicated envel  type

## Status

Accepted

## Context

Claude Code is a task tool that starts subagent / local workflow.
"AI Team" in internal. current kaoiro visualizes this inActivities activity
not. `wrapper/src/adapter.ts` `sdkMessageToEvents` `type:"system"`
All other than `subtype==="init"` are destroyed and the task-based message is thrown away.

On the other hand, the SDK message column for the parent session has a dedicated message.
Flow (verified, [agent-sdk-events](../specs/agent-sdk-events.md)):

- `system/task_started` — start. `task_id`
  `task_type` / `workflow_name` / `tool_use_id` / `skip_transcript`
- `system/task_progress` — progress. `subagent_type`
  `summary`
- `system/task_notification` — End. `status`(completed/failed/stopped)
  `summary` / `usage`

I want to pick up this and send it to the client and raise the resolution of the goal (A) “Prog  and state”
(I show how many agents are running.) subagent
What entities do we handle?

## Decision

- **Entity Model (F1)**: subagent / workflow
identity / transport**Child Entity**」
Handle as: Each task is linked with parent `agent_id`, and the lifecycle is
bound to the parent session.
- **transport(F2)**: represent the task lifecycle**New envel  type**Home
Launch / update / complete with individual events. parent agent `state_change`
`KaoiroState` keeps child task information together.
- **state particle size (F3)**: Notify state**Rough lifecycle**(running / completed /
failed / stopped + progress meta) subagent state (such as thinking 8 state)
non-scope (expansion in the future `getSubagentMessages` path), not in the parent stream.
- **Notice Particle Size (F4)**: List of tasks running to clients (`task_id` + type/name +
Pass `status` + progress meta). `task_started`(+1)/ `task_notification`
(-1) Cal。d from top level flat ag。ation.
- **Data Range (F Japanese termーJapanese term**`usage` / `last_tool_name` / `summary`
- **Privacy Policy**: wrapper / server's responsibility to notify clients of presence and state.
How to visually express subagent / workflow
persona→sprite→A/B separation of overview(../specs/overview.md).
- New envel  type official name / Schema details
[ADR-0047](0047-task-envel -schema.md) Single type `task` +
  `payload.kind`)。**Repair of reservation type**
([ADR-0010](0010-protocol-precisification.md))))
`version` ([ADR-0015] (0015-protocol-version-stamping.md)).

## Consequences

### Positive

- The AI team activity that the agent runs inJapanese termーGent is visualized and the goal (A) resolution is increased.
- A dedicated type prevents the meaning of `state_change` by keeping the parent state cohesion.

### Negative

- server is responsible for maintaining and delivering active set of child tasks
[ADR-0048]
- Envel  type type increases.

### Neutral

- Only the rough life cycle can be observed. The granularity state remains as a future expansion.
- The protocol is the same `version` for the reservation. The receiver ignores the unknown type.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
|Independent top-level entities of Persona accord|Lifecycle is bound to parents`task_id`the parent local observationstate is rough and becomes an over promise|
|Home`state_change`Home`ext`Include subagents array|Required to combine with parent state and prepare ignition at subagent alone update|
|execution number|Don’t leave “w) is running” and don’t meet the request (type/name identification)|
|Particle size 8 state`getSubagentMessages`Contact Us|transcript reads in v0. Sufficient life cycle|

## Related

-agent: [subagent-tasks](../specs/subagent-tasks.md)
[protocol](../specs/protocol.md)(type and payload),
[agent-sdk-events](../specs/agent-sdk-events.md)
-  ADR: [0010](0010-protocol-precisification.md)(Reservation type policy),
[0015](0015-protocol-version-stamping.md),
[0047](0047-task-envel -schema.md),
[0048](0048-task-ag。ation-delivery.md)
- Origin: my-idea-efef
").

## Addendum (issue #170, 2026-08-09): `task_updated`is not eligible for F3

**Background**Step 1: Real SDK
(`@anthropic-ai/claude-agent-sdk@0.3.220`)
Context 3 subtype(`task_started` / `task_progress` /
`task_notification`), the fourth subtype of undocumented
`system/task_updated` `status` is a rough 4 value of F3
wider (running/completed/failed/stopped)
(pending/running/completed/failed/killed/paused)。

`task_updated`
execution counts simultaneously when using intermediate state such as `status: killed`
I had a concern that I would be crazy by taking the end event.

**Contact Us**In the instruction of the master, instead of guessing from the type definition
Script scripts were captured and measured.
[agent-sdk-events](../specs/agent-sdk-events.md)
(subagent/workflow) message. Results: Nature Complete / `stopTask()` /
all four routes of interrupt / `backgroundTasks()`
`task_notification` must be
Issued (S  0.3.220, 2026 09 capture). Based on this survey:

- `task_updated` keeps v1 unobjected (F3 coarse 4-value model)
not extended). `wrapper/claude-code/src/adapter.ts`
`sdkMessageToTask` returns `task_updated`,
The caller (`AgentHost`) is not known as subtype
The number of simultaneous execution count is not involved only in the log
(fail-visible — Counting does not leave the path to madness with unknown shape).
- This ADR or new ADR if you want to import `task_updated` in the future
Revised to `task_progress`/`task_notification`
not readable).

**Home**: kaoiro issue #170 implementation session (Home, 2026.09).
