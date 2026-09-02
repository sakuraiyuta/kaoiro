---
title: Phase 6 — Emotion Filter (Flavoring)
description: Add a filter that attaches an emotion property to normalized events and layers emotion onto expressions. Shelved for the time being by the master's decision on 2026-08-02 (priority lowered while untouched).
status: planned
phase: 6
depends_on: [phase-3-server-multiagent]
last_updated: 2026-08-02
---

# Phase 6 — Emotion Filter (Flavoring)

## Goal

Add a filter that attaches an emotion property to common events and layers emotional
nuance onto state-based expressions (the flavoring for Goal B).

## Acceptance Criteria

- [ ] The emotion filter attaches `ext.emotion`
- [ ] The client layers emotion flavoring onto state-based expressions
- [ ] Phase 3 remains usable even if the emotion filter fails

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 6-1 | Emotion-inference filter (local, asynchronous) | ⏳ | Non-blocking |
| 6-2 | Apply flavoring to client expressions | ⏳ | |
| 6-3 | Specify + implement “mood” (persistent layer) | ⏳ | Adoption decided (2026-06-11, issue #5). Mood = a slowly changing, persistent state derived from emotion events. Details of change speed, decay, and expression composition will be decided in the approach discussion when work begins |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## Followups (in-phase but unfinished)

None.

## Open Questions Blocking This Phase

None.

## Progress Log

- 2026-08-02: Shelved for the time being by the master's decision (status: shelved).
  The restart date is undecided; reactivate this plan when work begins.

## See Also

- Specs: [overview](../specs/overview.md),
  [plugin-model](../specs/plugin-model.md)
- Previous: [phase-5-i18n](phase-5-i18n.md)
