---
title: Retire the per-agent checklist projection
status: accepted
date: 2026-11-28
supersedes: [49]
superseded_by: null
related_specs: [protocol, subagent-tasks, codex-app-server-events]
---

# ADR-0079 — Retire the per-agent checklist projection

## Status

Accepted for [issue #1284](https://github.com/sakuraiyuta/kaoiro/issues/1284).
Supersedes [ADR-0049](0049-tasklist-on-task-envelope.md).

## Decision

Remove the dashboard's expandable checklist, its completion count and its
item details. The Claude and Codex wrappers stop collecting and sending
these snapshots. Native planning tools and Codex plan mode remain
available. Codex still reports in-turn planner activity to the watchdog
without the item contents. Muse still relays its plan log. Child task
events, operator-only delivery and the dashboard's child ring retain their
existing contracts.

Keep wire version `"0"` under the exception approved for this retirement.
The server validates the reserved legacy pair as before, handles its
session identity and acknowledges it without storing or broadcasting the
checklist. The dashboard ignores the retired pair from an older server.
See the [task envelope contract](../reference/protocol/tasks.md) and the
[version exception](../reference/protocol/versioning.md#retired-checklist-projection).

An old checklist already received at the server may have been the last
frame to carry a new session ID. The server still admits that identity
under the existing rules. A new wrapper sends the ID on its next ordinary
outbound envelope. If it stops before that send, restore may select the
prior session. The general recovery gap is tracked in
[issue #1282](https://github.com/sakuraiyuta/kaoiro/issues/1282).

## Consequences

Server/dashboard and runner/wrapper updates can be staggered. An old tab
still connected to an old server may display its previous checklist until
reload or rejoin. Rolling both sides back restores collection as native
planning events arrive. There is no kaoiro checklist history to recover.
