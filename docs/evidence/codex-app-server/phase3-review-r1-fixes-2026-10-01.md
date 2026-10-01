---
title: Codex inter-agent early delivery phase 3 review round 1 fixes
status: recorded
last_updated: 2026-10-01
---

# Phase 3 implementation review round 1

The reviewed baseline was `9c770fd3`. The fixed source and regression tests
are commit `237ae75067dd0f7ccfac3903aa9343af955fb669` (tree
`64066cbb29a294d34b8c01efa866bd25d6d45a10`). Tests used
`env -u CODEX_HOME` and the existing 0.156.1 pin. No authenticated native
turn or production Codex home was used.

The reviewer's production-path reproductions failed before the fixes:
Codex had 3 failed tests, 31 skipped (exit 1), and the server had 1 failed
test, 36 excluded (exit 2). The fixes now release queued peer roots at either
steer reconciliation order, including after a different peer's root; discard
an inert IA placeholder after a contradictory item; apply the same receive
order to operator and peer steering; and keep a qualified terminal unknown
from being overwritten. The reference now distinguishes the ledger-lifetime
uncertainty summary from generation-scoped loss fields.

## Final non-live checks

| Scope | Result | Exit |
| --- | --- | --- |
| Server full suite | 1,771 passed, 1 excluded | 0 |
| Server fenced-unknown regression after final mutation restore | 1 passed, 36 excluded | 0 |
| Codex full suite | 1,220 passed | 0 |
| Agent common full suite | 505 passed | 0 |
| Wrapper core full suite | 306 passed | 0 |
| Claude Code full suite | 761 passed | 0 |
| Antigravity full suite | 406 passed, 2 skipped | 0 |
| Runner full suite | 787 passed | 0 |
| Dashboard full suite | 1,077 passed | 0 |
| Workspace typecheck | 7 packages completed | 0 |
| Workspace build | 6 build-bearing packages completed | 0 |
| Dashboard check | 0 errors, 0 warnings | 0 |
| Dashboard build | Completed; Vite reported a chunk-size warning | 0 |
| Scoped server format check; `git diff --check` | Passed | 0 |

The suites emitted the same expected fixture, development-auth, and Node
warnings as the baseline record. No unhandled test error remained. The
repository-wide format caveat for unchanged `persona_assets_test.exs` remains
as described in the [baseline evidence](phase3-nonlive-gates-2026-10-01.md).

## Negative controls

Each mutation changed only the named guard, ran the covering test, and was
restored before the final positive run. The M1 mutation was repeated after
the additional different-peer test was added; the S1 mutation was repeated
after server formatting.

| Removed boundary | Red result |
| --- | --- |
| Turn-end release of steered peers | 2 failed, 1 passed, 13 skipped; exit 1. Both no-root and different-peer successors stayed queued. |
| IA-specific placeholder fallback decision | 1 failed, 20 skipped; exit 1. The conflicting item blocked a later root. |
| Shared queued-input admission guard | 1 failed, 20 skipped; exit 1. An operator steer overtook an earlier peer root. |
| Qualified-unknown terminal guard | 1 failed, 36 excluded; exit 2. A later `settled` report was accepted. |

The [phase 3 design](../../plans/adr-0063-phase3-codex-early-delivery.md)
still requires the authenticated native gate on the final Codex pin. Issue
#468 will update the pin before this branch is rebased; the director will
arrange a separate scratch home before the native probe.
