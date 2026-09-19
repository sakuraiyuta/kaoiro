---
title: Personality-prompt injection by engine
description: How the wrapper passes the server-delivered personality prompt into each engine SDK, unmodified.
status: accepted
last_updated: 2026-09-19
related: [protocol]
---

# Personality-prompt injection by engine

### Injection into the SDK

Injection points differ by engine, but both share that **the wrapper only passes
the received string through** and has no composition logic.

**Claude Code**: The Claude Agent SDK's `systemPrompt` accepts
`{ type: 'preset', preset: 'claude_code', append?: string }`. Put the prompt
string received in the handshake directly into `append`.

```typescript
systemPrompt: {
  type: 'preset',
  preset: 'claude_code',
  append: promptFromHandshake,   // personality + footer already combined server-side
}
```

`preset: 'claude_code'` preserves the tool-use practices and safety
instructions equivalent to Claude Code. The personality description is an
appendage at its end and does not replace the preset.

**Codex**: Put the same string into a developer-role message as
`developer_instructions` in per-run configuration
([ADR-0032](../../adr/0032-codex-adapter.md) F3, confirmed by live observation on
2026-07-10). Codex has no concept equivalent to a preset.

## Constraints

- MUST: Injection into Claude uses `append` in
  `systemPrompt: { type: 'preset', preset: 'claude_code', append: ... }`. Do
  not discard `preset` and replace it with a hand-built string. Codex uses
  `developer_instructions`.

## See Also

- [Persona delivery](../protocol/persona-delivery.md).
- [Personality-prompt injection (design)](../../architecture/personality-injection.md).
- [Personality configuration](../configuration/personality.md).
