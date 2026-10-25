---
title: N2 — minimal native-state transactions and recovery
status: accepted
last_updated: 2026-10-25
---

# N2 — minimal native-state transactions and recovery

Tracking: [issue #709](https://github.com/sakuraiyuta/kaoiro/issues/709).
Parent: [release reduction, sections 4 and 7](issue-709-release-reduction.md).
Baseline: `8986936d9136fb7c7c7545f808543ceffe91dffd`.
This approved design does not approve implementation integration or deployment.
The implementation base after N1 and P3 is
`d3a0801370a11c6e84d566f92a549154369dbac2`. N3 owns the final
recovery-table renderer and exhaustive phase property test; N2 must already
provide working recovery commands and interruption tests.

## 1. Fixed guarantee boundary

Keep B1–B9 of the parent design: a usable home; native-hash-aware switching;
credential exclusion and move-only restore; classification; stopped-writer
checks; verified snapshots; resumable replacement; agreement of the actual,
next-start and requested home paths; and retention of required releases.
Snapshots remain, as the operator decided on 2026-10-22.

Do not retain acceptance, completion receipts, an ordered history of accepted
homes, latest-snapshot-only restore, lineage, legacy repair, barriers, or
retirement evidence. A completed forward proves the updater's post-start
checks, not a Codex model turn or thread resume. Those checks remain manual.

The maintenance contract is cooperative: the updater exclusively owns the
managed service's stop/start and managed home mutations until recovery ends.
Independent Codex writers, manual starts during maintenance, modifications
of an operation's files, and concurrent use of an old tool are unsupported.
Replacing an installed release with `--allow-dirty` while an updater run
is queued or holds `.lock.update` is unsupported.
Boot starts of the enabled unit are in scope: a persisted intent must precede
exposing a release/home pair that may run. An empty managed cgroup does not
establish absence of independent writers.
The existing warning and fresh-setup exit remain. No new launch barrier,
distributed lock, compatibility orchestrator, or credential backup is added.

Classification for the subsequent implementation: **L**. Schema and
release/deploy paths change; concurrency, credentials and destructive
operations are safety-sensitive, and recovery commands change observable
behavior. Protocol, authentication authority, shared harness and dependency
locks need no production change. Expected total diff exceeds 200 lines and
is predominantly deletion. This submission changes documentation only.

## 2. Record and locking model

Use `codex-state/v2/records/<uuid>.json`, private directories (0700) and
regular, single-link, owner-private records (0600). One record owns one
forward snapshot and its subsequent explicitly selected restores. There is
no second backup registry and no acceptance registry. Restoring an older
retained snapshot is allowed when no other operation is unfinished.

| Field | Meaning |
|---|---|
| `schema: 2`, `uuid`, `root`, `service`, `home` | Record identity; canonical installation and home paths, installed unit ID |
| `source`, `target` | Original forward release IDs and native SHA-256 values; immutable, including after a restore |
| `phase` | One of the eight states in section 4 |
| `snapshot` | `{path, staging, status, manifestHash}`; status `planned`, `retained`, `prune-intent`, or `retired`; hash absent until published |
| `tool`, `updaterPid`, `created` | Physical tool release for in-flight protection; PID/timestamp are diagnostic, and PID never authorizes recovery |
| `cleanup` (optional) | Exact staging path, logical bytes counted, and whether its removal remains pending |
| `replacement` (only for restore) | `{attempt, from, priorPhase, staging, aside, credentials, promoted, stateDigest, startRequested}` |
| `asides` | Append-only list of `{attempt, aside}` for every admitted restore; entries survive cancellation, subsequent attempts and snapshot prune |
| `prune` (only during/after prune) | Exact snapshot path and its root device/inode, pre-removal size, removal result |

`replacement.from` is the release at restore admission. Its target is always
`source`, the snapshot's original release. `attempt` gives each restore new
sibling staging/aside names, so repeated restores do not reuse a quarantine.
`credentials` contains only the names present before replacement, never
contents, hashes, or sizes. `stateDigest` hashes the normalized manifest's
state entries, excluding credentials. `promoted` is a durable checkpoint of
filesystem completion, not a second lineage history. `startRequested` is
saved while the configured home is absent, before switching to source and
publishing the restored home; section 5 distinguishes a pending promotion from a home that may have run.
Append the attempt/aside entry atomically with restore admission, before any
rename can create it. An entry whose attempt never reached replacement may
name an absent path; absence does not remove the entry.

Reuse the existing snapshot manifest classification and payload format;
write minimal metadata (UUID, canonical home, source/target native identity).
Remove unit/config identities and receipt material from new manifests. A
manifest's old `source` object shape may remain readable, but device/inode
is not compared for B8. Deletion ownership in `prune` is separate: it
prevents deleting an unrelated directory subsequently created at that path.

Use the existing `atomicJSON` write/fsync/rename/parent-fsync primitive.
Before publishing `snapshot-verified`, sync copied state files, the manifest,
and containing directories, then the snapshot-parent rename. Before a
replacement checkpoint, sync both parents affected by each rename. A failed
sync refuses the next destructive/start step. This requires ordinary local
filesystem rename/fsync semantics; it does not promise survival of storage
failure or provide a power-loss test result.

`.lock.update` remains the mutually exclusive directory, with the existing
manual stale-lock inspection. Acquire it for a whole updater/recovery/prune
operation; do not acquire it recursively in helper subprocesses. Keep
`.lock.links` for current/previous changes, record publication that changes
release protection, install replacement, and release pruning. Order is
update then links whenever both are needed. Installation keeps its existing
install lock and narrow links-lock section; it does not wait for an update
lock held by its caller. Every deletion under the links lock re-reads the
protected release set. Remove `codex-owner.json` and PID/start-tick proofs;
the updater PID in the operation record is diagnostic only.

Public commands acquire their own locks. Updater-internal helper calls run
inside the updater's locks, with the transaction UUID as the operation
selector, not an authority token. A stale lock is never silently stolen.
After an operator proves the old worker gone and removes its stale locks,
a new worker resumes solely from the persisted phase and filesystem state.

Scans validate only the fields needed to identify unfinished operations and
protected releases. Fully validate the selected record before acting on it.
A malformed optional historical diagnostic does not stop another update.
An unreadable/unknown phase or retention field cannot safely be classified;
it refuses mutation with the record filename, without dumping its contents.
This replaces registry-wide receipt/binding validation, not error checking.

## 3. Home agreement and switching

Replace `staticShape`, `checkBinding` and full-binding equality with a small
path check in `codex-service.mjs`:

1. Compute the next-start home from the installed unit environment and the
   launch shim's `runner.env` resolution, using the existing literal parser.
   For every state-aware forward, restore, resume or recover, require a
   non-empty explicit `CODEX_HOME` in this next-start environment before
   stopping; the requested `--codex-home` alone is insufficient.
   Keep the supported-unit restrictions required to compute that path,
   private ownership, and `KillMode=control-group`. Drop recorded fragment
   hashes, environment-file hashes/inodes, manager-environment snapshots,
   and `ExecStart` text equality. Still require the supported launch shim.
2. While active, read only `CODEX_HOME` and `HOME` from the actual MainPID's
   environment. If `CODEX_HOME` is empty/unset, resolve its default from that
   process's `HOME`, not from the possibly edited next-start environment.
   Bracket that read with MainPID and process-start-time checks. These are
   read-consistency checks, not durable transaction-owner proofs.
3. Resolve all present paths to canonical absolute paths and compare paths.
   Before stop, live = next-start = requested. After stop, next-start =
   recorded. A stopped restore also requires snapshot home = requested.
   During the home-absent replacement interval, resolve its existing parent
   plus basename; only this recorded interval may omit the leaf directory.

Same-path environment edits and inode replacement pass B8. A different home
refuses before stop. Unknown unit/environment syntax still refuses: removing
identity checks does not make shell evaluation a safe path resolver.

`guard` without a transaction still requires equal native hashes. Retained
snapshots alone no longer force a state-aware same-pin update; an unfinished
operation does. With a transaction, the guard recognizes only safe forward,
never-started return, and verified restore. No general cross-pin bypass is
introduced. Historical completed/failed records cannot authorize a new
code-only native downgrade.

## 4. Phases and commands

Retain normal updater options. Add mutually exclusive
`--resume-codex-transaction <uuid>` and
`--recover-codex-transaction <uuid>`, usable with `--detach` and the same
physical tool-path pinning. Resume continues the chosen operation; recover
returns a never-started forward to its source or restores its snapshot when
start became possible. They never reinstall or build an artifact. The helper's
`summary` shows phase, snapshot retention and the operation UUID only.
N2 refusal/failure text already names the applicable physical updater with
`--resume-codex-transaction <uuid>` or `--recover-codex-transaction <uuid>`.
A stale-lock error names these commands **after** inspection/removal of the
stale lock; it never recommends bypassing a live owner. N3 centralizes this
rendering, rather than supplying missing R1/R3/R6 exits.

| Durable state | May have happened | Resume / recovery exit |
|---|---|---|
| `prepared` | Stop, partial copy, or complete snapshot publication; candidate never started | Resume snapshot while stopped, or recover unchanged source; remove only owned partial staging and record `failed` |
| `snapshot-verified` | Snapshot durable; current still source; candidate never started | Resume checks stopped state against snapshot, writes `start-intent`, then switches target; recover writes `failed`, then starts unchanged source |
| `start-intent` | Current may be source or target; candidate start may or may not have happened | Resume only the recorded target and post-start checks, then `completed`; recover performs snapshot restore; code-only source return refuses |
| `completed` | Forward post-start checks passed | No acceptance step; new update allowed; explicit restore or prune allowed |
| `failed` | Forward ended before any candidate start request | Does not block another update; pending staging cleanup warns. Recover may retry the unchanged source start only if current still equals source; no historical downgrade authorization |
| `restore-prepared` | Restore admitted; old home untouched; staging absent/partial/complete | Resume rebuilds/verifies only the owned staging and enters `replace-intent`; cancellation before replacement returns to `priorPhase` and restarts unchanged `replacement.from` if appropriate |
| `replace-intent` | Some/all home and credential renames, and possibly source start | Resume the same replacement using section 5; once promoted, start only snapshot source and check it, then `restored` |
| `restored` | Restored source passed post-start checks | Snapshot remains retained until explicit prune; new update, another explicitly named restore, or prune allowed |

Before mutation on resume/recover, re-read current, live/next home agreement
and service activity. In pre-start forward or restore-prepared, a boot may
have restarted the unchanged source/from release. Stop it again and assert
B5 before copy, verification or renames; failure or a populated cgroup leaves
all links/home objects untouched. An inactive service still requires B5.
A pre-start forward with current other than source refuses as inconsistent;
it cannot authorize a code-only return. On resume, a published snapshot that
no longer matches source state (source may have written after boot) refuses
forward with a recover command. Recover settles it and leaves the running
source's state intact; a new update can take a fresh snapshot.

Persist `start-intent` **before** switching current to target, while holding
the links lock; a failed write prevents the switch. This conservatively
routes even a failure before the switch through restore. It is preferable
to deriving startup history from current: the same phase rule covers explicit
start, enabled-unit boot start and a failed link switch. The service template
has [`WantedBy=default.target`](../../runner/deploy/kaoiro-runner.service),
and the [installation runbook](../operations/runner-install.md) enables the
unit and user lingering; a stopped service does not remain stopped across
reboot.
A `start-intent` resume with current still source first stops/asserts B5
and verifies that the stopped state still matches the snapshot; otherwise
it refuses forward and names recover. Then it switches to target and starts
it. If current already equals target, resume may finish its startup checks; recover always stops/asserts B5 and
restores before source activation.

`failed` is written only from the two pre-start forward phases. For source
return, restore the source link and save `failed` **before** requesting its
start; a crash after the start must not leave `snapshot-verified` eligible
for a later forward using a stale snapshot. A failed source restart is an
error, with `recover` retry available and no false success report.

`prepared` is published before staging creation. Snapshot publication is
ordered: create/copy/sync stage, verify, rename to destination, publish the
manifest hash plus `retained` and `snapshot-verified` in one record write.
After a crash with a complete destination but a `prepared` record, compare
its manifest UUID, source/target and home with the selected record, verify
the payload, and adopt it on either resume or recover. Recovery stores the
verified manifest hash and `retained` before settling `failed`: it remains
prunable and protects source like any retained snapshot. For an invalid
owned destination, resume refuses; recover leaves `snapshot.status=planned`,
saves `failed`, reports the unverifiable path, and starts unchanged source.
A terminal `planned` destination may be explicitly pruned by UUID using path
ownership/root identity checks, without requiring a valid manifest. Never
silently delete it. A planned snapshot is not restorable and does not protect
source once the operation is terminal. If destination is absent, recovery
marks it `retired`; owned partial staging follows the cleanup rule below.
If the destination is missing although the record says verified, continuing
forward refuses, but pre-start source recovery still works. Mark the missing
snapshot retired when explicitly resolving that recovery. A directory with
no operation record is not adopted or recursively deleted: report the path
for operator disposition, while leaving ordinary source start available.

A snapshot failure removes its UUID-owned staging, with path and logical
size recorded before removal. If removal fails, persist `cleanup.pending`
and `failed`; a later update warns, and `prune <root> <uuid>` retries exactly
that cleanup. It does not scan and delete arbitrary sibling directories.
These are R1–R3 exits, including the two record/publication crash windows.

The updater's post-start check must read active service state, a positive
MainPID, current/target agreement and the existing artifact attestation;
re-read live home agreement too. A successful `--version` subprocess alone
is insufficient. `started` becomes this completion step, replacing the old
transition into `awaiting-acceptance`. A failed start or check leaves
`start-intent`, or `replace-intent` on restore, and exits nonzero.

## 5. Restore interruption exits (R4)

Admission takes an explicitly named retained snapshot. Verify it and the
original source release/native before stopping anything. No newest-snapshot
or intervening-release restriction remains. If a forward is already
unfinished, only recovery of that record may proceed; selecting an unrelated
snapshot waits until the existing operation is resolved. This is exclusion
of overlapping mutations, not historical lineage.
Recovery from a pre-start forward uses the never-started source-return path,
not restore admission. Thus cancellation of `restore-prepared` cannot
restart an unstarted candidate while reverting its record to a pre-start
phase. Cancellation may restart only unchanged `replacement.from`, including
when `priorPhase` is `start-intent` and its switch has not yet happened. The
restored start-intent still requires snapshot recovery for a later return;
cancellation never selects a new release or makes a never-started claim.
Cancellation records the owned restore-staging path and size, removes it
using the same retryable cleanup rule as a failed forward, clears the
cancelled replacement fields, then restores `priorPhase`. Recover selects
this cancellation exit in `restore-prepared`. After `replace-intent`, both
resume and recover finish the same replacement; cancellation is unavailable
because credentials may already have moved.

Save `restore-prepared`, the previous phase, the current release, and new
attempt-specific sibling paths. Stop and assert B5. Prepare/verify state-only
staging. Record the present credential names, `stateDigest`, and
`replace-intent` durably before renaming the live home. All paths must be
private, owned, disjoint from releases/snapshots and siblings on one
filesystem. Preserve the original home as `aside`; never delete it.

Let H = configured home, S = restore staging, Q = aside. On each resume,
stop the managed service again if active and assert B5 before filesystem
work. Only the recorded from/source releases are admissible as current.
The boot-safe order is H→Q, credentials Q→S, durable start intent, source
link, S→H, startup check. In particular, publishing H before selecting its
native is forbidden.

| H | S | Q | Durable intent | Action on the same record |
|---|---|---|---|---|
| present | present | absent | false | Verify S; rename H to Q and sync parent |
| absent | present | present | false | Finish credential moves; verify S; save `startRequested=true` |
| absent | present | present | true | Verify S and credential locations; idempotently switch to source under links lock, then rename S to H and sync parent; save `promoted=true` |
| present | absent | present | true | Require current=source; promotion happened, possibly followed by boot start; save `promoted=true` if missing, then finish source startup checks |
| any other combination | | | | Refuse further changes; preserve all objects and report fresh setup/manual repair as the remaining exit |

For each recorded credential name, exactly one of Q/name and S/name must
exist before promotion: Q-only → rename to S; S-only → already moved.
Both or neither refuses without overwrite. A name not recorded must be
absent from both. Directories are moved intact; contents are not read.
Snapshot and staging payload verification exclude credentials.

`startRequested` means source activation has been authorized, including a
boot start, not that `systemctl start` returned. Persist it only after all
credential moves and S's `stateDigest` check, while H is absent. Then select
source before promoting S. The restore switch guard admits this exact
`replace-intent`, H-absent, verified-S, credentials-moved observation with
intent true; it does not require the home to have been promoted already.
Hold the links lock through source selection and promotion, syncing the
link parent before publishing H. With explicit `CODEX_HOME`, a boot between
home removal and promotion cannot launch Codex; a boot after promotion can run
only source, and the intent is already durable. If H is present and S absent
with intent true, do not compare mutable H with the old digest or require
pre-start credential locations again: source may have refreshed credentials
or written state. Never repeat home replacement in that observation.
Before H is published, S still must verify even when intent is true.
A second explicit restore uses a fresh attempt and fresh paths in the same
record; it does not re-enter the previous replacement.

B1 uses the existing `codexHomeProblem` missing-directory refusal for an
explicit home; it is not a transaction-aware launch barrier. No new barrier
is added. The parent B1 text must say state-aware operations require explicit
next-start `CODEX_HOME`, and the missing-home interval prevents Codex launch;
it does not prevent the runner service itself from booting.

The runbook includes a one-time preparation for a default-home installation:
resolve the live process's actual home and the next-start default, obtain
operator approval to configure that **same canonical path** explicitly in
the installed environment, then check live/next/requested agreement before
maintenance. Do not relocate data or change production configuration as part
of N2 implementation. Unset/empty next-start `CODEX_HOME` refuses before stop.

No N2 command deletes an aside. The operator owns its eventual cleanup via
the runbook: list `asides` from all records (including pruned snapshots), wait
until the record is terminal (or the attempt has been superseded after
settlement) and no unfinished replacement refers to that path, inspect the
exact directory for state worth retaining, and explicitly remove only that path after choosing to discard it. Do not use wildcard
cleanup or infer permission from snapshot prune. Interrupted replacement
asides may still contain credentials and must remain private. Keep entries
after manual cleanup so repeated restore never loses an earlier aside's name.

## 6. Prune and release protection (R7)

Expose `prune <root> <uuid>`, with no evidence file. No-op on an already
retired snapshot except retrying recorded partial staging cleanup. Require
a terminal phase and no unfinished replacement using that snapshot. Under
both locks, record `prune-intent` with the exact snapshot path, size and root
device/inode before deletion. Initial pruning checks path ownership and
disjointness; it does not require an intact payload to relinquish a corrupt
backup. On retry, an absent directory completes retirement, a partial
directory with the recorded identity is removed, and a changed identity or
symlink refuses. Do not call `verifySnapshot` after deletion has begun.
Only after removal and parent sync save `retired`. Record files remain.
This also accepts an owned terminal `planned` destination left by recovery
of an unverifiable snapshot; missing destinations settle retired. Device/inode
is an accidental-replacement guard, not eternal identity: inode reuse at the
same UUID path could evade it. Concurrent external path replacement is outside
the cooperative contract; no stronger filesystem identity is claimed.

`protected` lists source releases of `retained` and `prune-intent` snapshots.
An unfinished operation additionally keeps the releases needed to finish its
operation: source/target/tool for forward, source/from/tool for restore.
Once terminal, the tool and target cease to be state-derived protection. Current/previous
protection remains the install/updater's independent rule. Do not protect
every release ever mentioned by a historical record.

The updater's common release-prune block, reached by both state-aware
forward and ordinary update, takes `.lock.links` and then requires
`readlink "$root/current"` to equal `releases/$id`, the release activated by
this run. If it differs or cannot be read, remove no releases, report that
the actual current link target (or an explicit unreadable marker), the
expected `releases/$id`, and that pruning was skipped (a later update
retries). Stop through the existing `kaoiro_die` path with exit 75, matching
failure to acquire the links lock; do not print `$id` on stdout or reach
the trailing "is running release" message. The message must not claim that
the activated release is still running. This check precedes the
protected-set read and every deletion. Execute the reader at the fixed
physical path
`$root/releases/$id/deploy/kaoiro-runner-codex-state.mjs`, not through
`current` or the original physical tool directory. Keep the lock through
the read and deletion: install replacement checks the same lock and cannot
replace the checked current release. Reader failure remains exit 78 with
nothing deleted. In an ordinary update the target reader may be pre-N2;
this is safe because N2 preflight/guard refuse to activate a pre-N2 target
while a retained v2 snapshot exists, subject to section 1's unsupported
concurrent tool-replacement limit. Keep the original pinned tool for every
in-flight state action; terminal source-only protection does not change. The running shell
continues reading its already-open updater script safely because install
removes and recreates a release directory rather than overwriting that
script in place.

Record publication and removal of protection happen under `.lock.links`,
the same lock held by install replacement and release prune. Exercise two
real concurrent contenders, including install versus snapshot publication,
before landing; single-threaded mocked lock calls are not sufficient.

## 7. Cutover and returning to old tools

Before every mutating state action and `protected`, project only old
`transactions/*.json` phase and `backups/*.json` retired status. Allow old
transaction phases `completed`, `restored`, `retired`, with every backup
explicitly `retired: true`; missing/unreadable/unknown values refuse. Do not
validate old acceptance fields, edit old records, or convert them to v2.
An old unresolved record prints: "Resolve old Codex state records with the
previous tool release" and names the pre-N2 procedure. Read-only inventory
must still work so the refusal can be diagnosed. Ignored `barriers/` neither
authorize nor block an operation.

Use the last deployed pre-N2 physical tool release for those old records,
before any v2 operation. The deployment release note must name its immutable
SHA and verified tool path; this cannot be a guessed future tag in this
design. U3 remains a per-installation deployment check, not an agent
production probe: check its records at cutover before creating v2 state.
The old tool still has the interrupted-restore and partial-staging defects
listed in issue #695. If its existing recovery/accept/retire/abandon commands
cannot resolve a record, cutover remains refused: preserve the old state and
request operator recovery/fresh setup under the old runbook. N2 does not
pretend that its new exits repair old schema-1 records or rewrite their phase
to bypass admission. An all-terminal/all-retired installation needs no
record migration.

N2 adds exactly this standalone UTF-8 line to its helper (LF or CRLF):

```js
export const CODEX_STATE_SCHEMA = 2;
```

Read the verified target deploy file without executing it; accept exactly
one line matching `^export const CODEX_STATE_SCHEMA = 2;\r?$` in multiline
mode. No matching line (including a differently formatted or unsupported
version) means pre-N2; duplicate matching lines refuse. This is a capability convention in a
verified artifact, not an authentication or JavaScript parser boundary.

Before stopping, refuse a state-aware forward whose source is pre-N2:
"Update to an N2 release with the same native first". B9 holds because the
source remains running. A state-aware target must also be N2-capable before
stop: an old tool must not be activated on newly retained v2 state.
There is no automatic snapshot-discard option, pre-v2 return field or nonterminal prune exception.

| Return path | Executing tool | Rule |
|---|---|---|
| Never-started recovery | Pinned N2 physical updater | Recorded source is necessarily N2-capable; settle failed and restart it |
| Snapshot recovery | Pinned N2 physical updater | Restore only the recorded N2-capable source, preserving its snapshot |
| Manual `switch --rollback` | N2 switch | Equal native hash and no unfinished operation; a pre-N2 target additionally requires no retained/pruning v2 snapshot |
| Source-code revert / reinstall old tarball | N2 installation and switch tools until transition ends | Same conditions; do not invoke old install/prune while v2 retention or an unfinished operation remains |
| Old-record recovery | Last deployed pre-N2 physical tools | Only before v2 creation; old directories remain untouched by N2 |

The first N2 deployment is planned as a same-pin update and creates no v2
record. The dependency is `@openai/codex` `0.161.0` at `3eaf5c99`, `a470e90b`
and this design's baseline; admission still compares actual native hashes,
not the version string. If the pin must change before N2 deployment, stop
and design that transition separately. N2 does not add a bridge release.

Every resumable switch accepts only its recorded before/after release IDs
as current; a third release refuses. Switching to an already-current ID is
idempotent and does not rewrite `previous`. Source-return holds the links
lock through recording `failed` and the source-start check, so temporary
tool protection cannot disappear while the worker still uses that tool.

## 8. Helper rewrite, deletion map and implementation checks

| Area | N2 change |
|---|---|
| `kaoiro-runner-codex-state.mjs` | Replace dual registries with v2 records and the eight phases; keep selected-record checks, snapshot guard, summary/target/protected; implement resume/recover/prune and old-record refusal |
| Same helper | Delete `staticShape`, `validateReceipt`, `validateTransactionState`, `acceptedEvents`, `acceptedHome`, `recoveryLineage`, `liveOwner`, `lockOwner`, `accept`, `retire`, `abandon`, `acceptedForwardTransaction`; remove legacy repair and acceptance exports after P3 consumers are gone |
| `codex-service.mjs` | Path agreement of section 3; retain installed-unit interpretation, private ownership and `assertStopped`; N1 already removes the foreign-UID walk |
| `codex-snapshot.mjs` | Retain classification/manifest verification/capacity; reduce binding metadata; durable copy publication; replace phase-per-credential callbacks with resumable replacement observation |
| `kaoiro-runner-update.sh` | Resume/recover options, durable start ordering, source-restart settlement, active/MainPID post-check, remove acceptance guidance and owner-proof cleanup |
| `kaoiro-runner-switch.sh`, `kaoiro-runner-install.sh` | v2 switch authorization and old-tool refusal; projection-based protection under links lock |
| `codexReceipt`, `codexLineage`, `codexLineagePending`, `codexLegacy` tests and lineage harness | Delete only after the case inventory below is fulfilled; keep old-record cutover tests in `codexState` |
| `codexStateWorkflow`, `codexState` tests | Follow the case inventory; add interruption exits independently of the eventual N3 table. Keep `codexHomeClassification` and wrapper home tests |

Update only affected sections of `runner-update-and-rollback.md`,
`codex-home.md`, `runner-install.md`,
`reference/deployment/transactions-and-identity.md`, and ADR-0069. Remove
acceptance/receipt/lineage/abandon/evidence-retirement instructions and inbound
links. N2 documents its recovery commands; N3 consolidates their hints/table.
At N2 landing also amend the parent's B1 row as specified in section 5 and
its S16 row to explicitly include the tool and target of an unfinished
forward in in-flight protection (source-only once terminal).
No server recovery, publication workflow, enrollment, native pin, package
lock or production configuration is changed by N2.

The helper's two child processes go through `execChildSync` with closed
profiles ([design delta](https://github.com/sakuraiyuta/kaoiro/issues/709#issuecomment-6391542536)).
The physical switch uses `codex-switch`: `XDG_RUNTIME_DIR` and
`DBUS_SESSION_BUS_ADDRESS` for the nested guard's `systemctl --user`,
`KAOIRO_SYSTEMCTL` so that the nested guard reads the same service manager
as the parent, and `KAOIRO_NODE`. The post-start attestation uses
`codex-attest`: `KAOIRO_NODE`, which is still set to the helper's own
interpreter, and the `KAOIRO_RUNNER_DIR`, `KAOIRO_RUNNER_ENV` and
`XDG_CONFIG_HOME` selectors. Through these selectors, the launch shim sources
the same runner.env as the updater's own attestation. Both profiles also keep
the common keys. `NODE_OPTIONS`, shell loaders and credentials do not reach
either child. The helper is in the checker's managed scope. Test fixtures
reach processes nested in the switch through their own `KAOIRO_NODE` wrapper,
not through `NODE_OPTIONS`.

The [case-level test migration inventory](issue-709-n2-test-inventory.md)
is required before deleting/replacing tests. Each retained row names a
surviving test group and its guard mutation; create those replacements first,
then delete old cases/harness imports. Reconcile the inventory with N1/P3 at
implementation start, especially the S13 cases rescued by N1. Record exact
candidate, test names and red mutation results; green suite totals alone do
not establish coverage. Remove old harness only after every retained row
has a replacement and every guard whose sole coverage was removed has a
red mutation result. Unchanged primitive checks retain their existing tests;
do not turn this migration into a re-audit of unrelated guards.

Implementation acceptance, run on the exact committed candidate through the
project's runner typecheck and full test suite in the remote test environment:

- Real shipped updater through its physical/symlink entry, disposable
  installation/home: cross-native forward, post-start completion, restore,
  same-pin update with a retained snapshot, and permitted/refused old-tool
  returns.
  Keep service-manager fakes for deterministic faults, and separately run
  disposable real-systemd start/stop/cgroup/path agreement controls before
  deployment. Never count synthetic service replies as systemd evidence.
- Kill the owned worker before/after snapshot rename and record publication;
  before start intent, after intent but before start, and after start but
  before completion. Dead-owner recovery must not depend on the original
  PID. At every cut, assert actual current link, service calls, record, home,
  snapshot/staging presence, and a completing recovery command.
- Fake-manager boot cases use the shipped updater and an enabled-unit boot
  action that resolves current and writes a native-specific state marker;
  it must run independently of updater `start` calls. Cut after forward link
  switch before explicit start: record is already `start-intent`, target
  boot writes state, recover must restore before any source launch. Cut
  before link switch with intent saved: conservative restore still works.
  Boot in prepared/snapshot-verified on source: resume/recover stops again,
  asserts B5, and rejects stale snapshot reuse while recover remains usable.
  On restore, boot at every H→Q, credential, intent, source-link, S→H and
  promoted checkpoint boundary. H absent must reject Codex launch through
  the real missing-home guard; H published can start only source. Have that
  boot mutate H and refresh credentials before resume; require completion
  without digest/location refusal or a second replacement. Assert source/target calls and H/S/Q, not just
  exit status. Separately move each intent write after its exposure step;
  each mutant must fail the corresponding boot case. This deterministic
  control does not substitute for the disposable real-systemd check above.
- Interrupt before/after every home/credential rename and source-start
  request. Resume twice; no old credential bytes appear, current credential
  file/directory identities are preserved, and aside state is untouched.
  Before promotion, missing/both credential locations refuse without
  overwrites. Restore the same snapshot twice, then cancel another attempt
  and prune: every `{attempt, aside}` entry remains discoverable and no
  command removes the earlier aside directories.
- R2: partial staging, complete snapshot with `prepared` record, verified
  record without snapshot, and orphan snapshot. Recover a valid complete
  destination into retained/failed then prune; recover an invalid one into
  planned/failed then explicitly prune without payload verification. R7:
  kill during recursive deletion, retry after root disappearance, and reused
  root/symlink refusal.
- B2/B5/B6/B8 controls: unbacked cross-pin switch, populated cgroup after
  stop, corrupted snapshot, live home A versus next-start B, and next-start
  path changed after preparation. Refuse in the actual control flow and
  count zero subsequent switch/start/replacement calls where applicable.
- Same-path environment edit and inode change pass; real child `/proc`
  environment supplies the live path and fallback HOME, not fixture data.
  An unset/empty next-start home refuses before stop, while a live default
  plus explicit next-start identical path passes. The missing explicit home
  test exercises the real runner/Codex launch path after boot. Production
  defaults receive a lifecycle test independently of injected service fakes.
- Cutover: every old unfinished phase/unretired reference refuses; all
  terminal/retired old records pass despite obsolete receipt metadata.
  Legacy and v2 directories' bytes stay unchanged on refusal.
- Protected-release concurrency: two contenders, install replacement and
  snapshot publication, no protection gap; completed target/tool becomes
  prunable but snapshot source does not. Pre-N2 tool capability must refuse
  with a retained snapshot even when native hashes match.
- Common release-prune reader controls, using shipped updater/install code
  with a recording manager: (1) after a state-aware forward completes,
  replace a third dirty physical tool with an archive containing the actual
  pre-N2 helper before prune; (2) repeat with an ordinary update and a
  retained snapshot from an earlier forward. In each case compare an
  unchanged-tool control, require the installer to succeed, and preserve
  the retained snapshot and its source release. For each path separately,
  mutating the reader back to the original tool must fail the source
  preservation assertion. (3) Move current away from this run's activated
  release before the prune lock is acquired: exit 75 with the skip message
  and no release deletion; removing the current check must make this test
  fail. (4) Make the selected physical reader fail: exit 78 and no release
  deletion; treating failure as an empty protected set must make this test
  fail. Retain existing unfinished tool/target protection and terminal
  source-only projection tests. These are reader-selection checks, not
  evidence about native execution or service-manager lifetimes.
- Mutate one new guard/phase-ordering branch or caller wiring at a time;
  corresponding tests must fail, then restore and rerun. At minimum remove
  the durable-intent write, the path comparison, the prune identity guard,
  and the pre-v2 source/activation checks separately. Run mutations remotely.

## 9. Observation and limits

The development-only `--allow-dirty` replacement excluded by section 1 is
not mechanically refused throughout an updater run. These fresh reads of
the physical tool remain within that documented limit:

- Ordinary update: nested install, preflight, and switch (including the
  switch helper's guard). A third tool release need not be current,
  previous or protected by a state record during these reads.
- State-aware update before `prepare` / `prepare-restore` records the tool:
  nested install, the tool's `VERSION`, and the prepare helper itself.
  In-flight record protection starts only after preparation is published.

Review inferred, without measuring these earlier-read windows, that replacing
the ordinary tool with pre-N2 code could bypass the N2 preflight/guard,
activate a pre-N2 target, and let that target's prune reader under-report v2
protection. How a pre-N2 helper handles state-aware prepare arguments was
not established and may fail closed. The shared prune reader rule is defence
in depth; it does not establish safety for every unsupported replacement
window. A mechanical prohibition on replacing an installed release while an
updater owns `.lock.update` is outside N2's scope.

Measured on 2026-10-22 with the appendix recipe, using the production
`codex-snapshot.mjs` functions and the real shell `kaoiro_lock_acquire` from
baseline `8986936d9136fb7c7c7545f808543ceffe91dffd`. A disposable remote
`test` run reported **pass, exit 0**, no warnings/unhandled errors,
822 stdout bytes and 0 stderr bytes. The container image was
`sha256:ca00bbbd878662d0fec8acd87fffe50384a04aa93e25f4e0bcf7f6b3673296b4`.
The one-off probe is verification tier (c): actual product verification plus
a corrupt-payload negative control, rather than a new maintained checker.

| Observed event | Actual result | Design consequence |
|---|---|---|
| Snapshot published before phase save | Phase file still `prepared`; snapshot exists; staging absent; credentials omitted | A complete snapshot can precede its record checkpoint; R2 must reconcile it |
| Corrupt payload control | Production `verifySnapshot` threw | Hash verification is an effective check, not just metadata inspection |
| Two lock attempts with owner alive | Both exited 75; lock still exists | Directory exclusion works against a simultaneously alive owner; the two contender attempts were sequential |
| Owned child killed after credential move | Saved `credential-moved:auth.json`; H absent, S/Q present; credential only in S; lock remains; child signal `SIGKILL` | Process death neither rolls back renames nor releases directory locks |
| Old restore and lock retried | Both refused | New resume logic and explicit stale-lock handling are needed |
| Remaining promotion done with filesystem primitives | H present, S absent, Q preserved; credential inode unchanged; old snapshot history in H and newer history in Q | The observed interrupted layout has a non-copying completion path; this is not proof of the future v2 handler |
| One payload file removed after prune intent | Snapshot root still exists; old verification refuses | Prune retry must not require an intact manifest/payload |
| Prune completed | Snapshot absent; phase file says retired | Retirement can follow confirmed removal |
| Cleanup | Probe root absent | Probe-owned home, records, snapshot and locks were removed |

The appendixed source SHA-256 is
`bc2261f9b0bbddb71f30de793b7ab28c9743d832122ce372c276c5b5d3c907ed`;
the exact stdout SHA-256 is
`8f41ae9d0c03163fc7b13c484bde30f55b673a36ea578c4c347ce1a56d6fb3ec`.
Run it by saving the appendix body and passing it to the remote test helper
as `node --input-type=module -e <body>` against the clean baseline checkout;
no dependency preparation is needed. The appendix also accepts a checkout
argument when saved as a file.

These are observations of real record writes, snapshot verification,
directory locks, renames and process death. The v2 schema/phase logic is
proposed, not tested. Real systemd and Codex are not exercised here; their
existing stopped-service/path contracts are retained, and integration checks
remain implementation/deployment acceptance work. No claim about power-loss
survival follows from a process-kill experiment.

## 10. Design choices and remaining validation

The design uses pre-stop refusal for a pre-N2 state-aware source, one record
per snapshot with an append-only aside list, temporary forward tool/target
protection, and explicit next-start `CODEX_HOME`. These are the director's
2026-10-22 decisions. No snapshot-discard return mechanism or new launch
barrier is proposed. The implementation remains L and needs its independent
review after design approval; the director owns dispatch and landing.

The primitive observation below remains evidence of filesystem/lock lifetime,
not a passed v2 boot test. The revised ordering, case migration and new
negative controls are implementation acceptance requirements, not measured
behavior of code that has yet to be written. No production action is included.

## Appendix: disposable primitive observation

This is a one-off observation recipe, not a shipped test or a prototype of
the v2 state machine. Save the fenced body as `lifecycle.mjs` and run
`node lifecycle.mjs <checkout>` against the baseline named above, inside the
disposable remote test environment. The phase file is deliberately minimal;
it observes `atomicJSON` persistence and the existing restore callback, not
the schema reader. No service manager or Codex native is started.

```js
import * as fs from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const repo = process.argv[2] || '/w/repo';
const modulePath = join(repo, 'runner/deploy/codex-snapshot.mjs');
const s = await import(modulePath);
const dir = fs.mkdtempSync('/tmp/n2-lifetime-');
const home = join(dir,'home'), backup = join(dir,'backup'), stage = join(dir,'restore'), aside = join(dir,'aside'), record = join(dir,'record.json'), lock = join(dir,'.lock.update');
const emit = (event, data) => console.log(JSON.stringify({event,...data}));
const exists = p => fs.existsSync(p);
let child;
try {
 fs.mkdirSync(home,{mode:0o700}); fs.mkdirSync(join(home,'sessions'));
 fs.writeFileSync(join(home,'sessions/thread.jsonl'),'old-history');
 fs.writeFileSync(join(home,'auth.json'),'synthetic-credential');
 const authIno=fs.statSync(join(home,'auth.json')).ino;
 const uuid=randomUUID();
 s.atomicJSON(record,{phase:'prepared',uuid});
 const result=await s.snapshot(home,backup,{uuid,staging:join(dir,`.staging.codex-${uuid}`)});
 assert.equal(s.verifySnapshot(backup,result.sha256).uuid,uuid);
 assert.equal(exists(join(backup,'state/auth.json')),false);
 emit('snapshot-before-phase-save',{phase:JSON.parse(fs.readFileSync(record)).phase,snapshot:exists(backup),staging:exists(join(dir,`.staging.codex-${uuid}`)),credentialsOmitted:true});
 s.atomicJSON(record,{phase:'snapshot-verified',uuid});
 const payload=join(backup,'state/sessions/thread.jsonl');
 fs.writeFileSync(payload,'bad');
 assert.throws(()=>s.verifySnapshot(backup,result.sha256),/Snapshot payload mismatch/);
 fs.writeFileSync(payload,'old-history');
 emit('corrupt-payload-control',{refused:true});
 fs.writeFileSync(join(home,'sessions/thread.jsonl'),'new-history');
 s.prepareRestore(backup,result.sha256,home,stage);
 s.atomicJSON(record,{phase:'restore-prepared',uuid});
 const program=`import {promoteRestore,atomicJSON} from ${JSON.stringify(modulePath)}; import fs from 'node:fs';
fs.mkdirSync(${JSON.stringify(lock)},{mode:0o700});
promoteRestore(${JSON.stringify(home)},${JSON.stringify(stage)},${JSON.stringify(aside)},phase=>{atomicJSON(${JSON.stringify(record)},{phase}); if(phase==='credential-moved:auth.json'){process.stdout.write('ready\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);}});`;
 child=spawn(process.execPath,['--input-type=module','-e',program],{stdio:['ignore','pipe','pipe']});
 await new Promise((ok,fail)=>{child.stdout.once('data',ok);child.once('error',fail);child.once('exit',c=>fail(new Error('child exited early '+c)));});
 const contender=()=>spawnSync('/bin/sh',['-c','. "$1"; kaoiro_lock_acquire "$2"','probe',join(repo,'runner/deploy/kaoiro-runner-common.sh'),lock],{encoding:'utf8',env:{PATH:process.env.PATH}});
 const a=contender(), b=contender(); assert.equal(a.status,75);assert.equal(b.status,75);
 emit('contenders-while-owner-alive',{exit:[a.status,b.status],lock:exists(lock)});
 const exited=new Promise(ok=>child.once('exit',(code,signal)=>ok({code,signal})));
 child.kill('SIGKILL'); const death=await exited;child=undefined;
 const state={phase:JSON.parse(fs.readFileSync(record)).phase,home:exists(home),stage:exists(stage),aside:exists(aside),credentialInStage:exists(join(stage,'auth.json')),credentialInAside:exists(join(aside,'auth.json')),lock:exists(lock),...death};
 assert.equal(state.home,false);assert.equal(state.credentialInStage,true);assert.equal(state.credentialInAside,false);
 assert.equal(fs.statSync(join(stage,'auth.json')).ino,authIno);
 emit('after-owner-death',state);
 assert.equal(contender().status,75);
 assert.throws(()=>s.promoteRestore(home,stage,aside,()=>{}));
 emit('old-restore-rerun',{refused:true,staleLockStillRefuses:true});
 fs.rmdirSync(lock);assert.equal(contender().status,0);
 fs.renameSync(stage,home);
 s.atomicJSON(record,{phase:'restored',uuid});
 assert.equal(fs.readFileSync(join(home,'sessions/thread.jsonl'),'utf8'),'old-history');
 assert.equal(fs.statSync(join(home,'auth.json')).ino,authIno);
 assert.equal(fs.readFileSync(join(aside,'sessions/thread.jsonl'),'utf8'),'new-history');
 emit('manual-finish-primitives',{phase:'restored',home:true,stage:exists(stage),aside:exists(aside),credentialInodePreserved:true});
 fs.rmdirSync(lock);
 s.atomicJSON(record,{phase:'restored',uuid,prune:'intent'});
 fs.rmSync(payload);assert.throws(()=>s.verifySnapshot(backup,result.sha256));
 emit('partial-prune',{recordedIntent:true,snapshot:exists(backup),oldVerificationRefuses:true});
 fs.rmSync(backup,{recursive:true});s.atomicJSON(record,{phase:'restored',uuid,prune:'retired'});
 emit('pruned',{snapshot:exists(backup),phase:JSON.parse(fs.readFileSync(record)).prune});
} finally {
 if(child){const exited=new Promise(ok=>child.once('exit',ok));child.kill('SIGKILL');await exited;}
 fs.rmSync(dir,{recursive:true,force:true});emit('cleanup',{remaining:exists(dir)});
}
```
