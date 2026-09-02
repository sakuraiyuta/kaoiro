---
title: Transition observability and resume support for the Codex engine
description: There is no way to observe Codex compaction, so Codex support for session_lifecycle and resume_prompt is deferred.
status: deferred
urgency: low
blocks: []
opened: 2026-08-31
decided: 2026-08-31
---

# Transition observability and resume support for the Codex engine

## 背景

Resume in [ADR-0055](../adr/0055-compaction-resume-and-lifecycle-log.md)
depends on local observation of `compact_boundary`, and `request_compact` is
Claude-only (Codex has no `/compact` path and assumes engine-side
auto-compaction). For now, Codex session_lifecycle records will also contain
only the disconnect-related events known to the server.

## 選択肢

- A: Investigate a Codex SDK method for observing compaction and add a producer
  if it is observable
- B: Retain the engine-side auto-compaction premise and leave it out of scope

## 影響

The Codex agent's timeline contains only disconnect-related events, so behavior
caused by compaction cannot be investigated afterward.

## 判断材料

Whether a confirmed compaction-boundary event appears in the Codex SDK event
specification ([codex-sdk-events](../specs/codex-sdk-events.md)).

## 暫定方針

B (operator ruling 2026-08-31: treat this, including surrounding unimplemented
and unsupported areas, as a future task. Claude-only support is sufficient for a
while).
