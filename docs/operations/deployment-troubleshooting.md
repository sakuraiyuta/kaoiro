---
title: Deployment troubleshooting
description: Recovering a server container that failed to start after a host reboot, and troubleshooting runner Antigravity CLI presence, stale model lists, or version warnings.
status: accepted
last_updated: 2026-11-20
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

**Symptom.** The setup wizard fails with `antigravity CLI (agy) not found: ...`, or the runner journal reports ``runner: warn — antigravity `agy models` probe unavailable: ...; publishing the pinned 1.3.1 snapshot`` (or `probe failed` / `no parseable models`). On a running host, the dashboard's Antigravity model list can also lag behind an upstream `agy` release, or its reported `agy` version can disappear if the `agy --version` probe fails on reload.

**Diagnosis.** When the `antigravity` capability is enabled, the setup wizard (`runner/src/setup.ts:205-220`) presence-checks `agy` on `PATH` via `resolveAgyExecutable` and fails closed if missing. At runner startup (`runner/src/runner-cli.ts:238-262`) and on every config reload while `antigravity` remains enabled (`runner/src/runner-cli.ts:458-506`), the runner runs `agy models` (`runner/src/antigravity-catalog.ts:58-89`) and `agy --version` (`runner/src/antigravity-version.ts:1-77`) as separate probes. The runner does not poll `agy` on a timer, so an upstream `agy` self-update does not update the registered model catalog until startup or a config reload re-runs those probes. Each probe's failure degrades only its own field in the runner registration (`runner/src/runner-cli.ts:491-535`): if `agy models` fails or emits unparseable output, catalog resolution falls back to the pinned 1.3.1 snapshot with a stderr warning while a working `agy --version` still reports the version; if `agy --version` fails, `resolveAgyVersion` returns `null` (`runner/src/antigravity-version.ts:66-77`); if it succeeds with invalid output, registration drops the value through `normalizeAgyCliVersion` (`runner/src/config.ts:734-766`). Either way `antigravity_cli_version` is omitted, so the version display disappears on the dashboard while a working `agy models` probe keeps the live catalog. When a shared root cause breaks both probes (for example a missing or unexecutable `agy` file), both the 1.3.1 snapshot fallback and the missing version occur together. Additionally, a changed `agy` version detected on config reload emits a warning to stderr (`runner: warn — antigravity agy version changed <old> -> <new>`, `runner/src/runner-cli.ts:557-565`).

**Remedy (missing CLI or schema warning).** Ensure `agy` is installed and its directory is added to `PATH` in `runner.env` ([When using nvm / fnm / asdf](runner-install.md#when-using-nvm--fnm--asdf)), or configure `antigravity.cli_path`. Restart the runner service and verify the runner journal (`journalctl --user -u kaoiro-runner`) shows `runner: antigravity agy version <version>` without warnings. If `conversation_summaries.db` emits a schema mismatch warning, check its `user_version` as described in [Antigravity session index](runner-install.md#antigravity-session-index).

### Refreshing a stale model list or recovering from a failed reload probe

Re-saving `runner.config.json` — even without changing its contents — triggers a config reload (`runner/src/runner-cli.ts:458-506`, pinned by `runner/test/antigravity-cli-wiring.test.ts`) that re-runs `agy models` and `agy --version` and republishes the runner registration without restarting running agents.

**One re-save may not be enough after 15 minutes.** As directly observed with an isolated copy of `agy` 1.5.13 after its 15-minute updater cooldown, `agy models` spawns a background self-updater (`agy --bg-updater`) while returning a model list immediately (neither an older binary nor a live binary replacement was tested). By inference from that behavior (not measured end-to-end across a live binary download and replacement), an out-of-date `agy` can respond to the first reload probe with its pre-update model list while updating in the background:

1. Save `runner.config.json` (unchanged contents are sufficient while `antigravity` is enabled).
2. Check the runner journal (`journalctl --user -u kaoiro-runner`) for an `antigravity agy version` line (`runner: warn — antigravity agy version changed <old> -> <new>` when a reload observes a new version, or `runner: antigravity agy version <version>` after a service start) or inspect the model list and reported CLI version in the dashboard.
3. If the version or model list is still old, wait for the background `agy` self-update to finish replacing the binary, then save `runner.config.json` once more.

**Recovery from a failed reload probe.** Because `agy models` and `agy --version` run independently on reload (`runner/src/runner-cli.ts:486-506`), a failed `agy models` probe (unavailable/unexecutable binary, non-zero exit, timeout, or unparseable output) replaces the previous live list with the pinned 1.3.1 snapshot, whereas a failed or invalid `agy --version` probe drops the reported `agy` version (`antigravity_cli_version`); both occur together when the underlying `agy` executable is missing or unusable. Once `agy` is healthy again, save `runner.config.json` again to re-probe and restore whichever field degraded (the live model list, the version display, or both). Whether a failed reload probe should keep the last published catalog instead of reverting to the 1.3.1 snapshot is tracked in [issue #1218](https://github.com/sakuraiyuta/kaoiro/issues/1218).

## Codex launches are refused: `CODEX_HOME` is unusable

**Symptom.** The runner journal shows `runner: error — CODEX_HOME=<value> ...; Codex launches are refused until it is fixed` at startup, and `runner: codex launch refused for <agent>: CODEX_HOME=<value> ...` for each Codex spawn, restart or relaunch. A refused spawn, resume, switch or restart also shows as a failed result on the dashboard. **A Codex agent that crashed while `CODEX_HOME` was unusable is not relaunched: it goes offline with no reason on the dashboard, and the journal line is the only signal.** Claude and Antigravity agents are unaffected. Started by hand, a Codex wrapper prints `CODEX_HOME points to "<value>", but that path does not exist`.

**Diagnosis.** `CODEX_HOME` in `runner.env` is relative, names a path that does not exist, or names a file. The reason is the tail of the message (`is not an absolute path`, `does not exist`, `is not a directory`).

**Remedy.** If the directory is missing, create it (`mkdir -p` and `chmod 700`; Codex does not create it): the runner checks it at every launch, so no restart is needed. If the value in `runner.env` is wrong, correct it and restart the runner service (the value is read at startup). To go back to the default home, remove the line and restart. Then start again any Codex agent that went offline, from the dashboard. See [Codex home for production](codex-home.md).

If a Codex wrapper rejects `codex_tool_home`, inspect its local runner config:
the path must exist, be absolute, and resolve to a directory distinct from
the Codex state home. Restarting the wrapper creates a new private directory.
Before deploying the isolation change, verify the pinned native CLI applies
the policy to both new and resumed app-server threads; the RPC payload by
itself is insufficient evidence.

## See Also

- [Multi-host deployment architecture](../architecture/deployment.md).
- [Server update and rollback](server-update-and-rollback.md#44-failure-handling).
- [Runner update and rollback](runner-update-and-rollback.md).
- [Runner install and distribution](runner-install.md).
- [Codex home for production](codex-home.md).
