---
title: Device authorization grant for native clients
status: accepted
date: 2026-10-31
opened: 2026-10-31
supersedes: []
superseded_by: null
related_specs: [device-authorization, authentication-authorization]
related_adrs: [13, 42, 50]
---

# ADR-0070 — Device authorization grant for native clients

## Context

A browser logs in through OAuth
([ADR-0042](0042-oauth-allowlist-login.md)) and keeps an encrypted session
cookie ([ADR-0013](0013-user-token-cookie-persistence.md)). The OAuth
callback ends in a redirect to `/index.html`, so a client without a browser,
such as kaoiro-client.nvim, cannot receive its result. Its only other way in
is a shared token, and a deployment may switch token authentication off and
offer OAuth only. Persona HTTP accepted the cookie only, and the server had no
bearer credential, no token table and no rate limit for people.
[issue #801](https://github.com/sakuraiyuta/kaoiro/issues/801) asks for the
OAuth 2.0 device authorization grant
([RFC 8628](https://www.rfc-editor.org/rfc/rfc8628)).

## Decision

1. **RFC-shaped wire with a stateless bearer (A').** `POST /oauth/device` and
   `POST /oauth/token` follow RFC 8628 and RFC 6749 §5 (form-encoded input,
   `{"error"}` responses). The access token is a `Phoenix.Token` encryption
   of `%{provider, uid, iat}` under its own salt: the identity the session
   cookie already carries, plus the first issue time. The server stores no
   token. Persona HTTP, `GET /session/ticket` and `GET /session/refresh`
   accept it in `Authorization: Bearer`; the WebSocket keeps the 30-second
   ticket, so no bearer goes into a URL. Roles are resolved from the
   allow-list on every request, as for the cookie.
2. **The bearer never falls back to the cookie, and its failures touch
   neither.** A request with an `Authorization` header is judged on it alone.
   A failure answers with the RFC 6750 challenge and does not clear a session
   or disconnect a socket: the cookie that rides along may belong to someone
   else using the same browser, and an expired token is not a revocation.
3. **A sliding three-day lifetime and an absolute thirty-day one.** The
   cookie has no absolute lifetime; a stolen bearer is not allowed to be kept
   alive by refreshing it forever. The thirty days do not end an already
   connected WebSocket.
4. **Approval in the dashboard SPA.** The server has no HTML templates and
   the OAuth controller stays untouched. The approval API takes only an OAuth
   session cookie and a JSON body. Approving binds the approver's identity,
   which the device then acts as.
5. **A single backend.** Pending codes live in one node's ETS table. A
   non-empty `DNS_CLUSTER_QUERY` disables the flow and a connected node makes
   it unavailable; a deployment of disconnected backends behind one proxy is
   a deployment condition rather than something the server can detect. The
   operator set a single server as the deployment policy (2026-10-31).
6. **Only https.** The flow and the bearer are served only when the request's
   scheme, after `Plug.SSL` applies `x-forwarded-proto`, is https. A
   dev/test-only configuration key is the sole exception; `runtime.exs`
   never reads it.
7. **The two native endpoints own their input (P1).** The endpoint's
   `plug Plug.Parsers` line is replaced by `KaoiroServerWeb.Parsers`, which
   hands a POST to `/oauth/device` or `/oauth/token` to
   `KaoiroServerWeb.NativeOAuthInput` and delegates everything else to
   `Plug.Parsers.call/2` with the same options. The input is checked in a
   fixed order and the verdict is left in `conn.private`, never raised, so
   the controller builds every failure with its headers.

## Alternatives

- **B': hand the native client the session cookie.** No server-side change
  downstream, but the native endpoint would write a cookie and so need JSON
  for login-CSRF reasons, departing from the RFC's form encoding and
  `token_type`, and the issue and the client's ADR name RFC 8628.
- **Let `Plug.Parsers` parse the native endpoints too.** A malformed JSON
  body raises `ParseError` before the router, and the endpoint's catch-all
  renders it with the connection from before `Plug.SSL`, so the answer would
  be Phoenix's 400 without the controller's headers rather than the RFC's
  415. Relying on `Plug.Parsers` skipping a pre-fetched body depends on
  undocumented behaviour.
- **A server-rendered approval page.** Would add the first HTML template and
  touch the OAuth controller; the SPA already has the session.
- **Serving plain http with a warning.** RFC 8628 §3.1 and RFC 6750 §5.3
  require TLS; a bearer seen once is reusable.

## Consequences

- There is no per-token revocation, as with a copied cookie: removing the
  identity from the allow-list stops the next request and the allow-list
  watcher disconnects its sockets.
- Unauthenticated requests can hold all 20 pending slots for ten minutes; a
  restart clears them. Wrong user codes are capped at 5 per identity and 20 in
  total per 900 seconds, which bounds a guess at one code to about 2^-30.
- Follow-ups: an absolute lifetime for the cookie, and a lifetime for an
  already connected WebSocket.

The contract is [device authorization grant](../reference/protocol/device-authorization.md).
