---
title: Antigravity adapter — Antigravity CLI (agy) headless event specification
description: Measured behaviour of the Antigravity CLI (`agy` 1.1.26) in headless print mode — stream-json events, resume, customization discovery, hooks-as-permission-gate, and their derivation to kaoiro state. Third engine counterpart to claude-events / codex-exec-events.
status: provisional
related: [protocol, plugin-model, architecture, claude-events, codex-exec-events]
---

# Antigravity adapter — Antigravity CLI (agy) headless event specification

Moved to [Antigravity adapter — Antigravity CLI (agy) headless event specification](../architecture/antigravity-adapter.md#antigravity-adapter).

## Purpose

Moved to [Purpose](../architecture/antigravity-adapter.md#purpose).

## Why the CLI and not the Python SDK

Moved to [Why the CLI, over ACP](../architecture/antigravity-adapter.md#why-the-cli-over-acp).

## Definition

Moved to [Definition](../reference/engines/antigravity-events.md#definition).

### Main API and process model

Moved to [Main API and process model](../reference/engines/antigravity-events.md#main-api-and-process-model).

### stream-json events (actual 1.1.26 shapes)

Removed with the stream-json host; the ACP updates are in [ACP updates and their classes](../reference/engines/antigravity-events.md#acp-updates-and-their-classes).

### State derivation

Moved to [State derivation](../reference/engines/antigravity-events.md#state-derivation).

### Permission (hooks are the approval channel)

Moved to [Permission (hooks are the approval channel)](../reference/engines/antigravity-tools-permissions.md#permission-hooks-are-the-approval-channel).

### Tool children: prompts disabled, absolute tool deadline (issue #350)

Moved to [Tool children: prompts disabled, absolute tool deadline (issue #350)](../reference/engines/antigravity-tools-permissions.md#tool-children-prompts-disabled-absolute-tool-deadline-issue-350).

### Customization discovery (persona, hooks, skills)

Moved to [Customization discovery (persona, hooks, skills)](../evidence/antigravity/cli-contract.md#customization-discovery-persona-hooks-skills).

### MCP is not available in headless mode

Moved to [MCP is not available in headless mode](../evidence/antigravity/cli-contract.md#mcp-is-not-available-in-headless-mode).

### Tool definition (CLI bridge over the wrapper tool host)

Removed with the CLI bridge; the kaoiro tools are in [kaoiro tools](../reference/engines/antigravity-tools-permissions.md#kaoiro-tools).

### System-prompt equivalent (persona personality injection)

Moved to [System-prompt equivalent (persona personality injection)](../architecture/antigravity-adapter.md#system-prompt-equivalent-persona-personality-injection).

### Session / conversation resume and enumeration

Moved to [Session / conversation resume and enumeration](../reference/engines/antigravity-events.md#session--conversation-resume-and-enumeration).

### Models, effort, usage, rate limits

Moved to [Models, effort, usage, rate limits](../reference/engines/antigravity-events.md#models-effort-usage-rate-limits).

### Authentication and host requirements

Moved to [Authentication and host requirements](../reference/engines/antigravity-events.md#authentication-and-host-requirements).

## Constraints

Moved to [Constraints](../reference/engines/antigravity-tools-permissions.md#constraints).

## See Also

Moved to [See Also](../architecture/antigravity-adapter.md#see-also).
