---
title: Dashboard OAuth individual authentication (Google/GitHub/Nextcloud) + allowlist
status: accepted
date: 2026-07-26
opened: 2026-07-26
supersedes: []
superseded_by: null
related_specs: [auth-and-authz, threat-model]
related_adrs: [5, 11, 13, 21]
---

# ADR-0042 — Dashboard OAuth individual authentication + allowlist

## Status

Accepted (2026-07-26; issue #65 elevated to an implementation target by a
マスター directive, specification finalized)

## Context

Dashboard authentication uses only a shared token (`KAOIRO_CLIENT_TOKENS` =
`token:role`), so it can identify a “role” but not a “person” (ADR-0011/0013).
ADR-0005 establishes “OAuth + RBAC” as the main path and a stub allowlist of
permitted emails as the prototype; this ADR decides the method for the full
implementation.

Existing plumbing on which this depends (ADR-0013 / #47):

- session cookie (httpOnly + encrypted, 3-day sliding + 12h refresh)
- WS authentication through a 30-second encrypted ticket; `connect/3` resolves
  in the order ticket → token param → session
- logout / refresh 401 immediately disconnects active sockets by broadcasting to
  `Auth.socket_id/1`

The server currently has no OAuth library, HTTP client, or Ecto (seven
dependencies).

## Decision

1. **Library = assent** (pow-auth/assent) + HTTP client (Req). Google / GitHub
   use built-in strategies, while Nextcloud uses a custom strategy based on
   `Assent.Strategy.OAuth2.Base` (authorize `/apps/oauth2/authorize`, token
   `/apps/oauth2/api/v1/token`, and identity through OCS
   `/ocs/v2.php/cloud/user?format=json`). ueberauth is rejected because of its
   thick Plug integration and dependency footprint.
2. **Provider configuration is env** (`runtime.exs`):
   `KAOIRO_OAUTH_{GOOGLE,GITHUB,NEXTCLOUD}_CLIENT_ID` / `_CLIENT_SECRET` and
   `KAOIRO_OAUTH_NEXTCLOUD_BASE_URL`. Enable only providers whose id + secret
   (and, for Nextcloud, base_url) are present. Derive the redirect URI from the
   endpoint's `url` setting:
   `{scheme}://{host}[:{port}]/auth/{provider}/callback`.
3. **Allowlist = text file**. Its path is `KAOIRO_OAUTH_ALLOWLIST_PATH`. The
   format is one entry per line, `provider:identifier[:role]`; `#` comments and
   blank lines are allowed, and an omitted role defaults to viewer (the
   security-oriented default). The identifier is google = email (compared in
   lowercase), github = login, and nextcloud = user id. Parse it on every
   authentication and revalidation (the same policy as env tokens, so revocation
   takes effect on the next connect/refresh). Reject OAuth authentication when it
   is unset, the file is missing, or the entry does not match (fail-closed).
   Warn and skip malformed lines (fail-visible). SQLite (an option in ADR-0005)
   is excessive while Ecto is absent. DETS is also unsuitable for a static
   configuration edited by the operator.
4. **Store identity in the session** (`%{provider, uid}`). Do not store the
   role; resolve it again from the allowlist on every connect / refresh (the same
   pattern as revalidating `Auth.client_role/1` on the token path). Carry the
   identity in the encrypted ticket, and use
   `sha256("oauth:" <> provider <> ":" <> uid)` as the socket id. Reuse the
   lifetime, refresh, logout, and forced-disconnect mechanisms of ADR-0013 / #47.
   **Discard the provider access token after obtaining the identity and never
   store it** (Nextcloud OAuth2 has no scope support and its token therefore has
   full access).
5. **Coexist with token authentication**: when `KAOIRO_CLIENT_TOKENS` is unset,
   token authentication remains disabled (existing fail-closed behavior = no
   server-side change). The dashboard distinguishes UI through a new
   `GET /session/auth-methods`
   (`{"token": bool, "oauth": [provider, ...]}`): show the token input form
   only when tokens are enabled, and show OAuth buttons only for enabled providers.
6. **Routes**: `GET /auth/:provider` (302 → provider; store state/PKCE
   session_params in the session), `GET /auth/:provider/callback` (state
   validation → obtain identity → check allowlist → `put_session` → 302
   `/index.html`). On failure, redirect to
   `/index.html?auth_error={provider_error|not_allowed|invalid_state}` with a
   302 so the dashboard displays a message on the login screen.

## Consequences

### Positive

- Individual authentication and role assignment become possible, and deleting an
  allowlist line revokes access on the next connect/refresh (at most 12h) plus an
  explicit revoke. Propagation to active sockets has been strengthened from #148
  (re-resolve on each operation) with #160 (change-driven effect even on passive
  sockets that perform no operation) — see the Addendum at the end of this ADR
  for details.
- Reuse the cookie/ticket/logout plumbing of ADR-0013 by replacing only the
  identity; the WS and channel layers (role gate) remain unchanged.

### Negative

- New dependencies (assent + HTTP client) enter the server.
- Google requires https for redirect URIs (except localhost), so Google login
  cannot be used in plain-HTTP deployments (KAOIRO_PLAIN_HTTP, for example
  linux-host). GitHub / Nextcloud are expected to allow http redirects (verify
  during implementation).
- The same person becomes a separate identity when logging in through multiple
  providers (no account linking).

### Neutral

- ~~Keep the current two RBAC role levels, operator / viewer; finer-grained roles~~
  **Withdrawn (2026-08-14, issue #188).** Roles are now admin / operator / viewer
  ([ADR-0050](0050-principal-model-and-graded-access-control.md) D2). The text
  format of the allowlist remains `provider:identifier[:role]`; only `admin` was
  added to the role vocabulary, so the format in this ADR and the assumptions of
  the issue #160 watcher are unchanged. The following was the pre-withdrawal
  text: finer-grained roles (approver, etc.) are future work.
- Audit logs and multi-tenant isolation remain outside this ADR's scope (still
  listed as Known gaps in auth-and-authz).

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| ueberauth + strategies | Plug integration is thick and there is no Nextcloud strategy. assent is a set of plain functions and is easier to test |
| Put the allowlist directly in env | As entries grow, .env becomes bloated (the concern behind #83). A separate file is easier to operate |
| Store the allowlist in SQLite | Ecto is absent. A database is excessive for static configuration (a stub option in ADR-0005 but divergent from the current state) |
| Store the allowlist in DETS | Suited to runtime state written by the server, not configuration edited by the operator |
| Store the role in the session | Revocation would not take effect until the cookie expired. Re-resolve every time for the same reason as ADR-0013 |
| Retain the provider token | A Nextcloud token has full access, making the cost of leakage too high. Discard it after obtaining the identity |

## Addendum (issue #160, 2026-08-05): change-driven disconnect for passive sockets

**Background.** #148 implemented demotion of active sockets by re-resolving the
role on every operator operation and disconnecting on mismatch. This was a
“disconnect the moment an operation occurs” design: a socket that performed no
operator operation after demotion continued to receive operator-only deliveries
(tool input, etc.) from `AgentsChannel.handle_out`. At the time of the #148
implementation, this was intentionally deferred because re-reading the allowlist
for every envelope × every subscriber would burden the fan-out hot path (あお's
decision).

**Decision.** Revalidation of that deferral led to a different design that does
not touch the hot path:

- `KaoiroServer.OAuthAllowlistWatcher` detects changes to the allowlist file both
  through file_system events (fast path, bounded debounce) and periodic
  reconcile (backstop, bounding missed events).
- On each detection, calculate only the **snapshot diff** (additions, deletions,
  and role changes of `{provider, identifier}
  => role`) and send
  `Endpoint.broadcast(oauth_socket_id, "disconnect", %{})` only to identities
  whose entries changed (reuse the #47/#148 mechanism; add no new broadcast
  path). Never enumerate active sockets (this codebase has no mechanism for doing
  so, as confirmed by measurement).
- Keep the diff-calculation checkpoint in `:persistent_term`. The authorization
  SoT remains the allowlist file itself (`role_for/2` continues to re-read the
  file every time); the checkpoint is only auxiliary state tracking how far the
  watcher has propagated changes across process restarts.
  `:persistent_term.put/2` triggers global GC, so do not call it for an empty diff.
- `AgentsChannel.join/3` live-re-resolves and rejects a socket whose allowlist
  entry changed between connect and join. If the watcher disconnect occurs in the
  window before the transport finishes subscribing to the socket-id topic, it can
  be missed, so join itself is the last line of defense.

**Negative (a new trade-off for this codebase).**

- A watcher process crash → restart by itself causes **neither a disconnect nor
  `:persistent_term.put` when the retained checkpoint and current contents are
  unchanged** (the checkpoint survives BEAM process death in `:persistent_term`).
  Side effects can occur only when the **crash overlaps with “in the middle of
  reconcile (after diff calculation and before broadcast completion)” or with a
  “partial broadcast failure”**. In that case the checkpoint remains old, and a
  restart (or the next periodic reconcile) may send disconnect again to **only the
  identities changed at that point** (broadcast is idempotent, so duplicate sends
  to inactive sockets are harmless). The precise behavior is not “to every active
  socket” but “to changed identities, with duplicate sends possible when the
  conditions align.” The global-GC cost of `:persistent_term.put/2` also occurs
  **only when there is an actual change** (empty diffs do not call put, as the
  moduledoc specifies). The root supervisor does not explicitly set
  `max_restarts` (OTP default = 3 times / 5 seconds), so if this watcher (or an
  existing PersonaWatcher/FooterWatcher) keeps crashing beyond that range, the
  entire server falls — this is a property of the existing supervision tree and
  does not directly define the number of the “disconnect only on change” side
  effect (the limit of 3 concerns the crash loop, not “disconnects to every
  socket”).
- If file_system events are lost (backend not started / event dropped / temporary
  parent-directory absence), propagation is left to periodic reconcile and may be
  delayed by at most `@reconcile_interval_ms` (not indefinitely — see the
  “Detection” section of the `OAuthAllowlistWatcher` moduledoc).
- If the allowlist is read during a partial write, legitimate operators included
  may be disconnected excessively until the complete content is restored (an
  intentional fail-closed choice; no LKG is retained). Operationally, editing via
  temp-file + atomic rename is recommended, but this only reduces the probability
  and is not a guarantee.

Detailed design decisions (ふじ review, あお approval) are in the comment history
of issue #160; the implementation is documented in the module doc of
`KaoiroServer.OAuthAllowlistWatcher`.
