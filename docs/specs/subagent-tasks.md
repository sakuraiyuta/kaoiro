---
title: Client notifications for subagent/workflow tasks
description: Specification for notifying clients through a dedicated envelope about the existence, concurrency, type/name, and state of subagents/workflows launched by a wrapped agent.
status: accepted
related: [protocol, agent-sdk-events]
---
<!-- markdownlint-disable MD033 -->

# Client notifications for subagent/workflow tasks

## Purpose

The wrapper detects SDK messages about activities of subagents and local
workflows launched by the wrapped Claude Code through its Task tool—whether they
launched, their concurrency, running type/name, and state—and notifies clients.
The source of truth for the decision is
[ADR-0019](../adr/0019-subagent-workflow-entity-and-task-envelope.md).

## Definition

### Source data (SDK messages)

They appear in the parent session's `query()` message stream. For details, see
[agent-sdk-events](agent-sdk-events.md).

| Message | type/subtype | Main fields |
|---|---|---|
| Start | system / task_started | `task_id`, `description`, `subagent_type`, `task_type`, `workflow_name`, `tool_use_id`, `skip_transcript` |
| Progress | system / task_progress | `subagent_type`, `usage{total_tokens,tool_uses,duration_ms}`, `last_tool_name`, `summary` |
| End | system / task_notification | `status` (completed/failed/stopped), `summary`, `usage` |

`sdkMessageToTask` in `wrapper/claude-code/src/adapter.ts` derives these into a
`task` envelope (implemented on 2026-08-09 in issue #170). For the handling of
undocumented fields found by measurement (`task_started.prompt` /
`task_notification.output_file`) and the fourth subtype `task_updated`, see the
addenda to [agent-sdk-events](agent-sdk-events.md),
[ADR-0047](../adr/0047-task-envelope-schema.md), and
[ADR-0019](../adr/0019-subagent-workflow-entity-and-task-envelope.md): all are
intentionally unwired and out of scope. For terminal fallback and `raw_status`
when `task_notification.status` carries a value other than the three known
ones, also see the addendum to
[ADR-0047](../adr/0047-task-envelope-schema.md).

### Entity model

Subagents/workflows are **child entities**: visually, they are independent
entities; their identity and transport remain bound to their parent agent
(ADR-0019 F1). Each task links through a parent `agent_id`, and its lifecycle is
bound to the parent session. The client decides visual representation.

### Dedicated envelope type `task`

Task lifecycle flows through the **dedicated envelope type** `task` (ADR-0019
F2). The parent's `state_change` remains its own unchanged `KaoiroState`. The
schema is settled in [ADR-0047](../adr/0047-task-envelope-schema.md):

- One type, `task`, plus `payload.kind` (`started` / `updated` / `completed`).
- Required: parent `agent_id` / `task_id` / `task_type` / `status`.
- Optional progress metadata: `subagent_type` / `workflow_name` / `description` /
  `usage` / `last_tool_name` / `summary` / `skip_transcript`.
- `task_type` is an extensible enum. Measured SDK values are `local_agent` /
  `local_workflow` / `local_bash` (they differ from ADR-0047 F4's illustrative
  `subagent`/`workflow`, but raw SDK values pass through without a renaming layer;
  see that ADR's addendum). Future additions such as task lists are possible.
  Receivers fall back to a generic display for unknown values.

[protocol](protocol.md) includes it as a settled extension (with the same
`version`). The wrapper throttles `kind=updated` by interval plus change
threshold (`started` / `completed` are immediate,
[ADR-0048](../adr/0048-task-aggregation-delivery.md) F2). The implementation
uses three seconds plus either a token delta of at least 500 or a tool-name
change (`MIN_TASK_UPDATE_INTERVAL_MS` /
`TASK_UPDATE_TOKEN_DELTA_THRESHOLD` in `wrapper/claude-code/src/host.ts`). The
**first** `updated` for a `task_id` (with no preceding throttling record) is
always emitted immediately regardless of both interval and threshold (the
cold-start branch of `#shouldEmitTaskUpdate`), so the operator does not wait the
first three seconds for progress immediately after launch.

### Recipient: operator only

Live delivery of the `task` envelope and the `tasks` key in snapshots (stage 2)
are **operator-only** and are not delivered to viewers
([ADR-0048](../adr/0048-task-aggregation-delivery.md) addendum,
[ADR-0021](../adr/0021-role-information-disclosure-policy.md)).

### Concurrency and lifecycle

- Concurrency = `task_started` (+1) / `task_notification` (-1): a flat count of
  top-level tasks only (no nesting is followed).
- The notified states are the **coarse lifecycle** running / completed / failed /
  stopped plus progress metadata (ADR-0019 F3). Fine-grained subagent states
  (eight states) are out of scope.
- `skip_transcript` (ambient/housekeeping) is notified, but distinguishable by
  its flag.

### Implementation stages (local to this feature)

These are separate from the global `plans/` roadmap phase numbers (numbering:
[phase-32](../plans/phase-32-subagent-workflow-visibility.md)).

| Stage | Scope | Status | in / out |
|---|---|---|---|
| Stage 1: wrapper + protocol | Minimal detection/delivery slice | Implemented | in: adapter interprets task_* / emits dedicated envelope / computes concurrency / parent state_change remains unchanged / unit tests (vitest) for adapter transformation / protocol and agent-sdk-events extensions. out: server aggregation and client display |
| Stage 2: server aggregation and relay | Retention and delivery of child tasks | Implemented | in: aggregation through a flat task table plus parent `agent_id` reference ([ADR-0048](../adr/0048-task-aggregation-delivery.md) F1) / retain active set (discard when the parent leaves) / relay to client / one-time delivery at connection through the existing snapshot frame for later connections (same F3) / operator-only delivery (same addendum). out: client visual representation |
| Stage 3: client reception + overhead-ring UI (AgentCard) | Visualizes active subagents on AgentCard | Implemented | in: receives the `task` envelope; passes active task count from `AgentGridShell` to `AgentCard` (a dedicated accumulator in `App.svelte`, not folded into the `agents` map) / an overhead ring surrounding `.sprite` in `AgentCard.svelte` (CSS-only orbiting-light animation, no image asset; existing global rules automatically cover `prefers-reduced-motion`) / on-off only, with no numeric display. out: numeric display (active task count) and additional `AgentDetail` display (initially considered out of scope for issue #170, then added in stage 4 because that judgment had not been approved by the master) |
| Stage 4: overhead-ring UI (add AgentDetail) | Visualizes active subagents in AgentDetail too (issue #170 follow-up, 2026-08-10—the master had requested consideration in issue #170 on 2026-08-04, but it was not included during stage-3 implementation; this was found through the master's feedback and added) | Implemented | in: shared `TaskRing.svelte` for `AgentCard`/`AgentDetail` (centralizes overhead-ring markup + CSS + `@keyframes` to avoid duplicated `@keyframes`) / place the ring in `.portrait` of `AgentDetail.svelte` (outside `{#key}`, on-off only as in AgentCard) / because `.portrait` has variable width (the flex ratio of `.status` on desktop, `max-width: 8rem` on tablet and below), add `container-type: inline-size` and specify orbital radius in `cqw`: sprite values preserve the orbit ratio to the displayed element (same ratio as AgentCard's 2rem/8rem etc.); face values preserve the ratio to the face itself (AgentCard is an independent 5.4rem element, AgentDetail is 70% of `.portrait` width), so use cqw-converted values (fuji round1 N1). However, desktop's variable `.status` width can make `.portrait` greatly exceed 8rem; a live-master check (2026-08-10) found that cqw alone enlarged the orbit and made it overflow. Cap it with `min(cqw value, AgentCard absolute value)`, so desktop widths above 8rem stop at the same absolute size as AgentCard. After capping, real measurement still found overflow because `.portrait` padding (0.8rem) is narrower than AgentCard `.card` (1.4rem); add the `topOffset` prop (default `-2%`) to `TaskRing.svelte`, and shift the overhead-clearance anchor toward the face with `topOffset="6%"` from AgentDetail. Verify with Playwright T11 (1600px wide desktop + 844px BottomSheet, both sprite/face branches, freeze animation at its farthest point and fix non-overlap with `.bar`; it was also confirmed to fail with the prior value. The narrow-width case was additionally tested after Kuroe round2 noted that “safe when wider, therefore proportionally safe” must not be concluded without measuring; in measurement `.bar` and `.portrait` (BottomSheet) are spatially separate and never coexist) / wire from `App.svelte` through the pure `activeTaskCountForDetail()` function in `protocol.ts`, forcibly using 0 for disconnected/directory-only tiles (a pass-through wire would let stale `tasks` entries for disconnected agents leak). out: numeric display (active-task count; unchanged from stage 3) |
| Stage 5: overhead-ring dot count (issue #233; validated design is comment 5450038052) | Visualizes the number of active root tasks as the number of overhead-ring dots (from one on/off dot to N dots) | Implemented | in: add `count` prop to `TaskRing.svelte`; place one dot per root task at equal angles (not equal arc lengths) on the same ellipse; offset phases with `animation-delay` to orbit evenly (`animation-delay` must follow the `animation` shorthand because the shorthand resets it) / each dot's base rule uses its true elliptical coordinate (`--dot-x`/`--dot-y`) as rest state, so phases remain distinct after reduced motion completes / only the first dot has `role="img"` plus an `aria-label` containing the count; remaining dots are `aria-hidden` (prevents repeated announcement of decorative siblings) / wire `count={activeTaskCount}` to both `AgentCard`/`AgentDetail` callers / no UI cap (full rendering is measured in Playwright even for 50/500 dots). Children internal to a workflow do not become separate dots (see “Detecting child agents inside workflows” below; wrapper/server/wire-protocol extension is out of scope). out: change to wrapper/server task aggregation (`activeTaskCountByAgent` remains the source of truth) |

### Detecting child agents inside workflows (verified in issue #233)

Issue #170 left this unverified: whether a child agent spawned internally by a
workflow appears as a **separate `task_started`** in the same session. Issue
#233 (the overhead-ring dot-count implementation; validated design in issue #233
comment 5450038052) verified this against a real stream.

**Verification environment**: Claude Agent SDK 0.3.228; a local workflow whose
`parallel()` step launches two internal `agent()` calls.

**Observed raw SDK messages**:

- Exactly one `system/task_started` for the root task (`task_type=local_workflow`,
  with a workflow name).
- The two internal agents appear only under the root's
  `task_progress.workflow_progress` (distinct agent IDs, with start/done state).
- No child `task_started` / `task_notification` is emitted.
- The root completes through `task_updated` / `task_notification`.

**Conclusion**: the wrapper already maps every independent `task_started`
(without filtering by parent or type), so if children are delivered as their own
stable task events in the future, the existing path will pick them up with no
additional implementation. At present, `workflow_progress` is not among the
fields declared by SDK 0.3.228's `SDKTaskProgressMessage` type (`task_id` /
`tool_use_id` / `description` / `subagent_type` / `usage` /
`last_tool_name` / `summary` / `uuid` / `session_id`). Wiring this runtime-only
field would bind kaoiro's lifecycle contract—including start/end/retry and
version-difference semantics—to an undocumented SDK shape. This is intentionally
out of scope.

**Policy (the root=1 compromise)**: children inside workflows are not
“unobservable”; they are observable in an undocumented progress field but are
intentionally excluded from kaoiro's stable task-event source of truth. The
overhead ring (TaskRing) has one dot per root task and does not distinguish the
number of internal child agents (whether a 16-way fan-out or one subagent). This
is a known semantic compromise, not a claim that children are completely
unobservable. Rerun this probe when the SDK is upgraded. Once stable child
`task_started` events are emitted, the existing path will pick them up and this
policy can be reconsidered.

## Constraints

- **MUST**: Do not affect the parent agent's `state_change` (`KaoiroState`).
- **MUST**: The dedicated envelope type is a reserved extension; leave the
  protocol `version` unchanged
  ([ADR-0010](../adr/0010-protocol-precisification.md) /
  [ADR-0015](../adr/0015-protocol-version-stamping.md)).
- **SHOULD**: Make `skip_transcript` tasks distinguishable by their flag.

## See Also

- Related specs: [protocol](protocol.md), [agent-sdk-events](agent-sdk-events.md)
- ADR: [0019](../adr/0019-subagent-workflow-entity-and-task-envelope.md)
  (entity model and transport),
  [0047](../adr/0047-task-envelope-schema.md) (envelope schema),
  [0048](../adr/0048-task-aggregation-delivery.md) (server aggregation and delivery)
