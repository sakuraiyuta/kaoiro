---
title: Whether to Detect Duplicate or Conflicting Work Division
description: Decide whether to prevent conflicts that can occur in autonomous work division, such as multiple agents working on the same file simultaneously, with a detection mechanism or by limiting the approach to observation.
status: open
urgency: low
blocks: []
opened: 2026-07-28
decided: null
---

## 背景

[ADR-0044](../adr/0044-coordination-injection-hitl.md) F2 allows work
division within the scope of responsibility to be established without operator
approval, so multiple agents may conflict by working on the same file and same
task simultaneously. The AI opinion when filing kaoiro issue #87 also promotes
an experimental-economics approach: "observe with a minimal deterministic
guard + free dialogue, and see failure patterns in the data."

## 選択肢

| Option | Description | Advantages | Disadvantages |
|----|------|----------|-----------|
| A | No detection initially (collect failure patterns through dashboard observation, then design) | Avoids over-design and allows necessity to be judged from real data | Rework from duplicate work may occur during initial operation |
| B | Minimal declarative lock (declare the target scope to the server when agreeing on work division, and warn on overlap) | Early warning of conflicts | Declaration granularity is difficult to design and easily becomes nominal |

## 影響

There is no implementation that blocks work (ADR-0044's initial implementation
can start with no detection).

## 判断材料

- Frequency and actual harm of conflicts observed during initial operation
  (dogfooding)
- How far existing measures such as git worktree / branch separation can absorb
  them

## 暫定方針

Option A (observe with no detection initially).

## 解決時のアクション

- [ ] Based on observation results, make the need for a detection mechanism an ADR or close this question
- [ ] Close this open question (delete it)
