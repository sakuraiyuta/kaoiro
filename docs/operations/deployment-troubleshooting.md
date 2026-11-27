---
title: Deployment troubleshooting
description: Recovering a server container that failed to start after a host reboot, and troubleshooting runner Antigravity CLI presence, stale model lists, or version warnings.
status: accepted
last_updated: 2026-11-24
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

**Symptom.** Setup cannot find `agy`, the runner journal reports a catalog
probe failure, or the dashboard shows the fallback catalog or no CLI version.

**Diagnosis.** With Antigravity enabled, the runner checks the model list and
version independently at startup. A failed model probe uses the pinned 1.3.1
catalog. Incomplete authentication also skips that probe. A failed or invalid
version probe omits the CLI version from the host registration. An unusable
executable can cause both symptoms. See
[Antigravity authentication](runner-install.md#antigravity-authentication).

**Remedy (missing CLI or schema warning).** Ensure `agy` is installed and its directory is added to `PATH` in `runner.env` ([When using nvm / fnm / asdf](runner-install.md#when-using-nvm--fnm--asdf)), or configure `antigravity.cli_path`. Restart the runner service and verify the runner journal (`journalctl --user -u kaoiro-runner`) shows `runner: antigravity agy version <version>` without warnings. If `conversation_summaries.db` emits a schema mismatch warning, check its `user_version` as described in [Antigravity session index](runner-install.md#antigravity-session-index).

### Refreshing the registered model list or CLI version

Confirm the executable works in the service environment. Wait for any upstream
update to finish. In an isolated observation, `agy` 1.5.13 could return a
model list while its updater was still running. Once the installed binary is
ready, follow the [host restart procedure](../reference/configuration/runner.md#applying-host-configuration).
Check the startup journal and the resulting dashboard catalog and version.
Saving the file again does not run either probe.

## Codex launches are refused: `CODEX_HOME` is unusable

**Symptom.** The runner journal shows `runner: error — CODEX_HOME=<value> ...; Codex launches are refused until it is fixed` at startup, and `runner: codex launch refused for <agent>: CODEX_HOME=<value> ...` for each Codex spawn, restart or relaunch. A refused spawn, resume, switch or restart also shows as a failed result on the dashboard. **A Codex agent that crashed while `CODEX_HOME` was unusable is not relaunched: it goes offline with no reason on the dashboard, and the journal line is the only signal.** Claude and Antigravity agents are unaffected. Started by hand, a Codex wrapper prints `CODEX_HOME points to "<value>", but that path does not exist`.

**Diagnosis.** `CODEX_HOME` in `runner.env` is relative, names a path that does not exist, or names a file. The reason is the tail of the message (`is not an absolute path`, `does not exist`, `is not a directory`).

**Remedy.** If the directory is missing, create it (`mkdir -p` and `chmod 700`; Codex does not create it): the runner checks it at every launch, so no restart is needed. If the value in `runner.env` is wrong, correct it and restart the runner service (the value is read at startup). To go back to the default home, remove the line and restart. Then start again any Codex agent that went offline, from the dashboard. See [Codex home for production](codex-home.md).

If a Codex wrapper rejects `codex_tool_home`, inspect its local runner config:
the path must exist, be absolute, and resolve to a directory distinct from
the Codex state home. Restarting the wrapper creates a new private directory.

## See Also

- [Multi-host deployment architecture](../architecture/deployment.md).
- [Server update and rollback](server-update-and-rollback.md#44-failure-handling).
- [Runner update and rollback](runner-update-and-rollback.md).
- [Runner install and distribution](runner-install.md).
- [Codex home for production](codex-home.md).
