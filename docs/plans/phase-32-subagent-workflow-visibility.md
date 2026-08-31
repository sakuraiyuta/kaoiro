---
title: Phase 32 — Visibility into internal subagent/workflow activity
description: Detect the existence and state of subagents/workflows started by Task tools in the wrapper, aggregate them through the server, and visualize them as a ring above the dashboard's agent.
status: in_progress
phase: 32
depends_on: []
last_updated: 2026-08-10
---

# Phase 32 — Visibility into internal subagent/workflow activity

## Goal

Implement [issue #170](https://github.com/sakuraiyuta/kaoiro/issues/170).
The wrapper detects subagent / local-workflow activity started by an agent's
Task tool from SDK messages, then sends it through server aggregation and
operator-only delivery using the dedicated `task` envelope. The dashboard
visualizes it as a “ring above the agent” (a CSS-only orbiting light-point
animation) on `AgentCard`/`AgentDetail` (32-5). The decision sources of truth
are [ADR-0019](../adr/0019-subagent-workflow-entity-and-task-envelope.md)
(entity model / transport), [ADR-0047](../adr/0047-task-envelope-schema.md)
(envelope schema), and [ADR-0048](../adr/0048-task-aggregation-delivery.md)
(server aggregation / delivery, operator-only). The feature specification is
[subagent-tasks](../specs/subagent-tasks.md).

## Tasks

| # | Task | Owner | Status | Notes |
|---|------|-------|--------|-------|
| 32-1 | wrapper: interpret `task_started`/`task_progress`/`task_notification` + emit `task` envelopes | あお | ✅ | `wrapper/claude-code/src/adapter.ts` provides pure function `sdkMessageToTask`, and `wrapper/agent-common` provides `makeTask`. `kind=updated` is throttled in host.ts by 3 seconds + either a 500-token delta or a tool-name change. An unknown subtype (`task_updated`) only emits a fail-visible warning and never affects the concurrent-task count (ADR-0019 addendum, unchanged). Unknown `task_notification` statuses were changed to terminal fallback in the M2 fix round (2026-08-09, ふじ round 1): values other than the known 3 (completed/failed/stopped) are treated as status="failed"; the raw value is retained only as raw_status for logging and is not sent on the wire. This path counts as completed (-1), so the original “never affect the count” rule does not apply to unknown task_notification statuses |
| 32-2 | server: `TaskStates` GenServer (flat task table) + wrapper_channel/agents_channel wiring | あお | ✅ | New `server/lib/kaoiro_server/task_states.ex`. `WrapperChannel.terminate/2` calls `TaskStates.discard_for_agent/1` only when the owner check of `AgentStates.disconnect/3` succeeds (ADR-0048 F1). Add a `tasks` key to the `AgentsChannel` snapshot push; it is non-empty only for operators (viewers use the existing fail-closed catch-all, which drops even `type: "task"` itself, ADR-0021) |
| 32-3 | dashboard: receive `task` envelopes + ring above `AgentCard` | あお | ✅ | `protocol.ts` adds `TaskPayload`/`taskOf`/`parseTasks`/`applyTaskEnvelope`. `App.svelte` retains `tasks` as an accumulator separate from `agents` (ADR-0019 F2: do not overwrite the parent's state_change slot). `AgentCard.svelte` wraps `.sprite`/`.face` in `.sprite-slot` (position: relative) + `.task-ring` (elliptical orbit using 12-step `translate`-based keyframes, no image asset; extract to shared `TaskRing.svelte` in 32-5). `prefers-reduced-motion` is covered by the existing global rules in `app.css` (`animation-duration: 0.01ms !important`, etc.); no per-component override. Use activeTaskCount only for on/off and do not display a number (こはく scope decision) |
| 32-4 | docs: finalize spec/ADR addendum, protocol.md, and this plan | あお | ✅ | Update stages 1–3 of [subagent-tasks](../specs/subagent-tasks.md) to implementation complete; add measured fields (`prompt`/`output_file`/`task_updated`) and the measured record of terminal-notification guarantees to [agent-sdk-events](../specs/agent-sdk-events.md); add addenda to ADR-0019/0047/0048 (task_updated out of scope / measured task_type values and no prompt/output_file wiring / operator-only delivery) |
| 32-5 | follow-up: add the ring above `AgentDetail` (マスター finding, recover the missed scope) | あお | 🔄 | Details are in the “Follow-up” section below. Direction: クロエ; review: ふじ; implementation: あお. Under review |

**Why status is not raised to `done`:** implementation and unit tests for 32-1–32-4
are complete, but for issue #170 as a whole the completion report to こはく,
external review (ふじ = wrapper/server; whether クロエ needs UI review is a
decision for こはく), commit approval, and push are still pending.

## Design decisions confirmed by measurement (recorded with the ADR; read it)

During stage-1 implementation, 3 points were measured against the real SDK
(`@anthropic-ai/claude-agent-sdk@0.3.220`). The addenda to the respective ADRs
are the source of truth for details and evidence; this section is only a summary
and does not duplicate their content:

1. `task_started.prompt` / `task_notification.output_file` exist as undocumented
   fields, but are not wired into the `task` envelope
   ([ADR-0047](../adr/0047-task-envelope-schema.md) addendum).
2. Measured `task_type` values are `local_agent`/`local_workflow`/`local_bash`
   (different from the example in ADR-0047 F4). Do not rename them; pass SDK raw
   values through unchanged (same addendum).
3. The fourth undocumented subtype, `task_updated`, is outside v1
   ([ADR-0019](../adr/0019-subagent-workflow-entity-and-task-envelope.md)
   addendum). `task_notification` was measured to be emitted at termination on
   all 4 paths: natural completion, `stopTask()`, interrupt, and
   `backgroundTasks()` (SDK 0.3.220, 2026-08-09 capture,
   [agent-sdk-events](../specs/agent-sdk-events.md)).

## Non-Goals (outside #170 scope, こはく decision)

- Equivalent support in the Codex engine: only measure that the type definition
  for `@openai/codex-sdk@0.144.1` has no subagent/task-lifecycle equivalent
  events; do not implement it.
- Numeric display of the active-task count: leave it for a future proposal.
- Additional display on `AgentDetail`: it was initially excluded from scope in
  the 32-3 implementation, but that decision was found not to have マスター
  approval and was added in 32-5 (the Follow-up below).
- Verification of whether child agents spawned by a workflow appear as separate
  `task_started` events (the “needs verification” section of
  [subagent-tasks](../specs/subagent-tasks.md)) remains unstarted.

## Follow-up: add the ring above `AgentDetail` (2026-08-10)

32-3 implemented the ring on `AgentCard` (grid display), but not on
`AgentDetail` (the detailed persona-image panel), and the Non-Goals section had
called it “a separate future proposal.” That exclusion did not have マスター
approval: in the [2026-08-04 issue comment](https://github.com/sakuraiyuta/kaoiro/issues/170#issuecomment-5384483995),
マスター itself listed “whether to show it on AgentDetail too” as a priority
to consider. It was not included in the 2 open questions promoted to ADRs that
day (ADR-0047/0048), nor in the 2026-08-09 implementation (32-1–32-4), and was
instead moved to Non-Goals. On 2026-08-10, マスター noticed the omission in
live verification and said “I do not remember specifying that”; tracing the
issue comment history identified this as a missed scope item, so it was added
(scope recovery, not a specification change).

Structure: direction クロエ (direction / minor decisions), review ふじ,
implementation あお.

Implementation: create `TaskRing.svelte` and share it between `AgentCard` and
`AgentDetail` (avoid duplicating CSS `@keyframes`, クロエ 2026-08-10). In
`AgentDetail`, specify the orbital radius with `cqw` (container query width) so
it follows the variable width of `.portrait`, and add
`container-type: inline-size` to `.portrait`. Wire `activeTaskCount` from
`App.svelte` through the new pure function
`activeTaskCountForDetail()` in `protocol.ts`; force it to 0 on disconnected /
directory-only tiles (クロエ 2026-08-10: transparent wiring would leak stale
`tasks` entries from disconnected agents).

**Additional fix (マスター live verification, 2026-08-10):** On desktop, `.status`
can vary in width (`flex: 0 0 20%`), making the measured `.portrait` width much
larger than 8rem. With only `cqw`, the orbit grew beyond the AgentCard's assumed
size and reached the “return to grid” button. Cap it with
`min(cqw値, AgentCard絶対値)`: a narrow `.portrait` at or below
8rem continues to scale proportionally with cqw, while desktop above 8rem caps
at the same absolute sizes as AgentCard (sprite: 2rem/0.72rem, face:
1.35rem/0.49rem).

A slight overflow remained after the cap (the `.portrait` padding of 0.8rem is
not as wide as the AgentCard `.card`'s approximately 1.4rem). Add a new
`topOffset` prop to `TaskRing.svelte` (default is AgentCard's existing `-2%`),
and pass `topOffset="6%"` from AgentDetail to shift the above-head anchor downward
toward the face. This resolves it; the slight overlap with the face was approved
by マスター. Add Playwright e2e T11 (1600px wide desktop, both sprite/face
branches), freeze the CSS animation at the farthest point (0%/100% keyframes)
with the Web Animations API, and pin that the ring does not overlap `.bar` (the
return button), including the 6px box-shadow blur. Confirmed that reverting the
fix actually fails.

**Narrow-side verification (クロエ round-2 finding, 2026-08-10):** The absolute
contribution of `topOffset` (6% × portrait height) grows with portrait size,
whereas `orbitRy` is capped at a constant (0.72rem), so BottomSheet mode, where
`.portrait` has `max-width: 8rem`, could theoretically be the worst case. Do not
conclude “safe at the wide side means proportionally safe” without measuring
(クロエ identified the unmeasured cqw cap as the cause of this bug). Add the same
geometry check to T11 at 844px sheet-open. Measurement confirmed that `.bar` is
fixed at the top of the page, `.portrait` overlays the bottom as a BottomSheet,
and there is over 300px of margin; the 8rem cap and adjacency to `.bar` cannot
occur in the same layout. The 8rem cap is enabled only in BottomSheet mode.

## Related

- Specs: [subagent-tasks](../specs/subagent-tasks.md),
  [protocol](../specs/protocol.md),
  [agent-sdk-events](../specs/agent-sdk-events.md).
- ADRs: [0019](../adr/0019-subagent-workflow-entity-and-task-envelope.md),
  [0047](../adr/0047-task-envelope-schema.md),
  [0048](../adr/0048-task-aggregation-delivery.md),
  [0021](../adr/0021-role-information-disclosure-policy.md)
  (operator-only delivery uses the fail-closed default).
