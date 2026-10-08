---
title: Identity partitions and retained-steer recovery review delta
status: recorded
last_updated: 2026-10-09
---

# Issue 548 implementation review delta

Source and test commit: `5beef394e326e6ef442c5fdd32a5dcc4ed27da34`,
on `issue-548-early-own-request`, above the reviewed `f6317be8`.
This delta changes tests, documentation and the built-in footer; production
TypeScript and Elixir source are unchanged. No additional model run was used.
The [original native observations](issue-548-early-own-request-2026-10-09.md)
remain bound to their original source and artifact hashes.

## Newly pinned behavior

The earlier identity tests used equal seq values across identities, so the
defensive non-increasing split masked a missing identity partition. The
suite now tests seq 3 and 5 across two generations, independently for
classified and uncertain notices. Each produces two notices containing its
own entry. Both same-identity positive cases produce one notice.

The CLI/Host T4b unspent-ticket case now scripts the server's stale rejection
of basis 5. It asserts retained BODY-6, the new basis-6 authorization, actual
tool-result handoff, and acceptance of the same reply with that ticket, without
another model root. Network rejection and acceptance remain scripted; the
real ConversationStates regression separately establishes the admission rule.
T15d also asserts that the next host-queue head is ROOT-1.

## Positive gates

Commands run inside `setsid` and a non-root user/PID namespace, with inherited
CODEX_HOME unset for wrapper tests. Counts are copied from the final outputs.

| Gate | Output | Exit |
| --- | --- | --- |
| Wrapper typecheck/build | All five packages | 0 / 0 |
| Core full suite | 485 passed | 0 |
| Agent-common full suite | 568 passed | 0 |
| Claude Code full suite | 807 passed, 4 skipped | 0 |
| Codex full suite | 1,384 passed | 0 |
| Antigravity full suite | 493 passed, 3 skipped | 0 |
| Footer assets suite | 15 passed | 0 |
| Changed Markdown, Elixir formatting, whitespace | Clean | 0 |

Wrapper total: **3,737 passed, 7 skipped**, exit 0. Two existing
MaxListenersExceededWarning messages and expected fault-path logs appear;
there is no Vitest unhandled-error section. Footer tests emit the existing
test auth/cache warnings. Full server tests and native scenarios were not
repeated for this test/documentation delta.

## Independent negative controls

Each mutation was applied alone after committing the fix, against the suite's
test rather than a scratch driver, and restored before the next mutation.

| Mutation | Output | Exit |
| --- | --- | --- |
| KA: replace the identity partition key by a constant | 2 failed, 19 passed; both new cross-identity cases fail | 1 |
| Remove CLI retainSteeredBody | 1 failed, 4 passed; inline recovery lacks BODY-6 | 1 |
| Invert retireSteeredBeforeConfirmed comparison | 1 failed, 4 passed; inline recovery lacks BODY-6 | 1 |
| Replace host queue shift with pop | T15d fails: ROOT-2 instead of ROOT-1; 28 skipped | 1 |
| Revert the footer's dispatched-root wording | 1 failed, 14 passed | 2 |

The final full wrapper and footer suites above ran after restoring every
mutation. No process enumeration or host-wide kill was executed.

## Guidance and limits

A corroborated retained steer returns recovery and a fresh authorization
inline; waiting applies only to an empty recovery. The original addendum's
wait wording is superseded by `tmp/reviews/issue-548/design-r3b-fuji.md`.
Recovery sizes the complete JSON result, while steer admission sizes formatted
text. The margin for bodies in the 10 KiB range remains **unmeasured**.

Root progress relies on the host queue's FIFO order and per-token caps. Two
is a tuning value for steer count, not a bound on turn duration; only
host-queue roots contribute to this predicate. Coordinator-held roots are
released at reconciliation.

The [delta evidence index](issue-548-review-delta-2026-10-09.json) binds the
test diff, logs and addendum. The director owns review acceptance, landing and
production canaries; none of those operations were performed here.
