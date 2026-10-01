---
title: Codex home classification implementation evidence
last_updated: 2026-10-01
---

# Codex home classification implementation evidence

The exact five-root classification correction is implemented and passes the
Runner suite and packaged-artifact checks. Independent implementation review
and production preflight remain pending. No production home, unit or installed
release was inspected or changed during these implementation checks. No live
model turn or Codex CLI was used.

## Bound source and decision

- Baseline: `b4770ee07628b25144ae34be39e396fe8efc39d3`.
- Implementation: `a747ea6406fd610a4a6047dfe5a324b421a8deb3`, branch
  `issue-468-classify-home-links`. The following evidence-only commit does not
  change the tested source or packaged runtime.
- [Accepted design](../../plans/issue-468-home-classification.md), including
  immutable upstream source links, the complete 33-root list and review actions.
- Upstream `rust-v0.159.3`: commit
  `01fc69f4026735edfdf6789820549727a4867b11`.
- [Machine-readable record](home-classification-2026-10-01.json) binds source,
  upstream files, test logs, mutation logs, archive and deploy manifest hashes.
  `<scratch>` denotes the evaluator-owned temporary directory, retained until
  review completes; it is not a production home.

Only classification constants change runtime behavior: `agents`, `hooks`,
`model-profiles` and `plugins` are state; the distinct root `cache` is
disposable. Existing exact-name refusal, credential exclusion and non-following
symlink copy/restore remain in force. `plugins/cache` is installed state, not
root cache. Plugin-specific data may contain sensitive values; this change
makes no general secret-scrubbing claim. Snapshots remain private and outside
synchronization/external backups.

## Fixture and observation limits

The committed fixture has exactly the director-confirmed 33 top-level names.
Six actual SQLite databases are created by Node 24.3.0: memories has no sidecars;
five WAL-mode databases retain real WAL/SHM after their fixture child terminates.
All contain a successful migration row. No production DB or credential is copied.

The four instruction links point into owned external fixture settings. Their
target permissions are temporarily 000. Classification and snapshot/restore
succeed without descending into those targets; link text/type survive restore,
target modes and contents remain unchanged, and no external content appears in
the snapshot. Altered current links are restored to the snapshot link text.
Source inventories before/after snapshot and restored DB/sidecar bytes match.
Plugin bundle, plugin data and partial install staging survive; disposable root
cache does not. Snapshot payload excludes root auth, while refreshed synthetic
auth remains current after restore. Existing session bytes are restored.

Plugins includes `cache/openai-curated-remote/.../.codex-plugin/plugin.json`,
installed skill content, local plugin data and
`.remote-plugin-install-staging/partial/bundle.json`. These are structural
fixtures, not native-installed production plugins. Hisui reported metadata-only
production counts: plugins 411 descendants (148 directories, 263 files), cache
7 (4 directories, 3 files), skills 88 (28 directories, 60 files); all three had
zero symlinks, hard-linked files, special files and foreign-owned entries. The
evaluator did not independently inspect production. Actual metadata can change;
production classification must still run before maintenance.

## Test results

All test/build commands remove inherited `CODEX_HOME`, use an isolated scratch
`HOME`, and select Node 24.3.0 explicitly through PATH. Focused tests use
`pnpm exec vitest run test/codexHomeClassification.test.ts` in `runner/`.
The full suite uses `pnpm --filter @kaoiro/runner test` after building wrapper
prerequisites; typecheck uses `pnpm --filter @kaoiro/runner typecheck`.

| Check | Files | Tests | Exit |
| --- | --- | --- | --- |
| New fixture against unchanged baseline classifier | 1 failed | 5 failed | 1 |
| Corrected focused classification suite | 1 passed | 5 passed | 0 |
| Final committed implementation, Runner full suite | 38 passed | 858 passed | 0 |
| Runner typecheck | n/a | n/a | 0 |
| linux-x64 archive build and scratch install | n/a | n/a | 0 each |

Baseline fails on unclassified `agents`; the fixture therefore does not assume
that the new names already work. In particular, the three "refuses unknown
root" cases fail there before reaching their deliberately unknown names; their
baseline failures do not demonstrate unknown-name refusal. That refusal is
supported by the corrected positive assertions and the separate mutation that
removes the unknown-root guard (3 failed / 2 passed, exit 1).
Full suite duration was 95.06 seconds. Expected
fixture error messages and Node experimental SQLite warnings remain in the log;
there were no failing tests. The focused/mutation runs preceded two type-only
non-null annotations; the final full suite ran after the implementation commit.

| Mutation | Failed / passed tests | Exit |
| --- | --- | --- |
| Remove `agents` classification | 5 / 0 | 1 |
| Remove `hooks` classification | 4 / 1 | 1 |
| Remove `model-profiles` classification | 4 / 1 | 1 |
| Remove `plugins` classification | 4 / 1 | 1 |
| Remove root `cache` classification | 4 / 1 | 1 |
| Replace unknown-root refusal with state acceptance | 3 / 2 | 1 |
| Misclassify root `cache` as state | 2 / 3 | 1 |

Each mutation was restored, with the classifier SHA-256 checked after restoration.
Unknown roots `unclassified`, `plugins-extra` and `auth.json.tmp` fail the real
classify CLI with exit 78 and snapshot with a nonzero exit. Assertions require
both no backup and no staging creation. The existing refusal fixture formerly
named `plugins` now uses `unclassified-extension`; its refusal is still tested.

Discarded attempts are not evidence of behavior: an initial pnpm invocation ran
the whole suite before wrapper prerequisites existed; a wrong-working-directory
edit attempt left the old classifier in place; initial typecheck found the two
nullable test lookups; and a root-level packaged probe invocation could not find
Runner's `tsx` dependency (exit 254). Corrected focused, typecheck, final full
suite and packaged executions above replace those attempts. Their raw logs are
retained separately for review.

## Packaged classifier

Build `scripts/build-runner-tarball.sh --target linux-x64 --out <scratch>/built`
from the clean implementation commit. Install with
`runner/deploy/kaoiro-runner-install.sh <archive> --install-dir <scratch>/installed`.
No current/previous link or service is activated. The physical release directory
is `<scratch>/installed/releases/a747ea6406fd610a4a6047dfe5a324b421a8deb3`.

Strict `verify-release.mjs --require-deploy-manifest --hash` succeeds (exit 0),
with 153 manifest files. Corrupting the installed `deploy/codex-snapshot.mjs`
causes exit 70 naming its manifest mismatch. After restoring its original bytes,
strict verification succeeds again. The packaged classifier hash matches source.

An uncommitted scratch probe imports the committed fixture and calls the actual
installed classify CLI and snapshot/restore module. Its final run, after artifact
restoration, has classify 0, snapshot/restore 0, 33 roots and 6 migration DBs.
Instruction links and plugin state survive; root cache is omitted; current auth
is preserved; source inventory is unchanged. An unknown root gives classify 78
and snapshot 1, with zero subsequent staging/backup creations. The probe's own
negative control changes the observed cache category to state and fails with an
assertion (exit 1); the unchanged observation succeeds (exit 0). The probe is a
single-task scratch tool, not a committed verifier or a production gate.

## Review follow-ups and remaining boundary

S1 is addressed by requiring the candidate release's classify preflight before
stop for every pin update. Refusal aborts before stop and requires a separately
reviewed classification; the 12 unverified upstream candidates stay disallowed
and are listed in the design. S2 is addressed by attributed production metadata
and the representative plugin/staging fixture. N1 is the complete 33-name design
list. N2 is the runbook caveat that catalogs can be empty until cache re-fetch,
which must not be confused with lost installed plugin state or history.

The production update plan stays pinned to its previous reviewed target until
the director lands this correction and requests the plan update. This evidence
does not execute or replace production preflight and does not claim production
update acceptance. Test fixture trees are removed by their cleanup handlers;
source archive, build, installed scratch release and logs remain for review and
will be deleted by the evaluator when that review closes.
