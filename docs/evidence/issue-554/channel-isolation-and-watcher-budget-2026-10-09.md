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
