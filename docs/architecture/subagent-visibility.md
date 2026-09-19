---
title: Subagent visibility
description: Why subagent/workflow activity is surfaced to clients as child entities through a dedicated envelope, and the overhead-ring UI's implementation history.
status: accepted
last_updated: 2026-09-19
related: [protocol, architecture]
---

# Subagent visibility

## Purpose

The wrapper detects SDK messages about activities of subagents and local
workflows launched by the wrapped Claude Code through its Task tool—whether they
launched, their concurrency, running type/name, and state—and notifies clients.
The source of truth for the decision is
[ADR-0019](../adr/0019-subagent-workflow-entity-and-task-envelope.md).

### Entity model

Subagents/workflows are **child entities**: visually, they are independent
entities; their identity and transport remain bound to their parent agent
(ADR-0019 F1). Each task links through a parent `agent_id`, and its lifecycle is
bound to the parent session. The client decides visual representation.

### Implementation stages (local to this feature)

These are separate from the global `plans/` roadmap phase numbers (numbering:
[phase-32](../plans/phase-32-subagent-workflow-visibility.md)).

| Stage | Scope | Status | in / out |
|---|---|---|---|
| Stage 1: wrapper + protocol | Minimal detection/delivery slice | Implemented | in: adapter interprets task_* / emits dedicated envelope / computes concurrency / parent state_change remains unchanged / unit tests (vitest) for adapter transformation / protocol and claude-events extensions. out: server aggregation and client display |
| Stage 2: server aggregation and relay | Retention and delivery of child tasks | Implemented | in: aggregation through a flat task table plus parent `agent_id` reference ([ADR-0048](../adr/0048-task-aggregation-delivery.md) F1) / retain active set (discard when the parent leaves) / relay to client / one-time delivery at connection through the existing snapshot frame for later connections (same F3) / operator-only delivery (same addendum). out: client visual representation |
| Stage 3: client reception + overhead-ring UI (AgentCard) | Visualizes active subagents on AgentCard | Implemented | in: receives the `task` envelope; passes active task count from `AgentGridShell` to `AgentCard` (a dedicated accumulator in `App.svelte`, not folded into the `agents` map) / an overhead ring surrounding `.sprite` in `AgentCard.svelte` (CSS-only orbiting-light animation, no image asset; existing global rules automatically cover `prefers-reduced-motion`) / on-off only, with no numeric display. out: numeric display (active task count) and additional `AgentDetail` display (initially considered out of scope for issue #170, then added in stage 4 because that judgment had not been approved by the master) |
| Stage 4: overhead-ring UI (add AgentDetail) | Visualizes active subagents in AgentDetail too (issue #170 follow-up, 2026-08-10—the master had requested consideration in issue #170 on 2026-08-04, but it was not included during stage-3 implementation; this was found through the master's feedback and added) | Implemented | in: shared `TaskRing.svelte` for `AgentCard`/`AgentDetail` (centralizes overhead-ring markup + CSS + `@keyframes` to avoid duplicated `@keyframes`) / place the ring in `.portrait` of `AgentDetail.svelte` (outside `{#key}`, on-off only as in AgentCard) / because `.portrait` has variable width (the flex ratio of `.status` on desktop, `max-width: 8rem` on tablet and below), add `container-type: inline-size` and specify orbital radius in `cqw`: sprite values preserve the orbit ratio to the displayed element (same ratio as AgentCard's 2rem/8rem etc.); face values preserve the ratio to the face itself (AgentCard is an independent 5.4rem element, AgentDetail is 70% of `.portrait` width), so use cqw-converted values (fuji round1 N1). However, desktop's variable `.status` width can make `.portrait` greatly exceed 8rem; a live-master check (2026-08-10) found that cqw alone enlarged the orbit and made it overflow. Cap it with `min(cqw value, AgentCard absolute value)`, so desktop widths above 8rem stop at the same absolute size as AgentCard. After capping, real measurement still found overflow because `.portrait` padding (0.8rem) is narrower than AgentCard `.card` (1.4rem); add the `topOffset` prop (default `-2%`) to `TaskRing.svelte`, and shift the overhead-clearance anchor toward the face with `topOffset="6%"` from AgentDetail. Verify with Playwright T11 (1600px wide desktop + 844px BottomSheet, both sprite/face branches, freeze animation at its farthest point and fix non-overlap with `.bar`; it was also confirmed to fail with the prior value. The narrow-width case was additionally tested after Kuroe round2 noted that “safe when wider, therefore proportionally safe” must not be concluded without measuring; in measurement `.bar` and `.portrait` (BottomSheet) are spatially separate and never coexist) / wire from `App.svelte` through the pure `activeTaskCountForDetail()` function in `protocol.ts`, forcibly using 0 for disconnected/directory-only tiles (a pass-through wire would let stale `tasks` entries for disconnected agents leak). out: numeric display (active-task count; unchanged from stage 3) |
| Stage 5: overhead-ring dot count (issue #233; validated design is comment 5450038052) | Visualizes the number of active root tasks as the number of overhead-ring dots (from one on/off dot to N dots) | Implemented | in: add `count` prop to `TaskRing.svelte`; place one dot per root task at equal angles (not equal arc lengths) on the same ellipse; offset phases with `animation-delay` to orbit evenly (`animation-delay` must follow the `animation` shorthand because the shorthand resets it) / each dot's base rule uses its true elliptical coordinate (`--dot-x`/`--dot-y`) as rest state, so phases remain distinct after reduced motion completes / only the first dot has `role="img"` plus an `aria-label` containing the count; remaining dots are `aria-hidden` (prevents repeated announcement of decorative siblings) / wire `count={activeTaskCount}` to both `AgentCard`/`AgentDetail` callers / no UI cap (full rendering is measured in Playwright even for 50/500 dots). Children internal to a workflow do not become separate dots (see “Detecting child agents inside workflows” below; wrapper/server/wire-protocol extension is out of scope). out: change to wrapper/server task aggregation (`activeTaskCountByAgent` remains the source of truth) |

### Detecting child agents inside workflows (verified in issue #233)

Measurement: [Subagent workflow detection evidence](../evidence/claude/subagent-workflow-detection.md).

**Policy (the root=1 compromise)**: children inside workflows are not
“unobservable”; they are observable in an undocumented progress field but are
intentionally excluded from kaoiro's stable task-event source of truth. The
overhead ring (TaskRing) has one dot per root task and does not distinguish the
number of internal child agents (whether a 16-way fan-out or one subagent). This
is a known semantic compromise, not a claim that children are completely
unobservable. Rerun this probe when the SDK is upgraded. Once stable child
`task_started` events are emitted, the existing path will pick them up and this
policy can be reconsidered.

## See Also

- [Task and tasklist envelopes](../reference/protocol/tasks.md).
- [Subagent workflow detection evidence](../evidence/claude/subagent-workflow-detection.md).
- ADR: [0019](../adr/0019-subagent-workflow-entity-and-task-envelope.md) (entity model and transport).
