---
title: Phase 26 — Dashboard OAuth login + allowlist (issue #65)
description: Introduce Google/GitHub/Nextcloud OAuth personal authentication to the dashboard and authorize with a text allowlist (provider:identifier[:role]). When KAOIRO_CLIENT_TOKENS is unset, token authentication is disabled (OAuth only). Design: ADR-0042.
status: in_progress
phase: 26
depends_on: []
last_updated: 2026-07-26
---

# Phase 26 — Dashboard OAuth login + allowlist

## Goal

Introduce personal-identity login to the dashboard (OAuth: Google / GitHub /
Nextcloud + allowlist authorization). Shared-token authentication coexists only
when `KAOIRO_CLIENT_TOKENS` is configured; when unset, OAuth is the only option.
The design decision is [ADR-0042](../adr/0042-oauth-allowlist-login.md), and the
issue is [#65](https://github.com/sakuraiyuta/kaoiro/issues/65).

## Ownership

- Server (Elixir): **Ao**
- Dashboard (Svelte/TS): **Momo**
- Planning, supervision, and progress updates in this doc: **Kuroe** (assignees
  must not edit this doc directly—report progress to Kuroe)

## API contract (boundary for parallel work)

- `GET /session/auth-methods` → 200
  `{"token": true|false, "oauth": ["google","github","nextcloud"]}`
  (oauth includes only enabled providers; readable without authentication)
- `GET /auth/:provider` → 302 (to the provider's authorize URL). An invalid
  provider returns 404.
- `GET /auth/:provider/callback` → success: set a session cookie and 302
  `/index.html` / failure: 302
  `/index.html?auth_error={provider_error|not_allowed|invalid_state}`
- Subsequent WS connection, refresh, and logout retain the existing paths
  (`/session/ticket` → `?ticket=`, `GET /session/refresh`, `DELETE /session`).
- Addendum (2026-07-26, Ao, login CSRF defense): `POST /session/new` requires
  JSON content type (otherwise 415). The dashboard already sends JSON, so it is
  unaffected.

## Scope / Tasks

| # | Task | File | Owner | Status |
|---|---|---|---|---|
| 26-1 | deps: add assent + HTTP client (Req assumed). Follow assent's official adapter recommendation | `server/mix.exs` | Ao | done |
| 26-2 | Allowlist module: read path, parse `provider:identifier[:role]` (omitted role = viewer, warn+skip malformed lines), `role_for(provider, identifier)`. Parse every time (no cache) | `server/lib/kaoiro_server/oauth_allowlist.ex` (new) | Ao | done |
| 26-3 | runtime.exs: load `KAOIRO_OAUTH_*` provider settings + `KAOIRO_OAUTH_ALLOWLIST_PATH`. Extend startup WARN from `Auth.warn_token_config/0` with OAuth configuration state | `server/config/runtime.exs`, `auth.ex` | Ao | done |
| 26-4 | AuthController: `GET /auth/:provider` (save session_params to session) / callback (state validation → identity normalization → allowlist match → put_session → 302). Discard provider access tokens | `server/lib/kaoiro_server_web/controllers/auth_controller.ex` (new), `router.ex` | Ao | done |
| 26-5 | Session/WS integration: store identity in session, encrypt identity in ticket, resolve identity in `ClientSocket.connect/3` (recheck allowlist every time), OAuth variant of `Auth.socket_id`, identity-aware refresh/delete | `client_socket.ex`, `session_controller.ex`, `auth.ex` | Ao | done |
| 26-6 | Implement `GET /session/auth-methods` | `session_controller.ex`, `router.ex` | Ao | done |
| 26-7 | Server tests: allowlist parse/fail-closed, callback authorization/rejection, OAuth ticket connection, refresh 401 + forced disconnect, auth-methods. Follow existing suites (auth_test etc.) | `server/test/**` | Ao | done |
| 26-8 | Docs/env: update `.env.example` + `docs/specs/auth-and-authz.md` (socket auth table, cookie/ticket section, Known gaps) | `server/.env.example`, `docs/specs/auth-and-authz.md` | Ao | done |
| 26-9 | Dashboard: fetch `GET /session/auth-methods` at startup, conditional token-form display (hide when token is disabled), guidance when both are disabled | `dashboard/src/App.svelte` | Momo | done |
| 26-10 | Dashboard: OAuth login buttons (links to `/auth/:provider` below token input), display `?auth_error=` messages + clean the URL with `history.replaceState` | `dashboard/src/App.svelte` | Momo | done |
| 26-11 | Add `/auth` to the Vite dev proxy | `dashboard/vite.config.ts` | Momo | done |
| 26-12 | Dashboard verification: `pnpm typecheck` / `pnpm build` green. Check login-screen state branches (token only / OAuth only / both / neither) | `dashboard/` | Momo | done |

## Acceptance Criteria

- `cd server && mix test` / `mix format --check-formatted` green
- `cd dashboard && pnpm typecheck && pnpm build` green
- An identity outside the allowlist is rejected with `not_allowed` at callback
  (fail-closed). After removing an allowlist row, refresh (401) disconnects the
  live socket.
- With `KAOIRO_CLIENT_TOKENS` unset + OAuth enabled, show no token form and only
  OAuth buttons.
- Provider access tokens remain nowhere in logs, session, or DETS.

## Out of scope

- Finer role distinctions (approver etc.), audit logs, and multi-tenant
  isolation
- Removal of option A (token login form)—keep both coexisting
- Adding an OAuth question to the kaoiro.env wizard (#139 follow-up candidate)

## Progress log

- 2026-07-26: Plan created (Kuroe). Delegation to Ao/Momo started.
- 2026-07-26: 26-9–26-12 complete (Momo, commit 5887df0). On auth-methods
  fetch failure, gracefully degrade to the token form; fetchAuthMethods has
  shape validation. svelte-check 0 errors / build / 338 tests green; 0 review
  must-fixes.
- 2026-07-26: 26-1–26-8 complete (Ao, uncommitted). mix test 611 green
  (confirmed by Kuroe rerun). One must-fix corrected (when OAuth is enabled,
  evaluating Endpoint.url() before boot in warn_config prevented startup →
  split enabled?/1 to read only env + added a separate BEAM regression test).
  Additional findings: Nextcloud does not support PKCE (state only); avoid an
  assent 0.3.1 Req adapter header-injection bug (log only the exception type;
  fixed upstream but unreleased). Follow-up: allowlist role demotion does not
  affect live sockets; file an issue (#148—the same hole exists on the shared
  token path, and the AgentsChannel-side fix is the real solution).
- Handoff note: The constraint that AuthController.log_failure/3 logs only
  exception type is based on an assent 0.3.1 Req adapter header-injection bug
  (fixed upstream, unreleased). Reconsider whether to relax it when updating
  assent. If Nextcloud adds PKCE support, code_verifier: true can be added to
  the strategy.
- 2026-07-26: All commits complete and pushed (5887df0 dashboard / 8f75e92
  docs / 7f57a4c server). Remaining: master provider registration + real-device
  E2E (Kuroe has supplied the procedure in chat); role demotion is #148.
