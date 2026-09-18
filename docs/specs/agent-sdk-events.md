---
title: Claude Code adapter — Agent SDK event specification
description: Actual message/callback specification of the TypeScript Claude Agent SDK and its verified derivation mapping to kaoiro state.
status: accepted
related: [protocol, plugin-model, architecture, subagent-tasks]
---

# Claude Code adapter — Agent SDK event specification

This page preserves the original anchors; the moved sections are linked below.

## Purpose

Moved to [Claude events](../reference/engines/claude-events.md#purpose).

## Definition

Moved to [Claude events](../reference/engines/claude-events.md#definition).

### Message sequence (query() / Query)

Moved to [Claude events](../reference/engines/claude-events.md#message-sequence-query--query).

### Task (subagent/workflow) messages

Moved to [Claude events](../reference/engines/claude-events.md#task-subagentworkflow-messages).

### Permission callback (canUseTool)

Moved to [Claude events](../reference/engines/claude-events.md#permission-callback-canusetool).

#### Commands for manual verification (canUseTool firing boundary)

Moved to [Claude events](../reference/engines/claude-events.md#commands-for-manual-verification-canusetool-firing-boundary).

### Control (gap 1 settled)

Moved to [Claude events](../reference/engines/claude-events.md#control-gap-1-settled).

#### Notes on switching model / effort (#54 live verification, 2026-06-25, SDK 0.3.187)

Moved to [Claude events](../reference/engines/claude-events.md#notes-on-switching-model--effort-54-live-verification-2026-06-25-sdk-03187).

### Hooks (SDK surface; kaoiro wires only `CwdChanged`)

Moved to [Claude events](../reference/engines/claude-events.md#hooks-sdk-surface-kaoiro-wires-only-cwdchanged).

### State-derivation mapping

Moved to [Claude events](../reference/engines/claude-events.md#state-derivation-mapping).

### session_capabilities and optimistic stamps (2026-07-11, [ADR-0034](../adr/0034-session-capabilities-advertisement.md) F1 / phase-15 15-4b)

Moved to [Claude events](../reference/engines/claude-events.md#session_capabilities-and-optimistic-stamps-2026-07-11-adr-0034-f1--phase-15-15-4b).

## Constraints

Moved to [Claude events](../reference/engines/claude-events.md#constraints).

## Open Questions

Moved to [Claude events](../reference/engines/claude-events.md#open-questions).

## See Also

Moved to [Claude events](../reference/engines/claude-events.md#see-also).
