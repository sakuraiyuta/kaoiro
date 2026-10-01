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

The first server run was reported as exit 2: 1,769 of 1,771 passed and 1 was
excluded. Its full log was not retained, so the two failing test identities
and the suspected 100 ms assertion cannot be independently verified from that
run. A targeted rerun passed (2 passed, 239 excluded, exit 0), and the
unmodified full suite passed serially as shown above. The retained green
server log contains expected fixture and development-auth warnings.

Kohaku's six production-composition cases were copied into the Codex suite
and pass against the real CLI, host, session, and coordinator with a scripted
transport and strict link double. Further tests cover precondition slot
attachment before terminal, an observed item after P, terminal disposal,
watchdog reservation disposal, failed replacement with diagnostic, pending recovery and
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
| Watchdog reservation disposal | freezes steering and queued fallback differently | 1 | 1 |
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

## Review round 4 correction

Code and contract correction: `36e4f08b3a3002ddcf69edf8a6505ef6cd02cb76`.
Additional test correction: `1f3853e14bc7e158df6f5e1a2a846ad0061e8370`.
The scripted CLI, host, session, and coordinator reproduction showed that
watchdog freeze retired three `steering` cases before the fix: accepted A,
written without a response, and a precondition response not yet settled
(3 failed, exit 1). After the fix, all three retain their delivery obligation
without retirement; the exact stage assertions and retirement counts pass.
The coordinator separately retires a definite, unstarted `fallback` once.
The two committed pending-write cases from the previous round assert
`writing` at settlement; no native pipe timing is inferred from the fake
stream. The common integration fixture now checks zero host placeholders and
zero coordinator reservations in `afterEach`, with an explicit verifier
self-test opt-out and a final check that every fixture was covered.

All shell gates used `env -u CODEX_HOME`; the mutation runner removed
`CODEX_HOME` from each spawned Vitest environment. None used a live turn. Logs are under
`tmp/reviews/issue-346/impl-r4-fuji-artifacts/`. Counts and exit codes below
come from those logs at the corrected product code. The server suite ran alone;
the unrelated package suites preceded the additional test-only commit.

| Gate | Result | Exit |
| --- | ---: | ---: |
| Codex full suite, final run | 1,253 passed, 81 files | 0 |
| Agent common full suite | 505 passed, 20 files | 0 |
| Wrapper core full suite, serial rerun | 306 passed, 6 files | 0 |
| Claude Code full suite | 761 passed, 32 files | 0 |
| Antigravity full suite | 406 passed, 2 skipped, 28 files | 0 |
| Runner full suite | 787 passed, 35 files | 0 |
| Dashboard full suite | 1,077 passed, 76 files | 0 |
| Server full suite | 1,771 passed, 1 excluded | 0 |
| Wrapper, runner, protocol typecheck | each completed | 0 each |
| Dashboard check | 0 errors, 0 warnings | 0 |
| Wrapper, runner, dashboard build | each completed | 0 each |
| `git diff --check` | no errors | 0 |

The first wrapper-core run was concurrent with other suites. Its worker hit
the V8 heap limit and exited with one unhandled worker error (266 passed of
306, exit 1). The retained full log is `wrapper-core-test.log`; the serial
rerun passed all 306. The Codex log has expected error-path fixtures and no
Vitest unhandled-error summary. The server log has expected fixture warnings;
the dashboard build has its existing chunk-size warning.

Each mutation changed one boundary, ran the selected test with `CODEX_HOME`
unset, and restored the source before the final suites. The
logs retain the test names, failure counts, and command results.

| Removed boundary | Log | Result |
| --- | --- | --- |
| Retire only `fallback` at freeze, changed to retire all | `mut-freeze_steering.log` | 3 failed, exit 1 |
| Retirement of definite `fallback` at freeze | `mut-fallback-retirement.log` | 1 failed, exit 1 |
| Reservation discard when `noteSteerAttempt` refuses | `mut-admit_discard.log` | 1 failed, exit 1 |
| Reservation discard on queued host result | `mut-queued_discard.log` | 1 failed, exit 1 |
| Closed settlement retirement after re-entrant freeze | `mut-closed_settlement.log` | 1 failed, exit 1 |
| Pending-fallback peer admission guard | `mut-pending_peer.log` | 1 failed, exit 1 |
| Pending-fallback conversation admission guard | `mut-pending_conversation.log` | 1 failed, exit 1 |
| Automatic quiescence-check registration | `mut-after_each_wiring.log` | file failed in final verifier hook, exit 1 |

The `noteSteerAttempt` test observes the coordinator before the host returns
to the CLI. A first test version checked only after the CLI's later queued
cleanup; that mutation survived (exit 0), so it was replaced before the
results above. After the final mutation, the production source matched
`36e4f08b` and the final Codex run passed. The authenticated native gate is
still pending the final Codex pin.

The additional writing-state tests assert stage reports from the actual CLI
settlement: the pending-write P fallback remains queued without an unknown
stage, the E response reports unknown, and a new no-response writing case
reports `unknown` with `turn_steer_write_uncertain` and `turn_steer_timeout`.
The last case has no retirement or replay. Removing the stage-report call
made the E and no-response cases fail (2 failed, exit 1); allowing the fake
stream to complete its write made the no-response writing assertion fail
(1 failed, exit 1). After restoration, the Codex full suite passed 1,253
tests (exit 0) and wrapper typecheck exited 0. Their logs have SHA-256
`bfad7aa63864d02c0db89b0c2f35c9874955709404744ca39e73a4c573d334d1`
and `9cf1e9ae4b654017d851ccc60b3cb0e010f1ab7283b71d225a2c5885e0a3b434`;
the two mutation logs have SHA-256
`0c8dadc1fa34fadc736bb6647fcffbe00a5c1f56ef8031c3461451cba3261b4f`
and `cf0a8c347724b5dd9f791156f8fdb706a7304574c57bdeabd91450b3f15139de`.

Key log SHA-256 values: final Codex
`bfad7aa63864d02c0db89b0c2f35c9874955709404744ca39e73a4c573d334d1`,
wrapper core serial
`42e6878fa82ff69836ca001a8861c3336c2274380de33724cb503af6019a47b8`,
server
`3dcf8511b95678418f2aad76d7f4a41025582258fe1155de5b611e10b55e28f9`.

## Review round 5 correction

Product and contract commit: `a6e4251b07d901285b67a481d98eee0af979d5da`.
This section supersedes the round-4 account of a frozen `P` steer. The old
implementation discarded its reservation at watchdog freeze. A later definite
precondition fallback reached `settleSteerReservation` with no reservation and
returned without delivery, retirement, or an unknown stage. The pre-fix
selected run failed (1 failed, exit 1; `pre-fix-frozen-p.log`). The final
production-composition test now waits for the late settlement and asserts one
retirement, no unknown stage, and zero host slots and both
coordinator counts. The other three fail-stop cases wait for their late
`unknown` report and assert no retirement. A non-precondition rejection may
settle with either timeout or disconnected reason under the scripted shutdown;
both are unknown, never definite non-delivery.

The coordinator records the identity of a steer removed by freeze. Late
settlement consumes that identity exactly once and retires only if the CLI's
single fallback predicate is true. A queued or exceptional host result clears
the frozen identity before ordinary requeue. The unit test places a late
settlement between that clearing and `receive` and verifies that it cannot
retire the requeued envelope. The automatic `afterEach` verifier counts only
completed checks, with an explicit count for its one opt-out self-test; it
also checks the frozen-identity count at test end.

The final Codex and wrapper typecheck runs followed the last mutation and
used `env -u CODEX_HOME`. Other gates ran at the same product code before the
last test-only type annotation correction. Counts and exit codes are copied
from the logs under `tmp/reviews/issue-346/impl-r5-fuji-artifacts/`.

| Gate | Result | Exit |
| --- | ---: | ---: |
| Codex full suite, final run | 1,256 passed, 81 files | 0 |
| Agent common full suite | 505 passed, 20 files | 0 |
| Wrapper core full suite | 306 passed, 6 files | 0 |
| Claude Code full suite | 761 passed, 32 files | 0 |
| Antigravity full suite | 406 passed, 2 skipped, 28 files | 0 |
| Runner full suite | 787 passed, 35 files | 0 |
| Dashboard full suite | 1,077 passed, 76 files | 0 |
| Server full suite | 1,771 passed, 1 excluded | 0 |
| Wrapper, runner, protocol typecheck | each completed | 0 each |
| Dashboard check | 0 errors, 0 warnings | 0 |
| Wrapper, runner, dashboard build | each completed | 0 each |
| `git diff --check` | no errors | 0 |

The first wrapper typecheck found a test-only `void` return annotation
(exit 2); changing the check array to `() => true` made the rerun exit 0.
No final Codex or core run reports a Vitest unhandled error. The server log
contains expected fixture warnings; dashboard build retains its existing
chunk-size warning. No live turn or native gate was run.

| Removed boundary | Selected result |
| --- | --- |
| Record frozen steer identity | 1 failed, exit 1 |
| Clear frozen identity on queued requeue | 1 failed, exit 1 |
| Clear frozen identity on settlement | 1 failed, exit 1 |
| Require definite fallback for late retirement | 1 failed, exit 1 |
| Release the host reservation during freeze | 1 failed, exit 1 |
| Report the frozen-identity count | 1 failed, exit 1 |
| Run the automatic `afterEach` check | final verifier hook failed, exit 1 |

The mutation logs retain the exact test names. The first selection for the
`afterEach` mutation ran the explicitly opted-out verifier self-test and
survived; selecting a normal production-composition test made the final
mutation fail. All mutated files were restored before the final Codex suite.

Incarnation replacement during the gap before a late `P` settlement was not
measured. By source inspection, `DeliveryStates.bind_resync` calls
`retire_generation` for the old generation; that function records unresolved
metadata as interrupted and persists notification intents before a new
incarnation is assigned. `DeliveryRecovery.retire` only requests retirement
for received sequences still above its acknowledged prefix. Thus generation
replacement has a server recovery path for an unresolved old sequence, but
the exact sender-visible race between replacement and this late local
retirement remains a native-gate question on the final pin.

Final log SHA-256: Codex
`bd0682ebf18ef01cd420f121345dffb38603e7f89219470f31d3f00d57b3dddd`,
wrapper typecheck
`9cf1e9ae4b654017d851ccc60b3cb0e010f1ab7283b71d225a2c5885e0a3b434`,
core `67133b60e1a83755cade0b5ff0496001d892e9bb4a50f68b3e321df80a387e6e`,
server `dffa505e9e77b56ff774ff196a3227de333d288d490ba55d8f114a175a5a8770`.
