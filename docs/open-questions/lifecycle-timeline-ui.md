---
title: Dashboard UI for the Transition Timeline
description: How to visualize the session_lifecycle timeline in the dashboard (AgentDetail timeline vs. an integrated #175 view)
status: open
urgency: medium
blocks: []
opened: 2026-08-31
decided: null
---

# Dashboard UI for the Transition Timeline

## 背景

[ADR-0055](../adr/0055-compaction-resume-and-lifecycle-log.md) limits the
first cut to a pull query for operators and separates the UI.
issue #175 (visualization of in-progress compaction for peers / operators) can
be redefined as a consumer of this recording layer.

## 選択肢

- A: Add a timeline display to AgentDetail
- B: Create a dedicated view integrated with issue #175

## 影響

Up through phase-33 Stage C (pull query), only raw query results can be
inspected; there is no UI overview.

## 判断材料

How far the requirements on the issue #175 side (real-time behavior and the
scope of disclosure to peers) and the requirements for a timeline overview
(post-hoc debugging) can be met on the same screen.

## 暫定方針

File as a separate issue and redefine #175 as a consumer of this foundation
(determine the scope when work begins).
