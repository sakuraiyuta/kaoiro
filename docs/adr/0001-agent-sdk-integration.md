---
title: Adopt Claude Agent SDK as the integration approach
status: accepted
date: 2026-06-04
opened: 2026-06-04
supersedes: []
superseded_by: null
related_specs: [architecture, plugin-model, protocol, agent-sdk-events]
related_adrs: [2, 14, 17]
---

# ADR-0001 — Adopt Claude Agent SDK as the Integration Approach

## Status

Accepted

## Context

The means of observing and controlling CLI agents (Claude Code) was a problem.
Scraping terminal output via PTY is brittle because of TUI escapes. The CLI
headless mode (`claude -p --output-format stream-json`) allows observation but
is one-shot; the injection of instructions into a running session (hole 1) and
the external routing of permission approvals are weak. A surface that could handle
observation, control, and permissions in a single mechanism was needed.

## Decision

The wrapper will host the official **Claude Agent SDK** (TypeScript: `@anthropic-ai/
claude-agent-sdk`).

- Observation: Derive state from typed message sequences
  (`SystemMessage`/`AssistantMessage`/`ResultMessage`).
- Control (hole 1): Multi-turn control through session resume / streaming
  input.
- Permissions: Hold approvals with `PreToolUse` hooks / `canUseTool` callbacks
  and route them to the external UI.

## Consequences

### Positive

- Observation, control, and permission routing are integrated into a single
  in-process mechanism, eliminating the need for PTY.
- Hole 1 (instruction injection) is resolved by the same mechanism.
- It is type-safe, and permission approvals can be routed to the client UI.

### Negative

- The wrapper is limited to Python/TS (Elixir cannot be used). This results in
  a two-language configuration with the server (Elixir).
- The SDK details (streaming input / `Query.interrupt()` / `canUseTool` return
  values) are **confirmed** ([agent-sdk-events](../specs/agent-sdk-events.md),
  verified in 2026-06).

### Neutral

- Since the client is also TS, the wrapper and client use the same language.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| CLI stream-json | One-shot. Permissions are available only through MCP tools, making external UI integration weak |
| PTY scraping | Brittle due to TUI escapes, with unstable parsing |
| Launching the CLI as a port from Elixir | In-process permission callbacks / multi-turn injection are unavailable |
