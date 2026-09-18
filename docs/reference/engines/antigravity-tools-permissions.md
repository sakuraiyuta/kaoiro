---
title: Antigravity tools and permissions reference
status: implemented
last_updated: 2026-09-18
description: The Antigravity hook gate, bridge authorization, advisory sandbox, non-interactive child policy, and runtime permission-switch contract.
---

# Antigravity tools and permissions reference

## Authorization boundary

Headless `agy` cannot obtain an interactive approval. The host creates a
private customization directory with a `PreToolUse` hook and checks the hook
registration through `agy -p /hooks` before a turn. The hook forwards tool
requests to the wrapper permission broker and fails closed if the socket,
payload, or reply cannot be proven valid.

The generated rule directs kaoiro tool use through the wrapper CLI bridge. A
`run_command` is auto-allowed only when its complete command line matches the
bridge grammar; arbitrary shell input is classified by the gate. The bridge
uses a per-agent private Unix socket and a per-spawn nonce. Native headless
MCP is not the bridge transport.

The gate is conservative. Read-only core utilities and a constrained set of
local Git observations can be automatically allowed in `local` approval
mode; unknown commands, shell expansions, remote Git commands, path escapes,
and tool classes outside the allowlist require approval. `.git` is a protected
write location, including paths that reach it through a symlink. The detailed
classifier is `wrapper/antigravity/src/gate.ts`; its allowlist is the canonical
implementation for individual command shapes.

## Non-interactive child policy

Every child receives `GIT_TERMINAL_PROMPT=0` and
`SSH_ASKPASS_REQUIRE=never`. Unless the operator already supplied
`GIT_SSH_COMMAND`, the host sets it to `ssh -o BatchMode=yes`; preserving an
operator value produces a launch warning. If `SSH_AUTH_SOCK` is present but
has no identities, the CLI warns that SSH Git operations will fail in batch
mode. These controls make credential and passphrase prompts fail fast; they
do not grant credentials or authorize a network operation.

The tool wall-clock deadline is a separate last-resort guard. Its exact
settings and terminal projection are in
[the event reference](antigravity-events.md#watchdog-contract).

## Sandbox is advisory

The Antigravity `sandbox` setting is represented in kaoiro state, but this
engine does not claim CLI sandbox enforcement. The effective enforcement point
is the wrapper's hook gate and permission broker. Operators must therefore
interpret `permission.enforcement: "advisory"` as a boundary statement, not as
a promise that `agy` blocks an operating-system escape.

## Runtime permission switching

The wrapper supports the common `set_permission` request with three axes:
`sandbox`, `network_access`, and `approval`. Existing `setPermissionMode`
requests are rejected in favour of this structured request. The initial
selection defaults to `workspace-write`, `on-request`, and network access
derived from the sandbox.

Runtime switching is advertised only when both conditions hold:

1. permission-sync negotiation with the server succeeded; and
2. the runner supplied every launch ceiling: `max_sandbox`,
   `max_network_access`, and `max_approval`.

The advertised `permission_switch_axes` contains the three maxima. Missing
sync or any missing maximum is fail-closed: the host advertises no permission
switch capability. The server clamps a request first; the host checks the
same ceiling again before accepting a control or its evidence. A value beyond
the ceiling leaves the current configuration intact and reports
`permission_failed` with `reason: "exceeds_launch_ceiling"` and
`rolled_back_to` equal to the current selection.

An accepted switch is staged and applied before the next turn's gate is
constructed. It never mutates the gate already serving a running child. The
host then reports `permission_applied`; Antigravity has no per-turn identity,
so that observation intentionally omits `turn_id` while retaining the session
and execution identities required by the common control contract.

## Recovery-oriented facts

If a switch remains pending, do not infer success from a CLI tool result.
Wait for the host's `permission_applied` or `permission_failed` observation.
For a tool prompt or a blocked child, recover through the operator permission
channel; do not attempt to enable a host-wide `agy` setting as a substitute
for the wrapper gate. A quota terminal projects as `rate_limit` and blocked
`seven_day` rate limit state; see
[the event reference](antigravity-events.md#rate-limit-projection).

## Related pages

- [Antigravity event reference](antigravity-events.md)
- [Antigravity adapter architecture](../../architecture/antigravity-adapter.md)
- [Permission protocol reference](../../specs/protocol.md)
