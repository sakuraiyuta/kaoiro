---
title: Runner update and rollback
description: The runner-side steps interleaved with a server update, migrating a checkout-direct host to the release profile, and subsequent release-profile updates and rollback.
status: accepted
last_updated: 2026-10-01
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
pnpm -C wrapper build && pnpm -C runner build
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
./scripts/build-runner-tarball.sh --target linux-x64

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

`--detach` queues the update as a transient **service** unit via
`systemd-run --user --no-block`. **Always use it when running from an agent under
the runner**; without it, stopping the runner kills the caller and later steps
never run.

**The queued unit does not inherit the caller's environment.** A transient
unit runs with the user manager's environment, not this shell's, so `--detach`
forwards exactly two variables to it with `--setenv`: `PATH` (always) and
`KAOIRO_NODE` (only when set in the calling shell). Nothing else is forwarded;
in particular `KAOIRO_RUNNER_TOKEN` never reaches the update unit. If the
worker needs a Node or a `kaoiro-runner` binary that the user manager's default
`PATH` does not resolve, export `PATH` / `KAOIRO_NODE` in the shell that runs
`--detach`; a PATH that lacks them makes the detached run fail after the
ENQUEUED line, visible only in the unit's journal below.

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

Same-native, code-only switching remains possible with the new guarded switch
when there are no retained state references or incomplete transactions. A switch failure after a verified snapshot attempts snapshot recovery to the
recorded source, restarts it only after verification, and still reports a failed
update. A snapshot or recovery failure leaves the service stopped. Never
restart old code against potentially migrated state.

### Second-level recovery: fresh setup

If snapshot recovery cannot succeed, keep the runner stopped and let the
operator choose a fresh Codex setup. This deliberately loses Codex conversation
history, login and caches; it is not an automatic credential reset. Preserve
failed home/staging/quarantine trees privately instead of deleting them.

Use [Codex home creation and login](codex-home.md#fresh-setup-after-failed-snapshot-recovery)
at the configured canonical path with the verified selected release. Normally
keep the verified current release. A requested code downgrade instead needs a
fresh installation of that selected release against an empty home, never an
old binary against the failed migrated database.

Before restarting, the operator must preserve the recorded source/tool releases
and archive the installation's `codex-state` registry into a private diagnostic
directory under both update/links locks. This manual registry reset is allowed
only after confirming that the installation's records all belong to this
home/unit. If that scope cannot be established, preserve the entire old
installation and provision a fresh installation instead. Do not edit hashes,
remove just a barrier, or claim that old acceptance certifies the new home.
Recreate configuration, instruction links and hook trust, then have the
operator log in. Start Codex peers as explicitly new sessions and verify their
first turn and hook/profile marker; old session IDs must remain visibly missing.

## Codex state backup

This workflow requires Linux/systemd, a private same-user Codex home and an
operator-controlled maintenance interval with no dispatch, process spawning,
unit/environment reload, or release modification. Same-native comparison is
also enforced on macOS, where state-aware migration is currently unsupported.
The hash comparison does not prevent unmanaged replacement between checking
and execution. The script rejects unsupported unit/shell configuration rather
than executing it to discover the home.

Before scheduling maintenance, obtain explicit operator approval to run the
metadata-only classification preflight against the production home:

```sh
node "$tool_release/deploy/kaoiro-runner-codex-state.mjs" classify "$codex_home"
```

Keep the output private. It contains paths, modes and sizes, never credential
contents. Unknown entries require reviewed classification; do not delete or
rename files merely to make the check pass. Only the managed runner and its
service descendants are checked for stop completion. External processes are
not scanned; an unreadable process or another writer does not itself refuse
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

Forward backup requires the source runner to be active for live home binding.
A snapshot failure means a nonzero worker exit, no switch and no start. Inspect
the journal and private `codex-state/transactions/<uuid>.json`. A post-start
failure requires state-aware recovery. Directory replacement and code switching
are separate operations: retain staging/quarantine trees and transaction
records after interruption, especially if credentials have moved. Do not use a
recursive scratch cleanup on these paths. Use `inspect <install-root> <uuid>`
with the fixed state helper to read the recorded recovery paths.

The snapshot excludes `auth.json`, `.credentials.json`, `secrets/` and
`mcp-oauth-locks/`. Restore moves their current entries without reading or
copying contents. External keyring entries stay in place. Restore uses the
original canonical home path because secrets keyring account names derive
from that path. Backups are private anyway: rollouts/configuration may contain
sensitive information. New threads after the snapshot stay in quarantine;
there is no lossless merge or silent replacement of missing resume targets.

Successful runner startup leaves the transaction `awaiting-acceptance`.
Perform actual Codex startup and pre-existing history checks. Record their
observed result in a private mode-0600 JSON file with `schema: 1`, the transaction
`uuid`, its `nativeHash`, and boolean `codexStart` / `history`. Then run:

```sh
node --experimental-vm-modules \
  "$tool_release/deploy/kaoiro-runner-codex-state.mjs" \
  accept "$install_root" "$transaction_uuid" "$acceptance_file"
```

Acceptance publishes the auxiliary migration barrier. This manual evidence
record is an operator attestation, not a model turn performed by the helper.
The helper independently checks current release/hash and live/static home
binding. Subsequent updates require both backup arguments while any reference
is retained. Normal restore takes the newest applicable reference; older
selections require a separate operator-approved recovery plan describing the
intervening state loss. No force flag skips lineage.

Do not remove a barrier to fix it. `repair-barrier <install-root> <uuid>` uses
only a completed accepted transaction matching current release and original
home, preserving the damaged record for diagnosis. Otherwise use independently
verified snapshot recovery; absence of either proof requires an explicit
operator recovery plan. Home relocation is a separate reviewed operation.

Retirement requires accepted gate-6 snapshot/fresh-setup recovery results
(not old-binary compatibility with migrated databases), actual production startup/history
checks, and explicit abandonment of rollback. Supply a private JSON record
with `schema: 1`, `uuid`, and true `gate6`, `productionCodexStart`,
`productionHistory`, `abandonRollback` to
`retire <install-root> <uuid> <evidence-file>`. The helper acquires update/link
locks, marks the reference retired before deleting its named snapshot, and
leaves the migration barrier. Releases needed by other references stay
protected from prune/replacement. Manual deletion of protected releases is
prohibited.

## See Also

- [Multi-host deployment architecture](../architecture/deployment.md).
- [Server update and rollback](server-update-and-rollback.md).
- [Runner artifacts](../reference/deployment/runner-artifacts.md).
- [Runner service verification](runner-service-verification.md).
