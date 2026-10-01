# Codex 0.159.3 backup implementation review r3 evidence

Status: submitted for independent implementation review; not production approval.
Source: `68e38cff12cedae689f2c7d4cb165b10d04fe844`; reviewed baseline:
`77f54ed30a4379f4fc8501953d2b3a7c6167ee53`. The report commit changes docs only.
All implementation-r2 findings (S1, N1, N2) are accepted. No production runner,
production home or authenticated evaluation home was accessed. No push or deploy
occurred. This round used **0 live turns** and **4 local provider requests**.

## Capacity correction and tests

Migration inspection copies top-level SQLite DBs and their WAL/SHM/journal
sidecars into a disposable directory on the snapshot filesystem. Backup
preflight and the post-stop snapshot recheck now reserve that additional
logical byte count, using the same file selector as the copy. Restore keeps
its existing budget because it does not make a diagnostic DB copy.

Required backup bytes are payload bytes + diagnostic-copy bytes + the larger
of 20% of payload bytes or 1 GiB. The inode check also includes diagnostic
files and two potential new sidecars per database, alongside the existing
10-inode allowance. This is a preflight estimate, not a disk reservation:
concurrent consumption or new state can still cause the post-stop recheck
or snapshot to fail, in which case switching and starting remain blocked.

The workflow regression uses real filesystem free-space reporting and an
owned sparse DB: payload plus reserve fits, but the additional copy does not.
Before the fix, the new test **failed (1 failed, exit 1)**: the updater reached
`stop`, where a fixture guard returned 77 to prevent a huge copy. With the
fix it exits 78 for capacity before stop, with no switch, backup or registry.
The sparse file consumes logical space for estimation, not its full physical
size. No production disk was deliberately filled.

A separate selector test includes main/WAL/SHM/journal entries and excludes
nested DBs and credentials; restore's extra-copy count is zero. Two snapshot
recheck tests exercise byte and inode limits using process-local mocked
`statfsSync` in a Node child running the actual helper. Those quota fixtures
are semantic tests, not live disk-exhaustion or SQLite-format evidence. The
existing real clean-close and uncheckpointed-WAL tests also pass in the full
suite, including source immutability and reading the WAL-only migration row.

Six new mutation controls each exit 1: removing diagnostic bytes, preflight
wiring, snapshot-recheck wiring or diagnostic inodes; omitting WAL selection;
and charging the diagnostic budget during restore. Source hashes were checked
after restoration. These six controls cover this delta; the prior thirteen
controls remain historical r2 evidence, not rerun claims for this round.

## Verification results

All package tests/typechecks unset `CODEX_HOME` and use an isolated HOME.
The companion manifest binds logs, scripts, source and artifact hashes.

| Check | Result | Exit |
| --- | --- | ---: |
| Runner full suite | 37 files, 853 tests passed | 0 |
| Runner typecheck | Passed | 0 |
| Codex full suite | 79 files, 1,200 tests passed | 0 |
| Codex typecheck | Passed | 0 |
| Clean linux-x64 runner build | Source `68e38cff`, 153 manifest entries | 0 |
| Installed strict verification; restored verification | Passed | 0 / 0 |
| Missing launch script and manifest entry | Refused, next mutations 0 | 71 |
| Missing state helper and manifest entry | Refused, next mutations 0 | 71 |
| Evidence-output checker; altered observed PID | Passed / rejected | 0 / 1 |

Archive SHA-256: `a68bc0822a4e8630917e04079057364b5093b2980f958e0637a102eaf79a22be`.
Release manifest SHA-256: `1203f66cbb4029017328f34460e11cb4618de2b792a58a0ba5af2dd0c485b8b4`.
Native SHA-256: `8bf204b36a2f6dd0dab73aa2f639892e67ef9ac8befccb4a05b1496ebf25c479`.
The actual exec and app-server resolvers select that same native file. Installed
deploy bytes match the source commit. No backup implementation was injected.

## Real service and native recovery

The freshly built updater ran against an evaluator-owned user-systemd unit,
installed runner/launch shim and local loopback server. The capacity negative
temporarily enlarged one owned DB sparsely. With real filesystem capacity,
the updater exited **78**, preserving PID **2399598**, current release and the
single runner join. No backup or state registry was created; next mutations
were **0**. Original DB bytes were restored and checked before the positive run.

With sufficient capacity, detached update and restore both exited **0**,
with joins **1 → 2 → 3**. Source release `f0808401` and candidate `68e38cff`
both contain native 0.159.3: this is code-release/state recovery evidence, not
0.156.1 interoperability or old-binary access to migrated databases.

Native local exec created six databases before snapshot, without first opening
source DBs for inspection. The **18 DB/sidecar entries and hashes** match
before and after snapshot; copied migrations include state 58 and history 7.
A corrupted copied session payload refuses restore with exit **78**, unchanged
PID/current/home and zero next mutations. Restoring its bytes allows recovery.
The pre-snapshot native thread resumes with the same ID. The post-snapshot ID
is refused by the actual runner with `session_not_found`; an explicit new
session succeeds through the default app-server wrapper. Total local provider
requests: **4**. No authenticated provider or production service was used.

## Documentation, shutdown and retained material

The four flagged design prose lines are wrapped. The historical r2 record
also carries the requested timeout clarification: the director reports
production journal occurrences at **2026-09-30 11:49** and **2026-10-01 00:02
JST**; the evaluator did not read those logs. Review r2 concludes that
`final-sigterm` can add up to **30 seconds** to stopping and force termination
of children. The shipped unit has `TimeoutStopSec=30`. Snapshot waits for
stopped/empty service state, and real uncheckpointed-WAL tests cover SQLite
recovery, so this timeout does not invalidate backup correctness. Its cause
is assigned to a separate issue, not diagnosed here.

This r3 owned unit uses a **5-second** stop timeout to bound test teardown;
that fixture setting does not change the shipped unit. Final cleanup check:
`LoadState=not-found`, `ActiveState=inactive`, `MainPID=0`. Test fixtures were
removed. `<scratch>` is retained privately for review, including logs, scripts,
built archive, installed trees and rehearsal data. Authenticated homes are
untouched. Cleanup follows the director's review-completion instruction.
Independent review and the operator's adoption/rollout decision remain pending.
