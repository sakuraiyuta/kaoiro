---
title: Claude Agent SDK to integrationapproach
status: accepted
date: 2026-06-04
opened: 2026-06-04
supersedes: []
superseded_by: null
related_specs: [architecture, plugin-model, protocol, agent-sdk-events]
related_adrs: [2, 14, 17]
---

# ADR 1 — adopt Claude Agent SDK to integrationapproach

## Status

Accepted

## Context

The method of observation and control of the CLI agent (Claude Code) was a problem. Terminal output
PTY Scrape with TUI escape. CLI Headless
(`claude -p --output-format stream-json`) can be observation, but one-shot.
Injection (hole 1) to the session and ex  routing of permission is weak. Contact
The surface of permission is required.

## Decision

Official wrapper**Claude Agent SDK**(TypeScript: `@anthropic-ai/
claude-agent-sdk`host

`SystemMessage`/`AssistantMessage`/`ResultMessage`
derive the state from.
- control (hole 1): Multi-turn control with resume / streaming input.
- permission: `PreToolUse`   / `canUseTool`
Contact Us

## Consequences

### Positive

- No need to integration or PTY for one in-process mechanism with observation, control and permission routing.
- Hole 1 (injection) is solved by the same mechanism.
- Turn permission approval to client UI.

### Negative

- The wrapper is limited to Python/TS. server(Elixir)
- Details of the SDK (Streaming input / `Query.interrupt()` / `canUseTool` return value)
  **d**([agent-sdk-events](../specs/agent-sdk-events.md), 2026-06 validation)

### Neutral

- The wrapper + client becomes the same language as the client.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| CLI stream-json |one-shot. permission is weak in theternal UI linkage only via MCP tool|
|PTY|TUI escape  ttle and unstable|
|portxir to port the CLI|in-process permission callback/multi-turn injection is not available|
