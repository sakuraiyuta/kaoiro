---
title: Grok Build as a resident ACP engine
status: accepted
date: 2026-10-14
related: [issue-589, issue-590]
---

# ADR-0067 — Grok Build as a resident ACP engine

## Decision

Add engine grok and package @kaoiro/grok. Keep one resident grok agent stdio
child and one ACP session per wrapper. Use SDK 1.8.0 through separable ACP
modules, native _meta.rules for persona/footer, and a stdio MCP bridge to
common tool handlers. Existing engines retain their hosts.

Declare unsupported operations explicitly. Normal peer delivery includes
confirmation; early/yield are none and reply-basis v1 is not negotiated.
Use the existing approval projection, with spawn-only, display-only permission
source metadata. Compatibility settings remain owned by the user settings.
OS sandbox pairs are Linux-only until other platforms are measured; off with
network on remains portable. Shutdown is bounded below the runner reset grace.

## Rationale

ACP provides resident conversation, cancellation and permission requests.
A new process per prompt loses those properties. One engine does not justify
a generic ACP framework; extract common ACP code when another engine uses it.
Metadata-only diagnostics prevent unknown SDK variants from leaking content.

## Consequences

Cold resume, history, catalog probing, context usage and live model/effort
switching belong to later work units. Individual Claude hooks and upstream
reports are outside this work. Production enabling requires operator approval.

## Amendment 2026-10-14: authenticated HTTP MCP

The tool transport above is no longer a stdio bridge. Under the `read-only`
sandbox profile Grok's seccomp filter denies `connect(2)` on `AF_UNIX` for its
child processes, so the bridge (a child) could not reach the ToolHost's unix
socket and a read-only peer started without kaoiro tools and without any
report ([issue #604](https://github.com/sakuraiyuta/kaoiro/issues/604)).
Grok reaches a `127.0.0.1` HTTP MCP server from its own process under every
profile, so `ToolHost` now serves HTTP with a per-run bearer token, a strict
`Host` and `Origin` check, and a startup that fails closed. The stdio bridge
and the unix socket are removed. See
[Tool transport](../reference/engines/grok-acp.md#tool-transport) and the plan,
[issue-604-grok-http-mcp-transport](../plans/issue-604-grok-http-mcp-transport.md).

## Amendment 2026-10-14: permission switching at the execution boundary

On Linux, negotiated permission sync allows sandbox and network changes
within the raw launch ceiling ([issue #591](https://github.com/sakuraiyuta/kaoiro/issues/591)).
One serialized lane retires the old process group, creates a new process
and HTTP ToolHost, loads the same session, and waits for authenticated tool
readiness before promoting the new generation. Replay callbacks cannot
produce live events or permission requests. Same-profile changes retain the
process and take effect at the next prompt boundary.

The server owns the next selection. A pre-application lane failure never
invents a rollback: when the failed selection was next, dispatch stops until
a valid server relay or sync restores it. The wrapper publishes the stop as
`ext.permission_gate`. A prompt result needs a native `promptId` to count as
an observation; without it, that selection is blocked. Approval remains
`on-request`, and mode switching remains unsupported. See the
[engine reference](../reference/engines/grok-acp.md) and
[dated measurements](../evidence/grok/2026-10-14-permission-switch.md).

## Shared ACP client and HTTP host

The second ACP engine uses the connection, session and authenticated HTTP
MCP host from agent-common. Each engine imports the relevant subpaths.
Grok retains its existing transport and question defaults. See the
[Grok ACP reference](../reference/engines/grok-acp.md#acp-module-boundary).
