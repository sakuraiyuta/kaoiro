---
title: Production deployment manual
status: accepted
last_updated: 2026-11-07
description: Command cheat-sheet for bringing up, updating and rolling back a production deployment; each step links to its canonical runbook.
---

# Production deployment manual

A command cheat-sheet: the commands in the order an operator runs them, and a
link to the page that is canonical for each step. It holds no explanations.
When something here does not match what you observe, the linked page wins.

Before you start: tools, versions and the choice of how the server is reached
are in [Server install runbook § Prerequisites](server-install.md#prerequisites).
The deploy CLI's optional `--config <file>` is described in
[Server update and rollback § 4.3](server-update-and-rollback.md#43-update-procedure)
and [Server deploy configuration](../reference/configuration/server-deploy.md#config-keys).

## 1. Server install (first time)

```sh
git clone <repo-url> <repo-path>
cd <repo-path>
git checkout <target-sha>
cd server
mix kaoiro.env
cd ..
node server/deploy/kaoiro-server-deploy.mjs start --initialize
```

Detail: [Server install runbook](server-install.md) (`.env`, `start --initialize`)
and [Network and login runbook](network-and-login.md) (nginx, VPN, OAuth).
What the wizard asks: [Setup wizards](../reference/configuration/setup-wizards.md).

## 2. Runner install (first time, per host)

```sh
./scripts/build-runner-tarball.sh --require-tagged --target linux-x64   # or darwin-arm64
```

Transfer `dist-tarball/kaoiro-runner-<rev>-<os>-<arch>.tar.gz` to the runner
host, then:

```sh
tar xzf kaoiro-runner-<rev>-<os>-<arch>.tar.gz
cd kaoiro-runner-<rev>-<os>-<arch>
./deploy/kaoiro-runner-bootstrap.sh ../kaoiro-runner-<rev>-<os>-<arch>.tar.gz
sudo loginctl enable-linger "$USER"   # Linux only
```

Detail: [Runner install and distribution](runner-install.md#installation-on-the-target-host)
and [Running as a service](runner-install.md#running-as-a-service-systemd--launchd).

## 3. Verify

```sh
node server/deploy/kaoiro-server-deploy.mjs status
```

`status` does not replace the connectivity checks:
[Server update and rollback § 3](server-update-and-rollback.md#3-connectivity-checks)
and [§ 4.5](server-update-and-rollback.md#45-verification-and-its-limits).

## 4. Update

Read [High-risk change release](high-risk-change-release.md) first if the change
can stop the runner from starting or every agent's turns from completing. Write
the release note and land it before creating the release tag
([Release notes](../release/README.md)).

The server and runner commands below are grouped by host. **They are not in the
order to run them.** When the runner is stopped, built and started relative to
the server commit depends on the host's installation shape and on whether the
release changes server and wrapper together. Take that order from
[Server update and rollback § 4.3](server-update-and-rollback.md#43-update-procedure)
steps (3) to (7) and, for a paired release, from
[Coordinated server and wrapper updates](runner-update-and-rollback.md#coordinated-server-and-wrapper-updates).

Server:

```sh
node server/deploy/kaoiro-server-deploy.mjs update --target <target-sha> --dry-run
node server/deploy/kaoiro-server-deploy.mjs update --target <target-sha>
node server/deploy/kaoiro-server-deploy.mjs update --target <target-sha> \
  --transaction <transaction-id> --maintenance-approved
```

Runner:

```sh
# Linux:
install_root="${KAOIRO_RUNNER_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/kaoiro}"
# macOS:
# install_root="${KAOIRO_RUNNER_INSTALL_DIR:-$HOME/Library/Application Support/kaoiro}"

"$install_root/current/deploy/kaoiro-runner-update.sh" --from-repo <repo-path> --target <os-arch>
# or, from a pre-built tarball:
"$install_root/current/deploy/kaoiro-runner-update.sh" --tarball <path>
```

Detail: [Runner update and rollback § 4.6.2](runner-update-and-rollback.md#462-subsequent-updates).
If it fails: [§ 4.4](server-update-and-rollback.md#44-failure-handling).

## 5. Rollback

Server (only for a transaction the CLI created):

```sh
node server/deploy/kaoiro-server-deploy.mjs rollback \
  --transaction <transaction-id> --dry-run
node server/deploy/kaoiro-server-deploy.mjs rollback \
  --transaction <transaction-id> --confirm-restore
```

Runner, same native pin:

```sh
systemctl --user stop kaoiro-runner &&
  "$tool_release/deploy/kaoiro-runner-switch.sh" --rollback \
    --install-dir "$install_root" &&
  systemctl --user start kaoiro-runner
```

Runner, Codex native pin changed (restore the recorded state snapshot):

```sh
"$tool_release/deploy/kaoiro-runner-update.sh" \
  --install-dir "$install_root" --service kaoiro-runner \
  --restore-codex-backup "$snapshot_dir" --codex-home "$codex_home" --detach
```

Detail: [Runner update and rollback § 4.6.3](runner-update-and-rollback.md#463-rollback),
[Codex state backup](runner-update-and-rollback.md#codex-state-backup) and
[fresh setup](runner-update-and-rollback.md#second-level-recovery-fresh-setup).
If the server rollback fails: [Server update and rollback § 4.4 (3)](server-update-and-rollback.md#44-failure-handling).

## First run on an existing (pre-CLI) deployment

```sh
node server/deploy/kaoiro-server-deploy.mjs status
```

Expect `container.running: true` and `doneTransactions: []`, then preview the
update with `--dry-run`. Detail: [Server update and rollback § 4.2](server-update-and-rollback.md#42-preconditions).

## 6. Troubleshooting

| Symptom | First command | Canonical page |
|---|---|---|
| Container does not start after a reboot, or port bind fails (`cannot assign requested address`) | `systemctl show docker -p After`; `docker inspect --format '{{.State.Error}}' <container>` | [Deployment troubleshooting](deployment-troubleshooting.md#container-does-not-start-after-a-reboot) |
| Runner does not start, exit code 78 (`EX_CONFIG`) | `systemctl --user status kaoiro-runner`; `journalctl --user -u kaoiro-runner` | [Runner artifacts](../reference/deployment/runner-artifacts.md#restart-policy-and-exit-codes) |

## See Also

- [Deployment documentation](../README.md#deployment-documentation) — the
  architecture page, runbooks and reference pages this manual points to
- [Setup wizards](../reference/configuration/setup-wizards.md) — what
  `mix kaoiro.env` and `kaoiro-runner-setup.sh` ask and why
- [Runner install and distribution](runner-install.md) — full runner install /
  service / troubleshooting reference
- [Codex backend switching and rollback](codex-backend-switch.md) — backend
  selection, verification, and rollback (release note in
  [Stage 6 landing record](https://github.com/sakuraiyuta/kaoiro/issues/348#issuecomment-5726375118))
- [Codex home for production](codex-home.md) — the dedicated `CODEX_HOME`,
  its operator login, cutover and rollback
- [High-risk change release](high-risk-change-release.md) — start check, fleet
  restoration and all-agents-stopped recovery for changes that can stop the fleet
- [issue #303](https://github.com/sakuraiyuta/kaoiro/issues/303) (this manual's
  own tracking issue), [issue #306](https://github.com/sakuraiyuta/kaoiro/issues/306)
  (the server deploy CLI)
