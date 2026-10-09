# Issue 554: channel store isolation and watcher budgets (2026-10-09)

What was measured, on which commits, and what the results allow. Design:
`tmp/reviews/issue-554/design-r2-kao.md` (approved by kuroe). Plan:
`tmp/reviews/issue-554/impl-plan-kao.md`.

## Commits

- `eb26d71e` test(server): reset shared stores between channel tests and bound watcher waits
- `c301a5a9` test(server): fail instead of creating a DETS file named "undefined"

The C1 probe was generated from the watcher test as committed in `eb26d71e`
(git blob `8f6b2b793678cfde79cc14f8fb5d9b477cd2c8ea`).

## Baseline before the fix

`scripts/mix-test.sh test/kaoiro_server_web/channels/wrapper_channel_test.exs --repeat-until-failure 2 --seed 554`
on `0bfede23`: iteration 1 242 passed; iteration 2 220 of 242 (22 failures), exit 2.

## C1 measurement gate (kuroe r2 S3)

Probe copy of the watcher test: each event wait is a timed wrapper that logs
its elapsed time (`PROBE554 <file>:<line> us=<n>`). The probe waits up to the
real budget, `TestTimeouts.out_of_band()` (500 ms locally). 30 full-file runs
(`--seed 1000` to `1029`), 4 busy loops started by PID and stopped by PID
afterwards. Load (1 min) at run start ranged 1.20 to 9.41.

- Runs: 30 of 30 exit 0, each `Result: 16 passed`.
- Probe lines per run: 17 (every event wait).
- Largest sample: 285.1 ms.
- Samples above 250 ms: 6, in 6 runs, at three sites
  (probe line numbers, which are the committed line plus 1):

| probe line | committed line | what it waits for | max, ms |
|---|---|---|---|
| 122 | 121 | first disconnect after the synthetic event (demoted) | 257.9 |
| 173 | 172 | first disconnect in the second scenario (google target) | 285.1 |
| 260 | 259 | the disconnect after the directory appears, after `Process.sleep(80)` | 269.1 |

- Gate result (`tmp/measure-554/c1-gate.sh`, sha256 `ee3e8241…`): **exit 1**
  ("a site exceeded 250000 us"). Under the rule in kuroe r2 S3, C1 does not
  land until hisui decides D2 on this evidence.

What this does not show: the samples are under 500 ms, so no run failed at the
budget. The gate threshold is hisui's decision point, not a failure of the test.

## Mutation checks

Each mutant changes one committed line (single string replacement, asserted to
occur once). Each runs the four targeted files under `setsid -w`, then the file
is restored with `git checkout`. Exit 2 is ExUnit's failure exit.

| mutant | expected | result |
|---|---|---|
| m_c1: one event wait without the budget argument | budget guard red | exit 2, guard red only |
| m_c2: barrier line removed from `assert_no_disconnect/2` | verifier red | exit 2, verifier red only |
| m_c2 control: verifier uses a timed `refute_receive` of 50 ms | verifier green (the old form misses the late disconnect) | verifier green; only the guard flags the timed refute |
| m_c3: `rewrite!/2` writes in place | fixture tests red | exit 2, 2 red (reader and cleanup); 3 repeats, 3 of 3 red |
| m_c5a: ConversationStates restart removed | isolation test red | exit 2, second lifetime red |
| m_c5b: AgentActivity restart removed | isolation test red | exit 2, second lifetime red |
| m_c5c: DeliveryStates rows not deleted | isolation test red | exit 2, second lifetime red |
| m_c5d: SessionLifecycleEvents rows not deleted | isolation test red | exit 2, second lifetime red |
| m_s1: lifecycle store left down after the row delete | isolation test red | exit 2, second lifetime red (after the fix, the reset raises instead of creating a file) |

A mutant run against the first version of the reset created a stray DETS file
named `undefined` in the working directory (when the store was down). That led
to commit `c301a5a9`. The file was removed.

## Limits

- The C1 gate is one configuration (4 busy loops plus ambient peer load). No
  claim is made for arbitrary load.
- The ordering in `reset_dets!/1` (stop, then delete, then restart) is by
  construction and by reading the store's `terminate/2` and `init/1`. The
  mutant that removes the restart is red; the ordering of a late append against
  the delete is not reproduced mechanically.
- Repeat gate, not green. On commit `5bf6051a`:
  `scripts/mix-test.sh test/kaoiro_server_web/channels/wrapper_channel_test.exs --repeat-until-failure 2 --seed 554`
  iteration 1: 242 passed; iteration 2: 239 of 242 passed, exit 2. The base
  commit gave 220 of 242 in iteration 2, so the reset removes most of the leak
  but not all of it. The three remaining failures are sequence and revision
  assertions (`{:ok, 1, _}` expected, `{:ok, 2, _}` returned) in two
  permission-sync tests (wrapper_channel_test.exs lines 4309 and 2431), and an
  `admit_yield` token check (line 136). Their stores are DETS-backed and are not
  in the four-store reset: PermissionSettings, PermissionModes, WorkStore and
  IngressOrder (see `server/lib/kaoiro_server/application.ex` for the child list).
  Not measured: whether extending the reset to these stores clears all three.
- Full suite on the same commit: 2086 passed, 1 excluded, exit 0
  (`scripts/mix-test.sh --seed 554`, 157.9 s).

## Widened reset (commit 2d48d704)

- Repeat gate, `wrapper_channel_test.exs --repeat-until-failure 2 --seed 554`: three runs, each 242 passed, exit 0 (log: tmp/measure-554/impl-repeat2-1.log, not committed).
- Full suite, `scripts/mix-test.sh --seed 554`: 2090 passed, 1 excluded, exit 0, 182.2 s (25.0 s async, 157.2 s sync).
- Baseline at 0bfede23, same seed: 2077 passed, 1 excluded, exit 0, 143.5 s.
- `DeliveryLossDispatcher terminating` (noproc from `DeliveryStates.pending_losses`): 0 at the baseline, 4 at 2d48d704. The dispatcher polls DeliveryStates every second, and the reset stops DeliveryStates while it runs. The supervisor restarts the dispatcher, so tests pass, but the crash is a side effect of this change. Proposed fix (not applied): stop the dispatcher before the DeliveryStates step and restart it after (test-only). Product-side handling of noproc is a follow-up.
- Mutant table: not run at the time of this record.


## Final verification (commit 95b003b5)

Dispatcher fix: `test_stores.ex` stops `DeliveryLossDispatcher` before the reset steps and starts it after them (commit 9b3096ed).

- Full suite, `scripts/mix-test.sh --seed 554`: 2091 passed, 1 excluded, exit 0, 175.7 s. `DeliveryLossDispatcher terminating` count: 0 (baseline 0bfede23: 143.5 s, 2077 passed, 0; before the fix at 2d48d704: 182.2 s, 2090 passed, 4).
- Repeat gate, `wrapper_channel_test.exs --repeat-until-failure 2 --seed 554`: three runs, each 242 passed, exit 0.
- Reset-loop probe (400 `TestStores.reset!/0` calls per run, dispatcher crash reports counted in the captured log): with the fix, 0, 0, 0 (three runs); with the fix removed, 2, 1, 1 (two runs repeated). The probe lives outside the repository.
- Single-edit mutants (each run alone, file restored with `git checkout`; the test files target `store_isolation_test.exs`, `store_reset_coverage_guard_test.exs`, `store_singleton_guard_test.exs`, seed 554):

| mutant | exit | result (targeted files) | red tests |
|---|---|---|---|
| r01_memory_ConversationStates | 2 | 8/9 passed | 1 |
| r02_memory_AgentActivity | 2 | 8/9 passed | 1 |
| r03_dets_SessionPointers | 2 | 4/9 passed | 5 |
| r04_dets_PermissionModes | 2 | 4/9 passed | 5 |
| r05_dets_PermissionSettings | 2 | 4/9 passed | 5 |
| r06_dets_SessionLifecycleEvents | 2 | 4/9 passed | 5 |
| r07_dets_DeliveryStates | 2 | 4/9 passed | 5 |
| r08_dets_WorkStore | 2 | 4/9 passed | 5 |
| r09_dets_QuagmireSettings | 2 | 4/9 passed | 5 |
| r10_dets_Users | 2 | 5/9 passed | 4 |
| r11_dets_TokenDenylist | 2 | 3/9 passed | 6 |
| r12_dets_AgentDirectory | 2 | 4/9 passed | 5 |
| r13_dets_AgentStatusLines | 2 | 4/9 passed | 5 |
| r14_dets_ClearWatermarks | 2 | 3/9 passed | 6 |
| r15_dets_SessionStarts | 2 | 3/9 passed | 6 |
| r16_dets_IngressOrder | 2 | 5/9 passed | 4 |
| o1_AgentStatusLines_before_TokenDenylist | 2 | 8/9 passed | 1 |
| o2_IngressOrder_before_seed_sources | 2 | 7/9 passed | 2 |
| g1_list_missing_Users | 2 | 5/9 passed | 4 |
| g2_enumeration_blind_to_unlisted | 2 | 8/9 passed | 1 |

Notes on the table:
- r01 to r16: one reset step removed (2 memory, 14 DETS).
- o1 and o2: order swaps. o1 is pinned by the order test in the guard (the fixture alone does not see it); o2 is also seen by the fixture.
- g1: a listed store missing from the list. g2: the enumeration only sees listed tables, so the unlisted-table control turns red.
- Before the order test was added, o1 was green (exit 0). The table above is the rerun after commit 95b003b5.


## C1 gate with the file_event budget (commit cddf0eaf)

Budget: `TestTimeouts.file_event/0` = 2 x `out_of_band/0`, so 1000 ms locally (5000 ms under CI). The 14 waits that follow a file write use it. The threshold for this gate is half of that budget, 500 ms.

- Watcher test blob: `a27764e23ba3948af943d1effa7de36745d7c395` (commit cddf0eaf). Probe copy generated from that blob, with `assert_receive` replaced by a timed wrapper, 17 probe lines per run.
- Runs: 30 full-file runs (`--seed 1000` to `1029`) under 4 busy loops, started and stopped by PID.
- Load (1 min, at each run start): 1.10 9.25.
- Largest sample: 289.2 ms.
- Samples above 500 ms: 0. Samples above 250 ms: 6.
- Gate (`c1-gate.sh`, sha256 `ee3e8241c1617215...`, outside the repository), arguments `30 runs, 17 sites, threshold 500000 us`: exit 0 (gate_status=pass).

Full suite on cddf0eaf (`scripts/mix-test.sh --seed 554`): 2093 passed, 1 excluded, exit 0, 173.2 s; `DeliveryLossDispatcher terminating` count 0.

Negative control for the budget pin: moving one `file_event()` use back to `out_of_band()` makes the budget guard red (exit 2, 1 of 2 passed); moving all 14 back makes it red too (exit 2, 1 of 2 passed).
