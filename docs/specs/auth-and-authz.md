---
title: Authentication and authorization map
description: Current authentication and authorization boundaries for each kaoiro node (wrapper / runner / server / client). Starting point for the pre-OSS audit.
status: accepted
last_updated: 2026-09-19
related: [protocol, security-threat-model, architecture, protocol-inter-agent]
---

# Authentication and authorization map

This page preserves the original anchors; the moved sections are linked below.

The per-engine inter-agent tool authorization sections moved to [Inter-agent tool authorization](../reference/security/inter-agent-tool-authorization.md).

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

Moved to [Inter-agent tool authorization](../reference/security/inter-agent-tool-authorization.md#default-allow-set-and-per-engine-approval-gates).

### Permission configuration control

Moved to [Tool authorization](../reference/security/tool-authorization.md#permission-configuration-control).

### MCP (`mcp__kaoiro__send_to_agent`)

Moved to [Inter-agent tool authorization](../reference/security/inter-agent-tool-authorization.md#mcp-mcp__kaoiro__send_to_agent).

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

Moved to [Inter-agent tool authorization](../reference/security/inter-agent-tool-authorization.md#constraints-must).

## Release-time audit checklist

Moved to [Security release audit](../operations/security-release-audit.md#release-time-audit-checklist).

## See Also

Moved to [Security boundaries](../architecture/security-boundaries.md#see-also).
