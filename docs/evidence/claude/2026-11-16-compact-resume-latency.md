# Claude compact resume handoff latency

Related: [issue 1158](https://github.com/sakuraiyuta/kaoiro/issues/1158).
The measurements were taken on 2026-11-16 at base revision
`932ffc87d4c1c5098c0b5a994f3418424e9285eb`, with SDK 0.3.321 and bundled CLI
2.1.321. The production rows come from release 2026.11.15.1 and earlier.

## Production observations

The source is the wrapper's `[kaoiro][claude-code-receipt]` lines from
2026-11-01 to 2026-11-15. Each value is the time from `resume_pending`, which
is written at yield, to admission or rejection. Rejected receipts are cut off
at the 2-second budget then in force. Dates are in UTC+9.

| Day | Unpaused receipts | Min ms | Median ms | Max ms | Rejected (`missing_hook`) |
| --- | --- | --- | --- | --- | --- |
| 11-06 | 1 | 1316 | 1316 | 1316 | 0 |
| 11-07 | 9 | 1348 | 1391 | 1604 | 0 |
| 11-08 | 1 | 1490 | 1490 | 1490 | 0 |
| 11-10 | 8 | 1144 | 1422.5 | 2003 | 1 |
| 11-11 | 6 | 1560 | 1661 | 1760 | 0 |
| 11-12 | 4 | 1527 | 1561.5 | 1630 | 0 |
| 11-13 | 1 | 1548 | 1548 | 1548 | 0 |
| 11-14 | 12 | 1529 | 1638.5 | 1767 | 0 |
| 11-15 | 12 | 1720 | 1872 | 2004 | 4 |

- **Summary.** 55 notes were pending in total. 49 were admitted without a clock pause, none of them under 500 ms. One was admitted after a notification pause, at 168016 ms. Five were rejected, every one as `missing_hook`. Over the same period, no live push timed out.
- **Transcripts, 13 notes on 11-15.**
  - The CLI enqueued the note between 1655 and 2381 ms after `resume_pending`.
  - The four rejected notes enqueued at 1926–2381 ms.
  - Each enqueued text carried the note's correlation line, and each prompt then reached the model.
- **Trend.** The distribution is not stationary: the daily minimum rose from 1348 ms on 11-07 to 1720 ms on 11-15.
- **Unidentified cause.** The CLI step behind this latency is not identified. Transcript size explains little: r = 0.210, about 4.8 ms per MB, across 54 notes. The operator's hooks each took 12–36 ms.

## Fixture measurements

The fixture used the built `runClaudeCli` with the real Host, SDK, CLI, `request_compact`, and native hooks. The model provider and the Phoenix service were loopback fixtures. No paid inference was used.

| Condition | Result |
| --- | --- |
| Baseline | Admitted after 15–72 ms |
| Nonessential traffic through a proxy that takes 2.5 s to answer each request | Admitted after 41 ms |
| `count_tokens` delayed 1 s | Admitted after 15 ms |
| Model calls after the compaction delayed 2.5 s | Admitted after 34 ms |
| 555 other 200 KB sessions in the project directory | Admitted after 31 ms |
| Note's stdin line held 1.8 s | Admitted after 1835 ms |
| Note's stdin line held 2.4 s | `missing_hook` after 2003 ms, admission fail-stop, state `error`, later send not delivered |
| Held 2.4 s, with a notification during compaction | Admitted after 2561 ms (clock paused once) |
| Held 2.4 s, with the global setting raised to 10 s | Admitted after 2429 ms |
| Held 2.4 s on a turn with no compaction | No receipt and no fail-stop |
| Manual `/compact` with no reservation | No receipt |

- **Ruling out factors.** The first five rows do not reproduce the production latency, so they rule those factors out within this fixture.
- **The stdin hold.** The SDK's `spawnClaudeCodeProcess` launches the real CLI, and a relay delays only the note's line and the lines after it. This places the observed production gap where it occurs, between the wrapper's write and the CLI's enqueue.
- **The 10 s row.** That row raised the global setting, which also widens live pushes. It shows that a late hook passes every check. It does not test the fix itself.
- **Pinned tests.** `compact_resume_native.test.ts` pins the fix itself with its `slow` and `slow-unfloored` cases.
