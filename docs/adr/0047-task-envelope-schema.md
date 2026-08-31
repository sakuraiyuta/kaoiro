---
title: Formal name and payload schema for the task envelope
status: accepted
date: 2026-08-04
opened: 2026-06-16
supersedes: []
superseded_by: null
related_specs: [protocol, subagent-tasks, agent-sdk-events]
related_adrs: [10, 15, 19, 48, 49]
---

# ADR-0047 — Formal name and payload schema for the task envelope

## Status

Accepted (2026-08-04, decided in consultation with マスター; kaoiro issue #170).
This addendum finalizes the name and schema of the “dedicated envelope type” in
F2 of [ADR-0019](0019-subagent-workflow-entity-and-task-envelope.md).

## Context

ADR-0019 has already decided to notify subagents / workflows as child entities
with a parent, using a dedicated envelope type (transport=(i)). The remaining
questions were the formal type name and the concrete payload schema. Adding it to
the protocol is a reserved addendum ([ADR-0010](0010-protocol-precisification.md));
keep `version` unchanged ([ADR-0015](0015-protocol-version-stamping.md)).

The relevant precedent is that each existing type (state_change / log /
permission_request / result) uses a single-type design, with little precedent for
subtype branching. The protocol versioning policy is “a reserved type addendum
uses the same version.” In the future, we want to carry Claude Code's Tasklist
(todo) visualization (kaoiro issue #178) in the same frame.

## Decision

### F1: One type, `task`, with `payload.kind`

Do not split start / update / completion into separate types. Distinguish them by
`payload.kind` (`started` / `updated` / `completed`) within a single `task` type.
Use the protocol-reserved name `task` as the formal name.

### F2: Required payload fields

Require the following four fields for every kind:

- `agent_id` — reference to the parent agent (the child-entity link of ADR-0019
  F1). It matches the envelope's outer `agent_id`, but is also in the payload so
  the payload is self-contained when handled independently (server aggregation /
  snapshot).
- `task_id` — task ID unique within the parent session. The ingress length limit
  (256 byte) is part of the wire contract, but the source of truth is the `task`
  row in [protocol.md](../specs/protocol.md)'s “message types by direction”
  (`WrapperChannel.@max_task_id_field_bytes` on the server); do not duplicate it
  here.
- `task_type` — task type (F4).
- `status` — coarse lifecycle state (`running` / `completed` / `failed` /
  `stopped`, ADR-0019 F3).

### F3: Progress metadata is optional

Treat `subagent_type` / `workflow_name` / `description` / `usage` /
`last_tool_name` / `summary` / `skip_transcript` as optional progress metadata.
The SDK-side fields available differ by kind
([agent-sdk-events](../specs/agent-sdk-events.md)), so do not require them.

### F4: `task_type` is an extensible enum

Initial values are `subagent` | `workflow`. Do not make it a closed enum; allow
values to be added by addenda (`tasklist` was decided as an addition in
[ADR-0049](0049-tasklist-on-task-envelope.md)).
Receivers must not discard an unknown `task_type`; fall back to a generic task
display (forward compatibility).

## Consequences

### Positive

- Add a formal row to the protocol's “type and payload” table and begin Phase 1
  implementation (wrapper + protocol).
- A single type keeps receiver branching thin and aligns with the design of the
  existing types.
- The extensibility of `task_type` allows #178 (Tasklist) to use the same envelope.

### Negative

- Because the presence of optional fields varies by kind, receivers must check
  whether fields exist.

### Neutral

- Keep protocol `version` unchanged as this is a reserved addendum. Existing
  clients that ignore unknown types are unaffected.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| Split start/update/completion into separate types | The type enum grows and no longer matches the existing single-type design; receiver branching also increases |
| Type name `subagent` | It cannot encompass workflows or future tasklists |
| Type name `agent_task` | Renaming the reserved `task` provides no benefit and is redundant |
| Make progress metadata required too | Some fields cannot be obtained from the SDK for each kind, unnecessarily thickening the wire |

## Related

- Specs: [protocol](../specs/protocol.md) (type and payload table),
  [subagent-tasks](../specs/subagent-tasks.md) (feature specification), and
  [agent-sdk-events](../specs/agent-sdk-events.md) (source messages).
- Related ADRs: [0019](0019-subagent-workflow-entity-and-task-envelope.md)
  (source of the entity-model and transport decision),
  [0048](0048-task-aggregation-delivery.md) (server aggregation and delivery),
  and [0010](0010-protocol-precisification.md) /
  [0015](0015-protocol-version-stamping.md) (reserved addenda and version policy).
- Origin: promote the open question subagent-task-envelope-schema (filed
  2026-06-16) to this ADR.

## Addendum (issue #170, 2026-08-09): measured F4 values + do not wire prompt/output_file

**Measured F4 values.** During Phase 1 implementation, measurement of the real
SDK (`@anthropic-ai/claude-agent-sdk@0.3.220`) found that the actual values of
`task_started.task_type` were `local_agent` / `local_workflow` / `local_bash`,
not the F4 example values (`subagent` | `workflow`). Because F4 explicitly says
“extensible enum; fall back to generic display for unknown values,” pass the SDK
raw values through without a renaming layer (`sdkMessageToTask` in
`wrapper/claude-code/src/adapter.ts`). Renaming would add needless state for
values that F4 already permits as unknown, with no practical benefit.

**Do not wire `prompt` / `output_file`.** The same measurement found an
undocumented `prompt` (the full instruction to the launched subagent, the content
itself) on `task_started`, and an undocumented `output_file` (a local file path)
on `task_notification`. Include neither in the required/optional fields of F2/F3,
and do not wire either into the `task` envelope payload (as
`sdkMessageToTask` explicitly does not read both fields). The reason is that
`prompt` is the content itself and exceeds F3's granularity of “coarse progress
metadata,” while `output_file` exposes a local filesystem path specific to the
wrapper host. Wiring them in the future requires revising this ADR.

**Origin**: kaoiro issue #170 implementation session (あお, 2026-08-09).

## Addendum (issue #170, 2026-08-09): unknown `task_notification` status falls back to terminal

**Background.** F2's `status` has four coarse values, `running` / `completed` /
`failed` / `stopped`, but there is no guarantee that the raw SDK `status` string
carried by `task_notification` fits those four values (SDK version differences /
future additions). External review (ふじ round1 M2) pointed out that the initial
implementation simply turned an unknown `status` into `null` (= ignored).
`task_notification` is the only **terminal notification** among F1's three kinds;
ignoring it leaves the corresponding `started`/`updated` task in the client's
`tasks` table and the concurrent-task count never falls (a zombie task). This
contradicts the very premise at the beginning of F2 that `task_notification` is
terminal.

**Decision.** Always treat the `status` of `task_notification` as terminal
(`kind: "completed"`). If its value is one of the three known values
(`completed`/`failed`/`stopped`), use it unchanged; for anything else (an unknown
string or a non-string), fall back to `status: "failed"` — fail-visible (a zombie
task causes greater harm than ignoring an unknown status, so choose the safer
side). Keep the original raw value in `payload.raw_status`, but limit it to logs
and debugging and do not include it in the required wire schema (F2).
`wrapper/claude-code/src/adapter.ts`'s `sdkMessageToTask` and `host.ts`'s
`#applyTaskEvent` emit a warning log when `raw_status` is present.

The original description in 32-1 of the
[phase-32 plan](../plans/phase-32-subagent-workflow-visibility.md), “unknown
subtype/status does not participate in counting at all,” referred to the
implementation before this decision. It continues to apply to `task_updated`
(unknown subtype, still out of scope), but does not apply to an unknown
`task_notification` status; the plan has been corrected to match this addendum.

**Origin**: kaoiro issue #170 external-review response (あお, 2026-08-09,
ふじ round1 M2).
