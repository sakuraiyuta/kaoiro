---
title: Persona prompt injection — SDK systemPrompt.append + wrapper-bundled md
status: superseded
date: 2026-07-02
opened: 2026-07-02
supersedes: []
superseded_by: 29
related_specs: [persona-personality-injection, personas, threat-model]
related_adrs: [3, 6, 29]
---

# ADR-0026 — Persona Prompt Injection — SDK systemPrompt.append + Wrapper-Bundled md

## Status

Superseded by [ADR-0029](0029-persona-server-sot-and-pack-distribution.md) (2026-07-05). The injection method through SDK `systemPrompt.append` is retained, but the primary source of the personality prompt moves from wrapper-bundled md to a server-aggregated SoT, with delivery by a WS handshake push. The common footer’s composition also moves from the wrapper side to the server side.

The following is retained as historical background.

## Context

[personas](../specs/personas.md) has kept the personality of the persona sprites (ao/momo/kuroe), while explicitly treating conversation settings such as speech style and first person as out of scope because “there is currently no functionality to consume them.” Now that kaoiro has reached a dogfoodable stage, it is valuable to give runtime conversations a consistent character, so design a mechanism for injecting the personality description into the Claude Agent SDK.

The main design questions:

1. Injection path into the Claude Agent SDK (preset.append or complete replacement)
2. Storage method for the personality string (inline in config, external md reference, or bundled pack)
3. Contents and composition order of the common footer
4. Foundation for multilingual support
5. Handling the character-count limit

## Decision

- **D1 Injection method**: insert “personality description + common footer” into the SDK `systemPrompt: { type: 'preset', preset:
  'claude_code', append: ... }` `append`. Do not discard the preset and replace it with a custom string.
- **D2 Storage method**: **bundle** it in the wrapper repository as `wrapper/personas/<persona.id>.md`. If `config.persona.personality_prompt_file?` exists, use it as an override; otherwise resolve the bundled default (method γ2). Do not deliver it through the server.
- **D3 Common footer**: the contents and composition order were initially to be left to `persona-
  common-footer` as an open question (the provisional initial implementation hard-coded “one sentence recognising the environment,” equivalent to “this agent is operated through the kaoiro client”). This open question was merged into D5 of [ADR-0029](0029-persona-server-sot-and-pack-distribution.md) on 2026-07-05, and closed with the provisional policy confirmed as-is.
- **D4 Language**: add an optional `language?: string` field to Persona (default `"ja"` when unspecified). In phase-0, only read it and do not implement dispatch logic; track multilingual dispatch in [persona-language-dispatch](../open-questions/persona-language-dispatch.md).
- **D5 Character-count limit**: state a SHOULD guideline (200–1000 characters) in the spec. Do not impose a hard limit.
- **Inject only at wrapper startup**. Do not permit replacement mid-session. Do not provide an overwrite path from the server ([threat-model](../specs/threat-model.md) treats this like allowed_tools).
- **Do not expose it in envelopes**: do not put the personality string in state_change / log / result envelopes. IDs sent to the dashboard remain only `persona.id` / `persona.name` (canonical values from the pack, unchanged during the session). **A display name that can change while running is handled by a separate top-level `display_name` field** (issues #209 D19/D23)—consistent with this section’s intent not to make `persona.name` subject to renaming.

## Consequences

### Positive

- The same `persona.id` responds with the same sprites and speaking style across restarts, extending the identity persistence of [ADR-0003](0003-persona-identity-persistence.md) from appearance to behaviour.
- Because Claude Code preset tool-use etiquette and safety instructions are retained, side effects on existing behaviour are minimised.
- Personality descriptions can be managed in the wrapper repository, allowing prototypes and tuning without touching the server or dashboard. Iteration cost is low during dogfooding.
- Laying down the `language` field early avoids a type change when multilingual dispatch is added later.

### Negative

- The Claude Code preset instructions (conciseness, fact checking, etc.) can conflict with the personality description (speech-style overrides, etc.). Disambiguation remains only a SHOULD, and the operation waits until it becomes a problem.
- Because the personality string is bundled in the wrapper, the wrapper must be restarted for each personality update (no mid-session replacement).
- The common footer enters phase-0 with its contents still undecided, leaving the cost of replacing the provisional hard code later.

### Neutral

- The personality string is self-contained in the wrapper, so no schema changes are needed on the Envelope, server, or dashboard side. This does not break ADR-0003 (the server is agent-independent).
- The `default` persona has no personality description and receives only the common footer appended, symmetrically with the “default = no sprite, CSS face” default in personas.md.

## Alternatives Considered

### D1 Injection method

| Option | Why rejected |
|--------|--------------|
| B: Completely replace `systemPrompt` with a string | Would require recreating the large set of Claude Code preset tool-use etiquette and safety instructions; unrealistic at the dogfooding stage |
| C: Insert mid-session through a control message | The SDK has no such functionality (`systemPrompt` is effective only when a query starts) |

### D2 Storage method

| Option | Why rejected |
|--------|--------------|
| α: Inline in config JSON | JSON escaping creates friction when editing long text. Handling an md of several to dozens of lines as a JSON string is painful |
| β: Require an individual file reference in config | With no bundled default, the initial three instances would be “open the box and it does not work” |
| γ1: Deliver through server/priv | The server would become the primary source of the personality string, conflicting with the “cannot be overwritten from the server” policy |

### D4 Language

| Option | Why rejected |
|--------|--------------|
| η: Assume Japanese (make it an open question in the future) | It was the recommended option during consideration, but was rejected in favour of laying down a future-proof foundation first |
| ι: Decide nothing | Risk of implementation confusion: “Is it okay to write in Japanese?” |

### D5 Character-count limit

| Option | Why rejected |
|--------|--------------|
| μ: Error at a hard 8 KiB limit | Inconsistent with this scope’s policy of leaving disambiguation at SHOULD without pursuing it. Fail-fast can be added after it becomes a future problem |
| λ: No limit and no guideline | Provides insufficient guidance when writing the initial descriptions. Writing only a SHOULD guideline is enough |
