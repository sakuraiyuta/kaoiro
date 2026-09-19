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
Afterward use `<install-root>/current/deploy/`. [Runner artifacts](../reference/deployment/runner-artifacts.md) is canonical for layout; [Runner update and rollback](runner-update-and-rollback.md) is canonical for updates and rollback.

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

## See Also

- [Multi-host deployment architecture](../architecture/deployment.md).
- [runner/README.md](../../runner/README.md).
- [Runner update and rollback](runner-update-and-rollback.md).
- [Runner artifacts](../reference/deployment/runner-artifacts.md).
- [Runner configuration](../reference/configuration/runner.md).
