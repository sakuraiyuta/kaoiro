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

The bounded copy of the agy 1.2.11 database and synthetic SQLite measurements
are recorded in [the schema evidence](../evidence/antigravity/conversation-summaries-schema.md).
The copied kaoiro-origin row had two decoded `file:` workspace URIs, one matching
the agent cwd and one matching the epoch customization directory; no session ID
or row contents are retained in this plan. The observed cwd match depends on the
wrapper invariant and test pin described under Chosen approach.

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

The synchronous scan acceptance limit, set by director (kuroe), is p95 at or
below 60 ms for a 10,000-row candidate window with zero workspace matches.
Measured timings by workspace-match density and a runnable harness are in
[the performance evidence](../evidence/antigravity/conversation-summaries-schema.md#synchronous-scan-measurements).
Keep the 10,000-row window: picker and restore requests are operator-triggered
and infrequent, a roughly 55 ms event-loop pause is acceptable, and reducing
the window would hide older sessions. A SQL prefilter was rejected because
percent-encoding differences could hide a real match and it would change which
malformed rows produce warnings. Bulk restore performs N sequential existence
checks; if each encounters a continuously locked database, the 100 ms busy
timeout can accumulate to roughly `100 ms × N`.

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
  sidecar findings, and performance figures. Its committed benchmark harness
  is `docs/evidence/antigravity/benchmark-session-index.mjs`.
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
- Pin that `file:` workspace members with `?query` or `#fragment` are rejected
  consistently whether they appear before or after the matching cwd URI. A
  mutation that skips this validation must make that test fail.
- The existing default-host epoch-args test in
  `wrapper/antigravity/test/host.test.ts` must assert that actual spawn args
  contain `--add-dir <agent cwd>`. Mutate the wrapper args to omit the cwd
  entry and verify this test fails, then restore and verify it passes.
- Pin the mixed-offset warning for a synthetic candidate window with two
  offset suffixes; verify it is absent for a single-offset window and
  listing/existence remain available when offsets are mixed. Mutation
  control: bypass the offset-count warning branch and confirm its positive
  test fails, then restore and confirm it passes.
- Run the committed performance harness for match densities 1/2, 1/10, 1/100,
  and zero matches after building the runner. Report p50, p95, and maximum;
  acceptance is p95 <=60 ms for the zero-match 10,000-row window.
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
  and synchronous scan timing. `docs/evidence/antigravity/benchmark-session-index.mjs`
  reproduces the workspace-density measurement.
- `docs/operations/runner-install.md` — diagnose an empty picker after an agy
  update by checking the schema warning and `user_version`.
- Issue [#381](https://github.com/sakuraiyuta/kaoiro/issues/381) — report the
  old-session picker consequence after the implementation lands.
