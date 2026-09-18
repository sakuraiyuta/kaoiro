---
title: Security threat model
status: accepted
last_updated: 2026-09-18
---

# Security threat model

Related security topics: [Security boundaries](security-boundaries.md), [Authentication and authorization](../reference/security/authentication-authorization.md), [Tool authorization](../reference/security/tool-authorization.md), [Security enforcement boundaries](../reference/security/enforcement-boundaries.md), [Security release audit](../operations/security-release-audit.md).

## Purpose

Phase 3 bidirectional routing (instructions and approvals) **by design means
tool execution on machines where agents reside, initiated by the client**. This
records threats and mitigations before full operation or external release
(issue #10).

### Preconditions (ingress defenses)

| Layer | Defense | Source |
|---|---|---|
| Transport | TLS terminated at a reverse proxy. Plain HTTP is permitted only for VPN-limited deployments (`KAOIRO_PLAIN_HTTP`, [deployment](../specs/deployment.md) 1.5 — tokens/cookies travel unencrypted within the VPN, so transport secrecy is delegated to the VPN (WireGuard)) | Decision 2026-06-11 / VPN direct-connection mode 2026-07-26 |
| Wrapper connection | Token per agent_id | [ADR-0011](../adr/0011-phase3-reliability-and-auth.md) |
| Client connection | User token + role (only operators can instruct/approve; tokens are retained in httpOnly + encrypted cookies) | Same as above / [ADR-0013](../adr/0013-user-token-cookie-persistence.md) |

### Threats

1. **Instruction = remote tool execution**: An attacker who obtains an
   operator token can send arbitrary instructions to an agent. The agent may
   read/write files and execute commands within its authority (an impact scope
   equivalent to compromising the development machine).
2. **Approval abuse**: If an attacker returns allow for `permission_decision`,
   tool execution that a human should have stopped can proceed.
3. **Information leakage through tool input**: The `input` of
   `permission_request` can contain secrets such as command lines, file paths,
   and environment values. Viewers receive only a synthetic
   `state_change(waiting_permission)` with an empty payload and no `ext`,
   so they do not receive the input. Lax management of operator credentials
   can still expose it.
4. **Information leakage through statusline metadata (`ext`)**: cwd (the
   absolute working-directory path, exposing filesystem layout and project
   names) and model / context / rate_limits in a state_change's `ext` initially
   passed through a catch-all even to viewers (originating with #16). cwd is
   especially sensitive (#46).
5. **Session resume/summoning = remote startup + history exposure**: The path
   that resumes a wrapper through the server from the client extends threat 1
   (remote tool execution; [ADR-0014](../adr/0014-session-resume-and-restore.md),
   issue #22). In addition, JSONL metadata returned by a runner when presenting
   candidates (such as an initial-prompt summary) exposes conversation
   fragments, and a resume request for an arbitrary session_id / cwd can become
   a path to read/continue another party's conversation.

### Mitigations

| Mitigation | Status |
|---|---|
| Limit instructions and approvals to the operator role | Implemented in Phase 3 |
| Fail closed for token authentication when `KAOIRO_CLIENT_TOKENS` is unset (reject all on that token path) — prevents an operator being defenselessly exposed by misconfiguration (warning log on startup). The OAuth path also rejects all on an unset, missing, or mismatched allowlist | Phase 3.5 ([issue #28](https://github.com/sakuraiyuta/kaoiro/issues/28)) / OAuth in phase-26 |
| Size limit on `permission_request.input` (truncate at 16KB; mark `truncated`) | Implemented in Phase 3 ([protocol](../specs/protocol.md)) |
| Wrapper-side `allowedTools` ceiling — even when instructions arrive, wrapper configuration is the ceiling on executable tools (not extensible by server/client) | Guaranteed by wrapper design (the server cannot override canUseTool) |
| Instruction audit log (who sent what to which agent and when) | Future (when SQLite is introduced) |
| Tool-input masking (redaction of secret patterns) | Future |
| Deliver response logs (`log`/`result`, including tool I/O) to operators only | Phase 3.5 ([ADR-0012](../adr/0012-response-display-and-dashboard-scope.md)) |
| Remove envelope `ext` (cwd / model / context / rate_limits / slash_commands / future additions) for viewers on every type | Implemented in #46 (commits 9b32c34 / ef7b606) |
| Change viewer delivery to an **allow-list model** (operator-only is the default; viewer delivery requires an explicit declaration). Remove the `permission_request` envelope completely for viewers (replace with synthetic `state_change(waiting_permission)` to preserve grid consistency) | #46 / [ADR-0021](../adr/0021-role-information-disclosure-policy.md) |
| Operator-only envelopes such as log/result are broadcast in plaintext to `agents:lobby` and `AgentsChannel.handle_out` filters them per subscriber (not a gate at subscription). Secure this with the invariant that `AgentsChannel` is the only subscriber to `agents:lobby`; do not adopt a separate operator-only topic | #27 (evaluated and **kept the current design**; see MUST below for new subscribers) |
| Define **agent-to-agent disclosure** (the peer directory) as a third principal on an axis separate from viewers/operators; allow-list only explicitly enumerated fields in `directory_entry` to agents. Do not pass nested `ext` keys through; project only canonical keys. Continue excluding cwd / permission / `session_id` / `pending_permission` / `session_capabilities`, etc. | #150 / [ADR-0021](../adr/0021-role-information-disclosure-policy.md) F6 (“peer-directory information boundary” in [peer directory](../reference/inter-agent/directory.md) is field SoT) |
| Retain user tokens in httpOnly + encrypted session cookies (unreadable by JS even under XSS, secret in the cookie jar). Mitigate CSRF with SameSite=Lax + production `check_origin` | Phase 3.5 ([ADR-0013](../adr/0013-user-token-cookie-persistence.md)) |
| Add browser-side defense-in-depth headers (CSP / `X-Content-Type-Options: nosniff` / `X-Frame-Options: DENY` / `Referrer-Policy: strict-origin-when-cross-origin`) **before endpoint static delivery** (`KaoiroServerWeb.SecurityHeaders`). `index.html` and built assets bypass the router, so the `:browser` pipeline does not protect the SPA itself. CSP uses `script-src 'self'` (removes a route that relied solely on DOMPurify for untrusted agent output rendered with `{@html}`), `frame-ancestors 'none'` (operator-action inducement through clickjacking), and maps only `check_origin` entries matching the response origin to `ws:`/`wss:` in `connect-src` (`check_origin` means “origins permitted to open a socket”; `connect-src` means “destinations this page may connect to,” so their trust axes differ and not every entry is copied). In TLS reverse-proxy deployments, `rewrite_on: [:x_forwarded_proto]` rewrites only the scheme and leaves the internal port in conn; recover and compare the port from the endpoint's `:url` only when its external scheme/host match. Headers always contain configuration strings; the request Host is used only for comparison. In a VPN direct deployment without nginx ([deployment](../specs/deployment.md) 1.5), only the server can add them. | Implemented in #145 |
| OAuth individual authentication + allowlist (Google / GitHub / Nextcloud). Re-resolve a role from the allowlist on every connection and operation, so demotion also applies to live sockets. **Apply changes in a change-driven way even to passive sockets that never operate** (`OAuthAllowlistWatcher` detects allowlist-file changes by checkpoint diff and disconnects only affected identities; periodic reconciliation bounds lost events; `AgentsChannel.join/3` closes the connect-join race by revalidation) | Implemented in phase-26 ([ADR-0042](../adr/0042-oauth-allowlist-login.md) / [#148](https://github.com/sakuraiyuta/kaoiro/issues/148)). Passive sockets in [#160](https://github.com/sakuraiyuta/kaoiro/issues/160). Role refinement (approver, etc.) and multi-tenant isolation are future work ([ADR-0005](../adr/0005-access-control-oauth-stub.md)) |
| Expose JSONL metadata returned by the runner when summoning a session (such as an initial-prompt summary) only minimally and to operators (T2, [ADR-0014](../adr/0014-session-resume-and-restore.md)) | Implemented in Phase 4 (4-5) |
| Verify that a resumed session_id exists under the cwd bound to its agent; reject resumes to another cwd/arbitrary path (T3, verified by runner). Re-verify the replacement target of `switch_session` under the same cwd | Implemented in Phase 4 (4-5) |
| The startup-instruction UI (#22) does not present arbitrary cwd / arbitrary repository clones; restrict selectable cwd to the runner-config allowlist to bound the RCE surface (scope=medium, T1/T5) | Implemented in Phase 4 (4-8) ([ADR-0023](../adr/0023-host-runner-architecture.md)) |
| Consolidate spawn authentication through runner startup (daemon or one shot); authenticate with per-host runner tokens + server-issued per-agent tokens (secrets remain in the server and do not reach operators/clients). **Do not adopt** a wildcard shared token whose leakage affects the entire scope (consideration deferred to #71) | Implemented in Phase 4 (4-10) ([ADR-0024](../adr/0024-agent-instance-identity-and-spawn-auth.md) D2/D4). Revocation uses an agent_id-scoped denylist ([#72](https://github.com/sakuraiyuta/kaoiro/issues/72)) |
| For an engine whose approval gate is enforced only by the wrapper (`antigravity`), disable the CLI's own prompts, make the wrapper hook the sole decision channel, and verify on the production path both that the gate is registered and that completed calls in the measured hook classes (write / read / shell / subagent / network) were gated (otherwise fail the spawn / freeze the session). Unclassified names only warn; names outside those classes are not subject to completion correlation. The class scope is defined in ADR-0057 F4b | Implemented in phase-34 Stage A on 2026-09-04 (`6d48eab5`) ([ADR-0057](../adr/0057-antigravity-adapter.md) F4 / F4b; section below) |

## Open Questions

- Audit logging and tool-input masking remain future items as shown in the
  table above.

## See Also

- Related specs: [protocol](../specs/protocol.md), [architecture](system-overview.md)
- ADRs: [0002](../adr/0002-local-wrapper-websocket-topology.md),
  [0005](../adr/0005-access-control-oauth-stub.md),
  [0011](../adr/0011-phase3-reliability-and-auth.md),
  [0012](../adr/0012-response-display-and-dashboard-scope.md),
  [0014](../adr/0014-session-resume-and-restore.md),
  [0021](../adr/0021-role-information-disclosure-policy.md),
  [0023](../adr/0023-host-runner-architecture.md),
  [0024](../adr/0024-agent-instance-identity-and-spawn-auth.md),
  [0036](../adr/0036-session-lifecycle-commands.md),
  [0042](../adr/0042-oauth-allowlist-login.md),
  [0043](../adr/0043-agent-initiated-session-reset.md),
  [0057](../adr/0057-antigravity-adapter.md)
- Boundary implementation map: [auth-and-authz](security-boundaries.md)
