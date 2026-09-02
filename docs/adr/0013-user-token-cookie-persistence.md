---
title: Persist the user token in an httpOnly cookie (reload resilience)
status: accepted
date: 2026-06-15
opened: 2026-06-15
supersedes: []
superseded_by: null
related_specs: [protocol, architecture, threat-model]
related_adrs: [5, 11, 21, 42]
---

# ADR-0013 — Persist the User Token in an httpOnly Cookie (Reload Resilience)

## Status

Accepted

## Context

The dashboard (`dashboard/`, Svelte) received the user token (ADR-0011) in the
URL as `?token=…`, removed it from the address bar immediately with
`history.replaceState`, and then kept it only in JS memory. As a result,
**reloading the browser lost the token from both the URL and memory**; the
reconnection had empty params and was rejected fail-closed by
`Auth.client_role/1` (ADR-0011, issue #28). The token-persistence layer was
unimplemented (issue #45).

Constraints:

- A browser-standard WebSocket cannot attach a custom `Authorization` header,
  so credentials usable by WS are effectively limited to the two choices of
  "query (current)" or "cookie".
- The dashboard has an XSS surface because it renders agent-response-derived
  transcript / mermaid (the installed DOMPurify is supporting evidence). With
  Web Storage, the token is readable from JS, allowing an XSS to extend its
  impact to session theft. The operator role can execute and approve remote
  tools, so the cost of leakage is high.
- **`Set-Cookie` cannot be performed on an established WebSocket** (a cookie can
  be updated only with an HTTP response header).

The approach was settled through my-spec-elicitation for issue #45 (user
decision on 2026-06-15).

## Decision

Persist the user token in an **httpOnly + encrypted session cookie**.

1. **Container = reuse Phoenix's existing signed session cookie**
   (`_kaoiro_server_key`). httpOnly and SameSite=Lax are already configured.
   Do not add a new cookie or manual parsing.
2. **Storage = put the token in the session and encrypt the session** (add
   `encryption_salt`). `connect/3` and `/session/refresh` revalidate with
   `Auth.client_role/1` each time, so **revocation is reflected on the next
   connection/refresh**; encryption keeps the token confidential in the cookie
   jar (the limitation on immediately removing an active socket is below).
3. **Expiry = a three-day sliding window with `max_age`**. The open SPA
   periodically (12h) calls `GET /session/refresh` to reissue the cookie → **it
   does not expire while open**. After it is closed/disconnected, it expires
   three days after the last update. There is no absolute upper limit.
4. **There are two token-to-cookie exchange paths**. (a) prod = validate
   `GET /?token=…` in `RootRedirect` (after Plug.Session) → `put_session` → 302
   to clean `/index.html` (the token remains neither in the SPA nor the address
   bar). (b) dev = Vite (:5173) serves the SPA and does not go through
   RootRedirect, so the SPA sends the received `?token=` to `POST /session/new`
   (through the Vite proxy; cookies pass through the proxy over HTTP) to set the
   cookie (client-driven).
5. **WS authentication uses a short-lived ticket** (`connect/3` resolves in the
   order ticket → token param → session). **The Vite proxy does not forward
   Cookie on a WS upgrade, and the browser does not send cookies even on a direct
   cross-port connection to :4000, so a cookie cannot be carried over WS**
   (confirmed by verification). On reload, the SPA therefore obtains a
   **short-lived encrypted** `Phoenix.Token` **ticket** (30 seconds) with
   `GET /session/ticket` (HTTP with the cookie goes through the proxy), then
   connects the WS with `?ticket=` (the param goes through the proxy).
   `connect/3` decrypts the ticket back into the token. Encryption is required
   because with signing only, a ticket holder could Base64-decode the token (#47
   review). **The token itself never appears in JS** (nor can it be recovered
   from the ticket). On the initial load (with `?token=`), connect with the token
   param while setting the cookie. In prod, the same-origin direct connection
   sends the cookie over WS, so the session fallback also works.
6. **The secure flag is prod only**. Based on the existing `force_ssl`
   (`rewrite_on:
   [:x_forwarded_proto]`), set
   `Application.compile_env(:kaoiro_server,
   :session_secure, false)` to `true`
   in `prod.exs`. It is false in dev (http localhost). CSRF is mitigated by
   SameSite=Lax + prod's `check_origin` (default `url` host).

## Consequences

### Positive

- Reconnection is maintained across reloads and browser restarts, removing
  operational and development friction.
- With httpOnly + encryption, the token appears neither in JS nor as plaintext
  in the cookie jar. An XSS can obtain only the short-lived ticket (tens of
  seconds), and cannot steal a reusable token.
- Revocation is reflected by revalidation on each connection and
  `/session/refresh` (when refresh returns 401, a standard client disconnects
  itself).

### Negative

- Preventing revocation while the SPA is open requires a periodic HTTP heartbeat
  from the SPA (cookies cannot be updated over WS).
- Because a cookie cannot be carried over WS (not forwarded by the Vite proxy and
  not sent cross-port), reload authentication requires the extra step of
  "obtain a ticket over HTTP → connect with a param." `connect/3` has three
  paths: ticket / token param / session.
- **Immediate forced disconnection of an active socket**: This was initially
  impossible, but was resolved by issue #47. Initially, `ClientSocket` validated
  the token only on connect and `id/1` was `nil` (there was no
  `Endpoint.disconnect` path), so revocation was not reflected until the next
  connection. In #47, `id/1` was changed to a token-derived socket ID
  (`Auth.socket_id/1` = SHA-256 of the token; the raw token is not retained),
  and explicit logout (`DELETE /session`) and refresh 401 (revocation) now
  immediately disconnect active sockets through
  `Endpoint.broadcast(id, "disconnect", %{})`.

### Neutral

- The full OAuth implementation (the main line of ADR-0005) remains future work.
  The cookie only carries the token.
- The session was previously dormant (`put_session` was unused), so there are no
  existing sessions that can be broken by adding encryption.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| Store the token in Web Storage (localStorage) | Readable from JS → session theft through XSS; the operator's leakage cost is high |
| Add a dedicated httpOnly cookie | Requires manual parsing with `connect_info: [:x_headers]`; reusing the existing session is sufficient |
| Store only the role in the session (do not retain the token) | Revocation does not take effect until the cookie expires; immediate revocation through token revalidation is prioritized |
| Store the token with signing only (without encryption) | Plaintext tokens can be read from the cookie jar; encryption keeps the operator's token confidential |
| Expiry with an absolute upper limit | Conflicts with the operational requirement of "no expiry while open"; only sliding expiry is adopted |
