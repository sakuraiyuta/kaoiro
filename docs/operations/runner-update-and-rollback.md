---
title: Runner update and rollback
description: The runner-side steps interleaved with a server update, migrating a checkout-direct host to the release profile, and subsequent release-profile updates and rollback.
status: accepted
last_updated: 2026-10-25
related: [deployment]
---

# Runner update and rollback

The normative reference for why each step is shaped this way is
[Multi-host deployment architecture](../architecture/deployment.md). Release
layout and the activation contract are in
[Runner artifacts](../reference/deployment/runner-artifacts.md); the
self-test verification procedure and its dated measurement are in
[Runner service verification](runner-service-verification.md) and
[Runner service isolation](../evidence/deployment/runner-service-isolation.md).
This page covers the runner side; the interleaved server-side steps are in
[Server update and rollback](server-update-and-rollback.md).

A change that can stop the fleet from starting or every agent's turns from
completing (the runner's start path, the wrapper's turn lifecycle) follows
[High-risk change release](high-risk-change-release.md) first: it adds a
production-shape start check and a canary stage before the steps below, and it
links back here for the commands.

## Build identity preconditions

Forward production updates require an exact completed landing tag or schema-2
release tag ([Release tags](build-identity-and-release-tags.md#release-tags)); `--from-repo`
builds use `--require-tagged` by default. Tagged and `untagged` candidates also
check the current server's advertised `build_identity_formats` before stopping
the old unit. A failed check leaves the old runner running. Updater success uses
`--version --json` with the 40-character SHA, never the seven-character label.
Legacy releases can attest their pinned physical build-info JSON.

Detached enqueue is not completion. Record the actual worker result, registered
identity and required Codex acceptance using the
[deployment completion checks](build-identity-and-release-tags.md#deployment-completion-and-legacy-descriptors). Existing retained
rollback targets keep their native/state recovery contract.

Legacy descriptors produce a fixed warning and are ignored; see
[legacy descriptor handling](build-identity-and-release-tags.md#deployment-completion-and-legacy-descriptors).

## 4.6 Migrate to the release profile and update thereafter (issue #219)

[ADR-0018](../adr/0018-runner-distribution.md) (revised 2026-08-16) defines
immutable releases with an atomic switch. **The 4.1 in-place-build limit is
removed by this per-host migration, not by merging code.**

**(3) Stop the runner**

> **Do not perform (3) and (4) manually on release-profile hosts.** Run
> `kaoiro-runner-update.sh` from 4.6 once; it builds, expands, stops, switches,
> starts, and verifies without touching the active release. It stops the runner
> only immediately before switching. The following applies to checkout-direct
> hosts.

```sh
systemctl --user stop kaoiro-runner
```

**(4) Advance local to the target and build**

**Always use `--frozen-lockfile`.** If the target changed dependencies, building
with stale `node_modules` fails at runtime.

```sh
git fetch origin && git merge --ff-only <target-sha>
pnpm install --frozen-lockfile
node scripts/with-build-identity.mjs --require-tagged -- sh -c 'pnpm -C wrapper build && pnpm -C runner build'
```

**On failure, follow the server-side [failure handling](server-update-and-rollback.md#44-failure-handling), item (2).**
The server-side transaction from (1)/(2) is untouched — it is still sitting
at `env_consistency_checked`, waiting for `--maintenance-approved`.

**(7) Start the runner**

Skip for release-profile hosts — already started by `kaoiro-runner-update.sh`
in (3)/(4).

```sh
systemctl --user start kaoiro-runner
```

**(2) Runner build failed** (the server-side
[update procedure](server-update-and-rollback.md#43-update-procedure), step 4)

The server has not switched — the old container is still running. **Still
check [failure handling item (0)](server-update-and-rollback.md#44-failure-handling)**:
if the server's own prepare in the
[update procedure](server-update-and-rollback.md#43-update-procedure), steps
(1)/(2), already succeeded,
`latest` points at the new server image regardless of what the runner build
did. The server-side transaction itself is untouched and still waiting at
`env_consistency_checked`; fix the runner build and retry, or abandon this
deploy (in which case also revert the runner build to the old commit/lockfile
before restarting it — there is nothing server-side to undo).

```sh
git checkout <old-sha>
pnpm install --frozen-lockfile
pnpm -C wrapper build && pnpm -C runner build
systemctl --user start kaoiro-runner
```

If that is unavailable, leave the runner stopped. **Do not start it with a
partial `dist`.**

### 4.6.1 Migrate from checkout-direct (operator action, once per host)

**Only step (6) touches the running runner.** Agents disconnect only when it is
restarted there (the warning in section 2 “Run as a service” applies).

```sh
# 1. Record current operating state as a baseline for post-migration comparison
systemctl --user show -p ExecStart --value kaoiro-runner
<repo-path>/runner/dist/cli.js --version

# 2. Build tarball from repo while runner remains active
cd <repo-path>
git status --porcelain   # Must be empty (dirty checkout appends -dirty to id)
./scripts/build-runner-tarball.sh --require-tagged --target linux-x64

# 3. Install as a release without touching running dist
./runner/deploy/kaoiro-runner-install.sh \
  dist-tarball/kaoiro-runner-<rev>-linux-x64.tar.gz

# 4. Create current symlink. Unit still points to old path so no disruption
./runner/deploy/kaoiro-runner-switch.sh <release-id>

# 5. Retarget unit's ExecStart to point via current
install_root="${XDG_DATA_HOME:-$HOME/.local/share}/kaoiro"
sed "s|@@DEPLOY_DIR@@|$install_root/current/deploy|" \
  runner/deploy/kaoiro-runner.service \
  > ~/.config/systemd/user/kaoiro-runner.service
systemctl --user daemon-reload

# 6. First stop happens here. All subordinate agents disconnect
systemctl --user restart kaoiro-runner

# 7. Verify
systemctl --user status kaoiro-runner
"$install_root/current/deploy/kaoiro-runner-launch.sh" --version
```

Confirm (7)'s `--version` matches the value recorded in (1) and `status` is
`active (running)`. Rerun the connectivity checks in section 3.

**After migration, the repo's `dist` is no longer the live path.** The repo is a
build source; `pnpm -C runner build` does not affect the running runner.

### 4.6.2 Subsequent updates

Advance the repo to the target SHA, then run the update as **one command**.

```sh
install_root="${XDG_DATA_HOME:-$HOME/.local/share}/kaoiro"
git -C <repo-path> fetch origin
git -C <repo-path> merge --ff-only <target-sha>
git -C <repo-path> status --porcelain   # Must be empty

"$install_root/current/deploy/kaoiro-runner-update.sh" \
  --from-repo <repo-path> --detach
```

It performs build → install → stop → switch → start → identity check → prune in
order. **Stopping happens only immediately before switching**; build and expansion
never touch the active release. If build or expansion fails, it **never reaches
stop** and the old runner keeps running.

Exit 75 after the start step means activation and startup already happened,
but release pruning was skipped: either `.lock.links` was busy or `current`
no longer named this run's activated release when prune acquired that lock.
For a changed `current`, the error reports its observed link target and the
expected target; it does not report the expected release as still running.
Check `readlink "$install_root/current"` and the normal runner identity
checks before choosing the next operation. A later update retries pruning.
The updater stops on its error path, so it does not print a successful
release ID on stdout in either exit-75 case.
Distinguish the pre-work exit 75 for a held `.lock.update` by the lock name
in stderr: a post-start skip instead names `.lock.links` or reports changed
current. An ordinary update has already printed its starting-service line;
a state-aware forward has already recorded `completed`.

`--detach` queues the update as a transient **service** unit via
`systemd-run --user --no-block`. **Always use it when running from an agent under
the runner**; without it, stopping the runner kills the caller and later steps
never run.

**The queued unit does not inherit the caller's environment.** A transient
unit runs with the user manager's environment, not this shell's, so `--detach`
forwards only its explicit `--setenv` values: `PATH` and `KAOIRO_RUNNER_DIR`
always, plus `KAOIRO_RUNNER_CONFIG` and `KAOIRO_NODE` when set in the calling
shell. Nothing else is forwarded;
in particular `KAOIRO_RUNNER_TOKEN` never reaches the update unit. If the
worker needs a Node or a `kaoiro-runner` binary that the user manager's default
`PATH` does not resolve, export `PATH` / `KAOIRO_NODE` in the shell that runs
`--detach`. Node availability is checked before submission; a missing Node
refuses without ENQUEUED. Other worker failures remain visible in the unit's
journal below.

**The isolation is by cgroup, not process group.** The `systemd.kill(5)` default
`KillMode=control-group` kills every process in a unit's cgroup when it stops. The
transient service escapes because it gets an **independent cgroup whose parent is
the service manager**; adding `--scope` removes this property (inherits the
caller's environment and runs synchronously).

**`--detach` does not report success.** With `--no-block`, `systemd-run(1)` returns
once the start request is “only verified and enqueued”; when this command returns,
the update **may not have started**. Output contains only the enqueued unit name
and check commands; its exit status says nothing about the result. **The operator
performs final verification.**

```sh
journalctl --user -u kaoiro-runner-update.service -f
systemctl --user status kaoiro-runner-update.service
"$install_root/current/deploy/kaoiro-runner-launch.sh" --version
```

Main options:

| Option | Default | Meaning |
|---|---|---|
| `--from-repo <path>` | — | Build a tarball from the repo and install it |
| `--tarball <path>` | — | Install an existing tarball (for distribution hosts) |
| `--target <os-arch>` | — | Build target, only with `--from-repo` (`darwin-arm64` or `linux-x64`) |
| `--detach` | — | Queue update as a transient systemd user service via `systemd-run --user --no-block` |
| `--service <name>` | `kaoiro-runner` | Target systemd user unit |
| `--keep <n>` | `3` | Generations to retain; excludes `current` / `previous` |
| `--install-dir <dir>` | Above default | Install root |
| `--allow-dirty` | — | Allow activation of `-dirty` / `unknown`; **development hosts only** |

Never delete the release referenced by `current` / `previous`, regardless of
`--keep`. The runner **does not resolve the Codex wrapper until the first Codex
spawn**, so the active release continues to be read after startup; deleting it
breaks a spawn that has not happened yet.

### 4.6.3 Rollback

A rollback across Codex native hashes restores a retained snapshot before
starting the recorded source release. Never use an old `previous` script for
this operation. Prepare a verified physical tool-release path before updating:

```sh
"$tool_release/deploy/kaoiro-runner-update.sh" \
  --install-dir "$install_root" --service kaoiro-runner \
  --restore-codex-backup "$snapshot_dir" --codex-home "$codex_home" --detach
```

Same-native code-only switching remains possible when no operation is
unfinished, including when a v2 snapshot is retained. A retained v2 snapshot
forbids activating a pre-N2 tool even with the same native hash. First install
an N2-capable release with the same native; source and target must both carry
N2 capability before a state-aware forward. See
[the same-native command](production.md#5-rollback).

Before durable `start-intent`, recovery returns only to the recorded source
without replacing its home. Once that intent exists, recovery restores the
verified snapshot even if the candidate might not actually have started.
Never restart old code against potentially migrated state. Preserve the named
home/staging/aside trees after failure and use the recovery commands below.

### Second-level recovery: fresh setup

If snapshot recovery cannot succeed, keep the runner stopped and let the
operator choose a fresh Codex setup. This deliberately loses Codex conversation
history, login and caches; it is not an automatic credential reset. Preserve
failed home/staging/quarantine trees privately until recovery is complete.
Snapshots and diagnostic trees must stay outside cloud-synchronized or
externally backed-up directories. Once fresh setup succeeds, the operator must
record which old credential entries/trees are deleted or explicitly retained.
Retained trees need private local storage and a deletion date. A new login is
not evidence that old tokens were revoked. Use account-side session revocation
if available; do not guess a logout invocation that could affect the new home.

Use [Codex home creation and login](codex-home.md#fresh-setup-after-failed-snapshot-recovery)
at the configured canonical path with the verified selected release. Normally
keep the verified current release. A requested code downgrade instead needs a
fresh installation of that selected release against an empty home, never an
old binary against the failed migrated database. For a new installation root,
reinstall the unit with `ExecStart` pointing to that root's `current` launch
shim, run `systemctl --user daemon-reload`, and verify static unit/environment
home binding before startup and MainPID home binding afterward. Do not reuse
the former installation's operation records as authority for the new home.

Before restarting, the operator must preserve the recorded source/tool releases
and archive the installation's `codex-state` registry into a private diagnostic
directory under both update/links locks. This manual registry reset is allowed
only after confirming that the installation's records all belong to this
home/unit. If that scope cannot be established, preserve the entire old
installation and provision a fresh installation instead. Do not edit hashes,
or phases to authorize the new home.
Recreate configuration, instruction links and hook trust, then have the
operator log in. Start Codex peers as explicitly new sessions and verify their
first turn and hook/profile marker; old session IDs must remain visibly missing.

## Codex state backup

This workflow requires Linux/systemd with unified cgroup v2, a private same-user Codex home and an
operator-controlled maintenance interval with no dispatch, process spawning,
unit/environment reload, or release modification. Same-native comparison is
also enforced on macOS, where state-aware migration is currently unsupported.
The hash comparison does not prevent unmanaged replacement between checking
and execution. The script rejects unsupported unit/shell configuration rather
than executing it to discover the home.

For every Codex native pin update, before stopping the runner, obtain explicit
operator approval and run the candidate release's metadata-only classification
preflight against the production home. Build/install the candidate without
activation first, then use its verified physical tool-release path:

```sh
node "$tool_release/deploy/kaoiro-runner-codex-state.mjs" classify "$codex_home"
```

Keep the output private. It contains paths, modes and sizes, never credential
contents. Any classification refusal aborts the update before stopping the
runner. Unknown entries require a separately reviewed classification before
retrying; do not delete or rename files merely to make the check pass. Only the
managed runner and its service descendants are checked for stop completion. External processes are
not scanned; an unreadable process outside the service or another external writer does not itself refuse
the update. Each state-aware invocation warns that external writes can make
snapshot recovery fail. Detected copy/verification errors still stop the update
before switching or starting.

Build/install the candidate without activation, verify its deploy manifest,
and invoke its fixed physical updater path. An existing updater does not gain
these guards automatically. Both arguments must be explicit absolute paths;
the updater never takes its target from inherited `CODEX_HOME`:

```sh
"$tool_release/deploy/kaoiro-runner-update.sh" \
  --install-dir "$install_root" --service kaoiro-runner \
  --tarball "$archive" --codex-home "$codex_home" \
  --codex-backup-dir "$new_snapshot_dir" --detach
```

The helper requires unified cgroup v2 before stop. After stop it requires the unit
to be inactive or failed with `MainPID` 0, and checks for `populated 0` when the unit's
`ControlGroup` has a `cgroup.events` file. A failed check refuses the update and
attempts to resume the unchanged source when its recorded phase permits. Keep apt,
add-apt-repository and other root operations outside the runner's cgroup. Do not
use pattern-based kill pipelines or automatic sudo cleanup.

Forward backup requires an active source runner. State-aware operations
require explicit nonempty next-start `CODEX_HOME`; the canonical requested,
live and next-start paths must agree. A live default uses the running
process's actual `HOME`, not the next-start environment. The selected unit ID
must also agree. A token, comment or file-inode change at the same home path
does not invalidate a retained snapshot. The helper interprets supported
literal unit/environment settings and refuses unsupported shell expressions.

The operation record is private
`codex-state/v2/records/<uuid>.json`. The forward phases are `prepared`,
`snapshot-verified`, `start-intent`, then `completed`; a never-started return
records `failed` before restarting the source. The updater marks `completed`
only after verifying active state, positive MainPID, current release, verified
artifact and live/next-start home agreement. This verifies the runner start,
not a Codex turn or history resume. Perform those checks separately.

A pre-start snapshot failure returns a nonzero worker result and attempts to
resume the unchanged source. It verifies the source link/artifact and home
path before restart, then verifies the running service. A failed start or
post-start check is not reported as successful recovery. A restore aborted
before replacement restarts its admission release only if admission began
active; a restore that began stopped stays stopped on that abort. A stop
failure preserves its nonzero service-manager status. Transitional or unknown
activity refuses subsequent mutation.

Inspect the worker journal and selected record. Directory replacement and
code selection have separate checkpoints. Keep snapshot, staging, aside and
record paths after interruption; never remove them as scratch. `updaterPid`
is diagnostic and does not authorize recovery. An unfinished operation blocks
rival forward, restore, switch and prune operations.

The snapshot excludes `auth.json`, `.credentials.json`, `secrets/` and
`mcp-oauth-locks/`. Restore moves their current entries without reading or
copying contents. External keyring entries stay in place. Restore uses the
original canonical home path because secrets keyring account names derive
from that path. Backups are private anyway: rollouts/configuration may contain
sensitive information. New threads after the snapshot stay in quarantine;
there is no lossless merge or silent replacement of missing resume targets.
The disposable home-root cache is not restored; connector/plugin catalog lists
may remain empty until re-fetch completes (especially offline). Check installed
plugin state separately and do not infer history loss from an empty catalog.

The exact home-root name `.sqlite-maintenance.lock` is disposable, alongside
`thread-writer-locks`. Codex uses it to elect one background reclamation worker
per SQLite home (`sqlite_home`, which defaults to `CODEX_HOME`); this classification
applies only to the name at the Codex home root. Both
[0.160.0](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/state/src/runtime/reclamation.rs#L115-L130)
and [0.161.0](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/state/src/runtime/reclamation.rs#L26-L78)
create the file as needed and retain a kernel lock after acquiring ownership,
without using its contents as persisted state. Snapshots omit it from both
manifest and payload. Forward backup leaves its inode/content intact; full
restore leaves it in quarantine, and Codex recreates it in the restored home
at its next ownership attempt. Replacing an active lock's inode can admit
competing reclamation workers: do not delete or rename it to bypass refusal.

Use the recorded physical tool release whose classifier recognizes this lock
for every state-aware operation, including rollback. Helpers without that
classification refuse a lock-bearing home; switching back to older application
code does not justify switching to an older, incompatible state helper or
removing the lock.

`cloud-config-bundle-cache.json` and random home-root `.tmp` staging files remain
unclassified. This exclusion assumes stored ChatGPT-token authentication with
an ineligible workspace, without `CODEX_ACCESS_TOKEN`, workload identity, PAT,
or agent identity overrides. Before logging into a Business/Edu/Enterprise
workspace, migrating organizations, or selecting alternate authentication that
could enable the cloud cache, complete a separate source-based classification
review and install its compatible tool release. The
[cache eligibility predicate](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/cloud-config/src/service.rs#L52-L60)
guards both startup and background refresh. An unclassified cache can refuse
the next update at preflight **and full state restore** when the current home is
inventoried before promotion. Unknown temporary names also remain fail closed;
neither their prefix nor zero-byte contents authorize disposal.

### Resume and recover

Ask the helper for the commands instead of composing them. `next` is
read-only: it takes no lock and writes nothing.

```sh
node "$tool_release/deploy/kaoiro-runner-codex-state.mjs" next "$install_root"
node "$tool_release/deploy/kaoiro-runner-codex-state.mjs" \
  next "$install_root" "$transaction_uuid"
```

- `next <install-root>` prints each unfinished record's UUID and phase, then
  its `next (resume):` and `next (recover):` lines. A terminal record with a
  pending staging cleanup gets its `next (prune):` line. Each held
  `.lock.update` or `.lock.links` is listed as `lock present:`; whether its
  owner is alive is for you to inspect.
- `next <install-root> <uuid>` prints that record's whole row, including the
  `restore`, `prune` and `rollback` lines of a terminal record.
- With an unresolved schema-1 record, `next` prints the old-record guidance
  and exits 0.

Resume and recover always run from the record's physical tool release, not
from a `current` symlink that may have changed; the other lines name the tool
that printed them. Every argument is single-quoted (`'` is written `'\''`),
so a line can be pasted into a POSIX shell as printed.

A refusal prints its message, then the hint for its class: the record's
`next` lines, `see:` an anchor of this runbook, or both. A failure inside a
resume or recover run always prints the record's lines as they are after the
run settled, so a forward that returned to its source offers recovery, not
resume.

#### Recovery table

The table is generated from `runner/deploy/codex-state-recovery.mjs`
(`node runner/deploy/codex-state-recovery.mjs --runbook`). Outcomes:
`settle` records `failed` and starts the unchanged source; `held` exits
nonzero with the phase kept (or the phase in parentheses); `refuse` changes
nothing; `noop` succeeds without changing the record.

<!-- recovery-table:begin -->
| Phase | Command | Branch | Precondition | Outcome | Class |
|---|---|---|---|---|---|
| `prepared` | RES | P-RES-ok | current-source | completed | — |
| `prepared` | RES | P-RES-copy | copy-fault | settle | — |
| `prepared` | REC | P-REC-ok | current-source | failed | — |
| `prepared` | RST | P-RST-own | — | refuse | transaction |
| `prepared` | RES | PS.stopped | late-populated | settle | transient |
| `prepared` | PRN | P-PRN | — | refuse | transaction |
| `prepared` | UPD | P-UPD | — | refuse (G2.prepare) | — |
| `prepared` | RBK | P-RBK | — | refuse (G2.guard) | — |
| `prepared`, `snapshot-verified` | RES | PS.snapshot-stopped | activity-window | settle | transient |
| `prepared`, `snapshot-verified` | RES | PS.snapshot-binding | activity-window | settle | transient |
| `prepared`, `snapshot-verified` | REC | PS.return-link | late-link | held | integrity |
| `prepared`, `snapshot-verified` | REC | PS.return-binding | late-home | held | config |
| `prepared`, `snapshot-verified` | REC | PS.return-activity | activity-window | held (failed) | transient |
| `snapshot-verified` | RES | V-RES-ok | state-equal | completed | — |
| `snapshot-verified` | RES | V-RES-stale | state-differs | settle | — |
| `snapshot-verified` | REC | V-REC-ok | current-source | failed | — |
| `snapshot-verified` | REC | V-REC-missing | snapshot-missing | failed | — |
| `snapshot-verified` | RST | V-RST-own | — | refuse | transaction |
| `snapshot-verified` | PRN | V-PRN | — | refuse | transaction |
| `snapshot-verified` | UPD | V-UPD | — | refuse (G2.prepare) | — |
| `snapshot-verified` | RBK | V-RBK | — | refuse (G2.guard) | — |
| `snapshot-verified` | RES | PS.guard-nested | activity-window | settle | transient |
| `start-intent` | RES | S-RES-source | current-source | completed | — |
| `start-intent` | RES | S-RES-target | current-target | completed | — |
| `start-intent` | RES | S-RES-attest | attest-fault | held | transaction |
| `start-intent` | RES | S-RES-stale | state-differs | held | transaction |
| `start-intent` | REC | S-REC-ok | snapshot-retained | restored | — |
| `start-intent` | REC | S-REC-nosnap | snapshot-unretained | refuse | integrity |
| `start-intent` | RST | S-RST-own | snapshot-retained | restored | — |
| `start-intent` | PRN | S-PRN | — | refuse | transaction |
| `start-intent` | UPD | S-UPD | — | refuse (G2.prepare) | — |
| `start-intent` | RBK | S-RBK | — | refuse (G2.guard) | — |
| `start-intent` | RES | PS.guard-nested-intent | activity-window | held | transient |
| `start-intent` | RES | PS.after-switch | activity-window | held | transient |
| `start-intent` | RES | PS.post-start-active | no-start | held | transient |
| `start-intent` | RES | PS.post-start-binding | bad-live | held | config |
| `completed`, `restored` | RES, REC | T-noop | — | noop | — |
| `completed`, `restored` | RST | T-RST-ok | snapshot-retained | restored | — |
| `completed`, `restored` | RST | T-RST-retired | snapshot-retired | refuse | transaction |
| `completed`, `restored` | PRN | T-PRN | snapshot-retained | noop | — |
| `completed`, `restored` | UPD | T-UPD | — | noop | — |
| `completed`, `failed`, `restored` | RBK | T-RBK-ok | same-native | noop | — |
| `completed`, `failed`, `restored` | RBK | T-RBK-native | differing-native | refuse | config |
| `completed`, `failed`, `restored` | RBK | T-RBK-pre-n2 | pre-n2-target | refuse | config |
| `failed` | RES | F-RES | — | noop | — |
| `failed` | REC | F-REC-ok | current-source | failed | — |
| `failed` | REC | F-REC-moved | current-moved | refuse | integrity |
| `failed` | RST | F-RST | snapshot-retained | restored | — |
| `failed` | PRN | F-PRN | snapshot-retained | failed | — |
| `failed` | PRN | F-PRN-cleanup | cleanup-pending | failed | — |
| `failed` | UPD | F-UPD | copy-fault | noop | — |
| `restore-prepared` | RES | R-RES-ok | current-from | restored | — |
| `restore-prepared` | RES | R-RES-fail | late-link | held | transaction |
| `restore-prepared` | REC | R-REC-cancel | current-from | completed | — |
| `restore-prepared` | REC | R-REC-moved | current-source | refuse | integrity |
| `restore-prepared` | RST | R-RST | — | refuse | transaction |
| `restore-prepared` | PRN | R-PRN | — | refuse | transaction |
| `restore-prepared` | UPD | R-UPD | — | refuse (G2.prepare) | — |
| `restore-prepared` | RBK | R-RBK | — | refuse (G2.guard) | — |
| `restore-prepared` | RES | PS.stage | activity-window | held | transient |
| `restore-prepared` | RES | PS.replace-stopped | activity-window | held (replace-intent) | transient |
| `restore-prepared` | RES | PS.replace-binding | activity-window | held (replace-intent) | transient |
| `restore-prepared` | REC | PS.cancel-activity | activity-window | held (completed) | transient |
| `restore-prepared` | RES | PS.catch-restore | activity-window | held | transient |
| `replace-intent` | RES, REC | Q-L1 | layout-L1 | restored | — |
| `replace-intent` | RES, REC | Q-L2 | layout-L2 | restored | — |
| `replace-intent` | RES, REC | Q-L3 | layout-L3 | restored | — |
| `replace-intent` | RES, REC | Q-L4 | layout-L4 | restored | — |
| `replace-intent` | RES, REC | Q-bad | staging-corrupt | refuse | integrity |
| `replace-intent` | RES, REC | Q-cred | credential-both | refuse | integrity |
| `replace-intent` | RST | Q-RST | — | refuse | transaction |
| `replace-intent` | PRN | Q-PRN | — | refuse | transaction |
| `replace-intent` | UPD | Q-UPD | — | refuse (G2.prepare) | — |
| `replace-intent` | RBK | Q-RBK | — | refuse (G2.guard) | — |

| Site | Class | Message |
|---|---|---|
| G1.run | transaction | "Use the recorded physical updater tool" |
| G2.guard | transaction | "Unresolved Codex transaction requires recovery: ${}" |
| G2.prepare | transaction | "Unresolved Codex transaction requires recovery: ${}" |
| G2.restore | transaction | "Unresolved Codex transaction requires recovery: ${}" |
| G2.run | transaction | "Unresolved Codex transaction requires recovery: ${}" |
| G2.prune | transaction | "Unresolved Codex transaction requires recovery: ${}" |
| G3.run | integrity | "Current is outside recorded operation" |
| G3.guard | integrity | "Current is outside recorded operation" |
| G4.run-pre | config | "Selected installed service differs from record"; "Next launch CODEX_HOME differs from requested home"; "Running CODEX_HOME differs from requested home"; "Restore home/service differs from selected record" |
| G4.guard-entry | config | "Selected installed service differs from record"; "Next launch CODEX_HOME differs from requested home"; "Running CODEX_HOME differs from requested home"; "Restore home/service differs from selected record" |
| G4.restore | config | "Selected installed service differs from record"; "Next launch CODEX_HOME differs from requested home"; "Running CODEX_HOME differs from requested home"; "Restore home/service differs from selected record" |
| G4.prepare | config | "Selected installed service differs from record"; "Next launch CODEX_HOME differs from requested home"; "Running CODEX_HOME differs from requested home"; "Restore home/service differs from selected record" |
| G5.began | transient | "Runner activity is transitional or unknown" |
| G5.binding-run | transient | "Runner activity is transitional or unknown" |
| G5.pre-stop | transient | "Runner activity is transitional or unknown" |
| G5.target-check | transient | "Runner activity is transitional or unknown" |
| G5.resume-stop | transient | "Runner activity is transitional or unknown" |
| G6.helper | lock | "Lock held: ${}" |
| G6.updater | lock | "another run holds" |
| G6.switch-links | lock | "another run holds" |
| G6.install-links | lock | "another run holds" |
| G7.guard | cutover | "Resolve old Codex state records with the previous tool release: ${}" |
| G7.prepare | cutover | "Resolve old Codex state records with the previous tool release: ${}" |
| G7.restore | cutover | "Resolve old Codex state records with the previous tool release: ${}" |
| G7.run | cutover | "Resolve old Codex state records with the previous tool release: ${}" |
| G7.prune | cutover | "Resolve old Codex state records with the previous tool release: ${}" |
| G7.protected | cutover | "Resolve old Codex state records with the previous tool release: ${}" |

| Phase | `next` lines |
|---|---|
| `prepared` | resume, recover |
| `snapshot-verified` | resume, recover |
| `start-intent` | resume, recover |
| `completed` | restore, prune, rollback |
| `failed` | recover, restore, prune, rollback |
| `restore-prepared` | resume, recover |
| `replace-intent` | resume, recover |
| `restored` | restore, prune, rollback |
<!-- recovery-table:end -->

`resume` continues the recorded operation without reinstalling or rebuilding.
`recover` returns a never-started forward to its unchanged source, cancels a
`restore-prepared` attempt before replacement, or restores an unfinished forward in
`start-intent`. Both commands use the recorded service and home; they do not
select a new target from current configuration. `--detach` remains available.

Restore explicitly selects any retained snapshot with
`--restore-codex-backup`. There is no newest-only rule or historical receipt
chain. Verify the payload, UUID, canonical home and original source/target
release IDs/hashes before stopping. The snapshot's source release must still
verify. Each admitted restore appends a new attempt and aside path to the
same operation record. Consecutive and repeated selected restores are allowed.

`restore-prepared` builds a verified sibling staging directory. After
`replace-intent`, rename the live home aside and move current credential
entries into staging. If an expected credential exists in both locations or
neither, preserve both trees and refuse. Save `startRequested` while the home
is absent; select the source release under the links lock before publishing
the staged home. An absent explicit home makes the runner refuse Codex spawn.
Once the home has been published, a boot may write it: resume does not repeat
replacement or compare mutable state/credential contents against staging.
Successful post-start checks mark `restored`. All earlier asides remain named,
including after cancellation, another restore and prune.

### Editing the runner environment

A same-native code-only update requires no unfinished operation, and does not
prove home-path agreement. State-aware admission and resume compare the
canonical requested/recorded path with live and next-start settings. Editing
`runner.env` in place or by rename is allowed when those paths and the
selected service still agree. A new inode at the same canonical home path is
also allowed; this check does not authenticate historical directory identity.
Moving homes remains a separately approved relocation. Do not edit records
or snapshot hashes to bypass a mismatch.

### Old records and barriers

N2 does not convert schema-1 records. Before first activation on a host,
resolve every old unfinished transaction and retire every old retained backup
with its previous physical tool. The new reader examines only old `phase`
and `retired`: all transactions must be `completed`, `restored` or `retired`,
and all backups must have `retired: true`. Obsolete receipt damage does not
block that projection. Unknown, unreadable, unfinished or retained old records
refuse mutation and release-protection output with the filename and previous
tool guidance. Read-only `inventory <install-root>` lists old and v2 filenames.
Old directories remain untouched. The first N2 deployment must use the same
native hash; a pre-N2 source cannot enter an N2 state-aware forward.

Files under `codex-state/barriers` are inert: the helper never reads, writes,
repairs or deletes them. `accept`, `retire`, `abandon`, `repair-barrier` and
the old per-step actions are unknown actions. There is no acceptance evidence,
receipt, owner-PID authorization or automatic abandonment.

### Prune and owned staging cleanup

Explicitly discard a terminal operation's snapshot with the `next (prune):`
line that `next <install-root> <uuid>` prints (see the
[recovery table](#recovery-table)).

Prune requires no history evidence and can remove a corrupt owned snapshot.
It records durable `prune-intent`, the exact path, root device/inode and logical
size before recursive removal. Retry after partial deletion without expecting
an intact payload: an absent root completes retirement, while a symlink or
reused root refuses. It keeps the operation record and every aside. Retained
snapshots protect only their source release; unfinished operations additionally
protect source, target/from and the physical tool. Historical terminal target
and tool releases do not remain protected solely by that record.

Owned staging removal is separately recorded with path, size and a pending
flag before deletion. A failed removal remains visible and retryable through
recovery/prune. Unrecorded orphan directories are not silently adopted or
deleted. Manual removal of protected releases is prohibited.

### Stale operation locks

Operations acquire `.lock.update`, then `.lock.links` for record/link changes.
A held lock is never stolen. After worker death or boot, inspect the exact
worker/unit and paths before removing only its stale locks. Confirm that no
update/install/switch/helper you started remains alive and that the detached
`<service>-update.service` is not running. A build-directory cleanup failure
can deliberately retain `.lock.update`; inspect and preserve that directory
before clearing the lock. PID reuse or absence is not a state transition.
Then run the lines that `next <install-root>` prints (see the
[recovery table](#recovery-table)).

```sh
rmdir "$install_root/.lock.update"
rmdir "$install_root/.lock.links"
```

A lock directory is not an operation record. Preserve every named snapshot,
staging and aside tree while investigating; removing a stale lock does not
settle an operation or justify changing its phase.

## See Also

- [Multi-host deployment architecture](../architecture/deployment.md).
- [Server update and rollback](server-update-and-rollback.md).
- [Runner artifacts](../reference/deployment/runner-artifacts.md).
- [Runner service verification](runner-service-verification.md).
- [High-risk change release](high-risk-change-release.md).
