---
title: Server configuration
description: The server's .env variables, DETS persistence paths, and persona/footer mount points.
status: accepted
last_updated: 2026-10-31
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
`KAOIRO_SESSION_LIFECYCLE_EVENTS_PATH` / `KAOIRO_QUAGMIRE_SETTINGS_PATH` /
`KAOIRO_AGENT_STATUS_LINES_PATH` /
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

## Work admission settings

`KAOIRO_WORK_NOMINATED_PER_PRINCIPAL` and
`KAOIRO_WORK_ACTIVE_PER_ASSIGNEE` accept ASCII decimal integers from 0 to
2147483647. Unset means 16; empty strings, signs, whitespace, fractions and
out-of-range values fail startup. Zero disables only that admission check.
The nomination limit applies independently to outgoing director and incoming
assignee nominations. Total records, receipts, subordinate collections and
expiry remain bounded. Existing active-count predicates and transfer behavior
are unchanged; reducing a limit never evicts work.

Edit the deployment's `.env`, then recreate the service with the same image:
`docker compose up -d --no-build --force-recreate kaoiro`. `docker compose restart`
and restarting BEAM inside the existing container do **not** reload `env_file`.
A standalone process must start anew with the edited variables exported.

Operators and admins can change these limits live in dashboard settings.
The order is saved dashboard override, startup configuration, then default.
“Use server configuration” removes the override, rather than saving the current
fallback. The UI displays all three: effective value, fallback and source.
Healthy settings can be changed even when admission capacity is full; changing
settings does not require a work item. Viewers cannot read settings or audit
history, submit changes, or receive settings broadcasts.

WorkStore serializes admission and settings changes. Its existing DETS file
holds one `{:settings, :work_capacity}` object, separate from work/receipt/yield
records, containing schema 1, revision, overrides and at most 100 accepted
changes (time, authenticated operator, old/new overrides and effective values).
Revision starts at 0 and cannot exceed 9007199254740991. Updates require the
current revision; conflicts require reading again and explicit resubmission.
A no-op neither advances revision nor appends audit. At the ceiling a real
change returns `revision_exhausted`. Success requires insert, sync and validated
exact readback; it is not an optimistic acknowledgement.

An older binary ignores this object and enforces its own defaults/configuration.
It does not enforce these overrides. Upgrading again validates the retained
object. Downgrade is not corruption repair.

### Unavailable settings

A missing object is normal. An invalid or unsupported object is preserved and
closes admission with `work_settings_corrupt`. An unreadable or uncertain write
outcome closes admission with `work_settings_unknown`. WorkStore stays alive;
it does not repeatedly restart under the permanent supervisor child. Both
states block work/settings writes, receipts, claims, checks, transfers, yield
admission and other authority grants, and suppress expiry writes, including
read-triggered maintenance. Bounded diagnostic reads and volatile connection
registration remain available. No background retry or automatic fallback to
configuration/zero is performed.

The fixed invalid-state diagnostic is:

> Work admission is closed because {:settings, :work_capacity} is invalid or has an unsupported schema. The only repair is the offline one-key deletion procedure in docs/reference/configuration/server.md#repair-invalid-work-capacity-settings. Dashboard changes, environment overrides and restoring the pre-repair whole-file backup do not repair it.

The fixed unknown-state diagnostic is:

> Work admission is closed because the persisted work settings cannot be determined. Do not retry the update or delete the settings object. Perform a controlled server restart and read the authoritative settings; use the invalid-settings repair only if the object is then diagnosed as invalid.

The server logs the reason and fixed message once on entering the state.
Operator get/set/work-control replies carry that same reason and message.
An operator-only `work_settings` unavailable push has no revision, effective
values or audit; it disables editing even after a high-revision ready snapshot.
Wrapper work refusals retain the reason through MCP and contain no capacity
diagnostic. Neither saved data nor exception details appear in these messages.

| Attempted remedy | Invalid saved object | Unknown outcome |
|---|---|---|
| Dashboard set/reset/zero | Refused; not repair | Refused; do not retry blindly |
| Environment finite/zero/unset | Cannot override it | Cannot determine the saved value |
| Controlled restart | Same invalid object stays blocked | Classifies actual saved state: valid/absent ready, invalid corrupt, unreadable unknown |
| Restore pre-repair whole-file backup | Restores the invalid object too | Separate operator data-loss decision, not readback |
| Restore a known-good backup for physical file damage | Revalidate restored settings | Revalidate restored settings |
| Older binary | Bypasses the tag, does not repair it | Does not implement this contract |
| Offline one-key deletion | Selected repair below | Forbidden until invalidity is established |

A client timeout alone does not prove either server state. Reconnect and read
authoritative settings; never automatically replay a timed-out write. Physical
whole-file damage or invalid unrelated records use the existing whole-store
recovery procedure, followed by settings validation.

### Repair invalid work capacity settings

Only the human operator performs this production procedure. It intentionally
loses the saved overrides and their bounded audit tail, preserving other rows.

1. In the existing deployment Compose context, run `docker compose stop kaoiro`.
   Verify the service is stopped and no other process owns its WorkStore file.
   With `restart: unless-stopped`, killing BEAM inside the container can relaunch
   it; **do not do that**, and do not use `docker compose restart` before the
   checks below pass. For non-Compose deployment stop its actual supervisor and
   prevent automatic restart throughout offline repair.
2. Back up the closed **entire** WorkStore file privately and verify its checksum.
   Label this as containing the invalid object, not as a repaired replacement.
   Restoring it later restores corruption and any old work state too.
3. Use the **same release runtime**, without starting its application/supervisor.
   Open the selected file with `:dets.open_file(name, file: String.to_charlist(path))`
   using **only** the `file:` option; do not override type, keypos or repair mode.
   Stop on any open failure and use whole-store recovery instead. Require the
   invalid object at `{:settings, :work_capacity}`; record all neighboring rows
   privately. Delete exactly that key using `:dets.delete/2`; require `:ok` from
   deletion, `:dets.sync/1` and `:dets.close/1`. Reopen with the same file-only
   options and require the key to be absent and all other rows unchanged, then
   close successfully. Never truncate/delete the file or call `delete_all_objects`.
4. Unset **only** `KAOIRO_WORK_NOMINATED_PER_PRINCIPAL` and
   `KAOIRO_WORK_ACTIVE_PER_ASSIGNEE`. Preserve the image, `config.exs`, other
   `:work_store` values and unrelated environment. With the settings key absent
   the compiled defaults are 16/16.
5. Only after successful offline checks, perform a controlled verification boot:
   `docker compose up -d --no-build --force-recreate kaoiro`. Keep ordinary
   admissions paused operationally. Require an authorized settings read showing
   ready, revision 0, no overrides, defaults 16/16 and empty change log. Verify
   existing work/receipt/yield records and actual default-cap enforcement.
   A failed check means stop the service again; do not declare repair complete.
6. Reconnect clients, discard old snapshots/drafts and never replay timed-out
   writes. Record the operator, backup, lost-history boundary and verification
   privately. Only then resume ordinary use and explicitly set desired overrides.
