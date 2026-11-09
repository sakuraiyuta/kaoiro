---
title: Phase 5 — Internationalization (Pre-Beta English Translation)
description: An independent milestone to translate all documentation and UI into English for external release.
status: in_progress
phase: 5
depends_on: [phase-4-host-runner]
last_updated: 2026-11-10
---

# Phase 5 — Internationalization (Pre-Beta English Translation)

## Goal

Translate all documentation and UI into English for external release before the
beta release. Decide the primary language from this point onward at this stage.
The decision is [ADR-0006](../adr/0006-doc-language-i18n.md).

## Acceptance Criteria

- [ ] Complete the English version of the documentation (the entire docs/ set)
- [x] Translate UI text into English
- [ ] Decide the primary-language policy from this point onward

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 5-1 | Translate docs/ into English | ⏳ | |
| 5-2 | Internationalize UI text | ✅ | [issue #269](https://github.com/sakuraiyuta/kaoiro/issues/269): the bundled dashboard's own text is in typed `ja` / `en` tables with a language switch. Contract: [Dashboard i18n contract](../reference/ui/i18n.md) |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## Followups (in-phase but unfinished)

None.

## Open Questions Blocking This Phase

None.

## See Also

- ADRs: [0006](../adr/0006-doc-language-i18n.md)
- Previous: [phase-4-host-runner](phase-4-host-runner.md)
