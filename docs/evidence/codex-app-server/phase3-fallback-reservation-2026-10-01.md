---
title: Codex phase 3 fallback reservation verification
status: recorded
last_updated: 2026-10-01
---

# Phase 3 fallback reservation verification

The implementation under review is commits `faa0ca48caeae88f38de069985b81d8ec9688e22`,
`922fad6e82d0d55331d569af3c966c178c2a4684`, and
`26336da0c1406e1c56b7cb3e8f20b37e374e8427`, based on `842ec5a8`.
All commands below used `env -u CODEX_HOME`. The scripted
app-server tests did not use an authenticated live turn or the production
Codex home. The final native gate remains due on the landing pin after issue
#468.

The coordinator now owns each admitted steer reservation and its passive host
slot. A precondition rejection or exceptional unwritten attempt resolves that
slot into a single ordinary-format root at the original arrival position.
Terminal, contradictory, closed, and failed-replacement outcomes remove the
slot. A failed replacement retires the unstarted delivery for skip-v1 sender
recovery and emits a diagnostic. Pending fallback roots are neither inline
recovery candidates nor unread advisory items. Operator placeholders retain
their separate host mechanism.

## Non-live gates

| Gate | Tests or result | Exit |
| --- | ---: | ---: |
| Codex full suite, final test commit | 1,246 passed in 81 files | 0 |
| Agent common full suite | 505 passed in 20 files | 0 |
| Wrapper core full suite | 306 passed in 6 files | 0 |
| Claude Code full suite | 761 passed in 32 files | 0 |
| Antigravity full suite | 406 passed, 2 skipped in 28 files | 0 |
| Runner full suite | 787 passed in 35 files | 0 |
| Dashboard full suite | 1,077 passed in 76 files | 0 |
| Server full suite, serial rerun | 1,771 passed, 1 excluded | 0 |
| Wrapper typecheck | 5 packages completed | 0 |
| Runner typecheck | completed | 0 |
| Protocol typecheck | completed; no protocol test script exists | 0 |
| Dashboard check | 0 errors, 0 warnings | 0 |
| Wrapper build | 5 packages completed | 0 |
| Runner build | completed | 0 |
| Dashboard build | completed; Vite reported its existing chunk-size warning | 0 |
| `git diff --check` | no errors | 0 |

The first server run was exit 2: 1,769 of 1,771 passed and 1 was excluded.
Two unchanged channel tests timed out on a 100 ms receive assertion while
other suites and builds ran concurrently. The exact two tests then passed
alone (2 passed, 239 excluded, exit 0), and the unmodified full suite passed
serially as shown above. The server log also contains expected fixture and
development-auth warnings.

Kohaku's six production-composition cases were copied into the Codex suite
and pass against the real CLI, host, session, and coordinator with a scripted
transport and strict link double. Further tests cover precondition slot
attachment before terminal, an observed item after P, terminal disposal,
watchdog retirement, failed replacement with diagnostic, pending recovery and
unread exclusion, original-arrival insertion, and two steer reservations.
Every settled or fail-stopped integration case checks zero host placeholders
and zero coordinator reservations. A separate test makes each half of that
shared assertion fail on a deliberate orphan.

The pending-write tests use the real CLI, host, session, transport, and RPC,
with a fake child stream that delivers the response but holds the
`stdin.write` callback through terminal settlement. Both P and E schedules
record `writeState() === "writing"` at settlement. P replaces its
arrival-position slot and precedes a same-peer successor; E removes its
reservation without replaying the body and lets a later operator root run.
Both reach zero placeholders and reservations. These observations establish
the wrapper's behavior for this controlled schedule; the child stream does
not measure native pipe timing. Once the ordinary `#write` route begins, the
state changes to `writing` synchronously; it need not reach `written` by
settlement. The earlier two-`written` probe had an immediate callback and
does not establish an eventual-write invariant.

## Negative controls

Each row removed only the named production boundary or assertion, ran its
covering test with `env -u CODEX_HOME`, observed the nonzero invocation and
one failing selected test, then restored the file. All remaining selected
tests were skipped by the `-t` filter.

| Removed boundary | Selected test | Exit | Failed |
| --- | --- | ---: | ---: |
| Precondition slot attachment | attaches a precondition placeholder | 1 | 1 |
| Original-arrival slot insertion | inserts an exceptional fallback slot | 1 | 1 |
| Single fallback priority over successors | full successor batch | 1 | 1 |
| Terminal slot disposal | removes a terminal fallback slot | 1 | 1 |
| Failed-replacement retirement | retires a failed replacement once | 1 | 1 |
| Watchdog reservation disposal | freezes unresolved and queued fallback | 1 | 1 |
| Earlier unresolved reservation fence | holds a later fallback | 1 | 1 |
| Fallback unread exclusion | without offering fallback to recovery | 1 | 1 |
| Transport failure-before-admission guard | RPC is already failed | 1 | 1 |
| Observed-item exclusion from fallback | completed item after precondition | 1 | 1 |
| Shared queued-root admission guard | later operator steer cannot overtake | 1 | 1 |
| Host-placeholder leak assertion | shared quiescence check detects | 1 | 1 |
| Coordinator-reservation leak assertion | shared quiescence check detects | 1 | 1 |
| Failed-replacement diagnostic | retires a rejected fallback | 1 | 1 |

The first temporary mutation script found two identical insertion statements
and declined to mutate either. The second script selected only the IA
placeholder insertion and produced the red result above. This was a verifier
selection issue, not a product failure.

For the pending-write case, replacing the RPC's synchronous `writing`
assignment with `unwritten` made both selected tests fail (2 failed,
12 skipped, exit 1). Disabling the fake stream's callback hold also made
both fail (2 failed, 12 skipped, exit 1), pinning the verifier wiring.
Both mutations were restored before the final 1,246-test run.

Review artifacts under
`tmp/reviews/issue-346/impl-r3-fuji-artifacts/` include the logs and
mutation scripts. The final Codex log is SHA-256
`1d4d8bbe9ea94e5b4ac7975a37c46656dd95edb5019c01c3d50996ef0633e9cf`;
the green server rerun is
`a2eaac731e08c3724789383844e28f26eac6bcb4196c5c22de0b277f471b30f1`.
The final mutation logs are
`985b06230746af9dee3842ebe42fe760a9c22dd8d55a9b9abb8a886a9f862b48`
and
`c530f62c5456e8ac3293c74179d1951a133cb357f277330f26f8641c63e98345`;
the diagnostic mutation log is
`841428681546c50de98136479a0f486b5bc2c402e420398aaf8365f75d16c95c`.
The RPC-state and fake-stream-wiring mutation logs are
`94e87df6ea383dd60f95ef0ba58676963f276d30e1f9b6a8b868df2b86040994`
and
`7aadcd0513c7543b86bc71c39dad85bbe21877fde7c39cf96793152529e88385`.
