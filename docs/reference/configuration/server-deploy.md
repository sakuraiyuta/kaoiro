---
title: Server deploy configuration
description: The kaoiro-server-deploy.mjs CLI's --config keys, the status command's output, and the transaction phase / branch-classification state machines.
status: accepted
last_updated: 2026-09-19
related: [deployment]
---

# Server deploy configuration

## Config keys

Config keys (`--config <0600 JSON file>`; every key defaults to the value
shown, so a file only needs to state what it overrides):

| Key | Default | Meaning |
|---|---|---|
| `backup_root` | `~/kaoiro-deploy` | Absolute path; transaction directories live under it |
| `keep_generations` / `retention_days` | `5` / `30` | DONE transactions kept regardless of age / max age beyond that |
| `health_poll_interval_ms` / `health_poll_timeout_ms` | `2000` / `60000` | `update`/`rollback`'s own health poll after `compose up` |
| `stability_window_ms` | `30000` | How long the container must stay `running` with an unchanged restart count after health passes, before `update` calls itself done |
| `health_url` | `null` (derived via `docker compose port <service> 4000`) | Override only if the derived URL is wrong for this host |
| `expected_clean_stop_exit_code` / `expected_clean_stop_oom_killed` | `null` / `null` | **Must be set from a measurement on this host** (step 5) — until then every stop is treated as abnormal, the safe direction to fail in |

## Transaction states and status

**Checking status and reading a transaction's records**

```sh
node server/deploy/kaoiro-server-deploy.mjs status
```

Read-only; never mutates, never acquires the deploy lock. Returns one JSON
object:

| Field | Meaning |
|---|---|
| `command` | Always `"status"` |
| `docker` | `"docker"` or `"fake"` — the same override-visibility field every subcommand returns, so a gated test run (`KAOIRO_DEPLOY_DOCKER_BIN` + `--config allow_docker_override: true`) can never be mistaken for a production one when reading output back |
| `container` | `{running: true, container}`, or `{running: false, branch, reason, container}` (the A/B/D branch table below), or `{running: false, error}` when docker itself is unreachable |
| `health` | The target's own `GET /api/health` body when a container is running, `null` otherwise, or `{error}` if the request itself failed |
| `unfinishedTransaction` | `null`, `{id, phase, envConsistency}` for an in-progress transaction, or `{error, directory}` if its journal itself is unreadable/inconsistent |
| `doneTransactions` | Every completed transaction: `{id, sourceSha, targetSha, envConsistency, doneAt}` |
| `scopeNote` | States exactly what this command reads and does not (runner-side signals, the 5-b judgment, and a runner build failure's own cause are all out of scope) |

`container.branch` (only present when no *running* container is found) is one
of: `A` (one *exited* container — `start` would resume it directly with
`docker start`), `B` (no container, but this CLI's own transaction state or
the named volume still exists — recover with `update --transaction` or
`rollback`, never `start --initialize`), `C` (nothing at all —
`start --initialize` bootstraps), or `D` (anything else: 2+ containers, a
container in some OTHER status than `exited` — paused, restarting, dead — or
docker itself could not answer whether prior state exists — investigate
manually).

Every transaction's full record lives under `<backup_root>/<transaction-id>/`:
`journal.json` (the phase reached so far plus one history entry per
checkpoint — the authority for "how far did this get") and, from `archived`
onward, `manifest.json` (the durable facts: compose artifact SHA, env
consistency result, image ID, source/target SHA, volume ID, archive path+SHA,
required entries, rollback tag). Every phase `update`/`rollback` can reach,
in the order they occur:

| Phase | Meaning |
|---|---|
| `preflight` | The container was confirmed running; nothing else touched yet |
| `old_image_saved` | Old image retagged (`kaoiro-server:rollback-<sha>`) and verified by read-back |
| `build_prepared` | Target image built (`kaoiro-server:<target-sha>`) |
| `env_consistency_checked` | The #220 persistence-path check ran (or was recorded as skipped, pre-#310) |
| `maintenance_gate_passed` | The operator approved the stop window (`--maintenance-approved`) |
| `stopping` | About to run `docker compose stop` (checkpoint before the risky step) |
| `stopped` | Stop completed; exit code and OOM-killed recorded |
| `mount_resolved` | The volume name re-resolved from the now-stopped container |
| `archived` | DETS archived and verified; `manifest.json` written |
| `starting` | About to run `docker compose up` (checkpoint before the risky step) |
| `up` | New container running, not yet confirmed healthy |
| `healthy` | Health check confirmed the target `build_revision`, `build_dirty: false` |
| `done` | Stable for `stability_window_ms`; **terminal** |
| `rollback_stopped` | (`rollback` only) whatever was running has been stopped, or nothing was found to stop |
| `rollback_forensic_archived` | (`rollback` only) the CURRENT (pre-restore) volume state archived, before touching it |
| `rollback_restoring` | (`rollback` only) about to wipe and restore (checkpoint before the risky step) |
| `rollback_restored` | (`rollback` only) the restore verified against the manifest's `required_entries` |
| `rolled_back` | (`rollback` only) old image up, health confirmed for the old SHA; **terminal** |

A transaction stuck at any phase from `stopping` onward (`update`'s commit
half) cannot resume via `--transaction` — see 4.4.

## See Also

- [Server update and rollback](../../operations/server-update-and-rollback.md).
- [Multi-host deployment architecture](../../architecture/deployment.md).
