---
title: Multi-host deployment guide
description: Canonical manual procedure for operating a server (separate host, docker compose + nginx) and runners on multiple hosts. Covers nginx locations, env variables, DETS paths, auth token issuance, wss constraints, and updating existing deployments (interim until automation).
status: accepted
related: [security-boundaries, setup-wizards, security-threat-model]
---

# Multi-host deployment guide

## Purpose

Moved to [Multi-host deployment architecture](../architecture/deployment.md#purpose).

## Overall architecture

Moved to [Multi-host deployment architecture](../architecture/deployment.md#overall-architecture).

## 1. Deploy the server

Moved: 1.1-1.3 to [Server install runbook](../operations/server-install.md), the env variable table to [Server configuration](../reference/configuration/server.md), and 1.4-1.6 to [Network and login runbook](../operations/network-and-login.md).

### 1.1 Issue authentication tokens (three required)

Moved to [Server install runbook](../operations/server-install.md#11-issue-authentication-tokens-three-required).

### 1.2 Create `.env`

Moved to [Server install runbook](../operations/server-install.md#12-create-env) (steps) and [Server configuration](../reference/configuration/server.md) (env variable table and DETS paths).

### 1.3 Start with docker compose

Moved to [Server install runbook](../operations/server-install.md#13-start-with-docker-compose).

### 1.4 nginx reverse proxy

Moved to [Network and login runbook](../operations/network-and-login.md#14-nginx-reverse-proxy).

### 1.5 Direct VPN deployment (no nginx, plain HTTP, 2026-07-26)

Moved to [Network and login runbook](../operations/network-and-login.md#15-direct-vpn-deployment-no-nginx-plain-http-2026-07-26).

#### Boot order for a VPN publish address

Moved to [Network and login runbook](../operations/network-and-login.md#boot-order-for-a-vpn-publish-address).

### 1.6 Configure OAuth login (optional, ADR-0042 / issue #65)

Moved to [Network and login runbook](../operations/network-and-login.md#16-configure-oauth-login-optional-adr-0042--issue-65).

## 2. Deploy runners (multiple hosts)

Distribution currently uses tarballs (issue #70, revised 2026-07-25 in
[ADR-0018](../adr/0018-runner-distribution.md)); expand one on each agent host.
The full procedure and service setup (systemd user unit / launchd LaunchAgent)
are canonical in [runner/README.md](../../runner/README.md); this section covers
only points specific to multi-host deployment.

```sh
# ビルドホスト(1 台)で対象アーキテクチャごとに生成
./scripts/build-runner-tarball.sh --target linux-x64
./scripts/build-runner-tarball.sh --target darwin-arm64

# 各エージェントホストへ転送し、release として install する
# (展開先は <install-root>/releases/<rev>/、ADR-0018 2026-08-16 改訂)
./kaoiro-runner-install.sh kaoiro-runner-<rev>-linux-x64.tar.gz
./kaoiro-runner-switch.sh <release-id>
```

The install / switch scripts are in the package's `deploy/`. For the first
installation, expand the archive once and run from there
(`tar xzf ... && cd ... && ./deploy/kaoiro-runner-install.sh ../<archive>`).
Afterward use `<install-root>/current/deploy/`. Section 4.6 is canonical for
layout, updates, and rollback.

### `runner.config.json` example (`wss://` required)

For prod deployments through nginx, `server_url` must be `wss://` (`ws://`
direct connections receive 301 under the 1.4 constraint). Only the direct VPN
deployment (1.5) uses `ws://<PHX_HOST>:<PORT>/runner`. Make `host_id` unique per
host: the server's `HostRegistry` registers by host ID, so duplicates overwrite
one host with the other.

```json
{
  "host_id": "lab-pc-1",
  "server_url": "wss://kaoiro.example.com/runner",
  "cwd_allowlist": ["/home/agent/repos"],
  "capabilities": ["claude-code", "codex", "antigravity"]
}
```

Set `KAOIRO_RUNNER_TOKEN=<token issued in 1.1>` in `runner.env` (pair it with
`<host_id>:<token>` in server-side `KAOIRO_RUNNER_TOKENS`) and run `chmod 600`.
Override `server_url` with `KAOIRO_RUNNER_SERVER_URL` in `runner.env` as well
(issue #135; env takes precedence over the config file).

For local launchers, `runner/runner.env` is a separate gitignored file that
contains only `KAOIRO_RUNNER_TOKEN=<64 lowercase hex>`. `scripts/dev.sh` and
`scripts/dogfood.sh` create it with mode 0600 when absent and append its pair
to the server list for the configured host; a preset environment token wins
after validation.

### Run as a service

Templates for systemd user units (Linux) and launchd LaunchAgents (macOS) ship
in `runner/deploy/`. See the “Run as a service” section of
[runner/README.md](../../runner/README.md) for installation, exit codes, and
troubleshooting. In the release profile set `@@DEPLOY_DIR@@` to
`<install-root>/current/deploy`; starting the unit through the symlink is what
makes switching atomic. **Restarting a runner (including service restart) stops
all wrappers beneath it** (`supervisor.stopAll()` on SIGTERM), so
`systemctl --user restart` / `launchctl kickstart -k` with active agents
disconnects every agent on that host.

## 3. Connectivity checks

Moved to [Server update and rollback](../operations/server-update-and-rollback.md#3-connectivity-checks).

## 4. Update an existing deployment

Sections 1–2 cover **initial deployment**. This section is canonical for moving
an already-running deployment to a new version.

> **The server side is a CLI** (`server/deploy/kaoiro-server-deploy.mjs`,
> issue #306), driven by a transaction manifest + journal — 4.3/4.4 below
> document it. **The runner side remains a separate, still-manual (or
> checkout-direct) procedure** interleaved with the CLI calls; 4.6 covers the
> release-profile automation for it. Automation does not remove the 4.1
> limits by itself — they remain until their own resolving condition is met.

### 4.1 Known limits

The In-place build limit row moved to
[Multi-host deployment architecture](../architecture/deployment.md#build-and-restart-boundaries);
the remaining status paragraphs below stay here (to be moved in U20).

Moved to [Server update and rollback](../operations/server-update-and-rollback.md#update-related-resolved-limits).

### 4.2 Preconditions

Moved to [Server update and rollback](../operations/server-update-and-rollback.md#42-preconditions).

### 4.3 Update procedure

Moved to [Server update and rollback](../operations/server-update-and-rollback.md#43-update-procedure) (CLI overview, config keys -- see [Server deploy configuration](../reference/configuration/server-deploy.md) -- dry-run semantics, prepare/commit split, and the update-flow diagram).

Server steps (1)(2)(5)(5-a)(5-b)(5-c)(6) moved to U20's page above. Runner steps (3)/(4)/(7) below stay here until U21 gives them their own page.

Moved to [Server update and rollback](../operations/server-update-and-rollback.md#43-update-procedure) ((1) Save the old image, (2) Prepare the server image, including the issue #220 persistence-path/env-consistency check).

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

Moved to [Server update and rollback](../operations/server-update-and-rollback.md#43-update-procedure) ((5) Stop the server and determine whether it stopped cleanly, (5-a) Resolve the volume, (5-b) Migrate the user ledger, (5-c) Archive and verify DETS, (6) Start the server with the prepared image).

**(7) Start the runner**

Skip for release-profile hosts — already started by `kaoiro-runner-update.sh`
in (3)/(4).

```sh
systemctl --user start kaoiro-runner
```

Moved to [Server update and rollback](../operations/server-update-and-rollback.md#43-update-procedure) (status command output, transaction phases, and container-branch classification are now in [Server deploy configuration](../reference/configuration/server-deploy.md#transaction-states-and-status)).

### 4.4 Failure handling

Moved to [Server update and rollback](../operations/server-update-and-rollback.md#44-failure-handling) ((0) A prepare-phase abort left latest pointing at the wrong image, (0a) another run holds <lock-path>, (1) The commit step failed before reaching done).

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

Moved to [Server update and rollback](../operations/server-update-and-rollback.md#44-failure-handling) ((3) Roll back a committed transaction, (4) Runner does not restart, (5) Operational checks are incomplete).

### 4.5 Verification and its limits

Moved to [Server update and rollback](../operations/server-update-and-rollback.md#operational-success-the-success-criteria)
(the "Verification has two layers" intro is folded in there too).

#### Operational success (the success criteria)

Moved to [Server update and rollback](../operations/server-update-and-rollback.md#operational-success-the-success-criteria).

#### Provenance verification (build identity, issue #218, [ADR-0053](../adr/0053-build-identity.md))

Moved to [Transactions and identity](../reference/deployment/transactions-and-identity.md#provenance-verification-build-identity-issue-218-adr-0053).

### 4.6 Migrate to the release profile and update thereafter (issue #219)

[ADR-0018](../adr/0018-runner-distribution.md) (revised 2026-08-16) defines
immutable releases with an atomic switch. **The 4.1 in-place-build limit is
removed by this per-host migration, not by merging code.**

#### Layout

```text
<install-root>/
  releases/<revision>[-dirty]/   # tarball expansion; immutable thereafter
  current  -> releases/<revision>   # unit ExecStart goes through this
  previous -> releases/<revision>   # rollback target
```

The default `<install-root>` is Linux `${XDG_DATA_HOME:-~/.local/share}/kaoiro`
and macOS `~/Library/Application Support/kaoiro`. Override with
`KAOIRO_RUNNER_INSTALL_DIR` or each script's `--install-dir`.

**Estimate disk space.** An expanded release is **about 1 GB each** (measured
993 MB linux-x64 on 2026-09-18); the engine CLI itself is about 920 MB. The
default retention is three generations (`--keep`), using about 3 GB in
steady state.

`.lock.*` (exclusive locks) and `.staging.*` (expansion/build work areas) are
created directly under the install root. Staging from a run that missed its EXIT
trap (for example SIGKILL) is **garbage-collected immediately after the next run
acquires the lock**, so it does not accumulate.

**GC is prefix-scoped; each script targets only what it created**—install only
`.staging.install.*`, update only `.staging.build.*`. Deletion is justified only
when no other run of that script is active, within the scope guaranteed by its
lock. Install and update have separate locks, and update calls install; a glob
spanning both once let a **nested install delete an update's in-use build
directory** (`--from-repo` failed entirely; issue #219 review round 2). Lock
directories use the `.lock.*` prefix and match neither glob.

#### Activation contract (what may become `current`)

| Target | Contract |
|---|---|
| ID eligible for `current` | **Only a clean 40-digit hex**. `-dirty` / `unknown` require explicit `--allow-dirty` on a dev host |
| Reinstall a clean release | **Cannot replace** (content-addressed; reinstall is a no-op and has no override flag) |
| Reinstall dirty / unknown | Rejected by default; `--allow-dirty` permits replacement, but not while pointed to by `current` / `previous` |
| Rollback | No gate; `previous` was activated once already |

**Before a production update, confirm `git status --porcelain` is empty.** A build
from a dirty tree produces a `-dirty` ID and is rejected **before stopping the
runner** (the release-identity contract in [ADR-0018](../adr/0018-runner-distribution.md)).
`--allow-dirty` is for development hosts; in production it makes `current` a name
whose contents are not fixed.

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

#### 4.6.4 What tests do not guarantee (verify once on real hardware)

Deterministic tests pin the arguments passed by the update script to `systemd-run`
(`--user` / `--no-block` / a dedicated unit name / **no `--scope`** / no `PartOf` /
an absolute updater path) and worker ordering (stop → switch → start, with
rejections that can be decided before stopping handled before the stop).

**Tests do not pin systemd's behavior that `systemd-run --user --no-block` starts
the unit in a cgroup separate from the caller.** Testing it requires sharing the
host user-systemd instance, which has the active runner. Therefore **an operator
checks once on real hardware**, but **never use the production runner**; a
disposable probe unit is sufficient.

```sh
# 1. caller unit を作り、その中から updater と同じ形で worker を queue する
rm -f "$HOME/kaoiro-selftest.sentinel"
systemd-run --user --unit=kaoiro-selftest-caller \
  --description='kaoiro #229 self-stop probe (caller)' \
  /bin/sh -c 'systemd-run --user --no-block \
      --unit=kaoiro-selftest-worker \
      -- /bin/sh -c "sleep 20; date > $HOME/kaoiro-selftest.sentinel"; \
    sleep 300'

# 2. 2 つの unit の cgroup が別であることを確認する (ここが本題)
systemctl --user show -p ControlGroup --value kaoiro-selftest-caller.service
systemctl --user show -p ControlGroup --value kaoiro-selftest-worker.service
# → 異なる値であること。同一なら caller の停止で worker も死ぬ

# 3. caller を停止する (KillMode=control-group が caller の cgroup を皆殺しに
#    する。本番 runner の停止と同じ機構)
systemctl --user stop kaoiro-selftest-caller.service

# 4. worker が完走することを確認する
sleep 25
cat "$HOME/kaoiro-selftest.sentinel"          # 時刻が書かれていること
systemctl --user show -p Result --value kaoiro-selftest-worker.service
# → success

# 5. 後片付け
systemctl --user reset-failed kaoiro-selftest-caller.service \
  kaoiro-selftest-worker.service 2>/dev/null || true
rm -f "$HOME/kaoiro-selftest.sentinel"
```

Step (2) proves a separate cgroup and (4) proves completion after stopping the
caller. These are the prerequisites for `kaoiro-runner-update.sh --detach`; the
argv contract tests above ensure it starts in the same form. **Neither the
production runner service nor the `kaoiro-runner-update` unit is touched**, so run
this check at any time.

**Measurement record (2026-08-16, linux-host / Linux 6.8.0-137-generic, systemd
user instance):** the caller entered
`/user.slice/user-1000.slice/user@1000.service/app.slice/kaoiro-selftest-caller.service`,
while the worker entered a **separate cgroup** at the same `app.slice/kaoiro-selftest-worker.service`.
After `systemctl --user stop` stopped the caller, the worker wrote its sentinel and
exited `Result=success`; the active `kaoiro-runner` remained unaffected. **Repeat
the measurement when the host changes**—this is observed on one host, not a
guarantee for every systemd configuration.

## 5. Troubleshooting

### Container does not start after a reboot

**Symptom.** The server container is not running after a host reboot.

**Diagnosis.** Inspect the existing container's recorded error:

```sh
docker inspect --format '{{.State.Error}}' <container>
```

If it reports `cannot assign requested address`, check whether
`KAOIRO_PUBLISH_IP` is present on a host interface. A VPN address that is absent
while Docker starts causes the published port bind to fail.

**Remedy.** Install and verify the VPN ordering drop-in from [1.5](deployment.md#15-direct-vpn-deployment-no-nginx-plain-http-2026-07-26), then start the existing
container with `docker start <container>` once the publish address is present.
Do not treat `docker compose up --no-build` as the general recovery command: a
prepared `latest` tag can point to a newer image, while the existing container
identifies the known deployment state.

## See Also

- [auth-and-authz](../architecture/security-boundaries.md) — details of unset behavior for the three tokens
- [setup-wizards](setup-wizards.md) — interactive wizard automating env / config
  generation for **initial deployment**; section 4 updates are out of scope
  (automation in #218 / #219 / #220)
- [runner/README.md](../../runner/README.md) — full service and tarball-distribution guide
- [server/README.md](../../server/README.md) — local development and Docker basics
- [threat-model](../architecture/security-threat-model.md) — risk assessment for dev fallback / unset tokens
- [docs/operations/production.md](../operations/production.md) — Codex
  `codex.backend` selection and its rollback procedure, not covered here
