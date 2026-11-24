---
title: Runner update and rollback
description: The runner-side steps interleaved with a server update, migrating a checkout-direct host to the release profile, and subsequent release-profile updates and rollback.
status: accepted
last_updated: 2026-11-24
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

Automatic update and rollback are supported only on Linux with systemd. On macOS,
the runner is supported for the initial install only; see
[Running as a service (systemd / launchd)](runner-install.md#running-as-a-service-systemd--launchd).

A change that can stop the fleet from starting or every agent's turns from
completing (the runner's start path, the wrapper's turn lifecycle) follows
[High-risk change release](high-risk-change-release.md) first: it adds a
production-shape start check and fleet restoration procedure, and it links back
here for the update and rollback commands.

## Engine acquisition

Bootstrap and update install the candidate release, then acquire the enabled
Claude and Codex pins before switching. Update does this before stopping the
runner. When the configuration file is absent acquisition is skipped; an
unreadable or invalid file fails the operation. An acquisition failure leaves
the current release running, and a later update can retry. An already acquired
pin needs no network request; a missing pin requires access to the npm registry.
Acquisition has no timeout: if the registry stalls, update waits before
stopping the runner; interrupt the update to stop waiting.

Managed engine behavior depends on the release and operation.

| Tool and operation | If a managed pin is missing |
| --- | --- |
| Old-layout runner, wrapper spawn or Claude catalog probe | Uses the release tree's bundled engine. |
| Bundled runner, wrapper spawn | Fails when the required managed engine is missing from the store. |
| Bundled runner, Claude catalog probe | Fails when its Claude pin is missing from the store. |
| Update with acquisition | Fetches the candidate's enabled pins before stopping the service. A failed download leaves the current release running. |
| Bootstrap with acquisition | Fetches enabled pins before the first switch. A failed download prevents activation. |
| `switch` | Changes the selected release without acquisition. |
| `--rollback` | Restores the previous release link without acquisition. Its next managed spawn needs that release's pin in the store. |
| Configuration reload that enables an engine | Does not acquire pins. Fetch the newly enabled pin before launching that engine from a bundled release. |

For old-layout releases, the switch guard hashes the binary inside the
release. For bundled releases it compares the recorded native identity.
Acquisition verifies the acquired binary against the release's record.
The switch guard does not rehash the store after acquisition.

The updater executes the **candidate's** `deploy/kaoiro-runner-engines.sh`.
For an already retained release, `switch` and `--rollback` do not require that
script. To reinstall an older tarball, use its own tools or
`kaoiro-runner-install.sh` followed by `kaoiro-runner-switch.sh`.
For a bundled tarball, follow [Re-acquire an engine pin](#re-acquire-an-engine-pin)
after switching to confirm its pins are present before launching its engines.

### Re-acquire an engine pin

On the runner host, apply the intended `capabilities` before acquisition.
When repairing a damaged version, remove only that version's store directory
after confirming it is unused by active agents or operations. Keep healthy
pins used by retained rollback targets. From the runner user's shell use
the current release's acquisition tool with the runner's install root:

```sh
"$install_root/current/deploy/kaoiro-runner-engines.sh" \
  install --install-dir "$install_root"
```

The script uses the runner's usual configuration and fetches enabled pins
that are absent. It does not restart the service or change either release
link. Confirm the expected pin is present before launching the engine.
The engine store is not pruned automatically. See the
[engine store contract](../reference/configuration/runner.md#engine-store).

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
[deployment completion checks](build-identity-and-release-tags.md#deployment-completion-and-legacy-descriptors).

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
restarted there (the warning in [Run as a service](runner-install.md#run-as-a-service) applies).

```sh
# 1. Record current operating state as a baseline for post-migration comparison
systemctl --user show -p ExecStart --value kaoiro-runner
<repo-path>/runner/deploy/kaoiro-runner-launch.sh --version

# 2. Build tarball from repo while runner remains active
cd <repo-path>
git status --porcelain   # Must be empty (dirty checkout appends -dirty to id)
./scripts/build-runner-tarball.sh --require-tagged --target linux-x64

# 3. Install as a release without touching running dist
./runner/deploy/kaoiro-runner-install.sh \
  dist-tarball/kaoiro-runner-<rev>-linux-x64.tar.gz

# 3b. Fetch the release's engine pins (reads the runner configuration)
install_root="${XDG_DATA_HOME:-$HOME/.local/share}/kaoiro"
"$install_root/releases/<release-id>/deploy/kaoiro-runner-engines.sh" \
  install --install-dir "$install_root"

# 4. Create current symlink. Unit still points to old path so no disruption
./runner/deploy/kaoiro-runner-switch.sh <release-id>

# 5. Retarget unit's ExecStart to point via current
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
`active (running)`. Rerun the
[connectivity checks](server-update-and-rollback.md#3-connectivity-checks).

**After migration, the repo's `dist` is no longer the live path.** The repo is a
build source; `pnpm -C runner build` does not affect the running runner.

### First update from the old layout to the bundle

Use this path from the source identified in the release card. The source
and candidate must carry the same Codex native SHA-256. Check the approved
archive digest before extracting it privately. Invoke the candidate's
physical `deploy/kaoiro-runner-update.sh` with `--tarball`, the explicit
install root and service, and `--detach`. Keep the approved archive and
digest for recovery. Old tools reject the bundle during verification.
On an existing installation, bootstrap can switch `current` without
restarting an active runner; use the updater for this transition.

For a same-pin return, recheck the saved digest and extract a fresh copy
before stopping. Use that extraction's physical `kaoiro-runner-switch.sh
--rollback` in the existing stop/switch/start sequence. Confirm that
`previous` is the verified source. Recheck the running identity after return.
To update again after rollback, repeat the boundary update with the same
candidate tools after rechecking the source and the approved archive digest.

The updater shipped with the bundle prunes after activation under the link
lock. It keeps `current`, `previous` and the newest `--keep` valid release
directories (default 3). Re-read the retained set after the update. Name only
measured rollback targets in the card.

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

It performs build → install → acquire → stop → switch → start → identity check → prune in
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
Distinguish the pre-work exit 75 for a held `.lock.update` or `.lock.install` by the lock name
in stderr: a post-start skip instead names `.lock.links` or reports changed
current. The update has already printed its starting-service line.

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
| `--from-release <tag>` | — | Fetch and verify a tagged GitHub release (Linux x64/systemd) |
| `--target <os-arch>` | — | Build target, only with `--from-repo` (`darwin-arm64` or `linux-x64`) |
| `--detach` | — | Queue update as a transient systemd user service via `systemd-run --user --no-block` |
| `--service <name>` | `kaoiro-runner` | Target systemd user unit |
| `--keep <n>` | `3` | Newest valid releases to retain, counting `current` / `previous` (never pruned); at least 1 |
| `--install-dir <dir>` | Above default | Install root |
| `--allow-dirty` | — | Allow activation of `-dirty` / `unknown`; **development hosts only** |
| `--codex-native-change` | — | Allow a target whose Codex native differs from the current release; see [Codex native changes](#codex-native-changes) |

Never delete the release referenced by `current` / `previous`, regardless of
`--keep`. Every wrapper spawn starts `dist/kaoiro.mjs` from the release the runner
started from, so the active release continues to be read after startup;
deleting it breaks a later spawn.

#### Update from a published release

With the new updater on Linux x64/systemd, pass the exact published
`vYYYY.MM.DD.N` tag. This input excludes `--tarball`, `--from-repo`,
`--target`, and `--allow-dirty`. Install `curl` and `sha256sum` on the
update host. For a detached update, check the worker result as above.

```sh
"$install_root/current/deploy/kaoiro-runner-update.sh" \
  --from-release "$release_tag" --detach
```

The worker downloads the archive and its SHA-256 sidecar over HTTPS. It
checks the digest before invoking the installer. The installer checks the
expected unprefixed build version before placing or reusing a tree, so a
wrong version cannot occupy the commit's release directory. SHA-256
detects a mismatch in the retrieved files. A distribution origin that
replaces both the archive and the sidecar can supply a matching pair.

For the first upgrade from a release whose updater lacks `--from-release`,
download the archive and sidecar from the approved release. Verify the
archive against the digest recorded in the release card and use the existing
`--tarball` path. The Darwin arm64 download is for
[initial install](runner-install.md#running-as-a-service-systemd--launchd).
Darwin and musl runtime are unverified for this publication path.

#### Coordinated server and wrapper updates

For [issue #965](https://github.com/sakuraiyuta/kaoiro/issues/965), server U1
and wrapper U2 form one production release. Landings may be separate, but do
not leave production at either intermediate combination. The operator performs
the existing maintenance and [high-risk release/restore procedure](high-risk-change-release.md#4-release-and-restore-the-fleet):

1. Stop all agents and explicitly stop **every runner before the server
   commit** (`systemctl --user stop kaoiro-runner`). The updater's later stop
   does not replace this step. Stop manually launched/development wrappers
   connected to that server as well.
2. Apply the paired server release through the normal server deployment
   procedure, then run the runner updater with `--detach`.
3. Before restore, verify server and runner versions/identity and the runner
   connection. Confirm that old wrappers and pending spawns are absent. All
   agents being offline is expected at this stage.
4. Use the high-risk procedure's offline list and confirmation count to bulk
   restore. **After restore**, verify each wrapper's connection and
   `wrapper_build_info`, and record every tile's restore outcome. Partial
   success is not a completed restore.

Follow the existing failure procedure if a check fails. For rollback, stop
the runner first and restore the server **and** runner to the paired previous
release. A server-only rollback can silently deliver an unlinked `work_id` and
make a later yield fail; a runner-only rollback leaves old operation schemas.
If updater activation fails and restarts the previous runner, stop that runner
before paired recovery. Do not invent a new gate or treat an intermediate
combination as supported. Production release approval is still required.

### 4.6.3 Rollback

Use the fixed physical path of a verified release containing the guarded
switch. Keep stop, switch and start in one success chain; a refused switch
must leave the runner stopped:

```sh
tool_release=<physical path of that verified release>
systemctl --user stop kaoiro-runner &&
  "$tool_release/deploy/kaoiro-runner-switch.sh" --rollback \
    --install-dir "$install_root" &&
  systemctl --user start kaoiro-runner
```

The switch refuses a rollback across a Codex native change; going back across
one is the exception in [Codex native changes](#codex-native-changes). Never
retry with an older script through `previous`. The production manual keeps the
same command as a cheat-sheet entry
([rollback](production.md#5-rollback)).

## Codex native changes

The updater and the switch compare the Codex native of the current release
with the target. When the two differ, the updater refuses before it stops the
runner and the switch refuses before it changes `current`, unless the operator
passes `--codex-native-change`. No copy of the Codex home is taken and nothing
restores one. The new native migrates the home that `CODEX_HOME` in
`runner.env` names on its first start, so a native change only moves forward.

Keep a native pin change in a release of its own, so that a rollback for any
other reason does not have to cross it. Release it with the flag:

```sh
"$install_root/current/deploy/kaoiro-runner-update.sh" \
  --tarball "$archive" --codex-native-change --detach
```

The updater passes the flag to its pre-stop check, to the switch and to a
detached worker. When the started release does not reach a good state, the
rollback line it prints carries the flag too.

Going back across a native change is an exception. Use the current release's
switch, which accepts the flag, and run these in order:

1. Stop the runner.
2. Run the switch with `--rollback --codex-native-change`.
3. Start the runner.
4. Check the running version.
5. If Codex does not work on the migrated home, set up a fresh home as in
   [Fresh home after going back across a native change](codex-home.md#fresh-home-after-going-back-across-a-native-change).
   Codex conversations are lost.

```sh
tool_release=$(readlink -f "$install_root/current")
systemctl --user stop kaoiro-runner &&
  "$tool_release/deploy/kaoiro-runner-switch.sh" --rollback \
    --install-dir "$install_root" --codex-native-change &&
  systemctl --user start kaoiro-runner
"$install_root/current/deploy/kaoiro-runner-launch.sh" --version
```

Older releases kept Codex state records under `codex-state/` and snapshots in
the directories given to their updater. The tools in this repository neither
read nor write them, but an older release reads them again after a rollback to
it, and its updater
refuses to install a newer release while one of its snapshots is retained.
Leave them until going back to such a release is no longer expected; deleting
them is the operator's decision.

## Stale operation locks

Operations acquire `.lock.update` (update), `.lock.install` (install, which
update and bootstrap also run) or `.lock.bootstrap` (bootstrap), then
`.lock.links` for link changes.
A held lock is never stolen. After worker death or boot, inspect the exact
worker/unit and paths before removing only its stale locks. Confirm that no
update/install/switch you started remains alive and that the detached
`<service>-update.service` is not running. A build-directory cleanup failure
can deliberately retain `.lock.update`; inspect and preserve that directory
before clearing the lock. PID reuse or absence is not a state transition.

```sh
rmdir "$install_root/.lock.update"
rmdir "$install_root/.lock.install"
rmdir "$install_root/.lock.bootstrap"
rmdir "$install_root/.lock.links"
```

## See Also

- [Multi-host deployment architecture](../architecture/deployment.md).
- [Server update and rollback](server-update-and-rollback.md).
- [Runner artifacts](../reference/deployment/runner-artifacts.md).
- [Runner service verification](runner-service-verification.md).
- [High-risk change release](high-risk-change-release.md).
