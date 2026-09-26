---
title: Issue 403 — Repoint Gitea-era references in test code
description: Replace stale private Gitea issue numbers in runner, server, and dashboard tests using migration footers and line provenance.
status: approved
issue: 403
base: ba696b503261db5c3af9f4806a5579b9f8f8d995
last_updated: 2026-09-26
---

# Issue 403 — Gitea-era references in test code

## Problem and evidence

Test comments and test names still contain private Gitea issue numbers. Looking
these up on GitHub can lead to an unrelated issue. The task covers
`runner/test`, `server/test`, and `dashboard/test`; `wrapper/*/test` is deferred
until the issue 407 work lands.

The issue body reports an earlier audit of 818 Gitea-era occurrences across
four test roots. That count is not directly comparable to this audit's 915 raw
`#N` tokens across three roots: this audit uses the current base and includes
340 post-import tokens, five non-issue labels, and tests added since the earlier
audit.

This scoped audit at `origin/develop` (`ba696b503261db5c3af9f4806a5579b9f8f8d995`)
used `git blame -w -M -C -C` and the 2026-08-23 import boundary at
2026-08-23 04:54Z. The companion GitHub issue migration began creating native
issues at 2026-08-26 08:27Z. No blamed lines fell between these times.

The scoped audit found 575 pre-import `#N` tokens (98 numbers) and 340
post-import tokens (47 numbers). Each mapped destination is resolved from
the exact `Migrated from private Gitea issue N` footer on the imported GitHub
issue. Among the pre-import tokens, 83 use numbers 1–88 and retain their number;
five of these are non-issue labels. Another 490 have a footer destination; two
are Gitea issue 154, for which no imported-issue footer exists.

## Proposed decisions

| Source and numbers | Decision | Count |
|---|---|---:|
| Pre-import Gitea 1–88 | Keep the same number; this group includes five non-issue labels | 83 |
| Pre-import Gitea numbers with a migration footer | Repoint each occurrence to the footer's GitHub issue number | 490 |
| Pre-import Gitea 154 | Remove the stale issue marker while retaining the descriptive test name; no migration footer exists | 2 |
| Post-import references 89–276 listed below | Repoint only where the test context matches the old Gitea issue; keep the other GitHub references | 9 repointed / 117 kept |
| Other post-import references | Keep; the number is below 89 or refers to a GitHub issue created after migration | 214 |

Post-import contextual decisions (old number → footer destination; one
occurrence each):

| Old number | Decision | Count | Context |
|---:|---|---:|---|
| 120 → 116 | Repoint | 1 | Runtime config path isolation, not the current unread-message issue |
| 131 → 127 | Repoint | 1 | Unreachable-peer notification trigger, not the current deliberate-stop follow-up |
| 170 → 160 | Repoint | 1 | Allow-list role demotion, not the current subagent activity UI |
| 171 → 161 | Repoint | 1 | Store test teardown race, not the current runner version check |
| 180 → 170 | Repoint | 1 | Task-ring single-dot geometry, not the current persona-cache test |
| 187 → 177 | Repoint | 1 | Cross-BEAM test-path isolation, not the current user-identity feature |
| 197 → 187 | Repoint | 1 | User rename wire contract, not the current responsive redesign |
| 200 → 190 | Repoint | 1 | Session-event audit path, not the current compaction resume prompt |
| 221 → 211 | Repoint | 1 | Wall-clock conversation GC path, not the current release-preparation issue |

Post-import references retained in the 89–276 range are 203 (2), 207 (22),
209 (1), 217 (4), 228 (11), 231 (1), 232 (23), 233 (8), 257 (3), 266 (3),
273 (10), and 276 (29). These match the GitHub issue context; the `#217`
references also match the earlier reviewed issue 375 audit. Other post-import
references in this scope are retained.

For Gitea issue 154, the current public GitHub issue list was searched across
all open and closed results (265 issues returned, below the 1,000-result
limit) for the exact migration footer; no match was found. GitHub issue 154 is
unrelated, so only the stale markers are removed.

## Scope

Only issue markers in tracked files under `runner/test`, `server/test`, and
`dashboard/test` will change. Test behavior and production code are out of
scope. Gitea issue 154's two unmigrated markers will be removed from test names
without changing the surrounding behavioral description. References added by
the ongoing issue 407 wrapper-test work are outside this change.

## Verification

- Recompute the before/after counts by scope and by issue number from grep
  output; confirm the total delta matches the reviewed table.
- Verify every replacement destination against the matched migration footer.
- Check the diff to confirm it changes only issue-number tokens or the two
  unmigrated issue labels. Confirm non-issue labels such as `cwd #1`, `cwd #2`,
  `client #1 token`, and the dated master-approval `#1` labels are unchanged,
  and that none were included among the 490 footer-based replacements.
- Run full runner, server, and dashboard test suites. Report exit codes
  separately from pass counts.

## Documentation

No reference documentation is updated; this change only corrects historical
issue citations in tests.
