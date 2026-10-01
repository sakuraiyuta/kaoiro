---
title: Codex state backup around runner pin updates
status: proposed
last_updated: 2026-10-01
---

# Codex state backup around runner pin updates

Tracking: [issue 468](https://github.com/sakuraiyuta/kaoiro/issues/468).
Baseline: `3f35d77fc0218c60a9d54f08de54d11fe21efcef`; isolated dependency
candidate: `0aa961238e8411e9b8161a11ba26ae1d3d950ea9` (CLI/SDK 0.159.3).
Writer: kogane. Director: hisui. This is a design for review, not implemented
behavior or production authorization. Native migration results remain pending.

## Problem and evidence

The existing updater builds/installs before stopping the runner, then switches
and starts without backing up Codex state. See
`runner/deploy/kaoiro-runner-update.sh:293-317`. Its physical-path resolution
pins the executing deploy tools across a `current` symlink change. Detached
updates escape the runner's cgroup; removing that separation would kill the
updater when it stops its parent runner.

The documented release rollback swaps code but does not restore Codex state.
A new native binary may migrate the existing state databases. Successful
release switching or a successful old-binary process exit does not establish
that old threads can still resume. Issue 468 requires scratch measurement of
old/new/old operation and a pre-update backup before any production activation.
The Codex-home document's rollback relocates a home; it is not pin rollback.

## Options and choice

A live file copy before the current updater runs does not give a common stopped
boundary for DBs, WAL files and rollouts. A free-form external hook delegates
success semantics to arbitrary commands. Choose an explicit optional Codex
state operation in the existing detached update transaction, with a fixed
snapshot/restore helper and failure propagated to the worker's control flow.
Use existing file copies, hashes and directory rename; do not invent a database
migration or downgrade mechanism.

The option is opt-in for existing deployments. This pin's runbook requires it;
the design does not claim all old unmodified update invocations automatically
acquire a backup. Production rollout is separately authorized after gates 1–7.

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
and update locking; the helper never invokes systemctl or chooses a release.

Add a mutually exclusive rollback mode to the updater:
`--restore-codex-backup <directory>` together with `--codex-home <home>`.
It rejects `--from-repo`, `--tarball` and `--codex-backup-dir`. This mode uses
the backup's recorded source release rather than whichever release is now
`previous`. It runs detached under the same update lock and does not prune.
The detailed flag names can change only at the design-review boundary.

Affected tests: `runner/test/releaseUpdate.test.ts`, helper tests and release
packaging checks. Documentation: runner update/rollback, runner artifact
reference, the Codex-home distinction, and a dated issue-468 migration record.
No server protocol, model policy or phase-3 delivery implementation changes.

## Snapshot contract

Before service stop, validate both arguments, same-user ownership, executable
helper, destination parent, and the existing release-profile unit. Home must
be an existing absolute directory and not a symlink. Destination must be new,
outside the home and release trees. Reject overlapping paths, special files
and unusable permissions. Recheck source identity at the stopped boundary.
A snapshot directory is mode 0700 and its manifest is mode 0600.

Copy the stopped home as a tree, preserving regular files, directories, modes
and symlinks without dereferencing symlinks. Exclude top-level `auth.json`
from the snapshot and from the content manifest. Do not open it to hash or
inspect credentials. Configuration may itself be sensitive: all snapshot
contents stay private and no content is logged or published. Preserve all
other state together, including databases and sidecars, sessions, history and
configuration; do not guess that `state_5.sqlite` is the complete state.
External symlink targets are not backed up and are recorded as such. A DB or
session-storage path that resolves outside this tree makes this workflow
unsupported; fail before activation rather than silently take a partial state.

The manifest records format version, source home identity, source release and
its native version/hash, target release/version, timestamp, omitted credential
path, and sorted relative entries with type, mode, content hash or symlink
target. It binds only the local snapshot; do not publish private paths/hashes.
Verify the copied entries and entry set against the stopped source and then
publish the complete directory by rename from a unique staging sibling. A
partial directory is never an accepted backup. Disk-full/copy/hash/rename or
source-change failure makes the operation nonzero. Keep the pre-update state
and source release until the operator retires this rollback point; update
pruning must protect a source release referenced by the active backup record.

## Update ordering and failure behavior

1. Acquire the existing update lock; parse/validate options; prepare and verify
   the new release and tools without touching active state.
2. The director/operator establishes a maintenance interval with no new
   dispatch or spawn and rechecks every peer idle immediately before queuing
   activation. This is an explicit operating precondition, not an automated
   claim from a stale list or an injected fixture. The worker does not add a
   new server-drain protocol in this change.
3. Stop the runner through the service manager. Require the configured
   control-group stop behavior, service inactive, MainPID zero and no remaining
   service descendants before treating its writers as stopped. The dedicated
   home must not be used by an external CLI; if another holder of state files
   is detected or writer ownership cannot be established, stop here. Do not
   kill unrelated processes. The maintenance interval remains in effect.
4. Create and verify the snapshot. Backup failure leaves current unchanged,
   exits nonzero, and never switches or starts the candidate. Leave the runner
   stopped with an actionable failure, preserving original state; an operator
   may restart the unchanged old release after resolving the failure.
5. Switch only after snapshot success, then start and run the existing release
   identity checks. Preserve the backup reference in success/failure output.
   A switch failure can restart the unchanged old release as today. A failure
   after new startup must not automatically start old code on migrated state;
   direct the operator to the state-aware rollback command.
6. Release maintenance only after actual Codex start/history checks, not merely
   `runner --version`. Record gate 5 separately from rollout identity.

The snapshot helper is never a log-only advisory: a failing child and the
switch/start operations are in the same shell control flow. Interruption or
partial work does not trigger a trap that starts the candidate. Retain enough
private transaction information to identify whether switch/start occurred;
manual recovery first inspects current and process state instead of guessing.

## Restore ordering and credentials

The old release must still exist and pass artifact verification. Verify the
backup and requested home/release binding before stopping anything. Restore
staging contains the verified snapshot without auth.json. The same-user
operator-controlled backup is trusted input only after its manifest checks;
reject traversal and unexpected entry types rather than extracting an archive.

Under the update lock and maintained no-dispatch interval, stop writers as in
update. Retain the current home as a named failed-state sibling. Move its
current auth.json, if present, into the prepared restored home without reading
or duplicating its content. Do not restore an old refresh token from the
snapshot. External keyring credentials are untouched. An unsupported credential
layout or failed credential move stops recovery; it never falls back to a
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
out of scope. Even if the old binary can read migrated scratch state, keep
this backup-based rollback path as the documented safe baseline.

## First deployment and verification

The currently deployed updater does not understand these new options. Build
and install the reviewed candidate without activation; verify its release tree
and invoke the new updater by that release's fixed physical path with
`--detach`. Do not invoke an old `current` updater with unknown flags or update
the live release in place. Preserve a verified copy/path of the reviewed tools
for recovery; do not resolve rollback tooling through a moving/broken current.

Required evidence before implementation is called complete:

- Existing release update/switch/install/bootstrap tests stay green. New tests
  cover quoted argv under detach, legacy no-backup behavior, exact operation
  order, credential exclusion/preservation, unknown state files, symlinks,
  corrupt/missing snapshots and partial restore failure. Sensitive fixtures
  must not appear in logs or backups' credential entry.
- Every added activation/restore guard gets a mutation control: remove only
  that guard or disconnect its wiring, see its corresponding test fail, then
  restore and rerun. Backup failure must produce a nonzero worker invocation,
  zero new-release starts and no symlink switch. Restore failure must leave
  the service stopped with no old-binary start on an unchecked state.
- Exercise a built artifact through its actual installed symlink/physical
  deploy path with the real helper, no replacement backup implementation.
  The same path's missing/corrupt-backup control must fail and prevent the
  next mutation. Release-manifest checks must cover the shipped helper.
- Rehearse the service lifecycle in owned disposable user-systemd units, with
  owned fake runner/child state writers and then the native scratch state from
  gate 6. Verify the detached worker survives its caller's stop and no writer
  remains at snapshot time. A process-group stub alone cannot establish this.
  Never stop, restart or signal the production runner as a test.
- Gate 6 uses native-generated credential-free old state, old-to-old control,
  candidate migration, old opening of migrated state, and restored old state.
  Check thread IDs, sentinel history and read/write operation, not just exit
  status or migration counts. Bind results to final binary and source hashes.
- Run affected suites/build/typecheck and independent implementation review.
  Record warnings, exits and negative-control results. Missing systemd/native
  observations remain open gates; do not replace them with fixture assertions.

The director assigns the design reviewer before any deployment-script edit.
The implementation must preserve the approved fail-closed boundaries; a scope
or operating-contract change returns to the director before implementation.
