---
title: Security release audit
status: accepted
last_updated: 2026-09-18
---

# Security release audit

Related security topics: [Security boundaries](../architecture/security-boundaries.md), [Security threat model](../architecture/security-threat-model.md), [Authentication and authorization](../reference/security/authentication-authorization.md), [Tool authorization](../reference/security/tool-authorization.md), [Security enforcement boundaries](../reference/security/enforcement-boundaries.md).

## Release-time audit checklist

For the pre-OSS audit (private Gitea issue 91), verify the following against the
[security boundaries](../architecture/security-boundaries.md) and the
[authentication and authorization](../reference/security/authentication-authorization.md) /
[tool authorization](../reference/security/tool-authorization.md) references,
and keep this checklist synchronized with the issue checklist.

- [ ] Each socket's unset-token behavior (warn + fallback / fail-closed) matches
  the document.
- [ ] Every OAuth login is rejected when the allowlist is unset, missing, or
  mismatched (ADR-0042 fail-closed).
- [ ] Provider access tokens do not remain in session / cookie / DETS / logs.
- [ ] The `AgentsChannel.handle_out` allow-list does not leak new envelopes
  (complete `sanitize_envelope_for` coverage + tests).
- [ ] No operator-only inbound event omits `require_operator/1` (grep + tests).
- [ ] The operator-only HTTP endpoint (`RequireOperatorPlug`) is covered by tests
  for anonymous 401 / viewer 403 / operator and admin 200 (issue #232).
- [ ] Dev fallback risk is assessed (`:prod` fails closed when tokens are unset,
  covered by tests; issue #133).
- [ ] No secret appears in logs (check Logger for token / cookie / signed token).
- [ ] `secret_key_base` used by `Phoenix.Token.sign` is not a fixed production
  value.
- [ ] Cookie SameSite / Secure / HttpOnly match production configuration intent.
- [ ] CSRF (`check_origin`) is enabled in production.
- [ ] Adding envelope `ext` keys still strips them for viewers.
- [ ] Inter-agent body prompt-injection risk is documented in README / threat model.
- [ ] Server / client have no path to override the wrapper `allowedTools` ceiling
  (tests).
- [ ] Antigravity: with the hook removed, the registration check and the
  completed-tool correlation invariant both fail closed, and the bridge
  auto-allow rejects every shell-injection fixture (phase-34).
- [ ] `scripts/dev.sh` logs contain no secrets (grep `tmp/dev-logs/*.log`).
- [ ] Scan `git log --all -p` for token / .env / cookie / signed-token strings;
  none may enter commits intended for publication.
