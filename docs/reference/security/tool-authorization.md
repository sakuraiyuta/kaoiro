---
title: Tool authorization
status: accepted
last_updated: 2026-09-18
---

# Tool authorization

Related security topics: [Security boundaries](../../architecture/security-boundaries.md), [Security threat model](../../architecture/security-threat-model.md), [Authentication and authorization](authentication-authorization.md), [Security enforcement boundaries](enforcement-boundaries.md), [Security release audit](../../operations/security-release-audit.md).

The structural type for permission configurations is `PermissionConfiguration` in [@kaoiro/protocol](../../../protocol/src/index.ts). Per-engine inter-agent tool authorization remains in the [retained U15 sections](../../specs/auth-and-authz.md#tool-authorization--canusetool--permissionbroker).

### Tool authorization — canUseTool / PermissionBroker

- The wrapper's `Options.allowedTools` (`allowed_tools` in config) is the **ceiling**
  for SDK tool execution; server / client cannot extend it.

- Other tools flow through SDK `canUseTool` → `PermissionBroker.decide/2` → a
  `permission_request` envelope to the dashboard (operator-only), then an
  operator allows or denies (`permission_decision`, operator-only relay).

- Broker timeout is `permission_timeout_ms` in wrapper config; when unset it waits
  indefinitely (SDK default), avoiding accidental denial when no operator is
  present ([ADR-0022](../../adr/0022-pending-permission-authoritative-source.md)).

- Claude's tool ceiling remains `allowedTools` / `canUseTool`. Codex's selected
  sandbox/network policy may change through the operator-only `set_permission`
  control; approval stays `never`. Selection is not an immutable launch-time
  ceiling ([ADR-0033](../../adr/0033-permission-model-dual-axis.md) F3).
  Antigravity Stage B0 permission switching was implemented on 2026-09-18
  (`f1356d96`, permission sync in `9e1d9960`, reconnect ceiling check in
  `15cfd94a`). With all three launch ceilings and permission-sync support,
  sandbox / approval / network selections can change at the next execution
  boundary; the server and wrapper both enforce the launch ceilings
  ([ADR-0057](../../adr/0057-antigravity-adapter.md) F4c). The tool-class table
  remains fixed; each turn's gate captures the selected policy.

### Permission configuration control

`set_permission` requires a currently authorized operator/admin client socket.
Wrapper and runner credentials do not grant this operation. Resolve the actor
from the authenticated socket's user principal; never accept an actor, role, or
revision supplied in the command body. Audit records contain the principal ID,
not a token, cookie, or OAuth credential.

Server validation requires a connected current wrapper, advertised
`supports_permission_switch`, a known raw configuration baseline, valid fields,
and no pending session reset. Busy execution is allowed. The wrapper validates
the relayed configuration independently. Unsupported engines reject without
changing their configuration. Antigravity advertises switching only when all
three launch ceilings are present and permission sync is supported; legacy
configurations without that advertisement retain launch-fixed behavior.
Confirmation UI is not required for widening. Audit acceptance and observation
in the operator-only lifecycle
timeline; recording remains best-effort. See the complete
[permission contract](../../specs/protocol.md#permission-changes-at-an-execution-boundary).

### Antigravity gate socket and customization dir (phase-34)

**Status: implemented in phase-34 Stage A** — gate registration and completion
correlation were implemented on 2026-09-04 in `6d48eab5`.

For the `antigravity` engine the approval decision does not come from an SDK
callback. `agy` runs with its own prompts disabled and invokes a PreToolUse
hook per tool call, which adds an intra-host boundary between the engine
child and the wrapper ([ADR-0057](../../adr/0057-antigravity-adapter.md) F4).

| Boundary | Mechanism | Implementation | On failure |
|---|---|---|---|
| `agy` child → hook process | Hook registration in the wrapper-owned `.agents/hooks.json`, discovered through `--add-dir` | `wrapper/antigravity` customization-dir writer | Not registered → spawn fails with `antigravity_gate_not_registered`; hook exceeding the CLI `timeout` is killed and the tool call fails without running (measured) |
| hook process → wrapper | Per-agent unix socket inside a 0700 `mkdtemp` dir; per-spawn nonce carried in the hook's environment. Distinct from the `ToolHost` socket below — two sockets, two nonces, two protocols, so a shell that reaches the tool socket cannot answer gate questions | `hook.ts` → `gate.ts` | Socket error / wrapper deadline / malformed payload / missing nonce → `deny`; connection closed before an answer → the pending broker entry resolves as deny and `waiting_permission` is cleared |
| wrapper → operator | `PermissionBroker` → `permission_request` (operator-only) → `permission_decision` (operator-only relay) | shared with the Claude path above | unchanged |

- Each nonce rejects an unrelated same-uid process that guessed its socket
  path. Neither is a defence against the agent itself, whose shell
  inherits both socket paths and can read both nonces — which is why
  [threat-model](enforcement-boundaries.md#antigravity-engine--the-wrapper-is-the-only-enforcement-point-phase-34) records the gate self-verification as
  detection rather than authorization.
- The **execution-capability ceiling** for this engine is the wrapper's
  tool-class table plus the sandbox × approval × network cell matrix, not an
  SDK `allowedTools` list. It is local configuration and the server cannot
  widen it, exactly as the MUST below requires. The agent-internal tool class
  is denied unconditionally, and a tool name absent from the table is
  unclassified: denied under `approval: never`, escalated to the operator
  otherwise.
- kaoiro's own tool surface rides the `ToolHost` unix socket shared with the
  Codex adapter — a second socket, separate from the gate — invoked as a CLI
  through `run_command`. Its auto-allow is a whole-string
  match on a metacharacter-free alphabet (ADR-0057 F5). The socket is
  reachable from the agent's own shell and exposes only tools that agent
  already holds, so it is not a privilege boundary.
- The customization dir (persona rules + gate config) is wrapper-owned:
  0700 `mkdtemp`, rewritten from memory and hash-verified before every
  per-turn spawn, referencing writes and shell denied in every permission
  cell, deleted on close, with stale `kaoiro-agy-*` directories swept at
  startup after a SIGKILL.

## Constraints (MUST)

- MUST: State the execution-capability ceiling form for every engine recorded
  here (SDK allowlist / operator-selected OS policy / wrapper policy table).
  Distinguish a mutable selected policy from an immutable ceiling. An engine
  whose gate is enforced only by the wrapper must fail closed on a verification
  failure — there is no engine-side backstop to fall back on.
