---
title: Device authorization grant
description: The HTTP contract a native client (kaoiro-client.nvim) follows to log in through the browser and use a device access token.
status: accepted
last_updated: 2026-10-31
related_adrs: [70, 13, 42]
---

# Device authorization grant

A native client that cannot receive the browser's OAuth redirect logs in with
the OAuth 2.0 device authorization grant
([RFC 8628](https://www.rfc-editor.org/rfc/rfc8628)): it shows a code, a
person approves it in the dashboard after an OAuth login, and the client
collects a **device access token**. The token is a bearer credential for
persona HTTP, `GET /session/ticket` and `GET /session/refresh`; the
WebSocket still connects with a 30-second ticket. Introduced by
[issue #801](https://github.com/sakuraiyuta/kaoiro/issues/801); the decision
is [ADR-0070](../../adr/0070-device-authorization-grant.md), the security
model is in
[authentication and authorization](../security/authentication-authorization.md#device-authorization-grant).

## Availability

`GET /session/auth-methods` returns `device: true` when this server can serve
the flow to the request: it arrived over https, the server runs as a single
backend, at least one OAuth provider is configured, and the dashboard is
served. Otherwise both native endpoints answer
`503 {"error":"temporarily_unavailable"}`; when the cause is clustering the
body adds `"reason":"device flow requires a single backend"`. Deployment
conditions are in [server configuration](../configuration/server.md#device-authorization-grant).

## Native endpoints

Both endpoints take `application/x-www-form-urlencoded` only (parameters on
the media type are allowed), read no cookie and write none.

| method / path | request | success |
|---|---|---|
| `POST /oauth/device` | `client_id` (required), `scope` (optional, empty) | 200, below |
| `POST /oauth/token` | `grant_type=urn:ietf:params:oauth:grant-type:device_code`, `device_code`, `client_id` | 200, below |
| `GET /device` | — | 302 to `/index.html?device=1`; the browser carries a `#code=` fragment over |

`POST /oauth/device` answers:

```json
{
  "device_code": "<43 characters>",
  "user_code": "BCD-FGH-JKL",
  "verification_uri": "https://<host>/device",
  "verification_uri_complete": "https://<host>/device#code=BCD-FGH-JKL",
  "expires_in": 600,
  "interval": 5
}
```

The user code is nine letters from `BCDFGHJKLMNPQRSTVWXZ`, shown as
`XXX-XXX-XXX`. The approving browser matches it case-insensitively and
ignores hyphens, spaces and other characters. `client_id` is 1 to 64
visible ASCII characters; it is self-declared, shown to the approver as such,
and never trusted.

`POST /oauth/token` answers, once approved:

```json
{
  "access_token": "<opaque>",
  "token_type": "Bearer",
  "expires_in": 259200,
  "role": "operator",
  "identity": {"provider": "nextcloud", "uid": "ao"}
}
```

`role` and `identity` are kaoiro extensions; show "connected as
`provider:uid`" after connecting. No `scope` or `refresh_token` is returned.

### Polling

Poll no earlier than `interval` seconds after the issue and after each poll.
An early poll is answered `slow_down` and raises the interval by five seconds;
the server keeps the raised value for that code.

| situation | status | body |
|---|---|---|
| not decided yet | 400 | `{"error":"authorization_pending"}` |
| polled before the interval | 400 | `{"error":"slow_down"}` |
| denied, or the approver left the allow-list | 400 | `{"error":"access_denied"}` (once; the code is then gone) |
| expired, within 600 seconds after expiry | 400 | `{"error":"expired_token"}` |
| unknown, already collected, or swept | 400 | `{"error":"invalid_grant"}` |
| another `client_id` than at issue | 400 | `{"error":"invalid_grant"}` |
| unsupported `grant_type` | 400 | `{"error":"unsupported_grant_type"}` |
| approved | 200 | the token above (once) |

### Input errors

The checks run in this order; the first failure answers.

| check | status | body |
|---|---|---|
| request did not arrive over https | 503 | `{"error":"temporarily_unavailable"}` |
| content type is not a form | 415 | empty |
| a query string is present | 400 | `{"error":"invalid_request"}` |
| body over the 16 KiB operational cap | 413 | `{"error":"invalid_request"}` |
| malformed percent-encoding or invalid UTF-8 | 400 | `{"error":"invalid_request"}` |
| a parameter appears twice | 400 | `{"error":"invalid_request"}` |
| server unavailable (see Availability) | 503 | `{"error":"temporarily_unavailable"}` |
| missing or malformed `client_id`, missing `device_code` or `grant_type` | 400 | `{"error":"invalid_request"}` |
| non-empty `scope` | 400 | `{"error":"invalid_scope"}` |
| issue limit reached (10 per 60 s, 20 pending, 64 held) | 503 | `{"error":"temporarily_unavailable"}`, with `Retry-After` for the rate limit |

Unknown parameters are ignored. No `error_description` is sent.

## Approval API (dashboard)

The dashboard calls these with its OAuth session cookie and a JSON body. A
request carrying an `Authorization` header is refused with
`400 {"error":"cookie_session_required"}`; no session (or an identity that
left the allow-list) is `401 {"error":"unauthorized"}`; a shared-token session
is `403 {"error":"oauth_session_required"}`; a non-JSON body is 415. The
checks run in that order.

| method / path | body | success |
|---|---|---|
| `POST /session/device/lookup` | `{"user_code"}` | 200 `{user_code, client_id, issued_at, expires_in, identity: {provider, uid}, role}` |
| `POST /session/device/decision` | `{"user_code", "decision": "approve" \| "deny"}` | 200 `{"state": "approved" \| "denied"}` |

`issued_at` is an ISO 8601 UTC string with second precision
(`2026-10-31T12:00:00Z`); `expires_in` is the remaining whole seconds.
`identity` and `role` are the approver's, which the device will act as.

| situation | status | body |
|---|---|---|
| unknown code | 404 | `{"error":"unknown_code"}` |
| expired code | 410 | `{"error":"expired"}` |
| already approved or denied (state unchanged) | 409 | `{"error":"already_decided"}` |
| too many failed lookups | 429 | `{"error":"rate_limited","retry_after":<seconds>}` |
| missing `user_code` or unknown `decision` | 400 | `{"error":"invalid_request"}` |

## Using the device access token

Send it as `Authorization: Bearer <token>` (the scheme is
case-insensitive). It is never read from a form body or the query string.

- Persona HTTP (`GET /api/personas`, `GET /api/personas/:id`,
  `GET /personas/:set/:file`) authorizes with the identity's current role.
- `GET /session/ticket` returns the 30-second WebSocket ticket for the
  identity; connect to `/client/websocket?ticket=...` as the dashboard does.
- `GET /session/refresh` returns `{access_token, token_type, expires_in}`
  with a new token and writes no cookie.
- `DELETE /session` ignores the header. Discarding the token is the
  client's logout; the server keeps no per-token state to revoke.

A request with an `Authorization` header is judged on the header alone, even
when a cookie rides along:

| problem | status | `WWW-Authenticate` |
|---|---|---|
| two `Authorization` headers, empty or malformed token | 400 `{"error":"invalid_request"}` | `Bearer realm="kaoiro", error="invalid_request"` |
| request did not arrive over https | 400 `{"error":"invalid_request"}` | same |
| scheme other than `Bearer` | 401 | `Bearer realm="kaoiro"` |
| altered, foreign, expired or too old token, or identity not on the allow-list | 401 | `Bearer realm="kaoiro", error="invalid_token"` |
| viewer on an operator endpoint | 403 | `Bearer realm="kaoiro", error="insufficient_scope"` |

The 401 and 403 bodies are the endpoint's usual ones (`{"error":"unauthorized"}`,
`{"error":"forbidden"}`, an empty body for refresh).

### Lifetime and refresh

A token expires three days after it was issued or last refreshed, and in any
case thirty days after the first issue: a refresh carries the first issue
time over. `expires_in` is always the remaining lifetime,
`min(now + 3 days, first issue + 30 days) - now`, so a token refreshed on day
29 gets about one day. Refresh once half of `expires_in` has passed; when
`expires_in` drops below twelve hours, tell the user a browser approval will
be needed soon, then run the flow again once refresh answers 401.

Responses of the native endpoints, `GET /device`, the approval API, ticket and
refresh carry `Cache-Control: no-store` and `Pragma: no-cache`, except the
https redirect a production server's `Plug.SSL` sends before the request
reaches the application. Persona HTTP keeps its own
`Cache-Control: private, no-store`.
