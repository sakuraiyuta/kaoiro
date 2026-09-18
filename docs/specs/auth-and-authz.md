---
title: Authentication and authorization map
description: Current authentication and authorization boundaries for each kaoiro node (wrapper / runner / server / client). Starting point for the pre-OSS audit.
status: accepted
last_updated: 2026-09-18
related: [protocol, security-threat-model, architecture, protocol-inter-agent]
---

# Authentication and authorization map

This page preserves the original anchors; the moved sections are linked below.

The retained per-engine inter-agent tool authorization sections will move in U15.

## Purpose

Moved to [Security boundaries](../architecture/security-boundaries.md#purpose).

## Definition

Moved to [Security boundaries](../architecture/security-boundaries.md).

### Overall topology

Moved to [Security boundaries](../architecture/security-boundaries.md#overall-topology).

### Socket authentication (`server/lib/kaoiro_server/auth.ex`)

Moved to [Authentication and authorization](../reference/security/authentication-authorization.md#socket-authentication-serverlibkaoiro_serverauthex).

### Topic authorization (channel `join/3`)

Moved to [Authentication and authorization](../reference/security/authentication-authorization.md#topic-authorization-channel-join3).

### Three roles ([ADR-0050](../adr/0050-principal-model-and-graded-access-control.md) D2)

Moved to [Authentication and authorization](../reference/security/authentication-authorization.md#three-roles-adr-0050-d2).

### Role-based output gate ([ADR-0021](../adr/0021-role-information-disclosure-policy.md))

Moved to [Authentication and authorization](../reference/security/authentication-authorization.md#role-based-output-gate-adr-0021).

### Operator-only inbound (`handle_in`)

Moved to [Authentication and authorization](../reference/security/authentication-authorization.md#operator-only-inbound-handle_in).

### Operator-only HTTP endpoint (issue #232)

Moved to [Authentication and authorization](../reference/security/authentication-authorization.md#operator-only-http-endpoint-issue-232).

### Tool authorization — canUseTool / PermissionBroker

Moved to [Tool authorization](../reference/security/tool-authorization.md#tool-authorization--canusetool--permissionbroker).

- The default allow set (`READ_ONLY_TOOLS`,
  `wrapper/claude-code/src/read_only_tools.ts`) contains read-only tools (Read /
  Grep / Glob / LS / NotebookRead) plus side-effect-free inter-agent helpers
  `mcp__kaoiro__list_agents` / `mcp__kaoiro__whoami`. **Membership is a security
  decision, not a convenience**: omission is the per-use approval gate itself
  (`mcp__kaoiro__send_to_agent` / `request_compact` /
  `request_session_reset` are intentionally omitted).

- Codex has no canUseTool and auto-approves every kaoiro bridge tool
  (`default_tools_approval_mode: "approve"`), so a tool that needs per-use
  approval there asks on its own behalf: `operatorApprovalGated`
  (`wrapper/agent-common/src/approval_gate.ts`) calls the same
  `PermissionBroker.decide/3` from inside the MCP call and runs the wrapped
  handler only after allow. The wait is bound to the calling turn and capped
  at 300 s (ADR-0043, 2026-09-14 amendment). Currently gated this way:
  `request_session_reset`.

### Permission configuration control

Moved to [Tool authorization](../reference/security/tool-authorization.md#permission-configuration-control).

### MCP (`mcp__kaoiro__send_to_agent`)

- Inject the in-process MCP server from `wrapper/agent-common/src/inter_agent.ts`
  into the engine (Claude via `Options.mcpServers`, Codex via the tool-host bridge).
- `send_to_agent` is **not in the default allowedTools**, so it always goes through
  the broker. The colocated `list_agents` / `whoami` are read-only and therefore
  auto-allowed (the `READ_ONLY_TOOLS` set above).
- Routing uses the server's `route_inter_agent`; quotas use `ConversationStates`.
- Details: [protocol-inter-agent](protocol-inter-agent.md)

### Antigravity gate socket and customization dir (phase-34)

Moved to [Tool authorization](../reference/security/tool-authorization.md#antigravity-gate-socket-and-customization-dir-phase-34).

### Cookie / ticket sessions ([ADR-0013](../adr/0013-user-token-cookie-persistence.md))

Moved to [Authentication and authorization](../reference/security/authentication-authorization.md#cookie--ticket-sessions-adr-0013).

### OAuth login ([ADR-0042](../adr/0042-oauth-allowlist-login.md))

Moved to [Authentication and authorization](../reference/security/authentication-authorization.md#oauth-login-adr-0042).

### Two wrapper token paths

Moved to [Authentication and authorization](../reference/security/authentication-authorization.md#two-wrapper-token-paths).

## Known gaps (design choices and not yet addressed)

Moved to [Security boundaries](../architecture/security-boundaries.md#known-gaps-design-choices-and-not-yet-addressed).

## Constraints (MUST)

Moved to [Authentication and authorization](../reference/security/authentication-authorization.md#constraints-must).

Moved to [Tool authorization](../reference/security/tool-authorization.md#constraints-must).

- MUST: When injecting a new in-process MCP tool into the SDK, explicitly decide
  whether it belongs in default allowedTools (omitted = per-use approval;
  included = unsupervised).

## Release-time audit checklist

Moved to [Security release audit](../operations/security-release-audit.md#release-time-audit-checklist).

## See Also

Moved to [Security boundaries](../architecture/security-boundaries.md#see-also).
