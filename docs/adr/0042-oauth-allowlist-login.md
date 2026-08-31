---
title: dashboard OAuth Personalリスト (Google/GitHub/Nextcloud) + Permission List
status: accepted
date: 2026-07-26
opened: 2026-07-26
supersedes: []
superseded_by: null
related_specs: [auth-and-authz, threat-model]
related_adrs: [5, 11, 13, 21]
---

# ADR-0042 — dashboard OAuth PersonalList + Permission List

## Status

Accepted (2026 -26 Assigned to issue #65,
Specification)

## Context

dashboard authentication is a shared  (`KAOIRO_CLIENT_TOKENS` = `token:role`)
ADR-0011/0013
ADR 5 "OAuth + RBAC, Prototype is allowed mail
The whitelist stub is defined, and this ADR determines the approach of this implementation.

Premise existing  (ADR-0013 / #47):

- session cookie (httpOnly + encryption, 3 days sliding + 12h refresh)
- WS authentication via 30 seconds encryption ticket, `connect/3`
ticket → session param → session
- logout / refresh 401 is running to `Auth.socket_id/1`
Instantly disconnect socket

There is no OAuth library, HTTP client, or Ecto in the current server.

## Decision

1. **library = assent** (pow-auth/assent) + HTTP client (Req)。
Google / GitHub is built-in strategy, Nextcloud is
`Assent.Strategy.OAuth2.Base`
   (authorize `/apps/oauth2/authorize`、token
`/apps/oauth2/api/v1/token`, identity is OCS
`/ocs/v2.php/cloud/user?format=json`. ueberauth with plug binding
dependent thickness.
2. **The provider configuration is** (`runtime.exs`):
   `KAOIRO_OAUTH_{GOOGLE,GITHUB,NEXTCLOUD}_CLIENT_ID` / `_CLIENT_SECRET`
and `KAOIRO_OAUTH_NEXTCLOUD_BASE_URL`. id + secret
base url) is only valid for the provider. endpoint
`url` Configuration:
   `{scheme}://{host}[:{port}]/auth/{provider}/callback`。
3. **Permission list = text file**Home path
`KAOIRO_OAUTH_ALLOWLIST_PATH` Format 1 line 1 entry
`provider:identifier[:role]`, `#` Comments, empty lines, role omitted
viewer identifier is google = email (compare),
github = login,ttcloud = user id. parse every time you authenticate and reverify
(the same policy as env  — the expiration is reflected in the following connect/refresh).
Unset, file missing, and entry unmatched are rejected by OAuth
(fail-closed) malformed lines are warn + skip (fail-visible).
SQLite (ADR 5 option) is over-adopted against the current situation of absence of Ecto.
DETS is not suitable because it is a static setting that the operator edits.
4. **session contains identity**(`%{provider, uid}`) role
Resolve in the permission list every time connected / refresh is not stored
(same as `Auth.client_role/1` reverification of theRoute route). Ticket
encrypt identity and socket id
`sha256("oauth:" <> provider <> ":" <> uid)` Lifetime・refresh・
ADR-0013 / #47
   **The access  of the provider will not be destroyed and saved after obtaining identity**
(Nextcloud OAuth2 does not support scope for full access).
5. **Consistent with  Certification**: `KAOIRO_CLIENT_TOKENS` Not set
Invalid authentication (with fail-closed = without server side changes). dashboard
New `GET /session/auth-methods`
(`{"token": bool, "oauth": [provider, ...]}`)
The provider input form is only valid when the provider is enabled, and the OAuth button is valid
only display.
6. **route**: `GET /auth/:provider` (302 → provider. state/PKCE
session params is saved in session), `GET /auth/:provider/callback`
`put_session`
302 `/index.html`. failure 302
   `/index.html?auth_error={provider_error|not_allowed|invalid_state}`
In dashboard side displays a word on the login screen.

## Consequences

### Positive

- role and role grants per individual, andJapanese term removal of permission list is as follows:
connect/refresh (maximum 12h) + explicit revoke socket
In addition to #148 (resolving every operation), #160 (does not operate any changes once)
The passive socket is also change with change-driven — the ADR
Addendum at the end.
- ADR-0013's cookie/ticket/logout pipe is only replaced
Reuse and unchanged WS and channel layers (role gate).

### Negative

- new dependencies (assent + HTTP client) are included in the server.
- Google requests https to redirect URI (except localhost)
plain-HTTP deployment (KHomeIRO PLAIN HTTP, e.g.  -host), Google
Login is not available. GitHub / Nextcloud
(Confirmation required when implementing)
- If the same person enters multiple providers, it becomes another identity (not integration).

### Neutral

- The role particle size of ~~RBAC maintains the current value of operator / viewer. More
  **With al (2026 (2014, issue #188).**admin / viewer
ADR-0050
D2). Allow list text format remains `provider:identifier[:role]`
role = `admin`
watcher The following are descriptions before withdrawal: subdivision
(approver, etc.)
- Audit log multi-tenant iso  outside the scope of this ADR (auth-and-authz)
Known gaps

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| ueberauth + strategies |Nextcloud strategy assent is easy to test in the function group|
|Directly write permission list|.env is hypertrophy (#83 problem consciousness) when entry increases. Easy to use file separation|
|SQLite|Ecto Absent Excess DB for static setting (ADR st5's stub option but deviated from current situation)|
|DETS permission list|server for runtime state. Unsuitable for setting the operator to manually edit|
|Include roles in the session|The expired cookie does not expire. Resolving every time for the same reason as ADR-0013|
|Retention of provider |Nextcloud  is full access and costly leaking. identity destroyed after obtaining|

## Change-driven disconnect to passive socket

**Background**#148 resolves roles every time the operator operation is unmatched
"disconnect" approach enables the demotion to the socket in operation, but this
"It's right at the moment of operation" is approach, and do not operate the operator once after disqualification
socket is available only for `AgentsChannel.handle_out` operator.
etc.) #148 This is a fan-out hotpass every time
envel  × intentionally because of the cost of reading permission list for each subscriber
(Home judgment).

**Contact Us**As a result of re-verification of the view, another approach that does not contain a hot pass has been adopted:

- `KaoiroServer.OAuthAllowlistWatcher` changes the permission list file
file system Events (fast path, bordered debounce) and periodic
Detect both reconcile (backstop, event bound).
- Permission list for each detection**snapshot**(`{provider, identifier}
  => role`Add/Remove/role change) only and changed identity
Only shoot `Endpoint.broadcast(oauth_socket_id, "disconnect", %{})`
(reuse of the same mechanism as #47/#148 and do not increase the new broadcast route).
Not enumerating sockets in operation (this codebase)
not existed).
- The checkpoint of the differential calculation is stored in `:persistent_term`. Authorization
`role_for/2` is
checkpoint restarts the watcher process)
Auxiliary state only to track "how far reflected?" beyond.
`:persistent_term.put/2` triggers global GC, so if the difference is empty
not put.
- `AgentsChannel.join/3` changes the permission list between connect → join
The socket is played with live re-resolve (transport is
watcher disconnect before the socket-id topic subscribe
The join itself is the last fort because there is a window thatHomes when fired.

**Negative (new trade-off for this codebase).**

- The watcher process crashes → restart itself is
`:persistent_term.put`
**(checkpoint is unrelated to the life of the BEAM process)
`:persistent_term`. Side effects
**crash timing is "reconcile"
or "broadcast partial failure" is only
checkpoint remains old, after restart (or following periodic reconcile)
Home**only changed identities**GET OFF
(broadcast is idempotent, so it is not working.
harmless). not "to all sockets in operation" to "identified"
If the condition is aligned, it can be duplicated.
The global GC cost of `:persistent_term.put/2` has also been changed
When only** occurs (see moduledoc).
root supervisor does not explicitly set `max_restarts` (OTP default =
3 times / 5 seconds)
If FooterW er) continues to crash beyond that range, the whole server falls
——This is the nature of the existing supervision tree and the above "only when changed
disconnect Not directly stipulate the number of side effects (3 times)
Crash-loop itself is limited to "to all sockets disconnect"
not a story).
- lost file system event (backend unstarted / event drop / parent dir)
if the temporary missing), the reflection of the change will leave the periodic reconcile, and the maximum
Only `@reconcile_interval_ms` can be delayed (not delayed indefinitely)
`OAuthAllowlistWatcher` moduledoc "Detection" section.
- When the permission list is read during partial writing, it will be restored to complete content
may be over disconnected, including legitimate operators
(fail-closed intentional selection, not LKG maintenance). temp-file +
Editing with Editic rename is recommended, but this is guaranteed only by lowering the probability
None

Detailed design judgment (Home review, Home approval) is a comment history of issue #160,
See `KaoiroServer.OAuthAllowlistWatcher` module doc.
