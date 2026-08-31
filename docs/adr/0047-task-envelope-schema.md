---
title: task envelope  official name and payload schema
status: accepted
date: 2026-08-04
opened: 2026-06-16
supersedes: []
superseded_by: null
related_specs: [protocol, subagent-tasks, agent-sdk-events]
related_adrs: [10, 15, 19, 48, 49]
---

# ADR-0047 — task envelope  official name and payload schema

## Status

Accepted (2026.04) kaoiro issue #170).
[ADR-0019](0019-subagent-workflow-entity-and-task-envelope.md) F2
. envelope. type

## Context

ADR-0019 Note subagent / workflow
The policy (transport=(i)) to be notified by type has been determined. type
It was the form of the official name and payload schema. Add to protocol
[ADR-0010](0010-protocol-precisification.md)
([ADR-0015](0015-protocol-version-stamping.md)).

Determination material: existing type(state change / log / request / result)
Both are single type design, and the subtype value is thin. protocol versioning
The policy is the same version of the reservation type. Claude Code Tasklist
(todo) Visualization (kaoiro issue #178)

## Decision

### F1: Single type`task` + `payload.kind`

Start / Update / Complete does not separate type, single type `task`
`payload.kind` (`started` / `updated` / `completed`)
`task` is the official name of the reserved name in protocol.

### F2: Required fields for payload

The following four must fields are common.

- `agent_id` — parent agent reference (ADR-0019 F1 child entity link).
envelope  A scene that matches `agent_id` of the outer frame, but is taken by payload alone
payload to be self-contained with   consolidation and snapshot.
- `task_id` — unique task ID within the parent session. ing  Length limit
(256 byte) is part of the wire contract, but the
[protocol.md](../specs/protocol.md) `task`
Line (CO `WrapperChannel.@max_task_id_field_bytes`) — here
Do not overlap.
- `task_type` — task type (F4).
- `status` —Life lifecycle state
  (`running` / `completed` / `failed` / `stopped`,ADR-0019 F3).

### F3: Prog  meta is optional

`subagent_type` / `workflow_name` / `description` / `usage` /
`last_tool_name` / `summary` / `skip_transcript` with optional progress meta
Different fields for each kind SDK
([agent-sdk-events](../specs/agent-sdk-events.md))

### F4: `task_type`expandable enum

Initial value`subagent` | `workflow`Note Add value in addition to closed enum
`tasklist` [0049-tasklist-on-task-envelope](0049-tasklist-on-task-envelope.md)
Additional decision).
The receiver does not destroy the unknown `task_type` and fallback to the general-purpose task display
(forward compatibility).

## Consequences

### Positive

- The "type and payload" table of the protocol can be supplemented with the formal line, step 1
(wrapper + protocol)
- Single type, so the reception side has a touch panel, and the existing type group is designed.
- #178 (Tasklist) is placed in the same envelope  by the extension of `task_type`.

### Negative

- kind changes the presence or absence of optional fields.
Field presence check is required.

### Neutral

- The protocol `version` is set up for the preparation. I re unknown type
Does not affect existing clients.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
|Separate start/update/complete to another type|The type enum is different and is not aligned with the existing single type design. You can also take care of the receiver|
|Type Name`subagent` |name that cannot include workflow or future tasklist|
|Type Name`agent_task` |Book Now`task`No redundancy from|
|Make progress meta required|There is a field that is not included in the SDK for each kind, and the wire is unrequired|

## Related

-type: [protocol](../specs/protocol.md)(type and payload table),
[subagent-tasks](../specs/subagent-tasks.md)
[agent-sdk-events](../specs/agent-sdk-events.md)
-> ADR: [0019](0019-subagent-workflow-entity-and-task-envelope.md)
(entity model and transport deter ),
[0048](0048-task-aggregation-delivery.md)
  [0010](0010-protocol-precisification.md) /
[0015](0015-protocol-version-stamping.md)
- Origin: open-question subagent-task-envelope -schema (2026-06-16)
ADR

## Addendum (issue #170, 2026 2009): F4, non-routed + prompt/output file

**F4 actual metering.**Step 1: Real SDK
(`@anthropic-ai/claude-agent-sdk@0.3.220`)
`task_started.task_type`
(`subagent` | `workflow``local_agent` / `local_workflow` /
`local_bash` F4 is "extensible enum · unknown value to general display
Since it is stated "fallback", it does not sandwich the rename layer to the S  raw value
`wrapper/claude-code/src/adapter.ts`
`sdkMessageToTask`. Renamed to "Unknown value already allowed by F4"
I judged that there is no real benefit just by adding an un. state.

**`prompt` / `output_file`**`task_started`
undocumented `prompt` (instructed to subagent, the contents themselves),
`output_file` (local file path)
found to exist. F2/F3
`task` does not wiring to payload of envelope
(`sdkMessageToTask` does not explicitly read both fields). Reason: `prompt`
`output_file` is
Expose wrapper host-specific information in the local file system path.
In the future, this ADR must be revised.

**Note**: kaoiro issue #170 implementation session (Note, 2026.09).

## Addendum (issue #170, 2026-08-09): `task_notification`terminal fallback

**Background**F2 `status` `running` / `completed` / `failed` /
`stopped`, but `task_notification` actually carries the SDK raw
`status` There is no guarantee that the string fits in this 4 value (S  version difference·
future value added). External review (Note round1 M2)
Noted that `status` was simply defeated `null` (=ignored) ——
`task_notification` is the only three kind of F1**End notification**Note
`started`/`updated`
`tasks` Continue to remain on the table, and the number of simultaneous execution count is not lowered (zHomee
task). "`task_notification` is the end of the ADR first F2"
Contradicts the premise itself.

**permission**`task_notification` `status` always ends (`kind: "completed"`)
Handle as: `completed`/`failed`/`stopped`
If it is used as it is, otherwise (unknown string / non string) is
`status: "failed"` fallback — fail-visible
(I re unknown status)
The original raw value remains `payload.raw_status`, but this is the log
No wire required schema (F2)
`sdkMessageToTask`,
`host.ts` `#applyTaskEvent` `raw_status`


[phase-32 plan](../plans/phase-32-subagent-workflow-visibility.md)
"Unknown subtype/status is not involved in counting"
`task_updated`
`task_notification`
not applicable (the plan side is corrected according to this addendum).

**Note**: kaoiro issue #170 external review compatible (Note, 2026 09,
Note round1 M2)
