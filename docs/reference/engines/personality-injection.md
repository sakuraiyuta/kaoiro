---
title: Personality-prompt injection by engine
description: How the wrapper passes the server-delivered personality prompt into each engine (Claude Code SDK options / Codex app-server thread parameters / Antigravity and Grok ACP `session/new` metadata), unmodified.
status: accepted
last_updated: 2026-11-24
related: [protocol]
---

# Personality-prompt injection by engine

## Injection into the engine

Injection points differ by engine. Every engine shares that **the wrapper
only passes the received string through** and has no composition logic.

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

**Codex**: Pass the same string as `developerInstructions` in app-server
thread start/resume parameters. Codex has no concept equivalent to a preset.
See the [app-server session contract](codex-app-server-session.md).

**Antigravity**: Pass the same string as `_meta.antigravity.systemPrompt.append`
on the ACP `session/new` request (`wrapper/antigravity/src/generation.ts`).
`session/resume` does not resend it; a resumed session keeps the prompt it was
created with. The per-agent customization directory carries only the hook
registration, not persona text.

**Grok**: Pass the same string as `_meta.rules` on the ACP `session/new`
request (`wrapper/grok/src/grok/wire.ts`).

## Constraints

- MUST: Injection into Claude uses `append` in
  `systemPrompt: { type: 'preset', preset: 'claude_code', append: ... }`. Do
  not discard `preset` and replace it with a hand-built string. Codex uses
  `developerInstructions`.
- MUST: Antigravity and Grok receive the prompt unmodified in the
  `session/new` metadata, and no file in the Antigravity customization
  directory carries persona text.

## See Also

- [Persona delivery](../protocol/persona-delivery.md).
- [Personality-prompt injection (design)](../../architecture/personality-injection.md).
- [Personality configuration](../configuration/personality.md).
