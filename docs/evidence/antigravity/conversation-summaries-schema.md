---
title: "Antigravity conversation summary schema and measurements"
description: Bounded measurements of agy 1.2.11 session metadata and synthetic SQLite read behavior.
status: recorded
last_updated: 2026-09-26
related: [antigravity-adapter]
---

# Antigravity conversation summary schema and measurements

## Schema and row measurement

On 2026-09-26, local `agy --version` reported `1.2.11`. The schema was measured
from `~/.gemini/antigravity-cli/conversation_summaries.db`; it uses WAL mode and
`user_version=3`. The earlier metadata-only probe opened the original database
with Python SQLite 3.45.1 in `mode=ro` and set `PRAGMA query_only=ON`. Its main
database hash stayed the same, while the WAL/SHM hashes and mtimes changed. The
cause was not attributable from that observation. Per the director's decision,
that live probe stopped; no sidecar was restored or repaired.

The director later reported one out-of-procedure live connection by the
Antigravity peer used for the target session. It used Python's normal read/write
connection mode and issued only catalog/schema SELECTs plus a SELECT of the
target row; no write statement was run. The reported main-file mtime was
20:59, and the WAL and SHM mtimes were 21:00 local time. Because the peer was
also running agy, those sidecar timestamps may include ordinary agy writes;
the peer's SELECT result is excluded from this evidence. The new copied-database
probe below records source hashes and mtimes immediately before and after the
copy, including the pre-copy mtime after this incident.

The measured `conversation_summaries` table has these columns:

| Column | Declared type | Null/default |
|---|---|---|
| `conversation_id` | `TEXT` | primary key |
| `title` | `TEXT` | `NOT NULL`, `DEFAULT ""` |
| `preview` | `TEXT` | `NOT NULL`, `DEFAULT ""` |
| `step_count` | `INTEGER` | `NOT NULL`, `DEFAULT 0` |
| `last_modified_time` | `datetime` | `NOT NULL` |
| `workspace_uris` | `TEXT` | `NOT NULL` |
| `status` | `TEXT` | `NOT NULL`, `DEFAULT ""` |
| `source` | `TEXT` | `NOT NULL`, `DEFAULT ""` |
| `project_id` | `TEXT` | `NOT NULL`, `DEFAULT ""` |
| `agent_name` | `TEXT` | `NOT NULL`, `DEFAULT ""` |
| `parent_conversation_id` | `TEXT` | `NOT NULL`, `DEFAULT ""` |
| `nesting_depth` | `INTEGER` | `NOT NULL`, `DEFAULT 0` |
| `battle_id` | `TEXT` | `NOT NULL`, `DEFAULT ""` |
| `winning_conversation_id` | `TEXT` | `NOT NULL`, `DEFAULT ""` |
| `not_fully_idle` | `numeric` | `NOT NULL`, `DEFAULT false` |
| `killed` | `numeric` | `NOT NULL`, `DEFAULT false` |
| `last_user_input_time` | `datetime` | `NOT NULL` |
| `last_user_input_step_index` | `INTEGER` | `NOT NULL`, `DEFAULT -1` |
| `app_data_dir` | `TEXT` | `NOT NULL`, `DEFAULT ""` |
| `raw_summary` | `BLOB` | nullable |
| `group_id` | `TEXT` | `NOT NULL`, `DEFAULT ''` |

Indexes are `idx_conversation_summaries_last_modified_time`,
`idx_conversation_summaries_last_user_input_time`, and SQLite's primary-key
index on `conversation_id`.

To measure stored values without reopening the live database, the main file and
the existing `-wal` / `-shm` files were copied with `cp` to a mode-0700
temporary directory. The copy was opened read-only. The query selected only
`conversation_id`, `workspace_uris`, `last_modified_time`, and
`nesting_depth`, ordered by `conversation_id`, with `LIMIT 10`; it did not
select titles, previews, summaries, or conversation bodies. No conversation ID
or row value was written to output. Before and after the copy, each source file
had identical SHA-256 and mtime:

| Source file | SHA-256 before and after | mtime ns before and after |
|---|---|---:|
| `conversation_summaries.db` | `83d936529e3b2dab939e11c632a1f35f255e9c570c6e5a29ccc3385c4ff6c5ad` | `1790413048782016907` |
| `conversation_summaries.db-wal` | `83c6a3d663ef4a4f90ed98dd870039943e1d0d27db619213b09ac34c9edcd802` | `1790417649833245250` |
| `conversation_summaries.db-shm` | `fd0308a3e5365c965ac552c15911d495fe6f6450d386a44eec834079b4bb4ca4` | `1790417649830534384` |

That bounded sample contained eight JSON arrays and two empty strings in
`workspace_uris`. Its 14 array entries were all `file:` URIs, with no trailing
slash or percent-escaped path. Three decoded paths existed locally and matched
their `realpath`; the other eleven paths did not exist on this host. All ten
`last_modified_time` values were SQLite `TEXT` in the form
`YYYY-MM-DD HH:mm:ss.fffffffff+HH:MM`; Node v24.3.0 `Date.parse` accepted all
ten. All ten rows had `nesting_depth=0`. This sample confirms encodings, but
does not establish which array member is the agy process cwd or an
`--add-dir`; matching will therefore test every array member for exact cwd
membership and will not depend on member order.

The local `agy --help` did not advertise a session-list command or API. Its
relevant output was:

```text
  --conversation                  Resume a previous conversation by ID

Available subcommands:
  agent           List available agents
  agents          List available agents
  changelog       Show changelog and release notes
  help            Show help for subcommands
  install         Configure environment paths and shell settings
  mcp             Manage MCP servers (add, remove, list, enable, disable)
  mic-serve       Serve this machine's microphone to a CLI on another host
  models          List available models
  plugin          Manage plugins (install, uninstall, list, enable, disable)
  plugins         Alias for plugin
  remote-control  Manage the remote-control background daemon (start, status, stop)
  update          Update CLI
```

The installed help surface supports resuming a known ID, not discovering IDs.
No supported session-list API was found in the installed CLI surface.

The director obtained the target ID from the server's `session_id` field on
the Antigravity peer's whoami reply envelope. The ID was used once and is
omitted from this plan and command output. The copied row query selected only
`workspace_uris` and `nesting_depth` and returned one row. `workspace_uris` was
a non-empty JSON array with two `file:` URI entries; both decoded successfully.
One matched the agent cwd `/home/yuta/git/kaoiro`, and the other matched the
current per-epoch customization `--add-dir` path. `nesting_depth` was zero.
The current customization path still existed when checked. The query printed
only these shape and match results, not the ID or URI values.

The director measured the target launch at about 21:0x local time: its runner
spawn request and the agy and wrapper working directories all used
`/home/yuta/git/kaoiro`; agy received that cwd and the per-epoch customization
directory as its two `--add-dir` values. `host.ts:1290,1935` constructs these
two arguments, and `customization.ts:72-82` creates the customization path
with `mkdtempSync`. The matching customization URI therefore shows that the
stored workspace metadata includes this launch's unique temporary directory.
It does not establish when the conversation ID was first created; the ID may
have been resumed from an earlier launch.

For this target-row measurement, the main database was copied at about
2026-09-26 12:12 UTC into a mode-0700 temporary directory. The WAL and SHM
sidecars were absent immediately before and after the copy. The source main
file had SHA-256
`a4a803ca7f41c6c1a65ddd0a783279f73374cbe25a4735fc7c75460edb961ded` and size
86,016 bytes both before and after copying; the copied main file had the same
hash. The first JSON summary displayed mtime `1790424138987607000` ns after a
JavaScript `Number` conversion, which rounded the nanosecond value. A separate
timestamp-only copy against the same source hash captured the exact source
mtime `1790424138987607161` ns before and after copying. A read-only query
against the target copy left its main-file hash unchanged. The copied target
database was deleted after the query. This source state followed the reported
live connection; no further cause is assigned to its file changes.

For the timestamp-ordering check, a separate mode-0700 copy selected only
`last_modified_time` for ten rows, with no conversation IDs or other row data.
All ten values matched the fixed timestamp format and shared one UTC-offset
suffix. Before and after this copy, the source main file retained SHA-256
`a4a803ca7f41c6c1a65ddd0a783279f73374cbe25a4735fc7c75460edb961ded`, size
86,016 bytes, and mtime `1790424138987607161` ns; both source sidecars remained
absent. The copy hash matched the source and the temporary copy was deleted.
This bounded sample supports SQLite text ordering for the measured data; it
does not establish that older rows cannot have a different offset. Runtime
queries will count distinct six-character UTC-offset suffixes across the
10,000-row candidate window. If more than one suffix is present, a
rate-limited warning will say `mixed UTC offsets; picker order may be wrong`;
listing remains available and session existence is unaffected. The mixed
offset finding will trigger a fresh bounded measurement and ordering review.

## Read behavior and runtime measurements

The sidecar hypothesis was checked on synthetic databases only. A synthetic
WAL database with existing sidecars was queried through SQLite `mode=ro` plus
`PRAGMA query_only=ON`: main and WAL hashes stayed the same; the SHM hash
changed during `SELECT` and then stayed the same when the reader closed. This
confirms that a read-only query can update the shared WAL index in `-shm`.
The [SQLite WAL documentation](https://www.sqlite.org/wal.html) describes
shared wal-index state, read snapshots, writer concurrency, and checkpoint
behavior.

A second synthetic WAL database was closed so it had no sidecars, then opened
by Node v24.3.0 `DatabaseSync` with `readOnly: true`. The reader returned the
stored row and created both `-wal` and `-shm`; both remained after that reader
closed, while the main database hash was unchanged. A normal SQLite writer
then inserted another synthetic row, read both rows successfully, and its
close removed the sidecars. This is accepted as normal WAL behavior: a
read-only connection protects database records but may create local sidecars
when they are absent. The runner will not checkpoint or change journal mode.
The copied live database and its source sidecars remained byte-for-byte and
mtime stable during the row measurement.

`immutable=1` remains unsuitable. In a synthetic fixture it returned the old
main-file value while a newer committed value remained in WAL. The
[SQLite URI documentation](https://www.sqlite.org/uri.html) explains that
`immutable=1` skips locking and change detection.

The local shell Node is v24.3.0. The director separately measured the
production runner's Node as v24.3.0 from the systemd MainPID executable; the
production service was not inspected or changed by this work. The versioned
[Node v24.3 SQLite docs](https://nodejs.org/download/release/v24.3.0/docs/api/sqlite.html)
document `readOnly` and `timeout` for `DatabaseSync`, with synchronous
operations and stability 1.1 (Active development). The versioned
[Node v22.16 SQLite docs](https://nodejs.org/download/release/v22.16.0/docs/api/sqlite.html)
record `timeout` added in v22.16.0; the
[Node v23.11 SQLite docs](https://nodejs.org/download/release/v23.11.0/docs/api/sqlite.html)
do not expose that option. Therefore the implementation will keep the package
engine floor at `>=22`, but will use the database only on Node `22.16+` in the
22.x line or Node `24+`. The implementation will parse `process.versions.node`
and enforce those major/minor bounds; it will not infer support from
constructor behavior, because older releases may silently ignore unknown
options. Node 22.0–22.4 has no `node:sqlite`; Node 22.5–22.15 has no `timeout`;
Node 23 does not provide the required timeout. Unsupported runtimes fail
closed for Antigravity only.

On Node v24.3.0, synthetic measurements established:

- `new DatabaseSync(path, { readOnly: true, timeout: 100 })` read the fixture;
  an `UPDATE` failed with `ERR_SQLITE_ERROR`, and opening a missing path did
  not create a database.
- With another connection holding `BEGIN EXCLUSIVE`, an in-process read failed
  after 0.2 ms with `timeout: 0` and after 100.9 ms with `timeout: 100`.
- Importing `node:sqlite` emitted Node's `ExperimentalWarning` to stderr but
  did not make the process fail. Running the wrapper's
  `stderr_sink_guard.test.ts` with `NODE_OPTIONS=--require=node:sqlite` emitted
  that warning from the parent and worker processes and still passed all 40
  tests (exit 0). The guard statically scans wrapper source roots; it does not
  reject runtime warnings emitted by Node. The runner launch shim does not
  suppress this warning, so the first Antigravity database use will add the
  Node warning to runner stderr. This is accepted as log noise; it does not
  change process success or the stderr sink guard result.

The `ExperimentalWarning` is intentionally not suppressed in the runner launch
shim: a process-wide filter could hide unrelated experimental APIs. The
operator runbook will identify the one-time SQLite warning in the runner
journal as harmless log noise.

### Synchronous scan measurements

The earlier JavaScript scan benchmark took p50 44.91 ms, p95 51.45 ms, and
max 109.64 ms over 30 runs. A query-only bounded CTE benchmark took p50
6.82 ms, p95 8.72 ms, and max 9.95 ms on Node v24.3.0; neither measures the
complete helper for sparse workspaces. Kohaku identified that the earlier
unqualified full-helper result (p50 14.37 ms, p95 15.98 ms, max 16.04 ms) used
a dense workspace; it is superseded by the density-controlled measurements
below.

The committed [benchmark harness](benchmark-session-index.mjs) imports the
built `runner/dist/sessions.js`. Reproduce it from the repository root after
`pnpm -C runner build`:

```sh
for density in 2 10 100 1000000000; do
  MATCH_EVERY="$density" node docs/evidence/antigravity/benchmark-session-index.mjs
done
```

The synthetic WAL database has 12,000 top-level rows and 500 nested rows, so
the 10,000-row candidate window is full. Each top-level row has two `file:`
URIs: the requested cwd for every `MATCH_EVERY`th row, otherwise a different
workspace, plus a unique customization path. Timestamps use one fixed UTC
offset. Each density is warmed once, then the complete helper runs 30 timed
list calls. Matcher calls are counted separately over the same ordered
candidate window, stopping at 500 matches. `MATCH_EVERY=1000000000` produces
zero matches inside the candidate window. The timed harness records Node
version, host type, logical CPU count, and one-minute load average immediately
before and after the 30 runs. The host was a shared Linux system with 24
logical CPUs; load average is reported as run context, not a condition for
acceptance. The measurements were:

| Candidate match density | Candidate matches | Matcher calls | Returned | Load avg 1m before → after | p50 ms | p95 ms | Max ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1/2 | 5,000 | 1,023 | 500 | 0.07 → 0.07 | 19.60 | 23.94 | 24.63 |
| 1/10 | 999 | 5,023 | 500 | 0.07 → 0.30 | 32.92 | 37.01 | 37.01 |
| 1/100 | 98 | 10,000 | 98 | 0.30 → 0.30 | 54.01 | 61.68 | 65.00 |
| 0 | 0 | 10,000 | 0 | 0.30 → 0.30 | 53.73 | 67.87 | 70.58 |

The zero-match result meets the acceptance limit set by director (kuroe): p95
at or below 100 ms for a 10,000-row window with zero workspace matches. The
limit is intentionally above observed timing variation so shared-host load
does not determine pass or fail; its purpose is to catch structural regressions
such as parsing the entire window in JavaScript or expanding the window. The
10,000-row window remains because picker and restore work is operator-triggered
and infrequent, while reducing it would hide older sessions. A SQL prefilter
was not adopted: percent-encoding differences could hide a match, and it
would change which malformed rows produce warnings. Director (kuroe) accepts
the observed synchronous pause. The measured main database was 86,016 bytes.
During bulk restore, `sessionExists` performs N sequential primary-key checks;
if each encounters a continuously locked database, the 100 ms busy timeout can
accumulate to roughly `100 ms × N`, with each check failing closed. A lock
released near timeout can add query time.

The following load-varying measurements are reported by Kohaku in the second
implementation review and were not independently repeated in those load
states: with wrapper tests running (1-minute load average 7.49), p95 was 23.11,
37.17, 57.19, and 60.81 ms for 1/2, 1/10, 1/100, and zero matches; after that
suite, with peer agents active (load average 4.65 to 4.36), p95 was 66.84 ms
for 1/100 and 64.67 ms then 60.73 ms on a zero-match rerun. In an idle
measurement (load average 0.60), the corresponding p95 values were 29.90,
42.21, 50.82, and 54.10 ms. These observations show why load is recorded but
not used as an acceptance condition.

A separate in-memory mixed-offset fixture confirmed that SQLite
`unixepoch(last_modified_time, 'subsec')` sorts timestamps with different
offsets chronologically, but on 10,000 rows this query took p50 29.91 ms,
p95 34.33 ms, and max 34.34 ms over 30 runs. This is below the 100 ms
per-helper acceptance limit but slower than indexed text ordering for the
measured fixed-offset encoding. The bounded copied sample had one offset across
all ten timestamp values, so the design keeps indexed text order. Whether
older, unsampled rows use another offset is unknown. The implementation
retains text ordering, counts distinct offset suffixes in each candidate
window, and warns when a query finds a mixture; an operator can then remeasure
the stored encoding and revisit ordering.
