---
title: Personality Prompt Injection — SDK systemPrompt.append + wrapper included md
status: superseded
date: 2026-07-02
opened: 2026-07-02
supersedes: []
superseded_by: 29
related_specs: [persona-personality-injection, personas, threat-model]
related_adrs: [3, 6, 29]
---

# ADR-0026 — Personality Prompt Injection — SDK systemPrompt.append + wrapper included md

## Status

Superseded by [ADR-0029](0029-persona-server-sot-and-pack-distribution.md)
(2026.-05). Injected approach via the SDK `systemPrompt.append` is inherited,
First source of personality prompts from wrapper included md to server aggregate SoT
Changed the delivery to the push of the WS hand shake. Common footer
wrapper to server.

The following remains as historical circumstances:

## Context

[personas](../specs/personas.md) is the personality of a persona standing picture (ao/momo/kuroe)
Although it has been retained, the conversation setting such as the tone and the first person is "not in the current specification that you consume"
For this reason, it was explicitly non-objected. Kaoiro is dogfooding at the possible stage
Because it has a value that can be consistent with the conversation at the time of entry and exercise,
Design a mechanism to inject personality descriptions into the Claude Agent SDK.

Main design:

Claude Agent SDK
2. Personality string storage approach(written in config, see ex  md, or pack included)
3. The contents and   order of common footer
4. Multi-language base
5. Handling upper limit of characters

## Decision

- **D1 Injection approach**SDK`systemPrompt: { type: 'preset', preset:
  'claude_code', append: ... }`Home`append`In "personality description + common footer"
Contact Us Don't discard the preset and replace it with your own string.
- **D2 Stored approach**: `wrapper/personas/<persona.id>.md`
as****`config.persona.personality_prompt_file?`
Then override, if not, solve the included default (γ2 approach). via server
Do not distribute.
- **D3 Common footer**: Initially open-question`persona-
  common-footer`(Initial implementation provisional policy is "environment recognition 1 sentence"
(This agent is operated over the kaoiro client)
hardcode). This open-question is 2026 -05
[ADR-0029](0029-persona-server-sot-and-pack-distribution.md) D5
merged and closed as the provisional policy.
- **D4 Language**: Add `language?: string` field to Persona (not specified)
`"ja"` default). The dispatch logic is not included in phase-0.
Multilingual dispatch [persona-language-dispatch](../open-questions/persona-language-dispatch.md)
Contact Us
- **D5 Maximum number of characters**:Please specify SHOULD (200-1000 characters) in . hard upper limit
Not set.
- **Infusion only when wrapper is launched**Home mid-session server
No overwrite routes ([threat-model](../specs/threat-model.md))
allowed tools
- **Envelope Non Exposure**: Change the character string to state change / log / result envel
Not available. dashboard ID is `persona.id` / `persona.name`
only (pack-derived canonical, session-invariant). **Change in operation
`display_name` field
D19/D23) — `persona.name` itself is not subject to rename
Consistent with the purpose of

## Consequences

### Positive

- The same `persona.id` responds with the same stand-up + the same tone
[ADR-0003](0003-persona-identity-persistence.md)
Persistents are extended from the appearance to the behavior.
- Claude Code preset tool
Minimal side effects on behavior.
- Personality descriptions can be managed in the wrapper repository without touching the wrapper/dashboard
Prototype and adjustment can be rotated. low repetition cost of the dogfooding phase.
- Adding a `language` field to your next multilingual dispatch
There is no need to change the type.

### Negative

- Claude Code preset instructions (simplicity, fact confirmation, etc.) and personality descriptions (simplicity, overwriting, etc.)
where to compete. SHOULD

- wrapper restarts each time the personality update is included with the wrapper
(mid-session)
- In order to enter phase-0, the contents of common footer remain undecided,
The cost of replacement is left.

### Neutral

- The character string is complete within the wrapper, and the Envel ,  , and dashboard side.
No need to change schema. ADR.3
- `default` The persona does not have a personality description, and only the common footer is appended.
personas.md's "default = without standing painting /Face face" default and Namemetrical handling.

## Alternatives Considered

### D1 Injection approach

| Option | Why rejected |
|--------|--------------|
| B: `systemPrompt`string|Claude Code preset has a large amount of tool required to make use of manners and safety instructions, and it is non-realistic at the dogfooding stage|
|C: Insert mid-session with control message|No SDK`systemPrompt`query)|

### D2 Stored approach

| Option | Why rejected |
|--------|--------------|
|α: config JSON|JSON escaping is a friction between dogfooding. It is  cy to treat a few lines to tens of lines of md in JSON|
|β: config requires individual file reference|Initial 3 bodies are "not working when opening the box" because there is no included default|
|γ1: Deliver via server/priv|The server will be the primary source of the personality string, and it will collide with the "Unable to overwrite from the command line" policy|

### D4 Language

| Option | Why rejected |
|--------|--------------|
|η: Japanese assumption fixing (in the future open-question)|It was a recommendation at the time of review, but I was not allowed to lay future-proof first|
||Implementing maze risk of "wHome to write in Japanese?"|

### D5 Maximum number of characters

| Option | Why rejected |
|--------|--------------|
|μ: Hard Up to 8KiB error|SHOULD Do not align with this scope policy which does not pursue the possibility of distinguishing by the approach. fail-fast should be a problem in the future|
|λ: No upper limit, no indication|Insufficient guidance during initial writing. SHOULD|
