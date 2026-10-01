# Codex 0.159.3 native state rehearsal

Status: historical partial Gate 6 evidence, not adoption or deployment approval.
The [current recovery design](../../plans/issue-468-codex-state-backup.md)
requires snapshot recovery or fresh setup, not old-binary access to migrated
databases. No further old-binary run or old-home login is required.
The companion JSON binds the native binaries, snapshot implementation, probe
scripts and observations by SHA-256. All data came from a newly created,
credential-free scratch home. No production home, database, authentication
file or authenticated evaluation home was read or copied.

## Method and observations

The absolute 0.156.1 native executable created an exec thread and an
app-server thread. A local HTTP Responses provider returned fixed text;
there were **11 local provider requests and zero live model turns** across
the initial run and the additional restore/history check. CLI configuration
selected that provider explicitly, without an API key or ChatGPT login.
This measures native persistence and protocol behavior, not model behavior.

The native processes exited before each database inspection or snapshot.
The shipped `codex-snapshot.mjs` copied the stopped home, verified hashes and
recorded native migration levels. No handwritten SQL schema or migration
rows were used. The test preserved the original absolute home path across
version changes and restores because persisted rollout paths can refer to
that path. The sequence was old control, candidate, old opening candidate
state, then restoration of the pre-update snapshot at the same path; these
were sequential observations, not independently relocated home copies.

| Observation | state_5.sqlite migrations | thread_history_1.sqlite migrations | Result |
| --- | ---: | ---: | --- |
| Native old seed | 55 (maximum 55) | 6 (maximum 6) | Two native threads created |
| Old-to-old control | 55 | 6 | Same exec/app-server IDs resumed and appended |
| Candidate | 58 (maximum 58) | 7 (maximum 7) | Original IDs/history read; new input appended |
| Old after candidate | 58 | 7 | Same IDs read and appended; candidate input remained visible |
| Restored old | 55 | 6 | Original exec ID resumed and appended |
| Additional restored app-server check | 55 | 6 | Original app-server ID/history resumed and appended |

All six databases inspected in each recorded stage returned `ok` from
`PRAGMA integrity_check`. The migration rows, including checksums, and table
schemas matched between candidate and old-after-candidate observations.
Restored migration rows matched the old seed. The other databases were
`goals_1.sqlite`, `logs_2.sqlite`, `memories_1.sqlite` and `queue_1.sqlite`;
each retained two recorded migrations, maximum version 2.

The request captures show the old exec continuation receiving both its
original input and candidate input. The old app-server history response
contains the candidate's appended input. After restore, the original
app-server history remains and candidate input is absent, as expected for
rollback to the pre-update snapshot.

In a second candidate/restore pass, the candidate created a new post-backup
thread. After restore, old app-server `thread/resume` rejected its ID with
`-32600`, `no rollout found for thread id ...`, with zero additional local
provider requests. Resuming and appending to the original app-server thread
then succeeded. This is the native missing-thread result; it does not yet
prove the runner's T3 handling of a retained server session reference.

## Negative controls and verification limits

The observation checker consumed the captured IDs, history, requests,
integrity results, migration rows and schemas. Its normal invocation passed.
Supplying a wrong expected thread ID and a wrong expected sentinel separately
produced exit 1. These are checker negative controls against real outputs.
The missing post-backup thread is a native negative control, not a fabricated
error response.

The first native home exposed three missing classification entries in the
snapshot implementation. Upstream source identifies `.sandbox_migration` as
a one-shot policy migration marker, and `.tmp` plus `thread-writer-locks` as
maintenance/cache and lock storage. The implementation preserves the marker
and excludes the latter two after writers stop. The native snapshot and
restore then succeeded. Removing each classification from the implementation
made the corresponding test fail; unknown entries still refuse copying.

Native stderr reported that PATH helper aliases cannot be created beneath
`/tmp`. The probes used absolute native binaries and no shell/tool calls;
therefore they do not establish native helper execution or tool-item history
compatibility. No migration/fallback error appeared in the captured stderr;
the inspected scratch logs database also had no matching diagnostic rows.
Absence of a log message alone is not the compatibility criterion.

This capture did not measure the following:

- The real runner's retained-session resume path after restore, including its
  refusal without silently creating a new session and an explicitly requested
  new session succeeding; native tool-item history is also unmeasured here.
- A successful detached update and restore with owned real systemd units and
  a final built release. At this capture's implementation revision, the external
  process scan refused an unreadable unrelated process. The owned-unit negative
  rehearsal returned exit 78 with zero link changes/candidate starts. That
  historical refusal does not describe the simplified design, which removes
  the external scan; new implementation evidence must measure its real-service
  success independently.
- Remaining new-guard mutation coverage and independent implementation review.

Old-version resume of a candidate-created thread before restore was also
unmeasured. It is no longer an adoption requirement. The observed old-version
results below are retained as limited historical observations, not a supported
rollback route.

The observed old binary can operate on these migrated synthetic threads.
This narrow result does not authorize code-only rollback or removal of the
pre-switch backup: extensions, additional state and production history were
not part of the fixture. Candidate-only authenticated runtime gates remain separate.

Scratch artifacts are retained by Kogane for review and remaining Gate 6
checks, with cleanup after the evaluation closes.
