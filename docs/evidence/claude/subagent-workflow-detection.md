---
title: Subagent workflow detection evidence
description: Measured Claude Agent SDK stream showing whether a child agent spawned internally by a workflow surfaces as its own task event.
status: recorded
last_updated: 2026-08-30
related: [protocol]
---

# Subagent workflow detection evidence

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

## See Also

- [Subagent visibility](../../architecture/subagent-visibility.md) — the
  root=1 policy this measurement supports.
- [Task and tasklist envelopes](../../reference/protocol/tasks.md).
