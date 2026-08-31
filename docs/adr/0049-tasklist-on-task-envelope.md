---
title: Task Tasklist (todo) to task envel
status: accepted
date: 2026-08-04
opened: 2026-08-04
supersedes: []
superseded_by: null
related_specs: [protocol, subagent-tasks, codex-sdk-events]
related_adrs: [47]
---

# ADR-0049 — Let the Tasklist (todo) task join envel

## Status

Accepted (2026.04) kaoiro issue #178).
[ADR-0047](0047-task-envelope-schema.md) `task_type`
First application.

## Context

kaoiro issue #178. Claude Code
Tasklist, Codex `todo_list`)
I want to see. #170
"Agent's own todo item breakdown" instead of "Is child task running?"


Material: Both engine**List-wide updates**Contact Us
(Claude Code todo update, Codex SDK 0.144.1 ThreadItem `todo_list`
— `items[]: {text, completed}`,[codex-sdk-events](../specs/codex-sdk-events.md).
current codex adapter is destroyed). ADR-0047 `task_type`
Extendable enum and explicitly planned to supplement tasklist.

## Decision

### F1: type `task`pair to substitute the entire list

`task_type: "tasklist"` of type `task`
tasklist for each agent**Single Entity**(entity per item)
optional field `items`
(Item text + item status). Updates replace the entire list
(last-write-wins)

### F2: Only parent agent todo

Limit to the extent that you can observation from the stream of the parent session. subagent
todo does not pick up — child transcript reads
[ADR-0019](0019-subagent-workflow-entity-and-task-envelope.md)
It is a route that leaves "heavy in v0" and follows the same judgment.

### F3: Claude Code / Codex

Codex converts ThreadItem `todo_list` to the same envel .
`completed` boolean maps to item status
The particle size difference of item status betweenJapanese terms is acceptable).

### F4: The details are determined by the protocol

`items`'s status vocabulary, `kind`'s usage (for overall replacement)
`updated` Center, intermittent ([ADR-0048](0048-task-aggregation-delivery.md))
Applying to tasklist of F2) to the `task` line of protocol
(`version`) UI expression (display position/foldable)
Register to issue #178

## Consequences

### Positive

- The same server consolidation as #170
([ADR-0048](0048-task-aggregation-delivery.md) Flat task table /
snapshot
- Both engine source events (whole list update) and wire shapes are matched to the wrapper
Item value No calculation is required.

### Negative

- The particle size of the item unit (170metry with the child task display of #170) is lost. per item
Event history
- The particle size of the item status is different between the engine (Codex is completed).

### 2026 14 Supplement: Claude source changes to tool trigger +File files

Claude Agent SDK 0.3.228 default from the old `TodoWrite` whole-list payload
`TaskCreate` / `TaskUpdate` / `TaskList` Claude wrapper
de  the tool use id and trigger the corresponding tool re t
`~/.claude/tasks/<session_id>/*.json` `subject` and `status`
Reconstruct and distribute replacements. source file is still updated at assistant tool use
do not read before execution because it is not. unresolved join result /
reconcile and destroy the source once in conversation reset / interrupt, and
There is no transfer to the same tool use id of the next turn because it is destroyed without read.

`TodoWrite` remains in the public tool union of the SDK and `CLAUDE_CODE_ENABLE_TASKS=0`
It is measured with compatibility path. the whole-list replacement
so wrapper does not interfere with permanent directory read or tool re t join
invalid input does not warn and sendlele list as current.
Therefore, the Claude assumes that the source event itself is the whole list of F1
The wrapper adds the source-file enumeration and schema validation. wire
The whole-list LWW does not include the item difference to the server/dashboard.

This directory is not a public SDK contract. directory missing
read/JSON/schema will warn and fail-visible without sendinglele list.
empty list only has 0 JSON task file in session session directory
Contact Us The future unknown `Task*` warn once per name. background task `TaskOutput` /
`TaskStop`, `TaskGet` of tasklist read-only and `Task` are not known
tool the si , once warn and sort the following tool rename
not to miss.

compact does not change the session id, but the session id changes with fork/rebind
If you have a known tasklist, read the new session directory immediately. Contact Us
If not re-Deliverybuted, otherwise replace it with empty list. If you do not read source,
session the list of session to empty list and leave warning.
not left in the display. Init resume restores effective settings
not a tasklist restore contract, so after resume the task tool use
Tasklist is not redisplayed.

### Neutral

- tasklist Entity life and cleaning follow the same detachment as other
  (ADR-0048 F1).

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
|todo task entity per item|wrapper requires an item value calculation and is aJapanese termmetrical to Codex(completed only). Not suitable for source events|
|New envel  type|type enum increases and reverses ADR-0047's single type policy|
|subagent todo|Heavy child transcript reading (as ADR-0019)|

## Related

-Reservation: [protocol](../specs/protocol.md)
  [subagent-tasks](../specs/subagent-tasks.md),
[codex-sdk-events](../specs/codex-sdk-events.md)
-sk ADR: [0047](0047-task-envelope-schema.md) (task envel  schema,
`task_type` extension.
- Origin: kaoiro issue #178
UI decisions are recorded on the issue side.
