---
title: User  httpOnly cookie Persistent (reload resistant)
status: accepted
date: 2026-06-15
opened: 2026-06-15
supersedes: []
superseded_by: null
related_specs: [protocol, architecture, threat-model]
related_adrs: [5, 11, 21, 42]
---

# ADR-0013 — httpOnly cookie of user  (reload resistant)

## Status

Accepted

## Context

Dashboard (`dashboard/`, Svelte) is a user  (ADR-0011)
`history.replaceState` to receive and receive the URL with `?token=…`
The address bar has been removed, and it has been kept only in JS memory.  Japanese term
Home**Reloading the browser loses both URL and memory s**、
`Auth.client_role/1` fail-closed(ADR-0011,
Issue #28) ThePetsーKung Layer layer was unmounted state (issue #45).

:

- Browser standard WebSocket does not include a custom `Authorization` header,
cookiedentials that can be used in the WS are "cookietus" or "cookie".
- Dashboard draws agent response-derived transcript / mer 
(DOMPurify installed intercept). Web Storage approach is  from JS
In order to read, XSS spreads damage to session theft. operator roll
The remote tool execution/approves the cost of leaking.
- **`Set-Cookie` cannot be found on established WebSocket**(cookie is HTTP)
can only be updated with the response header).

my-spec-elicitation in issue #45.

## Decision

User **httpOnly + Encryption session cookie**

1. **Equipment = session Reuse existing signature session cookies**(`_kaoiro_server_key`)。
httpOnly・SameSite=Lax has already been configured. No new cookies or manual parsing.
2. **Storage = Add the session to the session and encrypt the session**(`encryption_salt`
Add). `connect/3` and `/session/refresh` are `Auth.client_role/1`
To reverify**Revocation reflects in the following connection/refresh**Cookies by encryption
ThePetsーJapanese term is hidden even on the jar (the limit below is the immediate elimination of the active socket).
3. **Expiry Date = `max_age` 3 Day Riding Window**Home Open SPA
`GET /session/refresh` is reissued by tapping on the regular (12h) → **Open
Not expired**. After closing/cutting, expire in 3 days from last update.  limit
Not available.
4. **2 paths to exchangecookies to cookies**Home (a) prod = `GET /?token=…`
`RootRedirect` (P .Session) → `put_session` → Clean
`/index.html` to 302 (the SPA does not remain in SPA or address bar).
(b) SPA is not via RootRedirect because dev = Vite( 73) delivers SPA
Received `?token=` via `POST /session/new` (via Vite proxy). Cookies are HTTP
If you throw it through proxy, set cookies (client drive).
5. **WS certification via short-lived ticket**`connect/3` is ticket →  param →
resolved in the order of the session). **Vite proxy does not transfer cookies to WS upgrade,
:4000 Directly connected (cross-port) does not send cookies to your browser, so you can
Not available** (defined by validation). SPA is `GET /session/ticket`
`Phoenix.Token`**Encryption*** Short life
Get a ticket** (30 seconds) and WS with `?ticket=` (param passes proxy)
connection. `connect/3` returns the ticket to the . Sign only
Encryption is required because the person with the ticket can restore the ticket to Base64 (#47)
Review).**The  itself does not appear in JS**(Cannot be restored from the ticket)
The first load (`?token=` Yes) is connected withion param, and the cookie is
Set. prod is the same origin directly connected to the cookie to take the WS session
Fallback is also effective.
6. **secure flag = prod only**Home Existing`force_ssl`(`rewrite_on:
   [:x_forwarded_proto]`)Japanese term,`Application.compile_env(:kaoiro_server,
   :session_secure, false)`Home`prod.exs`Home`true`Home dev(http localhost)
false. CSRF is `check_origin` (`url` host default) of SameSite=Lax + prod
.

## Consequences

### Positive

- Reconnection is maintained even when reloaded and browser reboot, and operation and development friction disappears.
- httpOnly + encrypts the cookie to JS and cookie jar. XSS
Reusable s cannot be theft with a short-lived ticket (to dozens of seconds).
- Invalidation is reflected in revalidation per connection and `/session/refresh` (refresh 401)
and regular clients spontaneously cut).

### Negative

- Regular HTTP heartbeat from SPA is required to prevent revocation during opening (on WS)
Cookies are not updated.
- To prevent cookies from being placed on the WS (Vite proxy non-transfer + cross-port non-transfer),
You need to get a ticket with HTTP → param connection. `connect/3`
ticket / session param / session
- **Im ate force cutting of working socket**: Initially it was not possible, but it was resolved with issue #47.
Initially `ClientSocket` verifies connect only when connect and `id/1` is `nil`
(without `Endpoint.disconnect` route), the expiration was not reflected until the next connection.
socket id(`Auth.socket_id/1` = socket
SHA-256 and raw token are non-retained and explicit logout (`DELETE /session`)
`Endpoint.broadcast(id, "disconnect", %{})` with 401 of refresh
Instantly disconnect the working socket.

### Neutral

- ADR。5 cookies only carry s.
-The session was absent (`put_session` not used), so it is broken by adding encryption
No existing sessions.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
|Web Storage(localStorage)|Read from JS → Session theft with XSS. operator High leakage cost|
|cookie httpOnly cookies| `connect_info: [:x_headers]`Manual parsing. Existing session|
|only role in session (token non-retention)|The expired cookie does not expire. Prioritize immediate revalidation|
|Only sign  (no encryption)|You can read plain s from the cookie jar. operator is encrypted and confidential|
|limit expiration date|Contrary to the operational requirements of "Un.ed"  Japanese term only adopt|
