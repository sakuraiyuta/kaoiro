---
title: Server configuration
description: The server's .env variables, DETS persistence paths, and persona/footer mount points.
status: accepted
last_updated: 2026-09-19
related: [deployment]
---

# Server configuration

| env | Required | Meaning |
|---|---|---|
| `SECRET_KEY_BASE` | Required | Generate with `mix phx.gen.secret` (64 characters); `openssl rand -hex 32` is too short |
| `PHX_HOST` | Required | Public hostname. Unset raises at startup (fail-fast, issue #134) |
| `PORT` | Optional | Defaults to 4000 |
| `KAOIRO_BIND_IP` | Optional | Effective only in :prod; defaults to all interfaces, which is normally fine (issue #134) |
| `KAOIRO_CLIENT_TOKENS` | Required | `<token>:<role>,...` (role = `operator`/`viewer`); unset rejects every client |
| `KAOIRO_WRAPPER_TOKENS` | Optional | `<agent_id>:<token>,...` (reverse order from client). Not needed when runners deploy only through spawn—authenticate with server-minted signed tokens (ADR-0024, revised 2026-08-02). Set only to pre-register fixed wrappers |
| `KAOIRO_RUNNER_TOKENS` | Required | `<host_id>:<token>,...`; pair the token issued in 1.1 with `KAOIRO_RUNNER_TOKEN` in the runner's `runner.env` |
| `KAOIRO_PERSONA_DIR` | Optional | Container path for persona-pack import; may be mounted read-only |
| `KAOIRO_FOOTER_DIR` | Optional | Container root for the two footer files |
| | | When unset, use built-in defaults only |
| `KAOIRO_PERSONA_CACHE_DIR` | Optional | Container path for the zip-extraction cache |
| | | Compose default is `/var/lib/kaoiro/persona-cache` |

Unset behavior differs by env (client = fail-closed; runner = fail-closed in
:prod and relaxed only in dev/test; wrapper = only signed tokens accepted in
:prod and relaxed in dev/test; issue #133, revised 2026-08-02).

Persona-pack import is separated from the extraction cache by
[ADR-0046](../../adr/0046-persona-cache-relocation.md), so `KAOIRO_PERSONA_DIR` may
be mounted `:ro`. To replace footers, mount the host directory
`/srv/kaoiro/footers` read-only:

```yaml
      - /srv/kaoiro/footers:/etc/kaoiro/footers:ro
```

The bundled compose sets `KAOIRO_PERSONA_CACHE_DIR=/var/lib/kaoiro/persona-cache`.
Keep the cache on writable persistent storage, separate from the persona-pack
mount.

The existing DETS paths (locations of files that retain state across
restarts) are configured by the bundled `docker-compose.yaml` through
`environment:` and the named volume `kaoiro-state`; compose users need not put
them in `.env`. When running a release directly on the host without compose,
set the following paths explicitly to writable persistent locations, including
the conditional PermissionSettings entry when enabling set_permission: `KAOIRO_SESSION_POINTERS_PATH` /
`KAOIRO_AGENT_DIRECTORY_PATH` / `KAOIRO_PERMISSION_MODES_PATH` /
`KAOIRO_CLEAR_WATERMARKS_PATH` / `KAOIRO_SESSION_STARTS_PATH` /
`KAOIRO_INGRESS_ORDER_PATH` / `KAOIRO_USERS_PATH` /
`KAOIRO_TOKEN_DENYLIST_PATH` / `KAOIRO_DELIVERY_STATES_PATH` /
`KAOIRO_SESSION_LIFECYCLE_EVENTS_PATH` / `KAOIRO_QUAGMIRE_SETTINGS_PATH` /
`KAOIRO_PERMISSION_SETTINGS_PATH` (required when set_permission is enabled).
Unset paths fall under a container-equivalent of `/tmp` and disappear after `docker compose down`
(the offline-agent list is lost).

For deployments enabling `set_permission` (issue #305), the `PermissionSettings`
store adds `KAOIRO_PERMISSION_SETTINGS_PATH=/var/lib/kaoiro/permission_settings.dets`
to this required persistence set: the bundled `docker-compose.yaml` sets it, and
`mix kaoiro.env`'s sample `.env` documents it alongside the other restart-surviving
paths. Keep raw requested settings in this file; `session_pointers.dets` continues
to hold observed effective snapshots.

`SESSION_LIFECYCLE_MAX_EVENTS_PER_AGENT` (unprefixed, ADR-0055 phase-33
Stage B) caps the per-agent event count the `session_lifecycle` DETS
retains, oldest discarded first. Unset defaults to 10000.

**These paths, including PermissionSettings when enabled, are the canonical
persistence set.** The preflight in section 4
checks that every path resolves under the named volume using this list. A DETS
file not listed can **silently escape backup**—`KAOIRO_USERS_PATH` did exactly
that, and the user ledger was lost when the container was recreated without it
in compose (issue #217).

**Note 2026-08-08:** Phase 30-7 removed the `InterAgentHistory` DETS, and the
server no longer reads `KAOIRO_INTER_AGENT_HISTORY_PATH`. The unused exports in
the bundled `docker-compose.yaml` and `scripts/dev.sh` were also removed when
phase 30 closed. However, **`inter_agent_history.dets` created before removal
may remain as debris in existing volumes** and is included in backups (about
1.9 MB observed on 2026-08-12). It is harmless because runtime never reads it,
but it appears in archive size and listings.

`KAOIRO_PLAIN_HTTP` and `KAOIRO_PUBLISH_IP` (direct-VPN deployment only) are
covered in the [Network and login runbook](../../operations/network-and-login.md#15-direct-vpn-deployment-no-nginx-plain-http-2026-07-26),
not repeated here.

## See Also

- [Multi-host deployment architecture](../../architecture/deployment.md).
- [Server install runbook](../../operations/server-install.md).
- [Network and login runbook](../../operations/network-and-login.md).
