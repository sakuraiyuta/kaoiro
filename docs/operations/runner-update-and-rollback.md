---
title: Runner update and rollback
description: The runner-side steps interleaved with a server update, migrating a checkout-direct host to the release profile, and subsequent release-profile updates and rollback.
status: accepted
last_updated: 2026-09-26
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

### 4.6 Migrate to the release profile and update thereafter (issue #219)

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

**On failure, go to 4.4 (2).** The server-side transaction from (1)/(2) is
untouched — it is still sitting at `env_consistency_checked`, waiting for
`--maintenance-approved`.

**(7) Start the runner**

Skip for release-profile hosts — already started by `kaoiro-runner-update.sh`
in (3)/(4).

```sh
systemctl --user start kaoiro-runner
```

**(2) Runner build failed** (4.3 step 4)

The server has not switched — the old container is still running. **Still
check (0)**: if the server's own prepare (4.3 (1)/(2)) already succeeded,
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

#### 4.6.1 Migrate from checkout-direct (operator action, once per host)

**Only step (6) touches the running runner.** Agents disconnect only when it is
restarted there (the warning in section 2 “Run as a service” applies).

```sh
# 1. 現在の稼働状態を記録する。移行後に比較する基準になる
systemctl --user show -p ExecStart --value kaoiro-runner
<repo-path>/runner/dist/cli.js --version

# 2. repo から tarball を作る。runner は稼働したまま
cd <repo-path>
git status --porcelain   # 空であること (dirty だと id に -dirty が付く)
./scripts/build-runner-tarball.sh --target linux-x64

# 3. release として install する。稼働中の dist には触れない
./runner/deploy/kaoiro-runner-install.sh \
  dist-tarball/kaoiro-runner-<rev>-linux-x64.tar.gz

# 4. current を作る。unit はまだ旧 path を指しているので無影響
./runner/deploy/kaoiro-runner-switch.sh <release-id>

# 5. unit の ExecStart を current 経由へ張り替える
install_root="${XDG_DATA_HOME:-$HOME/.local/share}/kaoiro"
sed "s|@@DEPLOY_DIR@@|$install_root/current/deploy|" \
  runner/deploy/kaoiro-runner.service \
  > ~/.config/systemd/user/kaoiro-runner.service
systemctl --user daemon-reload

# 6. ここで初めて停止が起きる。配下のエージェントは全て切断される
systemctl --user restart kaoiro-runner

# 7. 確認する
systemctl --user status kaoiro-runner
"$install_root/current/deploy/kaoiro-runner-launch.sh" --version
```

Confirm (7)'s `--version` matches the value recorded in (1) and `status` is
`active (running)`. Rerun the connectivity checks in section 3.

**After migration, the repo's `dist` is no longer the live path.** The repo is a
build source; `pnpm -C runner build` does not affect the running runner.

#### 4.6.2 Subsequent updates

Advance the repo to the target SHA, then run the update as **one command**.

```sh
install_root="${XDG_DATA_HOME:-$HOME/.local/share}/kaoiro"
git -C <repo-path> fetch origin
git -C <repo-path> merge --ff-only <target-sha>
git -C <repo-path> status --porcelain   # 空であること

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
| `--service <name>` | `kaoiro-runner` | Target systemd user unit |
| `--keep <n>` | `3` | Generations to retain; excludes `current` / `previous` |
| `--install-dir <dir>` | Above default | Install root |
| `--allow-dirty` | — | Allow activation of `-dirty` / `unknown`; **development hosts only** |

Never delete the release referenced by `current` / `previous`, regardless of
`--keep`. The runner **does not resolve the Codex wrapper until the first Codex
spawn**, so the active release continues to be read after startup; deleting it
breaks a spawn that has not happened yet.

#### 4.6.3 Rollback

If a problem appears after switching, return to the previous release.

```sh
install_root="${XDG_DATA_HOME:-$HOME/.local/share}/kaoiro"
systemctl --user stop kaoiro-runner
"$install_root/previous/deploy/kaoiro-runner-switch.sh" --rollback
systemctl --user start kaoiro-runner
```

**Run the script from `previous`.** The `current` release is being rolled back
because it may be broken, so its scripts are not trusted.

If switching itself fails during an update, `kaoiro-runner-update.sh` restarts the
service without moving `current` and exits non-zero. No rollback is needed; it is
already running the old release.

## See Also

- [Multi-host deployment architecture](../architecture/deployment.md).
- [Server update and rollback](server-update-and-rollback.md).
- [Runner artifacts](../reference/deployment/runner-artifacts.md).
- [Runner service verification](runner-service-verification.md).
