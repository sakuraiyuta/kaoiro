---
title: Phase 29 — Footer externalization and persona cache relocation
description: Implement externalization of the footer file and separation of the persona extraction cache.
status: done
phase: 29
depends_on: []
last_updated: 2026-08-03
---

# Phase 29 — Footer externalization and persona cache relocation

## Goal

Implement footer externalization from [ADR-0045](../adr/0045-footer-file-externalization.md),
and complete the `:ro` persona-cache support specified by
[ADR-0046](../adr/0046-persona-cache-relocation.md) and kaoiro issue #173.

## Tasks

| # | Task | Owner | Status | Notes |
|---|------|-------|--------|-------|
| 29-1 | Implement footer mechanism | あお | ✅ completed | ADR-0045 |
| 29-2 | Relocate cache | あお | ✅ completed | ADR-0046 / #173 |
| 29-3 | Documentation consistency sweep | もも | ✅ completed | Waves 1 and 2 |
| 29-4 | Review | ふじ | ✅ completed | 3 rounds (3 must-fixes total) → approve |

Status legend: ✅ done, 🟡 in progress, ⚠ partial, ⏳ not started, ⛔ blocked.

## Acceptance Criteria

- [x] `mix test` is green (749 passed)
- [x] Cold start succeeds with a `:ro` persona directory (chmod 0500 test)
- [x] Editing the footer file takes effect on the next connection without a restart (inotify live verification)

## See Also

- ADRs: [0045](../adr/0045-footer-file-externalization.md),
  [0046](../adr/0046-persona-cache-relocation.md)
- Specs: [persona-pack-schema](../specs/persona-pack-schema.md),
  [deployment](../specs/deployment.md)
