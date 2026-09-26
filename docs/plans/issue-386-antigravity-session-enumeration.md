---
title: Issue 386 — Enumerate and verify Antigravity sessions
description: Read Antigravity session metadata from conversation_summaries.db for the picker and resume validation.
status: in_progress
last_updated: 2026-09-26
issue: 386
must_fix_rounds_used: 0
---

# Issue 386 — Enumerate and verify Antigravity sessions

This design starts from `develop` at
`b71674a28baa0b1e4b113dca40ce02b220e6373c`. The worktree is
`worktrees/hiiro-386` on `issue-386-antigravity-session-enumeration`.

## Problem and evidence

Issue [#386](https://github.com/sakuraiyuta/kaoiro/issues/386) reports that the
Antigravity session picker is empty and that restoring an agent after a runner
restart fails with `session_not_found`. At the design baseline,
`runner/src/sessions.ts:343-369` returns an empty list and `false` for
Antigravity. The default resume path calls `sessionExists` before launching
(`runner/src/supervisor.ts:795-810`, `1276-1286`); enumeration calls
`listSessions` and sends an empty list on errors (`supervisor.ts:1230-1253`).
The issue's 2026-09-23 production observation independently records the resume
failure on runner `063b6899`.

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

The director also relayed an observation that Antigravity's whoami result did
not include `session_id`, while Claude and Codex results did. This is tracked
separately in [issue #418](https://github.com/sakuraiyuta/kaoiro/issues/418).

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

For the synchronous scan budget, a synthetic database used the measured
`workspace_uris` shape and ten thousand newest candidate rows. Parsing each row
in JavaScript took p50 44.91 ms, p95 51.45 ms, and max 109.64 ms over 30 runs,
so that design is rejected. A bounded CTE plus a SQLite function that decodes
each `file:` URI and compares the normalized path returned at most 500 rows;
in 30 runs it took p50 6.82 ms, p95 8.72 ms, and max 9.95 ms on Node v24.3.0.
The implementation will use this second shape and keep the 10,000-row
candidate window. A separate 100 ms busy timeout bounds lock waiting; a
successful scan is about 10 ms or less in the synthetic measurement, while an
operation that waits on a lock can block for about 100 ms. A lock released
near the timeout could add the scan time. During bulk restore, `sessionExists`
uses a primary-key lookup, but N sequential checks against a continuously
locked database can still wait up to roughly `100 ms × N`; each check then
fails closed.

A separate in-memory mixed-offset fixture confirmed that SQLite
`unixepoch(last_modified_time, 'subsec')` sorts timestamps with different
offsets chronologically, but on 10,000 rows this query took p50 29.91 ms,
p95 34.33 ms, and max 34.34 ms over 30 runs. That exceeds the measured
approximately 10 ms budget. The bounded copied sample had one offset across
all ten timestamp values, so the design keeps the indexed text order for the
measured encoding. Whether older, unsampled rows use another offset is
unknown; finding mixed offsets in the agy database requires revisiting the
candidate ordering and remeasuring before implementation.

## Chosen approach

Use Node's built-in `node:sqlite` `DatabaseSync`; do not add `better-sqlite3`
or raise `engines`. The runner is distributed as a self-contained tarball that
includes native modules for the target Node ABI
([runner distribution](../operations/runner-install.md)); a new native
dependency would require release packaging and verifier work that this
feature does not need.

Load `node:sqlite` lazily inside the Antigravity database helper using a
try/catch. No static import may make `sessions.ts` or the runner fail during
module initialization. Check the runtime capability window before opening the
database and verify the required API is present. If the module is missing, an
option is unavailable, or loading/opening/querying fails, only Antigravity
listing/existence returns `[]` / `false`. Emit one rate-limited warning line
per cwd and failure class at most once per minute, resetting after a successful
read; do not print a stack or database row. The warning for a schema mismatch
includes the observed `user_version` and missing column names. Claude and
Codex startup, listing, and existence checks remain
independent of this lazy path. No fallback scans conversation files or trusts
an unverified ID.

Open the live index with `{ readOnly: true, timeout: 100 }`, run only bounded
SELECTs, and close in `finally`. Each operation sees a SQLite WAL snapshot.
The reader does not block WAL writers, but can update/create `-shm` and
`-wal` sidecars and can briefly delay a checkpoint. The synthetic sidecar test
showed that a later ordinary SQLite writer can continue. No checkpoint,
journal-mode PRAGMA, or write is issued by the runner.

Require `user_version=3` and all columns used by the query, including
`nesting_depth`. If `nesting_depth` is absent, the schema check fails closed
for both listing and existence; listing all rows would reintroduce nested
subagent sessions into the picker. A missing database is never created.
Missing, locked, unreadable, mismatched, or unsupported data returns `[]` /
`false`; malformed non-empty workspace data also fails to match and produces
a rate-limited warning. Do not fall back to a legacy file scan.

`workspace_uris` accepts the measured JSON array of `file:` URI strings; an
empty string means that row has no known workspace. Require the JSON root to
be an array. Decode each `file:` URI with Node's `fileURLToPath`, then normalize
the decoded path. A malformed array or malformed `file:` URI makes the row a
non-match and emits the rate-limited warning; non-file schemes are ignored.
When the requested cwd exists, canonicalize it with `fs.realpathSync` before
comparison. If it does not exist, retain its normalized literal path, which
can match only an identical stored path. Require exact equality; do not use
prefix matching. This checks every array member without assuming which member
is the agent cwd or a customization directory. Matching depends on the wrapper
invariant at `wrapper/antigravity/src/host.ts:1290` that agent cwd is passed as
an `--add-dir`. A single observed row cannot distinguish whether agy stores
its process cwd or an `--add-dir`; both values were the same for the measured
launch, so either behavior matches kaoiro-launched sessions. Pin this wrapper
invariant with a test asserting that epoch args contain `--add-dir` followed
by the agent cwd.

For `file://host/path`, reject any URI with a non-empty authority before
calling `fileURLToPath`, independent of platform. The POSIX failure observed
in the test-only case must not become a Windows UNC match.

Stored timestamps use the measured fixed-width
`YYYY-MM-DD HH:mm:ss.fffffffff+HH:MM` shape. Parse this shape with a fixed
regular expression, convert the nine fractional digits to milliseconds with
rounding, build the UTC instant from the captured date/time fields, and apply
the signed offset. Do not use implementation-dependent `Date.parse` for this
format. A non-matching or invalid timestamp is skipped. SQLite text ordering
is used for the bounded candidate window; this relies on the measured
fixed-width representation using a consistent offset. The runtime offset
count described above makes violations observable without failing closed; a
mixed-offset warning means picker order and candidate selection may be wrong
until the stored encoding is remeasured.

For `listSessions(cwd, "antigravity")`, materialize the newest 10,000 rows
with `nesting_depth=0`, ordered by `last_modified_time`, and count distinct
`substr(last_modified_time, -6)` offset suffixes in that candidate window.
Emit the rate-limited mixed-offset warning when the count exceeds one, then
apply the workspace matcher in SQLite and return at most 500 rows. Register the URI
matcher as a deterministic SQLite function; `directOnly` is not needed for
these runner-issued SELECTs. Map `title` to optional `summary` and
`last_modified_time` through the fixed-format parser to `mtime`; skip rows with
an invalid time. Never return `preview` or `raw_summary`. A session outside the
newest 10,000 candidate rows for its workspace will not appear in the picker.
Subagent conversations (`nesting_depth > 0`) are excluded. Keep rows with
`killed=true` and do not filter by `status`, as decided by the director.

For `sessionExists(cwd, id, "antigravity")`, validate the ID, query the exact
primary key, and run the same workspace matcher. Unknown, malformed, missing,
or other-workspace IDs return false. This existence check reports whether a
known row exists even if it is nested or killed; the nesting decision changes
picker contents only.

## Scope

- Implement Antigravity listing and existence in `runner/src/sessions.ts` and
  add synthetic fixture coverage. Tests may inject a database path or loader;
  a separate default-path test will use a temporary home directory and no
  injected database dependency.
- Keep the existing default-host epoch-args assertion in
  `wrapper/antigravity/test/host.test.ts` as the cwd `--add-dir` invariant pin;
  no wrapper production change is in scope.
- Update `docs/reference/protocol/runner-control.md` with the metadata source,
  cwd scoping, nested-session filtering, fail-closed behavior, and the limit
  that sessions outside the newest 10,000 candidate rows may not appear.
- Mark B3 complete in `docs/plans/phase-34-antigravity-adapter.md` after
  landing.
- At landing, update this plan's frontmatter to `status: implemented` and set
  `last_updated` to the landing date.
- Add `docs/evidence/antigravity/conversation-summaries-schema.md` with the
  schema, bounded row encoding measurement, copy hashes/mtimes, Node API and
  sidecar findings, and performance figures.
- Add operator notes to `docs/operations/runner-install.md`: after an agy
  update, an empty picker should prompt checking the runner's schema warning
  and the database `user_version` before treating it as no sessions; the
  `ExperimentalWarning` emitted on first SQLite import in each runner process
  appears in the journal and is harmless log noise.
- After landing, comment on issue
  [#381](https://github.com/sakuraiyuta/kaoiro/issues/381) that its old-session
  picker consequence is lifted.

Out of scope: runner/server production services, dashboard and wrapper
production code, transcript replay, session reset behavior, changing the supported engine
range, live-agent tests, and opening the original database again. No new
runtime dependency is planned.

## Validation

- Use a synthetic database fixture based on the measured schema and row
  encodings: JSON arrays of `file:` URIs, empty `workspace_uris`, timestamp
  text with fractional seconds and UTC offset, and rows with both zero and
  positive `nesting_depth`. Include killed rows to pin that they remain in the
  picker. URI cases for
  `file:///home/x/%E3%83%86%E3%82%B9%E3%83%88`,
  `file:///home/x/space%20dir`, `file://host/path` (always rejected because
  it has a non-empty authority, independent of platform),
  `https://host/path`, and `file:///home/x/cwd/` are explicitly marked as
  test-only cases not present in the measured sample. Positive controls cover
  exact cwd matching and a symlink cwd canonicalized through
  `realpathSync`, URI decoding, fixed-format timestamp parsing, metadata
  mapping, newest-first order, and known-session T3 resume. Negative controls
  cover a different cwd; a missing cwd that only matches its identical
  literal path; malformed/unknown IDs; malformed URI values; nested rows
  omitted from listing; and IDs from another workspace.
- The existing default-host epoch-args test in
  `wrapper/antigravity/test/host.test.ts` must assert that actual spawn args
  contain `--add-dir <agent cwd>`. Mutate the wrapper args to omit the cwd
  entry and verify this test fails, then restore and verify it passes.
- Pin the mixed-offset warning for a synthetic candidate window with two
  offset suffixes; verify it is absent for a single-offset window and
  listing/existence remain available when offsets are mixed. Mutation
  control: bypass the offset-count warning branch and confirm its positive
  test fails, then restore and confirm it passes.
- Exercise the default database path with a temporary home directory and no
  injected path/loader until the first meaningful list and existence calls.
  Assert that a missing database returns `[]` / `false` and is not created.
- Against synthetic files only, test a held exclusive lock: the read waits at
  most the configured timeout, returns `[]` / `false`, and does not throw.
  Test a WAL fixture with no sidecars: a read-only SELECT may create sidecars,
  leaves the main database hash unchanged, and a normal writer can subsequently
  insert and read data. An attempted write through the read-only connection
  must fail.
- Inject an unavailable `node:sqlite` loader and runtimes missing required
  options. Verify the runner's local startup path still runs and Claude/Codex
  listing and existence work, while Antigravity returns `[]` / `false` with
  one rate-limited warning line. Repeat for schema-version mismatch and a
  missing `nesting_depth` column, asserting the warning includes the observed
  version and missing column. Do not contact a production service.
- Mutation control: change the Antigravity dispatcher back to `[]` / `false`
  and confirm the positive list, existence, and T3 controls fail; restore the
  implementation and confirm they pass. Remove the lazy-load/capability guard
  in a separate negative control and confirm the injected unsupported-runtime
  test fails, then restore it.
- Migrate detailed measurement records from this plan to
  `docs/evidence/antigravity/conversation-summaries-schema.md` in the
  implementation commit, keeping only design conclusions and an evidence link
  here. The evidence file will include both source-copy hash/mtime tables,
  the JavaScript nanosecond-rounding note, the reported out-of-procedure live
  connection (without its query result), synthetic sidecar and performance
  measurements, and versioned Node documentation links. The whoami observation
  is tracked in issue [#418](https://github.com/sakuraiyuta/kaoiro/issues/418).
- Run `pnpm -C wrapper build`, runner typecheck, runner build, and the full
  runner suite. Report exit codes separately from pass counts, unhandled
  errors, and warnings. Report the performance run, the lock timeout, the
  journal warning, and the negative-control red → restore → green output.

## Docs

- `docs/reference/protocol/runner-control.md` — Antigravity session metadata,
  cwd matching, picker filtering, and unavailable-index behavior.
- `docs/plans/phase-34-antigravity-adapter.md` — mark Stage B3 complete.
- `docs/evidence/antigravity/conversation-summaries-schema.md` — measured
  schema and bounded row encoding, supported Node window, sidecar behavior,
  and synchronous scan timing.
- `docs/operations/runner-install.md` — diagnose an empty picker after an agy
  update by checking the schema warning and `user_version`.
- Issue [#381](https://github.com/sakuraiyuta/kaoiro/issues/381) — report the
  old-session picker consequence after the implementation lands.
