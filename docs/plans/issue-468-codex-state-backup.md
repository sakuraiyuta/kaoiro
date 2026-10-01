---
title: Codex state backup around runner pin updates
status: accepted
last_updated: 2026-10-01
---

# Codex state backup around runner pin updates

Tracking: [issue 468](https://github.com/sakuraiyuta/kaoiro/issues/468).
Baseline: `3f35d77fc0218c60a9d54f08de54d11fe21efcef`; isolated dependency
candidate: `0aa961238e8411e9b8161a11ba26ae1d3d950ea9` (CLI/SDK 0.159.3).
Writer: kogane. Director: hisui. The round-5 design (`07ba8c64`) is approved,
including the director's acceptance of all remaining should/nit findings.
This contract includes those findings and implementation-review corrections.
Implementation review and production activation remain separately controlled.
Earlier native observations are historical evidence, not a
requirement to repeat old-version compatibility measurements.

## Problem and evidence

The existing updater builds/installs before stopping the runner, then switches
and starts without backing up Codex state. See
`runner/deploy/kaoiro-runner-update.sh:302-339`. Its physical-path resolution
pins the executing deploy tools across a `current` symlink change. Detached
updates escape the runner's cgroup; removing that separation would kill the
updater when it stops its parent runner.

The documented release rollback swaps code but does not restore Codex state.
A new native binary may migrate the existing state databases. Successful
release switching or a successful old-binary process exit does not establish
that old threads can still resume. Issue 468 requires a pre-update snapshot
attempt whose failure stops activation. Guaranteed history retention and old
binary compatibility with migrated databases are not adoption requirements.
The Codex-home document's rollback relocates a home; it is not pin rollback.

## Options and choice

A live file copy before the current updater runs does not give a common stopped
boundary for the managed runner's DBs, WAL files and rollouts. A free-form
external hook delegates
success semantics to arbitrary commands. Choose an explicit optional Codex
state operation in the existing detached update transaction, with a fixed
snapshot/restore helper and failure propagated to the worker's control flow.
Use existing file copies, hashes and directory rename; do not invent a database
migration or downgrade mechanism.

With the new tooling, a differing current/target Codex native hash always
requires this state-aware operation. Same-pin deployments can omit it when
no retained-reference rule requires a backup. Old unmodified update invocations
do not automatically acquire either the comparison guard or a backup.
Production rollout is separately authorized after gates 1–7.

## Recovery policy and accepted limit

A snapshot is a recovery convenience, not a promise of lossless or always
successful restoration. The operator accepts losing Codex conversation state,
login and caches if recovery requires creating a fresh home. Configuration,
instruction links and hooks must also be recreated and checked by the existing
[codex-home runbook](../operations/codex-home.md); a bare empty directory and
login alone are not the complete setup procedure.

Remove the external-process `/proc/*/fd` and `cwd` scan entirely. It cannot
establish exclusive access on this shared host, and an unreadable unrelated
process must not prevent this workflow. Emit one explicit warning per update
or restore that external writers are not inspected and can invalidate the
snapshot or restored state. Do not inspect, identify or signal those processes.
Runner unit checks still require inactive, MainPID zero and an empty service
cgroup. Configuration/home binding, credential exclusions, copy verification
and the snapshot-failure stop remain mandatory. Detectable source changes can
still make snapshot verification fail; the operator did not authorize ignoring
a snapshot error. No check promises to exclude an external writer or prevent
future writes after verification.

Recovery has two ordered levels: first the verified snapshot restore below;
if that fails or its resulting home is unusable, operator-led fresh setup.
Never automatically discard the failed home or reset credentials. No new
old-version authentication or old-opening-migrated-DB measurement is required.
Candidate-only live checks use the already approved 0.159.3 home and remain
within the existing maximum 20-turn budget.

## Interface and affected files

Extend `kaoiro-runner-update.sh` with paired absolute-path arguments
`--codex-home <home>` and `--codex-backup-dir <new-directory>`. Reconstruct them
as distinct quoted argv entries in detached mode, not as shell fragments or
environment variables. Never infer the target from the agent's inherited
CODEX_HOME or source runner.env in the backup helper.

A small Node helper in `runner/deploy/kaoiro-runner-codex-state.mjs` performs
snapshot, verification and restore preparation; it is shipped by the release
builder alongside deploy scripts. Use the deploy tool's selected Node runtime
and the existing release-tree verification. The updater owns stop/switch/start
and update locking; the helper queries service-manager state for binding and
stop verification, but never starts/stops a unit or chooses a release.

Add a mutually exclusive rollback mode to the updater:
`--restore-codex-backup <directory>` together with `--codex-home <home>`.
It rejects `--from-repo`, `--tarball` and `--codex-backup-dir`. This mode uses
the backup's recorded source release rather than whichever release is now
`previous`. It runs detached under the same update lock and does not prune.
The detailed flag names can change only at the design-review boundary.

Affected tests: `runner/test/releaseUpdate.test.ts`, helper tests and release
packaging checks. Release protection also changes
`kaoiro-runner-install.sh`, `kaoiro-runner-switch.sh` and the shared deploy
helpers. Extend `scripts/build-release-manifest.mjs` and
`runner/deploy/verify-release.mjs` as specified below. Documentation includes
`docs/operations/production.md`, runner update/rollback, runner artifact
reference, the Codex-home distinction, and a dated issue-468 migration record.
No server protocol, model policy or phase-3 delivery implementation changes.

## Binding the requested home to the service

On Linux, require the installed unit's actual ExecStart to be the supported
release launch shim, with no unrecognized wrapper or ExecStartPre/Post that
can change home selection. Before stopping a running service, get its MainPID
and start-time identity, inspect `/proc/<pid>/environ` in memory and retain
only `CODEX_HOME`; never print or log the environment or other variables.
Recheck MainPID/start time after reading to reject a restart or PID reuse.
Canonical path and device/inode must match the explicit `--codex-home`.
An unset/empty value means the launch user's effective HOME plus `.codex`,
not the updater's HOME. If that HOME cannot be established from the supported
unit/environment configuration, refuse rather than guess.

Also resolve what the *next* launch will use. Include the user manager's
current effective environment from `systemctl --user show-environment`,
including values loaded through `environment.d`, before applying the installed
unit's environment overrides/unsets and the launch shim's config-directory
rules. Retain only HOME, XDG_CONFIG_HOME, KAOIRO_RUNNER_DIR, KAOIRO_RUNNER_ENV
and CODEX_HOME in memory; never log the full command output or unrelated
values. Failure to read or interpret these inputs is a refusal. The current
manager environment, not a fresh independent interpretation of environment.d,
is authoritative for the next start; prohibit environment import/reload and
manager restart during maintenance. Bind the relevant effective values in the
private transaction and re-read them immediately before switch and start.
Unsupported unit precedence/expansion is rejected rather than approximated.
Resolve the actual runner.env path; do not assume the default location. Use a
non-executing, restricted assignment parser for runner.env: blank/comment
lines and simple optional-export assignments with literal or quoted values;
only explicitly supported HOME/XDG variable expansion for path resolution.
Reject command substitutions, shell commands, conditional logic, ambiguous
expansion and unsupported unit environment constructs. Discard unrelated
values without logging them. This may reject an otherwise shell-valid config;
normalizing it is an operator decision, not automatic execution by the helper.

Require requested home, running effective home and the next-launch home to
agree before stop. Record the selected unit/config identities and their private
content hashes in transaction metadata; recheck immediately before switch and
start so a runner.env change cannot select an unbacked home. The deployment
precondition forbids changing unit configuration during maintenance. These
checks establish a supported static configuration, not all possible shell
semantics. A differently configured target release's launch shim is unsupported
until its selection behavior is reviewed.

Restore uses the same binding. If the runner is still running, require the
same live check before stop. If already inactive after a failed update, do not
start it just to inspect its environment: require the original transaction's
recorded live binding and matching unchanged installed unit/config sources,
plus matching current static resolution and snapshot binding. Missing/stale
binding is a refusal requiring operator repair. The restore must not infer
its target merely from an arbitrary backup's supplied home path.

A forward update requesting a Codex backup requires a running source runner
for the initial live binding. If it is already stopped, refuse before any
switch/start; do not start it implicitly or reuse a previous update's binding.
The operator may explicitly restart the unchanged source release and retry.
Resuming an interrupted transaction uses its recorded recovery/restore path,
not a new forward update. The inactive-restore exception above remains narrow.

## Credential inventory and unclassified entries

The source inventory below was read for both tags `rust-v0.156.1` and
`rust-v0.159.3`, not inferred from names in a production home. Sources are
under `codex-rs/` in [0.156.1][old-src] and [0.159.3][new-src].

| Current-only path relative to CODEX_HOME | Source in both tags |
| --- | --- |
| `auth.json` | `login/src/auth/storage.rs:155,205-224`; direct file writer, no separate file lock/temp in that writer |
| `.credentials.json` | `rmcp-client/src/oauth.rs`, `FALLBACK_FILENAME` at old line 815 / new line 819; fallback writer uses the same file |
| `secrets/` (entire directory) | `secrets/src/local.rs:40-44`: `local.age`, `codex_auth.age`, `mcp_oauth.age`, `gateway_oauth.age`; old lines 299-327 / new 317-345 create `.<filename>.tmp-<pid>-<nonce>` beside them |
| `secrets/gateway_oauth.lock` (covered by `secrets/`) | `login/src/gateway_auth_storage.rs:20-24` |
| `mcp-oauth-locks/` (entire directory) | `rmcp-client/src/oauth/store_lock.rs:19,34-35,207` and `oauth/refresh_lock.rs:21,52-53`: store locks and hashed per-server refresh locks |

[old-src]: https://github.com/openai/codex/tree/rust-v0.156.1/codex-rs
[new-src]: https://github.com/openai/codex/tree/rust-v0.159.3/codex-rs

Exclude these paths from snapshot payload and content hashes. At restore,
move the current paths as whole entries from the stopped current home; do not
read, duplicate, downgrade or selectively merge their content. Preserve the
lock directories with them. The runner's processes must be stopped; external
credential writers or locks are not inspected. Preservation is consequently
best-effort with respect to those writers; unusable authentication requires a
fresh operator login. External keyring material is untouched. Credential-path
symlinks, hard-linked credential files or unsupported platform credential
layouts are refusals. The initial
implementation scope is Linux; no Windows/macOS credential coverage is claimed.

This is not a promise that arbitrary home content is free of secrets. User
configuration, plugins, rollouts and logs may contain sensitive values, so
all snapshots remain private. Before stop, construct an entry classification
from a checked-in list derived from these two tags and native synthetic-home
observations: current-only credentials, backed-up state/configuration, and
explicitly excluded disposable content. Preserve `.sandbox_migration`, the
one-shot policy-migration marker (`execpolicy/src/sandbox_migration.rs` in
both pinned tags). Exclude `.tmp` maintenance/cache files and
`thread-writer-locks` after the runner unit stops (`rollout/src/maintenance.rs`
and
`rollout/src/writer_lock.rs`); copying a lock file cannot restore its OS lock.
These entries are also present in a credential-free native-generated old
home. This existing observation supports the classification; additional old
native runs are not required. Inventory candidate-generated entries as well
as handwritten fixtures.
Known session/DB subtrees include
all their regular descendants/sidecars. Unknown top-level entries, unknown
credential-like sidecars and unclassified extension paths cause refusal;
there is no copy-all default or blanket allow-unknown flag. A new path requires
a reviewed classification before retrying. Inventory metadata must not open
credential contents. The director reports that production currently lacks
`.credentials.json`; this evaluator has not inspected production, and absence
is not used to weaken the rule.

Before scheduling maintenance, the director obtains explicit operator approval
for a production-home **metadata-only classification preflight**. It enumerates
names, entry types, sizes, ownership/modes and symlink metadata without opening
file contents or following symlink targets; it performs no hashing, copying,
login or native Codex invocation. Keep its output private. Run it while peers
are still available, resolve unknown entries through reviewed classification,
and record the classification version before scheduling their shutdown.
This document authorizes no production read: that approval is a separate step.
The preflight is advisory because the home can change; the updater repeats
classification and binding before stop and at the stopped boundary and refuses
any new unknown entry.

## Snapshot contract

Before service stop, validate both arguments, same-user ownership, executable
helper, destination parent, and the existing release-profile unit. Home must
be an existing absolute directory and not a symlink. Destination must be new,
outside the home and release trees. Reject overlapping paths, special files
and unusable permissions. Recheck source identity at the stopped boundary.
A snapshot directory is mode 0700 and its manifest is mode 0600.
Keep the original canonical home path on restore and reject a symlink home:
`rust-v0.159.3/codex-rs/secrets/src/lib.rs:184-195` derives the keyring account
from that canonical path's hash. Relocation can select a different encryption
key even when the encrypted credential files are preserved.

Copy the classified stopped-home state as a tree, preserving regular files,
directories, modes and symlinks without dereferencing symlinks. Apply the
credential exclusions above before opening or hashing content. Preserve the
classified databases and sidecars, sessions, history and configuration as one
snapshot; do not guess that `state_5.sqlite` is the complete state. External
symlink targets are not backed up and are recorded as such. A DB or session
storage path resolving outside the tree makes this workflow unsupported.

Before stop, count classified files and logical bytes and query available
space/inodes on the snapshot and restore-staging filesystems. Require the
snapshot payload plus the additional diagnostic DB/sidecar copy on its
filesystem, and a 20% payload reserve (at least 1 GiB). Account for diagnostic
file/directory inodes and SQLite-created WAL/SHM entries as well. Use the same
DB/sidecar selector for estimation and diagnostic copying. Both pre-stop
preflight and post-stop snapshot recheck include this extra copy. Restore
staging does not read migration levels and needs no diagnostic copy allowance. A
sparse file is charged its logical size unless sparse copying is
explicitly supported and measured. Record estimated downtime from a local
scratch copy-plus-hash throughput sample and file count; it is an estimate,
not a guarantee. Insufficient space rejects before stop. Recheck capacity
and source inventory after stop; late exhaustion still follows fail-closed
backup failure. Restore capacity includes a full staging copy while retaining
the failed current tree and existing backup.

The manifest also records each SQLite database migration table
(`_sqlx_migrations`, version/success only) for rollback diagnosis. Read these
from a disposable copy of the copied databases and WAL sidecars, then discard
that copy. SQLite read-only opens can mutate WAL/SHM files; never open source
or hash-bound snapshot databases with SQLite. Verify source and payload bytes
after collecting levels.
The manifest records format version, source home identity, source release and
its native version/hash, target release/version, timestamp, omitted credential
paths, and sorted relative entries with type, mode, content hash or symlink
target. It binds only the local snapshot; do not publish private paths/hashes.
Verify the copied entries and entry set against the stopped source and then
publish the complete directory by rename from a unique staging sibling. A
partial directory is never an accepted backup. Disk-full/copy/hash/rename or
source-change failure makes the operation nonzero. Keep the pre-update state
and both required releases until the operator retires this rollback point,
using the persistent record below.

## Persistent records, release protection and cleanup

Keep private records under `$root/codex-state/`: `backups/<uuid>.json` for
retained backup references and `transactions/<uuid>.json` for update/restore
progress. Directories are 0700, records 0600; write temporary siblings and
rename atomically. Record schema version, UUID, canonical home, snapshot path
and manifest hash, source/target/tool release IDs, config binding, phase and
owned staging/quarantine paths. Store no credential contents. Phases include
prepared, stopped, snapshot-verified, switch-intent, switched, start-attempted,
completed, restore-intent and restored. Persist intent before mutation;
recovery reconciles actual links/directories instead of trusting the phase
alone. A record identifies rollback state; it is not proof of model success.

Publish the retained backup reference before forward switch. Protect its
source release **and** the release containing the restore tools. Under the
existing links lock, both updater prune and install's release-replacement
branch must read all retained records; malformed/unreadable records refuse
those destructive operations. Current/previous protection remains. This
covers the two release-deletion paths found in the deploy scripts; manual
operator deletion is outside this protection and prohibited by the runbook.
Keep all retained references, not just the newest. Retirement is an explicit
operator procedure under update/links locking; no automatic backup pruning.

While any rollback reference is retained, a new forward update without both
backup arguments fails before stopping the runner, with the retained UUID and
instructions to supply both arguments or explicitly retire the rollback point.
A fully completed prior transaction allows another state-aware update with a
new snapshot; incomplete/failed transactions must first be recovered. Preserve
all older references until explicit retirement; do not silently supersede them.

Retirement requires the operator's acceptance of snapshot/fresh-setup recovery,
successful actual production Codex start and the applicable history or explicit
new-session checks, a completed forward or restored
transaction, and the operator's explicit decision to abandon rollback to that
snapshot (including its post-snapshot data-loss implications). Under both locks,
verify that no active recovery depends on it, then mark the reference retired
atomically before removing only its named snapshot and releasing its source/tool
release protection. Interrupted deletion is retried from that record; no glob
cleanup. Retire one reference without invalidating other retained references.

Always compare the current and target Codex native hashes computed from their
verified release trees, even when `$root/codex-state/` is absent. The updater
checks before stop; the shared switch path rechecks under the links lock before
changing links. New `switch.sh --rollback` compares previous against current.
A differing hash requires a validated state-aware transaction: a verified
snapshot for forward activation, or verified restored state for rollback.
Missing/unverifiable current or target native artifacts refuse the operation.
Resolve the binary through both shipped backend resolvers, including the SDK
constructor. Require the same canonical executable and exactly one native
candidate. Apply the comparison on macOS too; state-aware migration itself
remains Linux-only.

This is the primary pin-change guard; deletion of any backup record or barrier
cannot turn a differing-pin activation into a permitted code-only switch.
Same-hash equality permits only omission of the pin-change backup requirement,
not bypassing retained-reference, home-binding or other activation checks.

Keep an auxiliary per-home migration barrier at
`$root/codex-state/barriers/<sha256-canonical-home-path>.json`, mode 0600 in a
0700 directory. It contains a schema version, canonical home and device/inode,
installed unit identity, config binding, accepted release/native hash,
completing
transaction UUID and timestamp; no credentials. The state-aware updater is its
only writer under update/links locking, using a temporary sibling and atomic
rename. Create it at the **first completed forward or restore transaction**,
after actual startup and applicable history or explicit new-session checks;
persist that acceptance in
the transaction first, so a crash before barrier publication is recoverable.
Retained references and this barrier coexist. Update it at each subsequent
accepted forward/restore, and retain it when snapshots/releases are retired.

Before ordinary forward activation or generic rollback, compare the physical
current native hash with the barrier's accepted hash if present. A mismatch
indicates unmanaged mutation and refuses activation. Malformed/unreadable
barriers refuse both forward-update modes, generic switching and retirement;
they do not prevent read-only diagnosis or explicitly selected backup-based
restore/recovery. Absence never bypasses the independent release-hash check.

For barrier repair, the operator first selects the verified completed
transaction whose recorded acceptance matches the current physical release,
original home and fresh service/config binding. Under both locks, the helper
preserves the damaged barrier as a named diagnostic file and regenerates it
from that evidence, recording the repair. It must not bless the current hash
merely because it is current. If no matching accepted transaction is available,
use a verified snapshot's state-aware restore/recovery; that path validates
home, snapshot, release and transaction independently, retains the damaged
barrier, and publishes the restored hash only after acceptance. Without either
proof, stop for an operator-approved recovery plan; deleting the record is not
a repair. An interrupted transaction must be reconciled before normal updates.

Identify barriers by installed unit as well as canonical home, so changing
CODEX_HOME cannot silently evade the old binding by selecting an empty filename.
A home/config identity mismatch refuses ordinary activation. Home relocation
is outside this pin-update operation: require a separately approved relocation
procedure that handles path-derived keyring identity, validates the moved
state and transfers/rebinds the barrier under both locks. Do not auto-copy a
barrier to an unrelated new home or treat a path change as first installation.

New switch tooling also rejects generic `--rollback` while a retained record
marks unrestored migrated state. The state-aware updater may switch to the
specific recorded source only after verified restoration and home binding,
passing a transaction reference checked against the held update lock and
recorded target. No environment-only bypass. Without records, unchanged-pin
no-backup behavior is retained, subject to the independent hash comparison.
Legacy old scripts cannot acquire this guard retroactively; the runbook
explicitly forbids invoking them for pin rollback. Retirement output lists
removed snapshots/release protections and the auxiliary barrier that remains.

Own snapshot staging names by transaction, e.g. `.staging.codex-<uuid>`,
recorded before creation. Under the update lock, cleanup may remove only
unpublished snapshot staging whose recorded writer is gone and which contains
no moved credentials. Use the existing stale-staging ownership pattern;
never glob-delete external directories. Retain restore staging and quarantine
after any credential/state move, including SIGKILL, for explicit recovery.
Failure traps release locks but never delete the sole current credential,
committed backup or partially restored state and never start a service.

## Update ordering and failure behavior

1. Acquire the existing update lock; parse/validate options; prepare and verify
   the new release and tools without touching active state.
2. The director/operator establishes a maintenance interval with no new
   dispatch or spawn and rechecks every peer idle immediately before queuing
   activation. This is an explicit operating precondition, not an automated
   claim from a stale list or an injected fixture. The worker does not add a
   new server-drain protocol in this change.
3. Stop the runner through the service manager. Require the configured
   control-group stop behavior from the installed unit's effective
   `systemctl --user show -p KillMode`, not the repository template. Require
   inactive, MainPID zero and no remaining service descendants. Check the
   service's cgroup only; remove the external-process scan as described above.
   An absent already-removed service cgroup is acceptable after inactive/PID
   checks; unreadable state for a still-present service cgroup is a refusal.
   Refuse hosts without the unified cgroup-v2 controller file.
   This initial workflow requires a private same-user home on Linux. External
   processes are outside the stop guarantee and produce no per-process gate.
4. Create and verify the snapshot with an explicit
   `if ! helper ...; then ...; fi` failure branch, not merely `set -e`.
   Backup failure leaves current unchanged,
   exits nonzero, and never switches or starts the candidate. Leave the runner
   stopped with an actionable failure, preserving original state; an operator
   may restart the unchanged old release after resolving the failure.
   This uniform fail-stopped policy is intentional: backup failures include
   loss of home binding and detected source changes; classifying
   an arbitrary failure as harmless disk exhaustion would weaken the gate.
   By contrast, the existing switch-failure restart follows a completed,
   verified snapshot and an atomic switch refusal with unchanged state.
5. Immediately before switch, repeat inactive/MainPID/cgroup checks, the
   home/config binding and stopped-source verification. A restarted service
   or a detected source change refuses switch; an external holder by itself
   is not a refusal. Recheck before start;
   an unexpected external service start is not mistaken for candidate startup.
   Switch only after these checks, then start and run the existing release
   identity checks. Preserve the backup reference in success/failure output.
   On switch failure after a verified snapshot, attempt recovery to the
   recorded source release before reporting failure. If the forward transaction
   remains `snapshot-verified` or
   `switch-authorized`, it proves startup was not attempted: `before-start`
   persists `start-attempted` before launching. Create a `code-recovery`
   transaction bound to that original transaction, verified snapshot, stopped
   runner, unchanged home/configuration and source/target native identities.
   Switch only the link back to the recorded source; do not replace the home
   or move credentials. The switch guard rechecks the original pre-start phase
   and source bytes. This exception is not available to generic rollback.
   If startup absence cannot be proved, use verified snapshot restoration. An
   unknown
   link, failed stop/binding check or failed recovery must remain stopped;
   never guess which code to start. A failure after new startup must not
   automatically start old code on migrated state;
   direct the operator to the state-aware rollback command. Replace the
   generic commands currently printed at update.sh:333-337 whenever a Codex
   backup record applies. Update `docs/operations/production.md`'s runner
   rollback example and the dedicated rollback runbook to forbid code-only
   `switch.sh --rollback` after a pin migration. Replace the command itself,
   including production.md's `previous/deploy/...switch.sh --rollback`, with
   the verified tool release's fixed physical updater path and explicit
   `--restore-codex-backup` / `--codex-home` arguments. A warning beside the
   old command is insufficient: `previous` may point to unguarded old tooling.
6. Release maintenance only after actual Codex startup and the applicable
   history or explicit new-session checks, not merely `runner --version`. Record
   gate 5 separately from rollout identity.

The snapshot helper is never a log-only advisory: a failing child and the
switch/start operations are in the same shell control flow. Interruption or
partial work does not trigger a trap that starts the candidate. Retain enough
private transaction information to identify whether switch/start occurred;
manual recovery first inspects current and process state instead of guessing.

## Restore ordering and credentials

The old release must still exist and pass artifact verification. Verify the
backup and requested home/release binding before stopping anything. Restore
staging contains the verified snapshot without any current-only credential
entry. The same-user operator-controlled backup is trusted input only after
its manifest checks;
reject traversal and unexpected entry types rather than extracting an archive.

Order retained references by their recorded transaction completion sequence,
not filename or filesystem mtime. Normal restore accepts only the most recent
completed, not-yet-restored reference for that home (LIFO), with the current
release/state lineage matching its target. Recovery of an incomplete latest
transaction uses that transaction's own verified snapshot and recorded phase;
it does not skip to an unrelated older reference. An older selection is rejected
before stop with the intervening transaction UUIDs and affected state interval.
It requires a separate explicit operator-approved recovery plan naming those
transactions and the discarded newer work, with fresh home/config binding;
there is no general force/ignore-lineage flag. A sequence of validated latest-
reference restores may be chosen instead. Mark completed restores so subsequent
selection follows the remaining lineage rather than repeatedly selecting an
already-restored reference.

Under the update lock and maintained no-dispatch interval, stop the runner
unit and its descendants as in update; external writers are not scanned.
Retain the current home as a named failed-state sibling. Move its
current credential entries from the inventory, if present, into the prepared
restored home without reading or duplicating their content. Do not restore
old tokens from the snapshot. External keyring credentials are untouched. An
unsupported credential layout or failed credential move stops recovery; it
never falls back to a
historical token. A fresh operator login may be necessary if authentication
cannot be retained across the binary change.

Promote restored state at the original home path, switch to the snapshot's
verified source release, and start only after both operations succeed. Use
staging and sibling renames on the same filesystem. There is no claim of one
atomic transaction across a directory and a release symlink: on any partial
failure, remain stopped, retain both state trees and transaction metadata, and
print exact recovery paths. Never remove the sole current credential in an
error cleanup. Preserve directory mode/ownership. Missing/corrupt backups or
wrong home/release identity must fail before live-state replacement.

Rollback restores the pre-update point. New threads and turns after the backup
remain in the quarantined new state; lossless merging into the old schema is
out of scope. Server-side references to post-backup thread IDs are not deleted
or silently redirected. Expected behavior is the runner's existing T3 resume
existence check rejecting them, with a visible error and no substitute thread;
this is an expectation to measure, not established evidence. The operator
starts a new session explicitly. Recovery testing must submit a missing
retained server reference through the real runner resume path and confirm
visible refusal without an implicit replacement session; also confirm that an
explicitly requested new session works. Snapshot recovery and fresh setup are
the supported paths. Opening a migrated database with the old binary is not a
fallback and is not an adoption gate.

## Second-level recovery: fresh Codex setup

If snapshot verification, restoration, or the restored home fails, leave the
runner stopped and report the failed transaction. The operator may choose a
fresh setup, explicitly accepting loss of old Codex history and login. Keep
failed home/staging/quarantine trees private for diagnosis instead of deleting
or merging them. Do not copy any auth or credential entry into the new home.
Never store snapshots or diagnostic trees in cloud-synchronized or externally
backed-up directories. At completion, the operator explicitly records whether
to delete or retain each diagnostic tree and its old credentials. Retention
requires private local storage and a deletion date. Do not assume a new login
revokes an old one; use account-side session revocation if available. Do not
run a guessed logout command against an old tree or the fresh home.

Use the codex-home runbook's creation, configuration, instruction-link, hook
and device-auth steps, at the configured canonical path, with the verified
binary for the release being recovered. Normally retain the verified current
release and create fresh state for it. If the operator instead requires a
code downgrade, first provision a fresh installation of the verified selected
release against this empty home; never run old code on the quarantined migrated
state and never use an unguarded code-only rollback against it. Reinstall the
unit so `ExecStart` names the new installation’s `current` launch shim, reload
the user manager, and re-establish static unit/environment/home binding and
then live MainPID home binding on startup. Old installation bindings cannot
certify the new installation. Fresh setup is
an explicit operator recovery procedure, not an automatic updater fallback.

The old home inode and retention/barrier records do not certify the fresh
home. While stopped, preserve the source/tool release paths, and under both
update/links locks archive the affected installation's `codex-state` directory
to a named private diagnostic directory before treating this as a fresh state
history. Use this registry-archive procedure only for an installation dedicated
to this home/unit. If records cannot establish that scope, preserve the entire
old installation and provision a fresh selected-release installation instead.
Do not selectively
edit hashes or claim the new home matches old acceptance. Keep the referenced
releases and diagnostic snapshots manually until the operator retires them;
ordinary pruning must not run during reconstruction. The independent native
hash comparison remains active for later updates, even without these records.

The operator logs in again, starts the selected release, then requests new
Codex sessions and checks hooks/configuration and one actual model turn as in
codex-home.md. Retained server references to lost threads must visibly fail;
do not redirect them to replacement sessions. External programs still holding
the old home may interfere with the new one by path, so their shutdown is an
operator recovery consideration, not a claimed property of the removed scan.

## First deployment and verification

The currently deployed updater does not understand these new options. Build
and install the reviewed candidate without activation; verify its release tree
and invoke the new updater by that release's fixed physical path with
`--detach`. Do not invoke an old `current` updater with unknown flags or update
the live release in place. Preserve a verified copy/path of the reviewed tools
for recovery; do not resolve rollback tooling through a moving/broken current.

The existing release manifest covers first-party dist and selected Codex
runtime files, not deploy tools. Extend the builder to enumerate all regular
files under `deploy/` and include their hashes (including shell scripts,
verifier and state helper). Extend the verifier with explicit required deploy
entry points and traversal/containment checks, so removing a tool and its
manifest entry together fails. Add a strict `--require-deploy-manifest` mode
used for candidate/tool verification in this workflow. Legacy old releases
remain verifiable by their recorded legacy identity/manifest for restoration;
they must not be accepted as backup-capable tooling. Do not select strictness
solely from a marker inside the potentially incomplete candidate tree.
The manifest's trust limit remains accidental corruption, not malicious
rewriting of the entire tree and verifier. Native hash comparison likewise
cannot prevent an unmanaged binary replacement between verification and
startup. Maintenance forbids concurrent release mutation.

Required evidence before implementation is called complete:

- Existing release update/switch/install/bootstrap tests stay green. New tests
  cover quoted argv under detach, legacy no-backup behavior, exact operation
  order, credential exclusion/preservation, unknown state files, symlinks,
  corrupt/missing snapshots and partial restore failure. Sensitive fixtures
  must not appear in logs or backups' credential entry.
- Every added activation/restore guard gets a mutation control: remove only
  that guard or disconnect its wiring, see its corresponding test fail, then
  restore and rerun. Backup failure must produce a nonzero worker invocation,
  zero new-release starts and no symlink switch. Include wrong but valid
  requested homes, changed runner.env/user-manager environment, already-stopped
  forward updates and retirement/barrier enforcement. An unrelated unreadable
  process or known external holder must no longer cause refusal by itself;
  retain an explicit service-descendant/stopped-state negative. Cover
  deleted barrier (also deleted codex-state directory) with differing current /
  target hashes, corrupt-barrier repair and backup-based recovery, first barrier
  publication, changed-home binding, and non-latest restore selection. The
  deleted-barrier generic rollback and no-backup update must exit nonzero with
  zero switch/start mutations; unchanged-pin controls must still succeed when
  no other guard applies. Also cover
  restart immediately before switch, insufficient space, unclassified paths
  and all credential exclusions. Restore failure must leave
  the service stopped with no old-binary start on an unchecked state.
- Exercise a built artifact through its actual installed symlink/physical
  deploy path with the real helper, no replacement backup implementation.
  The same path's missing/corrupt-backup control must fail and prevent the
  next mutation. Release-manifest checks must cover the shipped helper and
  pre-existing deploy siblings. Independently remove an existing deploy
  script and the new helper (also remove each manifest entry); both must fail.
  Disconnect the coverage check and require those self-tests to fail, while
  a prose-only documentation change remains accepted.
- Rehearse the service lifecycle in owned disposable user-systemd units, with
  owned fake runner/child state writers and candidate-generated scratch state.
  Verify the detached worker survives its caller's stop and no runner-unit
  descendant remains at snapshot time. This does not claim external writers
  are absent. A process-group stub alone cannot establish this.
  Never stop, restart or signal the production runner as a test.
- Gate 6 rehearses candidate-generated credential-free state snapshot/restore
  and the documented fresh-home recovery path. Check snapshot verification,
  credential exclusion, retained history where available, and explicit fresh
  session behavior. No old-version login, model turn, or old-opening-migrated-DB
  measurement is required. Existing old-version measurements are historical
  observations only. Bind new results to final binary and source hashes.
- Rehearse failed switch recovery with the source pointer unchanged and with
  a pointer already moved to the recorded target. Recovery returns to the
  verified source or remains stopped with both recovery levels reported;
  a failed snapshot itself never switches or starts either release.
- Run affected suites/build/typecheck and independent implementation review.
  Record warnings, exits and negative-control results. Missing systemd/native
  observations remain open gates; do not replace them with fixture assertions.

The director assigns the design reviewer before any deployment-script edit.
The implementation must preserve the approved fail-closed boundaries; a scope
or operating-contract change returns to the director before implementation.
