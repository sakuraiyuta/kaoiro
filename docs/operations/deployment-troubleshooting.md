---
title: Deployment troubleshooting
description: Recovering a server container that failed to start after a host reboot, and troubleshooting runner Antigravity CLI presence or version warnings.
status: accepted
last_updated: 2026-09-27
related: [deployment]
---

# Deployment troubleshooting

## Container does not start after a reboot

**Symptom.** The server container is not running after a host reboot.

**Diagnosis.** Inspect the existing container's recorded error:

```sh
docker inspect --format '{{.State.Error}}' <container>
```

If it reports `cannot assign requested address`, check whether
`KAOIRO_PUBLISH_IP` is present on a host interface. A VPN address that is absent
while Docker starts causes the published port bind to fail.

**Remedy.** Install and verify the VPN ordering drop-in from [1.5](network-and-login.md#boot-order-for-a-vpn-publish-address), then start the existing
container with `docker start <container>` once the publish address is present.
Do not treat `docker compose up --no-build` as the general recovery command: a
prepared `latest` tag can point to a newer image, while the existing container
identifies the known deployment state.

## Antigravity CLI (agy) not found or version warnings

**Symptom.** The setup wizard fails with `antigravity CLI (agy) not found: ...`, or the runner journal reports ``runner: warn — antigravity `agy models` probe unavailable: antigravity CLI executable is missing; publishing the pinned 1.1.26 snapshot``.

**Diagnosis.** When the `antigravity` capability is enabled, the setup wizard (`runner/src/setup.ts:205-220`) presence-checks `agy` on `PATH` via `resolveAgyExecutable` and fails closed if missing. At runner startup and reload, the runner probes `agy --version` (`runner/src/antigravity-version.ts:1-5`, `runner/src/runner-cli.ts:185-209, 350-362`). If `agy` is absent from the service's execution `PATH`, catalog resolution degrades to the static snapshot with a stderr warning. Additionally, a changed `agy` version on config reload emits a warning to stderr (`runner: warn — antigravity agy version changed`).

**Remedy.** Ensure `agy` is installed and its directory is added to `PATH` in `runner.env` ([When using nvm / fnm / asdf](runner-install.md#when-using-nvm--fnm--asdf)). Restart the runner service and verify the runner journal (`journalctl --user -u kaoiro-runner`) shows `runner: antigravity agy version <version>` without warnings. If `conversation_summaries.db` emits a schema mismatch warning, check its `user_version` as described in [Antigravity session index](runner-install.md#antigravity-session-index).

## Codex launches are refused: `CODEX_HOME` is unusable

**Symptom.** The runner journal shows `runner: error — CODEX_HOME=<value> ...; Codex launches are refused until it is fixed` at startup, and `runner: codex launch refused for <agent>: CODEX_HOME=<value> ...` for each Codex spawn, restart or relaunch. Claude and Antigravity agents are unaffected. Started by hand, a Codex wrapper prints `CODEX_HOME points to "<value>", but that path does not exist`.

**Diagnosis.** `CODEX_HOME` in `runner.env` is relative, names a path that does not exist, or names a file. The reason is the tail of the message (`is not an absolute path`, `does not exist`, `is not a directory`).

**Remedy.** Create the directory (`mkdir -p` and `chmod 700`; Codex does not create it) or correct the path in `runner.env`, then restart the runner service. To go back to the default home, remove the line and restart. See [Codex home for production](codex-home.md).

## See Also

- [Multi-host deployment architecture](../architecture/deployment.md).
- [Server update and rollback](server-update-and-rollback.md#44-failure-handling).
- [Runner update and rollback](runner-update-and-rollback.md).
- [Runner install and distribution](runner-install.md).
- [Codex home for production](codex-home.md).
