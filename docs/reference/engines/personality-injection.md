---
title: Personality-prompt injection by engine
description: How the wrapper passes the server-delivered personality prompt into each engine (Claude Code / Codex SDK options, Antigravity rules file), unmodified.
status: accepted
last_updated: 2026-09-21
related: [protocol]
---

# Personality-prompt injection by engine

### Injection into the SDK

Injection points differ by engine. Claude Code and Codex share that **the
wrapper only passes the received string through** and has no composition
logic; Antigravity prepends a fixed kaoiro preamble to the same string (see
below), and still never edits the string itself.

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

**Antigravity**: there is no SDK; the `agy` CLI reads always-on rules from
customization roots passed with `--add-dir`. `rulesText()` in
[`wrapper/antigravity/src/customization.ts`](https://github.com/sakuraiyuta/kaoiro/blob/develop/wrapper/antigravity/src/customization.ts)
writes `<customization dir>/.agents/rules/AGENTS.md` as a fixed kaoiro
preamble (working directory pinned to the agent cwd, the bridge command
contract, "never touch this directory") followed by a blank line and the
handshake prompt verbatim. The directory is a per-agent `mkdtemp` (0700),
rewritten from in-memory content before every spawn and SHA-256-verified
after writing and after every turn; a mismatch ends the session with
`antigravity_customization_tampered`
([ADR-0057](../../adr/0057-antigravity-adapter.md) F3). The persona pack
stays engine-independent; the preamble is the only Antigravity-specific text.

## Constraints

- MUST: Injection into Claude uses `append` in
  `systemPrompt: { type: 'preset', preset: 'claude_code', append: ... }`. Do
  not discard `preset` and replace it with a hand-built string. Codex uses
  `developer_instructions`.
- MUST: Injection into Antigravity goes through `rulesText()` in
  `customization.ts` only — the preamble precedes the prompt, the prompt is
  written unmodified, and no other file in the customization directory
  carries persona text.

## See Also

- [Persona delivery](../protocol/persona-delivery.md).
- [Personality-prompt injection (design)](../../architecture/personality-injection.md).
- [Personality configuration](../configuration/personality.md).
