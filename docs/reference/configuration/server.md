---
title: Server configuration
description: The server's .env variables, DETS persistence paths, persona/footer mount points, and dashboard static caching.
status: accepted
last_updated: 2026-11-24
related: [deployment]
---

# Server configuration

| env | Required | Meaning |
|---|---|---|
| `SECRET_KEY_BASE` | Required | Generate with `mix phx.gen.secret` (64 characters); `openssl rand -hex 32` is too short |
| `PHX_HOST` | Required | Public hostname. Unset raises at startup (fail-fast, issue #134) |
| `PORT` | Optional | Defaults to 4000 |
| `KAOIRO_BIND_IP` | Optional | Effective only in :prod; defaults to all interfaces, which is normally fine (issue #134) |
| `KAOIRO_CLIENT_TOKENS` | Required | `<token>:<role>,...` (role = `admin`/`operator`/`viewer`; `admin` is the only config-only bootstrap path for the first admin, ADR-0050 D2); unset rejects every client |
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
`KAOIRO_WORK_STORE_PATH` / `KAOIRO_DELIVERY_POLICIES_PATH` /
`KAOIRO_SESSION_LIFECYCLE_EVENTS_PATH` /
`KAOIRO_AGENT_STATUS_LINES_PATH` / `KAOIRO_ROOMS_PATH` /
`KAOIRO_PERMISSION_SETTINGS_PATH` (required when set_permission is enabled).
Unset paths fall under a container-equivalent of `/tmp` and disappear after `docker compose down`
(the offline-agent list is lost, and every agent returns to the lobby:
[rooms](../inter-agent/rooms.md#storage-and-failure)).

For deployments enabling `set_permission` (issue #305), the `PermissionSettings`
store adds `KAOIRO_PERMISSION_SETTINGS_PATH=/var/lib/kaoiro/permission_settings.dets`
to this required persistence set: the bundled `docker-compose.yaml` sets it, and
`mix kaoiro.env`'s sample `.env` documents it alongside the other restart-surviving
paths. Keep raw requested settings in this file; `session_pointers.dets` continues
to hold observed effective snapshots.

`SESSION_LIFECYCLE_MAX_EVENTS_PER_AGENT` (unprefixed, ADR-0055 phase-33
Stage B) caps the per-agent event count the `session_lifecycle` DETS
retains, oldest discarded first. Unset defaults to 10000.

`KAOIRO_STATUS_LINE_RETENTION` (issue 482) sets how many entries of each
agent's status line change log are kept, from 1 to 100. Unset defaults to 20.
A value an operator stores from the dashboard takes precedence, and an
out-of-range value stops the server at boot.

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
but it appears in archive size and listings. Deleting it is safe: with the
server container stopped, remove `inter_agent_history.dets` from the state
volume, then start the container again. Cleanup is optional; backup and verify
tooling should treat the file as an optional leftover, not a required object.

`KAOIRO_PLAIN_HTTP` and `KAOIRO_PUBLISH_IP` (direct-VPN deployment only) are
covered in the [Network and login runbook](../../operations/network-and-login.md#15-direct-vpn-deployment-no-nginx-plain-http-2026-07-26),
not repeated here.

## Bundled dashboard static caching

`:serve_dashboard` is application configuration, not an environment variable,
and defaults to `true`. Setting it to `false` disables the
bundled dashboard's static files and makes `/` return 404; channels and APIs
remain available ([ADR-0007](../../adr/0007-client-separation-reference-dashboard.md)).

| Resource | Cache-Control |
|---|---|
| `/assets/*` | `public, max-age=31536000, immutable` |
| `/index.html`, `/notification-worker/*` | `no-cache` |
| `/icons/*`, `/manifest.webmanifest` | `public` with ETag revalidation (Plug default) |
| `/favicon.ico`, `/robots.txt` | `public` with ETag revalidation, always served |

`/assets/` is reserved for content-hashed build output. Document queries,
including `?vsn=`, retain `no-cache`; `/` redirects to `/index.html`. Icons,
manifest, favicon and robots retain Plug's version-query behavior: a leading
`?vsn=` uses `public, max-age=31536000, immutable` without an ETag.
Validators use Plug's existing file size and modification time; `no-cache`
requires revalidation and permits a 304 when the validator is unchanged.

## Device authorization grant

The device authorization grant ([ADR-0070](../../adr/0070-device-authorization-grant.md),
contract in [device authorization grant](../protocol/device-authorization.md))
has no env of its own. `GET /session/auth-methods` reports `device: true`, and
`POST /oauth/device` / `POST /oauth/token` answer, only when all of these hold:

| condition | when it fails |
|---|---|
| The request reached the server over https: a TLS-terminating proxy that **overwrites** `x-forwarded-proto` (the same assumption `force_ssl` and the cookie's Secure flag already make), with the normal build | A `KAOIRO_PLAIN_HTTP=true` build, and plain http straight to an excluded host (`localhost`, `127.0.0.1`), are refused with 503 |
| A single backend: one server process holds the pending codes in memory | A non-empty `DNS_CLUSTER_QUERY` disables the flow at boot (warning in the log); a node connected later makes it unavailable. Two backends that do not know of each other behind one proxy cannot be detected: do not deploy that way |
| At least one OAuth provider is configured | Without one there is nobody to approve |
| The dashboard is served (`:serve_dashboard`, ADR-0007) | Approval happens in the dashboard |

Pending codes are not persisted; a restart drops them and the devices start
over. Issued device access tokens survive a restart, since they are encrypted
with `SECRET_KEY_BASE`; rotating it invalidates them together with every
session cookie. Serving the flow from several backends would need a shared
store for pending codes and is not supported.

The dev and test configs set `:device_auth_allow_insecure_transport` so the
flow works over plain http locally; `runtime.exs` never reads it, so a release
cannot enable it.

## See Also

- [Multi-host deployment architecture](../../architecture/deployment.md).
- [Server install runbook](../../operations/server-install.md).
- [Network and login runbook](../../operations/network-and-login.md).

`KAOIRO_DELIVERY_POLICIES_PATH=/var/lib/kaoiro/delivery_policies.dets` is required
for the per-agent delivery policy store. Its canonical registry entry feeds
runtime configuration, the sample env and deployment backup checks. The file
holds deletable policy rows and permanent revision allocators; agent deletion
revokes first and removes the row while retaining its allocator. Directory and
file modes are 700/600. A corrupt or unavailable file stays intact and yields
unknown policy rather than a fresh on row. Restart after correcting the fault
reopens it and purges revoked rows without removing their counters.

Both matching and explicitly accepted new-store env checks require the
[placement gate](../../operations/server-update-and-rollback.md#delivery-policy-store-placement)
before maintenance: the actual constructor's effective path must lie on the
writable named state volume backed up for this transaction, with no deeper
mount or symlink. Image VOLUME at or below the state target is refused even
with an explicit compose override.

## Work capacity

Work has no per-director or per-assignee limit. The store-wide record cap
(`work_max_records`, 4,096 records including terminal work retained for 30
days) and the receipt caps are compiled values in `config/config.exs`.
The link cap is 32 links per work, compiled in `KaoiroServer.WorkReducer`.
No environment variable changes them.

`KAOIRO_WORK_NOMINATED_PER_PRINCIPAL` and `KAOIRO_WORK_ACTIVE_PER_ASSIGNEE` are
no longer read. If they remain in the deployment's `.env`, startup succeeds and
the values are ignored. A `{:settings, :work_capacity}` row left in the
WorkStore DETS file by an older release is ignored and kept in place.
