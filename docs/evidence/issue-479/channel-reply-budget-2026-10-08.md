# Channel reply budget: measurement and pins (issue 479), 2026-10-08

Frozen record. Measured on base `2d5d7b89` (origin/develop) on 2026-10-08,
host with 4 cores, shared with other agents. The probe that produced the
measurement was not committed; it wrapped `assert_reply` in four test files
inside a worktree and was reverted afterwards.

## Question

ExUnit's default `assert_reply` budget is `:assert_receive_timeout`: 100 ms
locally, 500 ms under `CI`. Some channel replies wait on a DETS fsync
(`:dets.sync/1`) and can exceed 100 ms under load. Four channel test files
(agents, runner, reply_basis, operator_input_modes) and restore_cwd still
used the ExUnit default at the time. Which default should `ChannelCase` use?

## Decision reference

Design r2 (approved by kuroe): `tmp/reviews/issue-479/design-r2-kao.md`
(sha256 `e0b100e0…`), review `design-r2-kuroe.md` (approve, sha256
`c97fe32e…`). Chosen mechanism: `KaoiroServerWeb.ChannelCase` defines
`assert_reply/2..4` with `TestTimeouts.durable_reply()` as the default.

## Method

- Probe: `assert_reply` renamed to a probe macro in agents, runner,
  reply_basis and operator_input_modes. The probe appends one TSV row per
  successful call: file, line, explicit flag, elapsed microseconds inside
  `assert_reply`, outcome. Default sites keep the ExUnit default (100 ms);
  one run used `KAO479_BUDGET=2000` to see the uncensored latency.
- Elapsed time is the wait inside `assert_reply`. The tests call
  `assert_reply` right after `push`, so this equals the reply latency. A
  timed-out call records no row; ExUnit reports the failure.
- Each file ran alone: `mix test <file> --seed 479`, `env -u CI`,
  `MIX_ENV=test`. The 1-minute load average was read from `/proc/loadavg`
  before each file.
- Percentiles: index `int(N * p)` into the sorted list (1-based, awk).
  Nearest-rank, `ceil(N * p)`, gives p99 = 13.0 ms for run2; this record
  uses the index method, p99 = 10.9 ms.

## Runs

| run | budget | window (UTC) | agents | runner / reply_basis / operator | 1-min load (agents) |
|---|---|---|---|---|---|
| run0 | 100 ms | 12:01:03 to 12:03:19 | 432/436 passed, exit 2 (4 timeouts) | 53 / 3 / 7 passed, exit 0 | 14.10 |
| run1 | 100 ms | 12:04:59 to 12:06:13 | 436 passed, exit 0 | 53 / 3 / 7 passed, exit 0 | 10.18 |
| run2 | 2000 ms | 12:06:19 to 12:07:02 | 436 passed, exit 0 | 53 / 3 / 7 passed, exit 0 | 8.33 |

The three runs fall in one short window, so the load difference is variation
within that window. Wall time: agents 119 s (run0), 66 s (run1), 39 s (run2).

Calls and sites:

- Default sites in the four files: 304 (agents), 60 (runner), 18
  (reply_basis), 2 (operator), total 384. Explicit-budget lines in agents are 9
  and are not measured here.
- Successful default calls: run0 465 (agents 354, runner 66, reply_basis 23,
  operator 22), plus 4 timeouts. Run2 471.
- Sites with at least one call of 5 ms or more: run0 58 (agents 45, runner 4,
  reply_basis 8, operator 1), plus 4 timeouts; run1 44; run2 34.

Distribution, run2 (uncensored, 471 calls): p50 0.1 ms, p90 2.8 ms, p99
10.9 ms, max 73.8 ms (agents, base line 1765).

Distribution, run1 (censored at 100 ms, 471 calls): p50 0.2 ms, p90 4.0 ms,
p99 53.6 ms, max 91.2 ms (reply_basis, base line 198).

## Timeouts at 100 ms (run0)

All four are in `agents_channel_test.exs` and fail with `no matching message
after 100ms` (base lines):

- 2147: `assert_reply ref, :ok` in the `permission_requested` audit-event test.
- 2274: `assert_reply first_ref, :ok, %{"revision" => first_revision}` in the
  queued set_permission audit-time test.
- 2354: `assert_reply ref, :ok` in the audit actor identity test (M1).
- 9108: `assert_reply perm_ref, :ok, %{"revision" => 1}` in the M7-S test.

With the same seed, the same sites completed in run1 at 16.2, 17.9, 39.1 and
59.7 ms, and in run2 at 6.0, 13.0, 5.8 and 43.7 ms. The 59.7 ms site was close
to the 100 ms budget at load 10.

## Per-site list

Sites with at least one successful call of 5 ms or more, maxima per run
(ms). Base line numbers are the base commit `2d5d7b89`.

| file | base line | run0 max | run1 max | run2 max |
|---|---|---|---|---|
| agents | 8960 | 99.2 | 22.5 | 5.7 |
| agents | 2205 | 96.2 | 19.8 | 7.6 |
| agents | 1848 | 85.2 | 8.2 | 7.2 |
| reply_basis | 87 | 82.4 | 24.0 | 6.2 |
| agents | 1765 | 78.1 | 58.9 | 73.8 |
| agents | 9227 | 71.5 | 69.3 | 10.9 |
| agents | 9035 | 62.9 | 14.6 | 8.3 |
| agents | 233 | 61.1 | 19.5 | 5.1 |
| runner | 1020 | 59.4 | 2.9 | 1.9 |
| agents | 5441 | 58.5 | 17.4 | 7.3 |
| agents | 8157 | 57.5 | 53.6 | 42.3 |
| agents | 1889 | 56.7 | 7.1 | 7.5 |
| agents | 166 | 55.4 | 8.4 | 8.7 |
| agents | 7372 | 52.2 | 7.4 | 2.7 |
| agents | 5850 | 51.4 | 15.5 | 19.5 |
| agents | 791 | 50.4 | 3.6 | 3.7 |
| agents | 5243 | 48.2 | 6.7 | 5.2 |
| agents | 58 | 43.8 | 9.8 | 5.9 |
| agents | 9167 | 43.0 | 4.0 | 2.0 |
| agents | 1674 | 32.7 | 19.7 | 6.3 |
| agents | 1963 | 31.3 | 15.6 | 5.5 |
| agents | 115 | 29.9 | 4.0 | 2.9 |
| agents | 7292 | 29.4 | 1.7 | 1.6 |
| agents | 352 | 29.1 | 12.8 | 2.8 |
| agents | 2133 | 28.3 | 59.2 | 5.9 |
| agents | 2393 | 25.5 | 12.8 | 6.8 |
| reply_basis | 116 | 25.5 | 3.5 | 2.8 |
| agents | 2539 | 25.3 | 12.4 | 5.4 |
| agents | 184 | 24.8 | 22.6 | 3.2 |
| reply_basis | 130 | 22.5 | 5.3 | 4.8 |
| agents | 2432 | 21.5 | 19.8 | 5.9 |
| agents | 2996 | 21.5 | 9.6 | 5.7 |
| agents | 2372 | 21.4 | 8.7 | 5.8 |
| agents | 821 | 20.8 | 3.2 | 3.2 |
| runner | 552 | 20.6 | 1.0 | 1.0 |
| agents | 8391 | 19.2 | 20.4 | 6.5 |
| agents | 798 | 18.0 | 3.5 | 4.4 |
| agents | 2173 | 17.4 | 33.5 | 10.1 |
| operator_input_modes_test | 33 | 17.2 | 2.9 | 3.3 |
| agents | 8949 | 17.1 | 9.3 | 6.2 |
| reply_basis | 198 | 17.0 | 91.2 | 5.1 |
| reply_basis | 153 | 16.6 | 28.1 | 3.0 |
| agents | 1823 | 15.8 | 9.9 | 5.8 |
| agents | 4957 | 15.0 | 3.9 | 2.7 |
| reply_basis | 164 | 15.0 | 27.7 | 2.6 |
| reply_basis | 95 | 12.2 | 52.6 | 2.9 |
| runner | 34 | 11.5 | 6.3 | 1.3 |
| agents | 736 | 11.1 | 29.2 | 2.8 |
| agents | 747 | 9.8 | 34.3 | 3.6 |
| agents | 2972 | 7.6 | 8.7 | 5.0 |
| agents | 210 | 7.5 | 3.9 | 3.3 |
| agents | 5191 | 7.4 | 4.0 | 2.4 |
| agents | 5766 | 7.3 | 1.7 | 1.4 |
| reply_basis | 97 | 6.4 | 4.0 | 2.7 |
| runner | 333 | 5.7 | 1.2 | 0.9 |
| agents | 7194 | 5.4 | 0.3 | 0.4 |
| agents | 5616 | 5.2 | 0.4 | 0.3 |
| agents | 5942 | 5.1 | 0.1 | 0.0 |
| agents | 8986 | 5.0 | 6.5 | 6.1 |
| reply_basis | 70 | 3.8 | 5.0 | 1.9 |
| agents | 2147 |  | 16.2 | 6.0 |
| agents | 2274 |  | 17.9 | 13.0 |
| agents | 2354 |  | 39.1 | 5.8 |
| agents | 9108 |  | 59.7 | 43.7 |

run0 timeouts (budget 100 ms, no latency recorded, ExUnit reported `no matching message after 100ms`): agents_channel_test base lines 2147, 2274, 2354, 9108.

## Implementation and gates

Commits on branch `issue-479-channel-budget` (base `2d5d7b89`):

- `7d097842` test(server): default channel assert_reply to the durable-write budget
- `b4dc2443` test(server): restore the TestTimeouts alias in WrapperChannelTest

The first commit removed the `TestTimeouts` alias from WrapperChannelTest
together with the local macro, but the module still calls
`TestTimeouts.out_of_band/0` and `slow_path/0`. The first full-suite run
failed on those calls (13 tests, `UndefinedFunctionError`; result
2064/2077 passed, 1 excluded, exit 2). The second commit restores the
alias. The targeted run of the module that had failed was not part of the
first check; this is recorded as the cause.

Gates on `b4dc2443`:

| gate | command | result |
|---|---|---|
| format | `mix format --check-formatted` | exit 0 |
| compile | `mix compile --warnings-as-errors` | exit 0 |
| full suite | `scripts/mix-test.sh` (seed 778842) | `2077 passed, 1 excluded`, exit 0, 167.3 s |

The one excluded test carries the `:dashboard_build` tag from
`test_helper.exs`.

## Negative controls

Run once each on the committed state, with the mutated file restored by
`git checkout` afterwards. Each control changes one line.

| control | mutation | files run | exit | counts | failing message |
|---|---|---|---|---|---|
| N0 baseline | none | pin B file and TestTimeouts test | 0 | 7 passed | none |
| N1 | ChannelCase default replaced by ExUnit default | pin B file | 2 | 1/2 passed | `after 100ms`, expected `after 500ms` |
| N2 | ChannelCase macro ignores the explicit budget | pin B file | 2 | 1/2 passed | `after 500ms`, expected `after 501ms` |
| N3 | `@durable_reply_multiplier` 5 to 1 | TestTimeouts test | 2 | 4/5 passed | `durable_reply` multiple test |

N0 runs two files: `channel_case_budget_test.exs` (2 tests) and
`test_timeouts_test.exs` (5 tests). The counts in the N1 to N3 rows are
from the same runs.

Pins tested: Pin A (default budget, `ChannelCaseBudgetTest`) fails under
N1; Pin B (explicit budget passed through, `ChannelCaseBudgetTest`)
fails under N2; the multiple pin in `test_timeouts_test.exs` fails under
N3.

## Not measured

- The heavy-load tail above 500 ms (design r2, "Heavy-load tail"). Not
  measured; the budget is `durable_reply()` with the multiplier as the
  single knob.
- The implementation review: handled by another peer, not by this record.
  The Stop gate was cleared with a user-approved skip, not a review.
