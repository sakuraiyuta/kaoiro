# Codex 0.159.3 backup implementation review r2 evidence

Status: submitted for independent implementation review, not adoption or
production activation approval. Source implementation: `cdf790e8cf78c046e44ffd08c956fc8c4ca952c3`,
on branch `issue-468-codex-pin`. The subsequent report commit changes docs only.
No production runner/home or authenticated evaluation home was accessed in
this round. No push or deploy occurred. Tests unset inherited `CODEX_HOME`;
all native invocations use the absolute pinned 0.159.3 binary and an explicit,
new, credential-free scratch home. There were **zero live model turns** and
**four local scripted-provider requests** in this round.

## Findings addressed

All implementation-r1 and design-r5 findings requested by the director are
accepted. The design and operating procedures are aligned with these changes.

| Finding | Change and evidence |
| --- | --- |
| Implementation M1 | Migration levels are read from disposable copies of copied DB/WAL/SHM/journal files. SQLite never opens source or hash-bound payload files. Real clean-close and uncheckpointed-WAL fixtures fail against the old code and pass after the fix, preserving source entries/bytes and verified payloads. |
| Implementation S1 | The first snapshot-failure branch asserts its error message and zero switch invocations, independently of the later switch guard. Removing that branch makes the test fail. |
| Implementation S2 | `production.md` includes ordinary same-native rollback through the verified physical tool-release path. Stop/switch/start share one success chain; state-aware recovery handles refused transitions. |
| Implementation S3 | Acceptance and retirement allow applicable history evidence or `explicitNewSession: true`; startup and explicit rollback abandonment remain required. `gate6` means accepted snapshot/fresh-setup recovery, not old-binary access to migrated DBs. |
| Implementation N1–N4 | Hosts without unified cgroup v2 are refused; failure journal output is limited to transaction UUID/mode/phase; native resolution documents trusted release-code execution; redundant printf spacing is removed. |
| Design S1 | Operators explicitly delete or retain old diagnostic credentials, with private local retention/deletion dates. No snapshots/diagnostics in cloud-sync or external-backup directories. A new login does not prove old-token revocation; account-side revocation is optional where available. |
| Design S2 | A forward `snapshot-verified` or `switch-authorized` phase permits code-only source recovery. The original pre-start proof, original target/source identity, stopped state, snapshot and home bindings are verified before switching and starting. Home inode and credential inode remain unchanged; no quarantine is created. `start-attempted` uses snapshot restoration. |
| Design N1–N4 | Removed external-writer detection wording, aligned maintenance completion with history/new-session evidence, documented reinstallation of unit ExecStart and home bindings for a new install root, and wrapped the flagged prose. |

Code-only recovery is a transaction-bound exception, not a generic rollback
bypass. Recovery-target redirection and loss of the original pre-start proof
at both switch and start boundaries are refused. Unknown/corrupt records
remain refusals rather than guessed proof of an unstarted candidate.

## SQLite reproduction and correction of earlier evidence

Each real SQLite fixture is created by Node 24.3's `node:sqlite`, in WAL mode,
with a committed migration row. One child closes normally; the other kills
only itself with SIGKILL, leaving the row in uncheckpointed WAL. The actual
snapshot module runs in a Node child process, not a copied implementation.
The old source implementation produces **2 failed tests, exit 1**, including
source entry/hash differences. The fixed version passes both cases and reads
the WAL-only migration row. The full suite verifies the final version.

The first attempt to run this test inside Vitest failed because that Vite
version could not load `node:sqlite`. It is retained as a discarded harness
failure, not M1 evidence. Moving the actual module invocation into Node avoids
that loader and also matches the shipped helper's runtime.

The earlier native rehearsal's `arms.py` explicitly calls Python SQLite
read-only inspection before snapshot inventory. A separate two-arm real-DB
experiment with the **old helper** measured:

- Without pre-inspection: snapshot exit 1, new WAL/SHM entries left in source.
- With the same Python read-only pre-inspection: sidecars already exist before
  snapshot; snapshot exit 0 and its before/after hashes match.

This reproduces a masking mechanism in the earlier method. The earlier run
lacks pre-inspection entry hashes, so it cannot establish that this was the
exclusive cause of its success. The earlier built-runner rehearsal also took
its snapshot before native DB creation. Our judgment is that the reviewer is
correct: green unit fixtures without real DBs, and a preconditioned native
home, were insufficient evidence of a non-mutating snapshot. Historical
records now explicitly state this limitation; their native persistence
observations are retained without claiming source immutability.

## Tests and negative controls

All package invocations use `env -u CODEX_HOME` and an isolated ordinary HOME.

| Check | Result | Exit |
| --- | --- | ---: |
| Runner full suite | 37 files, 849 tests passed | 0 |
| Runner typecheck | Passed | 0 |
| Codex full suite | 79 files, 1,200 tests passed | 0 |
| Codex typecheck | Passed | 0 |
| Clean linux-x64 runner build | Commit `cdf790e8`, 153 manifest entries | 0 |
| Installed strict release verification, then restored verification | Passed | 0 / 0 |
| Missing launch script plus its manifest entry | Refused, next actions 0 | 71 |
| Missing state helper plus its manifest entry | Refused, next actions 0 | 71 |
| Evidence-output checker | Passed; altered DB digest rejected | 0 / 1 |

The companion manifest lists **13 selected mutation controls**, each exit 1,
with logs and restored-source hashes: snapshot failure boundary, minimal
journal output, code-only recovery selection, uncertainty requiring restore,
switch/start proof wiring, state-promotion bypass, original-source target,
cgroup v2, new-session acceptance/retirement and missing acceptance/retirement
evidence. M1's two old-implementation failures are additional controls. These
are named coverage claims, not a claim that every existing predicate in the
entire updater has independent mutation coverage.

One pre-start test initially used positional `$1` after the fixture switch
had consumed its arguments. That fixture failure and its first mutation log
are excluded. The corrected fixture uses parsed `$id`; its positive check,
negative control and restored full suite all ran again. Final mutation logs
and their source bindings match the reported implementation.

## Installed artifact and real service rehearsal

Archive SHA-256: `7acaff1e30e3f82903cb902054c282bb555f04b57a4d93303edbc96e58f7a319`.
Release manifest SHA-256: `d95666ac2f89925c2bd55e3206fa5a61349e718164cf10d8e7ed6a2c67e922e9`.
Native SHA-256: `8bf204b36a2f6dd0dab73aa2f639892e67ef9ac8befccb4a05b1496ebf25c479`.
The strict installed verifier and actual exec/app-server resolvers agree on
that native file. Deploy source bytes in the installed tree match the source
commit. No backup implementation was injected.

A new, owned user-systemd unit ran the actual installed launch shim/runner
against an owned loopback server. A credential-free native 0.159.3 exec turn
created six real databases and a thread **before** snapshot, with no SQLite
inspection of that source. The detached updater switched between source
`f0808401` and candidate `cdf790e8`, then restored the source. Both releases
contain native 0.159.3; this measures state recovery across code releases,
not 0.156.1 interoperability or old-binary access to migrated state.

- Update and restore worker exits: **0 / 0**; runner joins **1 → 2 → 3**.
- Six DBs and their sidecars: **18 file digests/entries identical** before and
  after snapshot. Copied migration levels include state 58 and thread-history 7.
- Corrupting the copied snapshot's session payload makes detached restore
  exit **78** before stopping: same runner PID, same current, same home DB
  digests, zero next mutations. Restoring the original payload allows recovery.
- The original pre-snapshot thread resumes with the same native ID after
  restore. The post-snapshot thread fails the actual runner's resume request
  with `session_not_found`; no replacement wrapper joins from that request.
  An explicit new-session spawn succeeds and its default app-server wrapper
  completes one local turn. Total local provider requests: **4**, live: **0**.

The probe's final teardown, after all assertions, reached systemd's
`final-sigterm` timeout for a remaining child of the restored source unit;
systemd killed that owned child. The probe then exited 0 and removed its unit.
A subsequent explicit kill attempt found the unit already unloaded and did
nothing (exit 1); final observation is `MainPID=0`, `LoadState=not-found`,
`ActiveState=inactive`. This is not evidence of graceful Codex shutdown or a
newly diagnosed production defect. No production service was signalled.

## Remaining decisions and retained material

Independent implementation review and the operator's adoption/rollout decision
remain pending. No rejection or new live model run changed the separately
recorded runtime/model evidence. The authenticated later-turn total remains
10/20; gate 5 remains its separate 4-turn record. No old-home login was used.
The current gate-6 contract uses snapshot restore or operator fresh setup.
Credential revocation and production classification/maintenance still require
the operator; none was performed here.

The evaluator retains `<scratch>` (privately, outside cloud sync) for review:
raw logs, mutation controls, two SQLite experiments, the built archive,
installed artifact and owned service rehearsal trees. The temporary unit was
removed. Fixture directories are removed by the tests. Scratch and retained
authenticated homes will be removed only at the director's cleanup boundary.
The companion JSON maps `<scratch>` to the evaluator-owned directory already
reported privately to the director; no production paths or credential contents
are embedded in this report.
