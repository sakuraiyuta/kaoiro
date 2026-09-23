---
title: Runner install and distribution
description: Build and distribute runner tarballs to agent hosts, install and switch releases, and run the runner as a systemd/launchd service.
status: accepted
last_updated: 2026-09-19
related: [deployment]
---

# Runner install and distribution

## 2. Deploy runners (multiple hosts)

Distribution currently uses tarballs (issue #70, revised 2026-07-25 in
[ADR-0018](../adr/0018-runner-distribution.md)); expand one on each agent host.
This page is canonical for the full procedure and service setup (systemd user
unit / launchd LaunchAgent); this section covers only points specific to
multi-host deployment.

```sh
# Generate per target architecture on the build host (1 machine)
./scripts/build-runner-tarball.sh --target linux-x64
./scripts/build-runner-tarball.sh --target darwin-arm64

# Transfer to each agent host and install as a release
# (expanded destination is <install-root>/releases/<rev>/, revised 2026-08-16 in ADR-0018)
./kaoiro-runner-install.sh kaoiro-runner-<rev>-linux-x64.tar.gz
./kaoiro-runner-switch.sh <release-id>
```

The install / switch scripts are in the package's `deploy/`. For the first
installation, expand the archive once and run from there
(`tar xzf ... && cd ... && ./deploy/kaoiro-runner-install.sh ../<archive>`).
Afterward use `<install-root>/current/deploy/`. [Runner artifacts](../reference/deployment/runner-artifacts.md) is canonical for layout; [Runner update and rollback](runner-update-and-rollback.md) is canonical for updates and rollback.

### Run as a service

Templates for systemd user units (Linux) and launchd LaunchAgents (macOS) ship
in `runner/deploy/`. See "Running as a service (systemd / launchd)" below for installation,
exit codes, and troubleshooting. In the release profile set `@@DEPLOY_DIR@@` to
`<install-root>/current/deploy`; starting the unit through the symlink is what
makes switching atomic. **Restarting a runner (including service restart) stops
all wrappers beneath it** (`supervisor.stopAll()` on SIGTERM), so
`systemctl --user restart` / `launchctl kickstart -k` with active agents
disconnects every agent on that host.

## Running as a service (systemd / launchd)

Service definitions for host residency are in [`deploy/`](../../runner/deploy) (issue #136).

**Initial installation is completed entirely with `kaoiro-runner-bootstrap.sh <tarball>`** (issue
#314): wizard (the only interactive step) → install → switch → unit/plist placement →
enable/start in order. The OS is automatically detected via `uname -s` (systemd user
unit for Linux, launchd LaunchAgent for macOS). It is idempotent — if config already exists, it
skips the wizard (forced with `--reconfigure`, backing up existing config before overwriting),
and does nothing if the unit/plist content has not changed. It never restarts running services
silently, but only prints the restart command if changes were made.
`--dry-run` shows the plan only. The following is reference for running individual scripts manually (updates
are out of scope; `kaoiro-runner-bootstrap.sh` is for initial installation only).

> The canonical sources for **updating an already running deployment to a new version** are
> [docs/operations/server-update-and-rollback.md](server-update-and-rollback.md)
> (server side) and
> [docs/operations/runner-update-and-rollback.md](runner-update-and-rollback.md)
> (runner side). This section covers only the initial installation procedure. Updates involve shutdown order, DETS
> backup, and recovery on failure, so they are not described here.

| File | Purpose |
|---|---|
| [`deploy/kaoiro-runner-bootstrap.sh`](../../runner/deploy/kaoiro-runner-bootstrap.sh) | Single entry point for initial installation. wizard → install → switch → unit/plist → enable/start |
| [`deploy/kaoiro-runner-launch.sh`](../../runner/deploy/kaoiro-runner-launch.sh) | Launch shim. Consolidates env file loading, config resolution, and `exec` |
| [`deploy/kaoiro-runner.service`](../../runner/deploy/kaoiro-runner.service) | systemd **user** unit (Linux) |
| [`deploy/com.kaoiro.runner.plist`](../../runner/deploy/com.kaoiro.runner.plist) | launchd **LaunchAgent** (macOS) |
| [`deploy/runner.env.example`](../../runner/deploy/runner.env.example) | Template env file for `KAOIRO_RUNNER_TOKEN`, etc. |
| [`deploy/kaoiro-runner-install.sh`](../../runner/deploy/kaoiro-runner-install.sh) | Installs tarball to `releases/<rev>/` (does not touch running releases) |
| [`deploy/kaoiro-runner-switch.sh`](../../runner/deploy/kaoiro-runner-switch.sh) | Atomically switches `current` / `--rollback` |
| [`deploy/kaoiro-runner-update.sh`](../../runner/deploy/kaoiro-runner-update.sh) | Performs build → install → stop → switch → start → verify → prune in one go. Avoids self-termination with `--detach` |
| [`deploy/kaoiro-runner-common.sh`](../../runner/deploy/kaoiro-runner-common.sh) | Common logic sourced by the three scripts above (install root resolution, lock, symlink swap) |

**Run as a user service** (not as a root system service). This is because the runner reads the
host user's `~/.claude` / `~/.codex` credentials and spawns wrappers inside that user's repositories
([ADR-0023](../adr/0023-host-runner-architecture.md)).

**Do not write tokens in the unit/plist**. The launch shim reads from a 0600 env file.
`token` is also masked as `token=<REDACTED>` in Phoenix transport logs.

Because the env file is **`source`d** by the launch shim, its content must be valid shell syntax
(a series of `KEY=VALUE`, no whitespace around `=`, quotes around values containing
spaces). If the syntax is broken, the shim exits with 78 (see [Runner artifacts](../reference/deployment/runner-artifacts.md#restart-policy-and-exit-codes) "Restart
policy and exit codes"). **Mode 0600 is not checked by the shim** (because portable mode checks are OS-dependent and
would reject hosts using ACLs), so it must be ensured by operations.

### Common preparation

Run all of the following commands **at the repository root** (because paths are relative).

```sh
pnpm install --frozen-lockfile
pnpm -C wrapper build && pnpm -C runner build   # build dist/cli.js

# Generating config with the setup wizard in runner/README.md is fastest:
./runner/deploy/kaoiro-runner-setup.sh

# When placing manually (Linux: ${XDG_CONFIG_HOME:-~/.config}/kaoiro,
#                        macOS: ~/Library/Application Support/kaoiro)
conf="${XDG_CONFIG_HOME:-$HOME/.config}/kaoiro"   # adjust as above on macOS
mkdir -p "$conf"
cp runner/runner.config.example.json "$conf/runner.config.json"
cp runner/deploy/runner.env.example "$conf/runner.env"
chmod 600 "$conf/runner.env"
# adjust host_id / server_url / cwd_allowlist in runner.config.json to the actual environment,
# and write KAOIRO_RUNNER_TOKEN in runner.env
```

[Runner configuration](../reference/configuration/runner.md) is canonical for the
`server_url` env override (`KAOIRO_RUNNER_SERVER_URL`).

[Setup wizards](../reference/configuration/setup-wizards.md) is canonical for the
items asked, destinations, and validation rules in `kaoiro-runner-setup.sh`.

### Deployment forms (issue #219, [ADR-0018](../adr/0018-runner-distribution.md))

**Source origin (where it is obtained from) and activation layout (how it is placed and
started) are separate axes**. The latter has only one form under the release profile,
determined by what is set in `@@DEPLOY_DIR@@`.

| Form | `@@DEPLOY_DIR@@` | Purpose |
|---|---|---|
| **Checkout-direct** | `<repo>/runner/deploy` | Manual launch during development only. The checkout is the live path directly |
| **Local-build release** | `<install-root>/current/deploy` | **Production**. Build tarball in repo and install as release |
| **Gitea release** | `<install-root>/current/deploy` | **Production**. Install distributed tarball as release |

**Production hosts must use the release profile**. Keeping a checkout-direct service resident
overwrites `dist` in the active checkout on every update, so the runner can capture a mixed
old/new wrapper (the runner resolves on-disk artifacts each time it spawns a wrapper, and
codex resolves lazily until the first spawn). Under the release profile, building and
extraction are completely self-contained within `releases/<rev>/`, never touching a running
release.

[docs/operations/runner-update-and-rollback.md](runner-update-and-rollback.md)
is canonical for migration, update procedures, and rollback.

### Linux (systemd user unit)

**The following is an installation example for the release profile (production)**. Only
when manually launching during development with checkout-direct, replace
`$install_root/current/deploy` with `$PWD/runner/deploy`.

```sh
install_root="${XDG_DATA_HOME:-$HOME/.local/share}/kaoiro"
sed "s|@@DEPLOY_DIR@@|$install_root/current/deploy|" \
  runner/deploy/kaoiro-runner.service \
  > ~/.config/systemd/user/kaoiro-runner.service
systemctl --user daemon-reload
systemctl --user enable --now kaoiro-runner
sudo loginctl enable-linger "$USER"   # Enable boot start without login
```

- Status: `systemctl --user status kaoiro-runner`
- Logs: `journalctl --user -u kaoiro-runner -f`
- Forgetting `enable-linger` prevents starting at boot (starts only on login).
  Furthermore, **the user systemd instance itself restarts on each SSH session,
  restarting enabled units along with it** (verified on a real host in issue
  #142, 2026-07-26). The restart policy (`Restart=on-failure` /
  `RestartPreventExitStatus=78`) functions correctly within a single user systemd
  instance, but verifying over SSH on a host without `enable-linger` looks
  confusingly as if the unit restarts on every connection. When verifying "start
  → restart on failure", complete it within a single SSH session, and do not
  mistake timestamp changes across connections for a restart.

### macOS (launchd LaunchAgent)

macOS orchestration is unverified (follow-up issue
[#242](https://github.com/sakuraiyuta/kaoiro/issues/242)).
The release layout and install / switch work across operating systems, but operational validation
on a real host with `@@DEPLOY_DIR@@` pointing to `current/deploy` has not
been completed.

```sh
mkdir -p ~/Library/Logs/kaoiro
install_root="$HOME/Library/Application Support/kaoiro"
sed -e "s|@@DEPLOY_DIR@@|$install_root/current/deploy|" -e "s|@@HOME@@|$HOME|" \
  runner/deploy/com.kaoiro.runner.plist \
  > ~/Library/LaunchAgents/com.kaoiro.runner.plist
launchctl bootstrap gui/"$(id -u)" \
  ~/Library/LaunchAgents/com.kaoiro.runner.plist
```

- Stop / unload: `launchctl bootout gui/"$(id -u)"/com.kaoiro.runner`
- Restart: `launchctl kickstart -k gui/"$(id -u)"/com.kaoiro.runner`
- Logs: `~/Library/Logs/kaoiro/runner.log`
- `launchctl load` / `unload` are deprecated; use `bootstrap` / `bootout`
- Because plist does not expand `~` or shell variables, substitute with absolute paths before placing
- **launchd does not rotate logs**. On long-running hosts, add configuration to `newsyslog.d` or
  truncate periodically

### Verification

The launch shim can be tested alone before registering the service. **Set `server_url`
to an unreachable value and `host_id` to a value that does not collide with the
production environment**. Why both are required:

- Starting with `server_url` pointing to the real server registers with that server
- `HostRegistry.register/4` **overwrites** the entry keyed by `host_id` (also
  replacing `runner_pid`), and `drop/3` on disconnect **deletes the entry** by
  matching pid. Because the real runner does not re-register while maintaining
  its socket (`updateRegister` fires only on config reload), **connecting even
  momentarily with the same host_id deletes the real host's registration**. If
  `host_id` differs, overwriting does not occur even if `server_url` is mistaken

```sh
tmp=$(mktemp -d)
python3 - "$tmp/runner.config.json" <<'PY'
import json, sys, os
cfg = json.load(open("runner/runner.config.example.json"))
cfg["host_id"] = f"test-host-{os.urandom(3).hex()}"   # Avoid colliding with real environment
cfg["server_url"] = "ws://127.0.0.1:59999/runner"     # Make unreachable
cfg["cwd_allowlist"] = [os.getcwd()]
json.dump(cfg, open(sys.argv[1], "w"), indent=2)
PY
printf 'KAOIRO_RUNNER_TOKEN=dummy\n' > "$tmp/runner.env"
chmod 600 "$tmp/runner.env"
KAOIRO_RUNNER_DIR="$tmp" timeout 6 sh runner/deploy/kaoiro-runner-launch.sh
# Surviving while emitting connection errors is OK (exits with timeout's 124)
```

`timeout` is a GNU coreutils command, not installed by default on macOS.
Either replace with `gtimeout` from `brew install coreutils`, or omit `timeout` and
stop with Ctrl-C.

Handling of configuration errors can also be checked with the same procedure (both exit 78):

```sh
KAOIRO_RUNNER_DIR=$(mktemp -d) sh runner/deploy/kaoiro-runner-launch.sh
KAOIRO_RUNNER_DIR="$tmp" KAOIRO_NODE=/nonexistent sh \
  runner/deploy/kaoiro-runner-launch.sh
```

### When using nvm / fnm / asdf

Because systemd user units and launchd agents start with a minimal PATH,
`node` is not found. Write the absolute path in `runner.env`:

```sh
KAOIRO_NODE=/home/you/.nvm/versions/node/v22.20.0/bin/node
```

To make version-managed commands available in agent tool shells, also set
`PATH` in the same `runner.env`. The launch shim sources this file with
`set -a` before starting Node, so the runner and newly spawned wrappers inherit
the value. For an asdf installation, adapt this example to the host:

```sh
PATH="$HOME/.asdf/shims:$HOME/.asdf/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
```

The file is sourced by `/bin/sh`, so `$HOME` expands here. Keep the standard
system directories and the directory containing the `asdf` executable; asdf
shims invoke `asdf` by name. Adding only the shims directory can leave the
commands unusable. The Linux systemd path has been observed; launchd uses the
same launch shim, but this PATH procedure has not been verified on a macOS host.

Before changing the live file, use the temporary `KAOIRO_RUNNER_DIR` and
`KAOIRO_RUNNER_ENV` procedure under [Verification](#verification) to compare
the launch shim's `--version` behavior with and without the `PATH` line under
a minimal inherited PATH. Check that `node`, `gh --version`, `pnpm --version`,
and `asdf --version` actually run after sourcing the temporary file; finding
`pnpm` with `command -v` alone does not prove it can find Node. Do not point
the dry run at the production server or reuse its `host_id`.

The operator must update the real `runner.env` and restart the service for the
new PATH to reach wrappers. A runner restart stops active agents; schedule it
accordingly. Restart with `systemctl --user restart kaoiro-runner` on Linux, or
`launchctl kickstart -k gui/"$(id -u)"/com.kaoiro.runner` on macOS. No systemd
daemon reload is needed for an env-file edit. To roll back, remove or comment
out the `PATH=` line in `runner.env` and restart the service again.

On Linux, verify only the new runner process's PATH, without printing other
environment variables:

```sh
runner_pid=$(systemctl --user show --property=MainPID --value kaoiro-runner)
tr '\0' '\n' < "/proc/$runner_pid/environ" | grep '^PATH='
```

Then ask each newly spawned Antigravity, Claude Code, and Codex agent to run
`gh --version`, `pnpm --version`, and `asdf --version` in its tool shell. For
Codex, also check a non-login shell (`login:false`). The real `runner.env`
contains a token: do not dump the file. If checking its assignment, read only
its `PATH=` line with
`grep '^PATH=' "${XDG_CONFIG_HOME:-$HOME/.config}/kaoiro/runner.env"`.

## Creating distribution tarballs

Create a self-contained archive requiring only the Node runtime (issue #70,
revised 2026-07-25 in [ADR-0018](../adr/0018-runner-distribution.md)).
Because wrappers, engine CLIs (Claude Code / codex are bundled as actual
platform-specific npm packages), and native modules are all included, **neither
`pnpm install` nor building is required on the target host**.

**Run at the repository root** (the script resolves the root from its own
location and `cd`s there).

```sh
./scripts/build-runner-tarball.sh                      # For this host
./scripts/build-runner-tarball.sh --target linux-x64   # Cross-generation
./scripts/build-runner-tarball.sh --out /path/to/dir   # Change output destination
```

Targets are `darwin-arm64` / `linux-x64` (the 2 architectures with actual
demand). On other hosts (Intel mac, arm64 Linux), omitting an explicit
`--target` produces an error. The output destination defaults to
`dist-tarball/kaoiro-runner-<rev>-<os>-<arch>.tar.gz` (gitignored). When a
relative path is passed to `--out`, it is resolved **relative to the repository
root**.

Cross-generation is performed by injecting pnpm's `supportedArchitectures` into
`pnpm-workspace.yaml` only during the build, restoring it on exit (including on
interruption). Because this injection modifies tracked files, **two builds
cannot run concurrently**. Exclusive lock is enforced via `.tarball-build.lock`,
exiting with 75 if it cannot be acquired, so **run the 2 architectures
sequentially** (if a lock remains after abnormal termination, delete the
directory).

Measured size (tar.gz): darwin-arm64 **256 MB** / linux-x64 **368 MB**. Engine
CLI packages account for most of the size. The linux version includes musl
variants as well, supporting both glibc and musl.

### Installation on the target host

```sh
tar xzf kaoiro-runner-<rev>-linux-x64.tar.gz
cd kaoiro-runner-<rev>-linux-x64

./deploy/kaoiro-runner-setup.sh    # Interactively generate configuration
./deploy/kaoiro-runner-launch.sh   # Foreground launch for connectivity check
```

When placing manually without using the wizard, copy `runner.config.example.json`
/ `deploy/runner.env.example` to the configuration directory listed in the
"Setup wizard" section of runner/README.md and edit them (`chmod 600` for
`runner.env`).

When running as a service, place the unit / plist from the "Running as a
service" section above (set `@@DEPLOY_DIR@@` to the absolute path of `deploy/`
in the extraction target). **The shims inside the distribution can be used
as-is without modification**.

Asset upload to Gitea releases is tracked in
[#140](https://github.com/sakuraiyuta/kaoiro/issues/140).

## See Also

- [Multi-host deployment architecture](../architecture/deployment.md).
- [runner/README.md](../../runner/README.md).
- [Runner update and rollback](runner-update-and-rollback.md).
- [Runner artifacts](../reference/deployment/runner-artifacts.md).
- [Runner configuration](../reference/configuration/runner.md).
