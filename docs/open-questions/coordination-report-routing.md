---
title: Destination and format for post-hoc reports in autonomous coordination
description: Decide to whom and in what format to report work division and results established through a director (whether this should remain aligned with the current operation of reporting to the master through the director).
status: open
urgency: medium
blocks: []
opened: 2026-07-28
decided: null
---

## 背景

[ADR-0044](../adr/0044-coordination-injection-hitl.md) F2 decides that, under a
director appointed for each task, work division within the assigned
responsibility does not need operator approval (report afterward), but the
destination and format of that report are undecided. The current operation is
already that “each agent's results are collected by the director (クロエ), who
creates a decision summary for マスター” (マスター instruction, 2026-07-11),
so alignment with it is the issue.

## 選択肢

| Option | Content | Advantages | Disadvantages |
|----|------|----------|-----------|
| A | Report only to the director through inter-agent messaging (the director aggregates it for マスター) | Matches current operation; one reporting path | Consumes more of the director's context; destination is unclear when no director is present |
| B | Director report + dashboard notice (make assignment and completion visible in an envelope) | Operator can understand it without relying on scrollback (#87 observability concern) | Requires a new notification envelope |

## 影響

There is no implementation that this blocks. coordination-footer-scope was
settled independently in #165 as option A (only short action principles; do not
put detailed reporting procedure in the footer), so this question need not wait
for it.

## 判断材料

- A fallback destination when work has no appointed director, or when the
  appointed director is fatigued or leaves (F2 appointments are per-task and
  non-persistent)
- Dashboard display-design cost (and its relationship to aggregated display in
  subagent-tasks)

## 暫定方針

None (undecided).

## 解決時のアクション

- [ ] Finalize the reporting convention (the coordination-guidance footer is
      already settled as option A, so express procedural detail in a reference
      document rather than the footer)
- [ ] If needed, add a notification envelope to the protocol spec
- [ ] Close (delete) this open question
