---
title: Authentication and authorization
status: accepted
last_updated: 2026-09-18
---

# Authentication and authorization

Related security topics: [Security boundaries](../../architecture/security-boundaries.md), [Security threat model](../../architecture/security-threat-model.md), [Tool authorization](tool-authorization.md), [Security enforcement boundaries](enforcement-boundaries.md), [Security release audit](../../operations/security-release-audit.md).

The structural type for roles is `UserRole` in [@kaoiro/protocol](../../../protocol/src/index.ts); this page defines the authorization semantics.

### Socket authentication (`server/lib/kaoiro_server/auth.ex`)

| Socket | Topic convention | Authentication | env | When unset |
|---|---|---|---|---|
| Wrapper | `wrapper:<agent_id>` | `agent_id:token` pair / or server-minted signed token (ADR-0024) | `KAOIRO_WRAPPER_TOKENS` | `:dev`/`:test` = **dev fallback** (anyone may join; warning log) / `:prod` = pair auth disabled, **signed tokens accepted**, all else fail-closed (issue #133, revised 2026-08-02 to fix runner-only deployments rejecting every spawn) |
| Runner | `runner:<host_id>` | `host_id:token` pair | `KAOIRO_RUNNER_TOKENS` | `:dev`/`:test` = **dev fallback** / `:prod` = **fail-closed**, reject all (no signed-token branch; issue #133) |
| Client (token) | `agents:lobby` | `token → role` (admin/operator/viewer) | `KAOIRO_CLIENT_TOKENS` | **fail-closed** — reject every client in every environment |
| Client (OAuth) | `agents:lobby` | `identity (provider+uid) → role` (allowlist, [ADR-0042](../../adr/0042-oauth-allowlist-login.md)) | `KAOIRO_OAUTH_*` + `KAOIRO_OAUTH_ALLOWLIST_PATH` | **fail-closed** — reject all when provider or allowlist is unset, missing, or mismatched |

All three token comparisons use constant-time `Plug.Crypto.secure_compare/2`.
Comparison also runs for an unconfigured id, leaving no timing side channel. At
startup `Auth.warn_token_config/0` (delegating OAuth to `OAuth.warn_config/0`)
leaves a WARN log for unset configuration.

The two client paths coexist independently. If `KAOIRO_CLIENT_TOKENS` is unset
and OAuth is enabled, only OAuth is available; the reverse enables only tokens;
with both unset no one can enter. The dashboard selects its login screen using
the unauthenticated `GET /session/auth-methods`
(`{"token": bool, "oauth": [provider, ...]}`).

The wrapper/runner dev fallback does not operate in `:prod` (the runtime reads
`env: config_env()` from `config.exs` via `Application.get_env(:kaoiro_server, :env)`).
In a release with the respective token registry unset, runner connections are
rejected, while a valid server-minted signed wrapper token is still accepted
unless its agent has been revoked. Other wrapper connections are rejected. This
does not affect `:dev` execution through `scripts/dev.sh` (issue #133).

### Topic authorization (channel `join/3`)

- Wrapper: `WrapperChannel.join/3` (`wrapper_channel.ex:117-127`) validates the agent ID
  charset (`validate_agent_id/1`) and duplicate connections (`reject_if_connected/1`,
  ADR-0024 D5 reject-newcomer).
- Runner: `runner_channel.ex` validates the host ID charset.
- Client: `agents_channel.ex` permits only `agents:lobby`; the role is stored in
  socket assigns.
- The charset is `[A-Za-z0-9._-]` ([#61](https://github.com/sakuraiyuta/kaoiro/issues/61)),
  structurally preventing topic-string injection.

### Three roles ([ADR-0050](../../adr/0050-principal-model-and-graded-access-control.md) D2)

`admin` > `operator` > `viewer`, introduced in issue #188.

- There are only two declaration paths: `token:admin[:name]` in
  `KAOIRO_CLIENT_TOKENS`, and `provider:identifier:admin` in the OAuth allowlist.
  Do not create a dedicated file or env (the allowlist text format stays
  unchanged, so issue #160's `OAuthAllowlistWatcher` assumptions also hold).
- Misspellings fail closed. Both `parse_role/1` and `@roles` turn anything other
  than the three words into `nil` and reject authentication; never downgrade to
  viewer.
- Do not auto-promote existing operators (master decision 2026-08-14). Warn at
  startup when a deployment has zero admins (`Auth.warn_token_config/0`).
- **Every gate called “operator-only” on this page admits admin for both inbound
  and outbound paths.** The decision is centralized in
  `AgentsChannel`'s `@operator_capable_roles`; do not scatter direct
  `role == :operator` comparisons, which can create an asymmetric hole where
  inbound passes but outbound drops.
- The exception is `guard_against_reset_pending/2`. It is a restriction rather
  than a privilege, so admin is included in the guard as well.

### Role-based output gate ([ADR-0021](../../adr/0021-role-information-disclosure-policy.md))

`AgentsChannel.handle_out` uses an **allow-list**. Viewers receive:

- `state_change` (remove `ext`, hiding cwd / model / context / rate_limits / pending_permission)
- `agent_deleted`
- `permission_request` (rewrite as synthetic `state_change(waiting_permission)`, removing tool_name / input / request_id)
- `question_request` (rewrite as synthetic `state_change(waiting_question)`, removing the questions)
- `session_boundary` (payload trimmed to `{mode}`)

All others (`log` / `result` / `inter_agent_message` / `runner_sessions` /
`spawn_result` / `hosts` / `history_cleared` / `history_reset`) are completely
removed for viewers (fail-closed). A new envelope type is not delivered unless
explicitly declared (`sanitize_envelope_for(:viewer, _) -> :drop`). See the
MUST items in [threat-model](enforcement-boundaries.md#constraints) for threat-based rationale.

### Operator-only inbound (`handle_in`)

Call `require_operator(socket)` first, both directly and inside
`relay_to_wrapper_guarded/3` / `relay_to_runner_guarded/3`:

- `instruction` / `permission_decision` / `question_response` / `interrupt`
- `set_model` / `set_effort` / `set_permission_mode` / `set_permission` / `refresh_models`
- `refresh_engine_catalog`
- `spawn` / `stop` / `restart` / `enumerate_sessions` / `restore` /
  `resume_session`
- `session_reset`
- `clear_history` / `delete_agent` / `revoke_wrapper_token`
- `attach_open` / `attach_chunk` / `attach_close`
- `set_quagmire_settings`

The same events from a viewer are rejected with `{:error, :forbidden}`. Resolve
the role with `ClientSocket.role_for/1` for every operation rather than using a
snapshot (OAuth section, #148, below).

### Operator-only HTTP endpoint (issue #232)

Separate from the WS `handle_in` gate, an operator/admin-only HTTP endpoint
exists. `KaoiroServerWeb.RequireOperatorPlug` gates after `:fetch_session`: it
extracts the session-cookie credential with
`KaoiroServerWeb.SessionCredential.resolve/1` and live-resolves the role on
every request with `ClientSocket.role_for/1` (the same function as WS). Missing
or revoked credentials return 401; viewers return 403.

| endpoint | Reason |
|---|---|
| `GET /api/personas/:id` | Returns all manifest.json metadata and the full personality.md. A custom pack's personality.md is a system prompt and may contain proprietary operating instructions, so ADR-0021 F7's fail-closed default applies (new output surfaces are operator-only; viewer disclosure requires an explicit decision). |

### Cookie / ticket sessions ([ADR-0013](../../adr/0013-user-token-cookie-persistence.md))

- Initial authentication exchanges `?token=...` in a **POST body** (avoiding URL
  log leakage) for an httpOnly, encrypted session cookie (three-day sliding).
- WS reconnect obtains a 30-second Phoenix.Token via GET `/session/ticket` and
  connects with it in the WS query (Vite dev proxy cannot forward cookies to a WS
  upgrade).
- Socket IDs are SHA-256 hashes from `Auth.socket_id/1` (IDs for revoke; raw
  tokens are never retained).
- A session always holds exactly one credential. Token login (`POST /session/new`)
  clears `oauth_identity` when writing; OAuth login clears `client_token`.
- Login CSRF mitigation (ADR-0042) blocks the two credential-writing paths
  separately. `POST /session/new` **requires JSON content-type** (otherwise 415):
  SameSite=Lax only prevents cookies on a cross-site POST, while the response's
  first-party `Set-Cookie` is still stored, allowing a shared-token holder to
  replace a logged-in operator's session with an auto-submit form. Cross-site HTML
  forms cannot send JSON content-type and cross-origin `fetch` stops at preflight.
  `GET /?token=` is a plain navigation that sends cookies, so it instead checks
  the session and ignores the token when `oauth_identity` is present.

### OAuth login ([ADR-0042](../../adr/0042-oauth-allowlist-login.md))

- Providers are Google / GitHub / Nextcloud. Use `assent` + `Req`; only
  Nextcloud uses a custom `Assent.Strategy.OAuth2.Base` strategy
  (`KaoiroServer.OAuth.Nextcloud`, identity from OCS
  `/ocs/v2.php/cloud/user`, with `OCS-APIRequest: true` required).
- Route: `GET /auth/:provider` (302; store OAuth2 `state` in the session and bind
  it to the provider) → `GET /auth/:provider/callback` (validate state → normalize
  identity → check allowlist → `put_session` → 302 `/index.html`). An unconfigured
  provider returns 404; failures return
  `302 /index.html?auth_error={provider_error|not_allowed|invalid_state}`.
- The allowlist (`KaoiroServer.OAuthAllowlist`) is text in
  `provider:identifier[:role]` form. Omitted role means viewer; `#` and blank
  lines are ignored; malformed lines warn and skip (fail-visible). It is **parsed
  on every use**, so removing a line takes effect on the next connect / refresh
  without a restart.
- The session stores only identity (`%{provider, uid}`), not role. Resolve role
  from the allowlist on every connect / refresh (same shape as token-path
  `Auth.client_role/1` revalidation).
- **Re-resolve active sockets** ([#148](https://github.com/sakuraiyuta/kaoiro/issues/148),
  2026-07-28). The connect-time role is only a snapshot; freezing it would leave
  a demotion (operator → viewer) ineffective in an open tab. Dashboard cookie
  sliding is every 12 hours, too slow to rely on refresh alone. `ClientSocket`
  keeps the credential (`{:token, …}` / `{:oauth, …}`) in assigns, and
  `AgentsChannel.require_operator/1` calls `ClientSocket.role_for/1` again for
  every operator action. If it differs from the snapshot, broadcast #47
  `disconnect` to the `socket_id` topic; fan-out (operator-only delivery in
  `handle_out`) and client UI rebuild on reconnect.
- **Change-driven behavior also covers passive sockets that never act**
  ([#160](https://github.com/sakuraiyuta/kaoiro/issues/160), 2026-08-05). #148 cut
  sockets only when an action occurred, while `handle_out` fan-out kept using the
  connect-time snapshot, so a demoted socket with no operator action kept
  receiving data. `KaoiroServer.OAuthAllowlistWatcher` detects allowlist changes
  via file-system events (fast path) plus periodic reconcile (backstop bounded
  against missed events), and sends #47 disconnect only to changed identities via
  `oauth_socket_id` (it never enumerates active sockets; diff the allowlist
  snapshots instead). The diff checkpoint is `:persistent_term` (helper state
  surviving watcher restarts; the file remains authorization SoT). A race between
  allowlist change and connect/join is closed by live re-resolution in
  `AgentsChannel.join/3`. See the decision details in the
  [ADR-0042](../../adr/0042-oauth-allowlist-login.md) Addendum.
- Socket ID is `Auth.oauth_socket_id/2` =
  `sha256("oauth:" <> provider <> ":" <> uid)`. Forced disconnect on logout /
  refresh 401 reuses the ADR-0013 / #47 broadcast plumbing.
- **Discard provider access tokens after obtaining identity**; retain none in
  session / cookie / DETS / logs (Nextcloud OAuth2 lacks scope support, so tokens
  have full access). Because Assent exceptions may render
  `Authorization: Bearer …` through response structs, `AuthController` logs
  **only the exception type name**.
- Google requires an HTTPS redirect URI outside localhost, so Google login is
  unavailable when deployed with `KAOIRO_PLAIN_HTTP=true` (GitHub / Nextcloud
  permit HTTP).

### Two wrapper token paths

1. **Pre-registered**: `agent_id:token` pairs in `KAOIRO_WRAPPER_TOKENS`
2. **Server-minted signed token**: The spawn path (ADR-0024) issues one through
   `Auth.mint_wrapper_token/1` and `Phoenix.Token.sign/3`; the secret is
   `Endpoint.secret_key_base`. Tokens do not expire. Revoke uses these two paths
   (implemented 2026-07-23, [#72](https://github.com/sakuraiyuta/kaoiro/issues/72)):
     - **per-agent_id denylist** (`KaoiroServer.TokenDenylist`, DETS-persisted):
       `Auth.authorize_wrapper/2` checks it before the existing signature check;
       `delete_agent` seeds auto-revoke and the operator's
       `revoke_wrapper_token` handler inserts explicit entries. Writes are
       synchronous and `:dets.sync/1` fsync-gated (durable before ack / broadcast).
       The live channel intercepts `revoked` broadcasts on `wrapper:<id>` and
       stops in `handle_out` with `{:stop, :shutdown, socket}`. Fail-closed:
       startup fails on store corruption (retain the DETS file for forensics).
     - **secret_key_base rotation**: revoke the entire fleet at once (heavy hammer)

## Constraints (MUST)

- MUST: Reflect every new authentication boundary or role gate in this document
  (single source of truth).

- MUST: When changing `KAOIRO_*_TOKENS` fallback behavior, revalidate all three
  nodes together (and update `Auth.warn_token_config/0`).

- MUST: When adding an envelope type or channel event, update the
  `sanitize_envelope_for/2` allow-list (the fail-closed premise must hold).

- MUST: Put `require_operator/1` first in the `with` for every new operator-only
  inbound event.

### Connection authentication (v0 settled, [ADR-0011](../../adr/0011-phase3-reliability-and-auth.md))

TLS terminates at the reverse proxy (decision 2026-06-11; Phoenix uses plain HTTP).
Heartbeats use the Channels built-in provided by the client library.

| Connection | Method | Server setting |
|---|---|---|
| Wrapper (`/wrapper`) | **Per-agent token** presented as connection `token`; verify the pair on `wrapper:<agent_id>` join. | `KAOIRO_WRAPPER_TOKENS` (`id:token,id:token`) |
| Client (`/client`) | **User token + role** in connection `token`; role is `viewer`, `operator`, or `admin` ([ADR-0050](../../adr/0050-principal-model-and-graded-access-control.md) D2). | `KAOIRO_CLIENT_TOKENS` (`token:role,...`) |

- Token mismatch and unknown tokens reject the connection; unset env behavior differs by
  socket and `MIX_ENV` (issues #28/#133, with a startup warning):
  - **Unset `KAOIRO_CLIENT_TOKENS` disables token authentication in every env**. Unauthenticated
    operation is never enabled; OAuth login is the alternative ([ADR-0042](../../adr/0042-oauth-allowlist-login.md), [auth-and-authz](../../architecture/security-boundaries.md)).
  - **Unset `KAOIRO_WRAPPER_TOKENS` disables wrapper auth only in `:dev`/`:test`** (loopback
    convenience). **`:prod` is fail-closed**; runner-issued server tokens still authenticate
    spawn, so pre-registration is unnecessary in runner-only deployments (#133).
  - **Unset `KAOIRO_RUNNER_TOKENS`** has the same dev/test relaxation and prod fail-closed
    behavior, but runners have no signed-token path, so all runners are rejected in prod (#133).
  - Production must set client, wrapper, and runner env values ([threat-model](../../architecture/security-threat-model.md)).
- **Spawned wrappers** authenticate with the server-issued per-agent token in addition to the
  pre-registered token ([ADR-0024](../../adr/0024-agent-instance-identity-and-spawn-auth.md) D2/D4).
  Direct manual pre-registration remains as above.
- `instruction` / `permission_decision` are accepted only for operator role.
- The server detects wrapper disconnect and derives the agent state as `disconnected`; its
  derived envelope has no `seq` (the wrapper assigns the sequence). A terminal envelope adds
  optional `ext.disconnect = {origin, reason}`. The closed pairs are `operator/stop`,
  `runner/stop`, `agent_self/(stop|quota_exhausted|crash)`, and
  `unplanned/socket_lost`. A planned restart omits this terminal attribution.
