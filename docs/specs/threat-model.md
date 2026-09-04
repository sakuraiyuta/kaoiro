---
title: Threat model (bidirectional routing)
description: Threats and mitigations from client → agent instructions and approvals (issue #10).
status: accepted
related: [protocol, architecture]
---

# Threat model (bidirectional routing)

## Purpose

Phase 3 bidirectional routing (instructions and approvals) **by design means
tool execution on machines where agents reside, initiated by the client**. This
records threats and mitigations before full operation or external release
(issue #10).

## Definition

### Preconditions (ingress defenses)

| Layer | Defense | Source |
|---|---|---|
| Transport | TLS terminated at a reverse proxy. Plain HTTP is permitted only for VPN-limited deployments (`KAOIRO_PLAIN_HTTP`, [deployment](deployment.md) 1.5 — tokens/cookies travel unencrypted within the VPN, so transport secrecy is delegated to the VPN (WireGuard)) | Decision 2026-06-11 / VPN direct-connection mode 2026-07-26 |
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
   and environment values. It is delivered to viewers as well, so lax token
   management can leak it.
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
| Size limit on `permission_request.input` (truncate at 16KB; mark `truncated`) | Implemented in Phase 3 ([protocol](protocol.md)) |
| Wrapper-side `allowedTools` ceiling — even when instructions arrive, wrapper configuration is the ceiling on executable tools (not extensible by server/client) | Guaranteed by wrapper design (the server cannot override canUseTool) |
| Instruction audit log (who sent what to which agent and when) | Future (when SQLite is introduced) |
| Tool-input masking (redaction of secret patterns) | Future |
| Deliver response logs (`log`/`result`, including tool I/O) to operators only | Phase 3.5 ([ADR-0012](../adr/0012-response-display-and-dashboard-scope.md)) |
| Remove envelope `ext` (cwd / model / context / rate_limits / slash_commands / future additions) for viewers on every type | Implemented in #46 (commits 9b32c34 / ef7b606) |
| Change viewer delivery to an **allow-list model** (operator-only is the default; viewer delivery requires an explicit declaration). Remove the `permission_request` envelope completely for viewers (replace with synthetic `state_change(waiting_permission)` to preserve grid consistency) | #46 / [ADR-0021](../adr/0021-role-information-disclosure-policy.md) |
| Operator-only envelopes such as log/result are broadcast in plaintext to `agents:lobby` and `AgentsChannel.handle_out` filters them per subscriber (not a gate at subscription). Secure this with the invariant that `AgentsChannel` is the only subscriber to `agents:lobby`; do not adopt a separate operator-only topic | #27 (evaluated and **kept the current design**; see MUST below for new subscribers) |
| Define **agent-to-agent disclosure** (the peer directory) as a third principal on an axis separate from viewers/operators; allow-list only explicitly enumerated fields in `directory_entry` to agents. Do not pass nested `ext` keys through; project only canonical keys. Continue excluding cwd / permission / `session_id` / `pending_permission` / `session_capabilities`, etc. | #150 / [ADR-0021](../adr/0021-role-information-disclosure-policy.md) F6 (“peer-directory information boundary” in [protocol-inter-agent](protocol-inter-agent.md) is field SoT) |
| Retain user tokens in httpOnly + encrypted session cookies (unreadable by JS even under XSS, secret in the cookie jar). Mitigate CSRF with SameSite=Lax + production `check_origin` | Phase 3.5 ([ADR-0013](../adr/0013-user-token-cookie-persistence.md)) |
| Add browser-side defense-in-depth headers (CSP / `X-Content-Type-Options: nosniff` / `X-Frame-Options: DENY` / `Referrer-Policy: strict-origin-when-cross-origin`) **before endpoint static delivery** (`KaoiroServerWeb.SecurityHeaders`). `index.html` and built assets bypass the router, so the `:browser` pipeline does not protect the SPA itself. CSP uses `script-src 'self'` (removes a route that relied solely on DOMPurify for untrusted agent output rendered with `{@html}`), `frame-ancestors 'none'` (operator-action inducement through clickjacking), and maps only `check_origin` entries matching the response origin to `ws:`/`wss:` in `connect-src` (`check_origin` means “origins permitted to open a socket”; `connect-src` means “destinations this page may connect to,” so their trust axes differ and not every entry is copied). In TLS reverse-proxy deployments, `rewrite_on: [:x_forwarded_proto]` rewrites only the scheme and leaves the internal port in conn; recover and compare the port from the endpoint's `:url` only when its external scheme/host match. Headers always contain configuration strings; the request Host is used only for comparison. In a VPN direct deployment without nginx ([deployment](deployment.md) 1.5), only the server can add them. | Implemented in #145 |
| OAuth individual authentication + allowlist (Google / GitHub / Nextcloud). Re-resolve a role from the allowlist on every connection and operation, so demotion also applies to live sockets. **Apply changes in a change-driven way even to passive sockets that never operate** (`OAuthAllowlistWatcher` detects allowlist-file changes by checkpoint diff and disconnects only affected identities; periodic reconciliation bounds lost events; `AgentsChannel.join/3` closes the connect-join race by revalidation) | Implemented in phase-26 ([ADR-0042](../adr/0042-oauth-allowlist-login.md) / [#148](https://github.com/sakuraiyuta/kaoiro/issues/148)). Passive sockets in [#160](https://github.com/sakuraiyuta/kaoiro/issues/160). Role refinement (approver, etc.) and multi-tenant isolation are future work ([ADR-0005](../adr/0005-access-control-oauth-stub.md)) |
| Expose JSONL metadata returned by the runner when summoning a session (such as an initial-prompt summary) only minimally and to operators (T2, [ADR-0014](../adr/0014-session-resume-and-restore.md)) | Implemented in Phase 4 (4-5) |
| Verify that a resumed session_id exists under the cwd bound to its agent; reject resumes to another cwd/arbitrary path (T3, verified by runner). Re-verify the replacement target of `switch_session` under the same cwd | Implemented in Phase 4 (4-5) |
| The startup-instruction UI (#22) does not present arbitrary cwd / arbitrary repository clones; restrict selectable cwd to the runner-config allowlist to bound the RCE surface (scope=medium, T1/T5) | Implemented in Phase 4 (4-8) ([ADR-0023](../adr/0023-host-runner-architecture.md)) |
| Consolidate spawn authentication through runner startup (daemon or one shot); authenticate with per-host runner tokens + server-issued per-agent tokens (secrets remain in the server and do not reach operators/clients). **Do not adopt** a wildcard shared token whose leakage affects the entire scope (consideration deferred to #71) | Implemented in Phase 4 (4-10) ([ADR-0024](../adr/0024-agent-instance-identity-and-spawn-auth.md) D2/D4). Revocation uses an agent_id-scoped denylist ([#72](https://github.com/sakuraiyuta/kaoiro/issues/72)) |
| For an engine whose approval gate is enforced only by the wrapper (`antigravity`), disable the CLI's own prompts, make the wrapper hook the sole decision channel, and verify on the production path both that the gate is registered and that every completed tool call was gated (otherwise fail the spawn / freeze the session) | Planned — phase-34 ([ADR-0057](../adr/0057-antigravity-adapter.md) F4 / F4b; section below) |

## Constraints

- MUST: Accept instructions and approvals only from the operator role
  ([protocol](protocol.md)).
- MUST: Deliver response logs (`log`/`result`) only to the operator role
  ([ADR-0012](../adr/0012-response-display-and-dashboard-scope.md)).
- MUST: Deliver envelope `ext` (statusline metadata: cwd / model / context /
  rate_limits / slash_commands / future additions) only to the operator role
  (#46; remove it for viewers on every type).
- MUST: Viewer delivery uses an **allow-list model**. Of `agents:lobby` events
  / envelope.types, only those explicitly declared for viewer delivery reach
  viewers. Undeclared types are removed completely for viewers (fail closed;
  [ADR-0021](../adr/0021-role-information-disclosure-policy.md)).
- MUST: Remove the `permission_request` envelope completely for viewers.
  Deliver a synthetic `state_change(waiting_permission)` (`payload={}`, no
  `ext`) to viewers in its place for grid consistency
  ([ADR-0021](../adr/0021-role-information-disclosure-policy.md)).
- MUST: **Agent-to-agent disclosure also uses an allow-list model**. The peer
  directory (`directory_request`) is a **separate implementation and path**
  from viewer delivery; one allow list does not protect the other. Expose only
  explicitly enumerated fields in `directory_entry`; drop unknown nested `ext`
  keys by projecting to canonical keys (ADR-0021 F6, #150). When adding a peer
  directory field, explicitly decide whether **agent disclosure is needed**, as
  is done for viewer delivery.
- MUST: Only `AgentsChannel` may subscribe directly to `agents:lobby` (#27).
  `WrapperChannel` broadcasts every envelope, including log/result tool I/O,
  in plaintext to that topic; `AgentsChannel.handle_out`
  (`sanitize_envelope_for/2`) applies role filtering per subscriber. Therefore,
  a process newly subscribing to that topic (a monitoring hook, future feature,
  or test) must apply an equivalent role gate at the subscriber. #27 evaluated
  a separate operator-only PubSub topic but rejected it because the current
  sole subscriber is `AgentsChannel` and there is no practical harm; this
  invariant substitutes for defense in depth.
- MUST: A wrapper does not change its `allowedTools` / `canUseTool` settings in
  response to a server instruction (the execution-capability ceiling is local
  configuration).
- MUST: Limit resume target session_id to one that exists beneath the cwd bound
  to that agent (reject resume to another cwd/arbitrary path,
  [ADR-0014](../adr/0014-session-resume-and-restore.md)).
- MUST: Deliver JSONL metadata when summoning a session only to the operator
  role.
- SHOULD: Separate operator tokens from viewer tokens and minimize their
  distribution.

### Session-reset control (`/new` / `/clear`, phase-17)

`session_reset` is a high-privilege operation through which an operator, or an
agent itself after per-request permission_broker approval, can forcibly restart
an agent's execution environment (fresh wrapper spawn + discarding the old
session; reapply model / effort / permission_mode / sandbox / network_access at
their final effective values from phase-15 D8). Because overuse can lose work
in progress or amount to DoS, **six layers of defense** protect the authority
boundary ([ADR-0036](../adr/0036-session-lifecycle-commands.md)).

- **Origin and approval verification**: An operator-originated
  `AgentsChannel.handle_in("session_reset", ...)` begins, as before, with
  `require_operator/1`, so a viewer is forbidden. An agent's own
  `WrapperChannel.handle_in("session_reset_request", ...)` affects only that
  agent bound to the wrapper topic and is sent only at completion of that turn,
  after per-request permission_broker approval for Claude's
  `request_session_reset` tool
  ([ADR-0043](../adr/0043-agent-initiated-session-reset.md)). There is no
  dedicated path originated by another agent.
- **Capability advertisement**: The wrapper adapter stamps
  `ext.session_capabilities.supports_session_reset` - `session_reset_modes`
  directly after spawn. An unstamped / false / true+empty modes value fails
  closed: the dashboard Composer intercept does not fire, and the server relay
  rejects with `unsupported_session_reset`. Engine-name testing is forbidden;
  the adapter's advertisement is SoT (inheriting
  [ADR-0034](../adr/0034-session-capabilities-advertisement.md) F2).
- **Host binding (exact match)**: In `RunnerChannel.session_reset_result`,
  require exact `AgentId.host_id_from(agent_id) == host_id`. This strictly
  inverse-computes ADR-0024 D3's `<host_id>.<rand>` allocation and prevents a
  **nested-prefix spoof** where a host_id containing a dot lets a different
  host's agent_id impersonate it through naïve `starts_with?`.
- **reserved_session_command rejection**: If an old / external client sends
  literal `/new` / `/clear` to `send_instruction`, the server handler rejects
  it loudly as `reserved_session_command` at its start and never passes it to
  the engine (defense in depth rather than relying only on client-side
  interception).
- **SessionResets pending lock**: `check_and_acquire/5` atomically verifies
  lock existence + KaoiroState (`idle`/`waiting_input`) - dispatch-cooldown in
  one `handle_call` (the TOCTOU core of ADR-0036 F6). While a reset is pending,
  reject instruction / set_model / set_effort / set_permission_mode /
  **resume_session** all with `session_reset_pending` (`resume_session` was
  added after race analysis during the 2026-07-12 ε implementation found it
  omitted from ADR-0036 F2's list). The two-second dispatch cooldown protects
  against asynchronous state-report lag (closing the race from instruction
  dispatch to the arrival of wrapper state_change).
- **Viewer information boundary**: Broadcasts of `session_reset_started` /
  `session_reset_completed` / `session_reset_failed` are operator-only through
  `intercept` + `handle_out` (the origin / reason of `session_reset_started`
  also does not reach viewers). On the viewer side, sanitize the
  `session_boundary` envelope payload to `{"mode"}` only (request_id /
  previous_session_id / to_session_id are invisible to viewers, inheriting
  [ADR-0021](../adr/0021-role-information-disclosure-policy.md) + ADR-0036 F3).

### Antigravity engine — the wrapper is the only enforcement point (phase-34)

The `antigravity` engine drives the `agy` CLI with the CLI's own approval
prompts disabled, because headless `agy` auto-denies anything that would
need a prompt and a PreToolUse hook cannot lift that denial
([ADR-0057](../adr/0057-antigravity-adapter.md) F4). Threat 1 (instruction
= remote tool execution) keeps its blast radius, but the mechanism that
bounds it moves entirely into the wrapper: unlike Claude (SDK `canUseTool`)
and Codex (an OS sandbox fixed at spawn,
[ADR-0033](../adr/0033-permission-model-dual-axis.md) F3), nothing behind
the wrapper will refuse a tool call. The layers below record what that
costs. Design decisions live in ADR-0057; boundary mechanics live in
[auth-and-authz](auth-and-authz.md).

- **The failure direction is inverted.** With prompts disabled, a hook that
  does not fire means unrestricted execution, not a denial. That is not
  hypothetical: the same hook configuration placed under the cwd's
  `.agents/` was measured **not** to fire, root cause unresolved
  ([antigravity-cli-events](antigravity-cli-events.md)). Every gate failure
  the wrapper can observe — socket error, wrapper deadline, malformed
  payload, missing nonce, hook connection closed before an answer — is
  answered `deny`. The one it cannot observe is the hook never running,
  which is what F4b exists to catch.
- **Gate self-verification detects; it does not prevent**
  (ADR-0057 F4b). A quota-free registration check runs before the first
  turn, and a correlation invariant runs on every tool call: a tool step
  reaching `DONE` or `ERROR` with no gate request observed for its step
  index terminates the child and freezes the session. Because the check is
  keyed on completion, the tool has already run when the violation is
  seen. It bounds how long an unenforced session continues, not whether
  the first unenforced call executes.
- **F4b is not an authorization boundary.** The per-spawn nonce and the
  correlation state are readable by any shell the agent obtains, so a
  misaligned or compromised agent can forge gate requests that satisfy the
  invariant. F4b covers a vendor mechanism that silently stops firing; it
  must never be cited as a defence against the model itself.
- **The sandbox axis is advisory, and the operator has to be told.**
  `--sandbox` was measured to have no effect (a write outside cwd and an
  outbound `curl` both succeeded), so `read-only` and `workspace-write`
  are enforced by wrapper argument inspection alone. A shell command
  approved under `workspace-write` can still write anywhere on the host.
  The envelope carries `ext.permission.enforcement = "advisory"` and the
  dashboard badges it permanently, so an identical-looking two-axis badge
  never implies the Codex guarantee
  ([ADR-0033](../adr/0033-permission-model-dual-axis.md) F1).
- **The bridge auto-allow is a convenience, not a boundary.**
  `run_command` executes through `bash`, so a prefix match on the bridge
  invocation is satisfied by `…; curl … | sh`. The gate instead
  whole-string matches a metacharacter-free alphabet and falls through to
  the ordinary operator round trip on any mismatch (ADR-0057 F5). The
  `ToolHost` socket itself is reachable from any shell the agent runs; it
  exposes only tools that agent already holds, so it grants no new
  capability, and the match protects the *auto-allow* from being widened
  by shell chaining, nothing more.
- **The customization dir is part of the trusted computing base.** It
  holds the gate configuration and the persona rules, is re-read on every
  per-turn spawn, and was measured to become a workspace root the model
  operates in. One write there would rewrite the gate for every later
  turn, so writes and shell referencing it are denied in every permission
  cell, and the wrapper rewrites the files from memory and verifies their
  hashes before each spawn (ADR-0057 F3 / F4).
- **Tool-input disclosure has a wider surface.** Threat 3 applies as
  before, with `toolCall.args` carrying the command line, absolute paths,
  `Cwd`, and the transcript path into the operator dialog unmasked
  (tool-input masking remains a future item in the table above).
- **The Q1 fallback is a host-wide downgrade, not a deployment note.** If
  the prompt disable cannot be scoped to the wrapper's own child process
  and no process-scoped settings path exists, the remaining route writes
  `toolPermission: "always-proceed"` into the host's own
  `~/.gemini/antigravity-cli/settings.json`. That removes approval prompts
  from the operator's personal interactive `agy` sessions as well, outside
  kaoiro's control and beyond its process lifetime. It needs an explicit
  operator decision recorded in [deployment](deployment.md); it is not a
  default and not a silent setup-wizard step.

## Open Questions

- Antigravity Q1 ([ADR-0057](../adr/0057-antigravity-adapter.md)) — whether
  the CLI's approval-prompt disable can be scoped to the wrapper's own child
  process. A host-wide fallback changes the operator's personal `agy`
  sessions on that host, so it is a change to this document rather than a
  deployment note.
- Audit logging and tool-input masking remain future items as shown in the
  table above.

## See Also

- Related specs: [protocol](protocol.md), [architecture](architecture.md)
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
- Boundary implementation map: [auth-and-authz](auth-and-authz.md)
