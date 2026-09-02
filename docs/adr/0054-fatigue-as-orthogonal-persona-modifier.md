---
title: Treat fatigue as a persona modifier separate from protocol state
status: accepted
date: 2026-08-21
opened: 2026-08-21
supersedes: []
superseded_by: null
related_specs: [persona-pack-schema, personas, protocol]
related_adrs: [29, 40]
---

# ADR-0054 — Treat fatigue as a persona modifier separate from protocol state

## Status

Accepted

## Context

Issue #162 requests showing an agent with high context usage through a fatigued
expression without reinterpreting its existing runtime state. Adding
`fatigued` to the protocol's `state` vocabulary would involve wrapper,
server, and dashboard state transitions, existing expression coverage, and rolling
upgrade compatibility. Fatigue, on the other hand, is not an execution state
that is exclusive with `thinking` or `done`.

Persona packs previously had only the seven required states. We need to accept
packs that have a fatigue image without breaking unsupported packs or the CSS
face fallback, while not allowing unknown state IDs.

Following the prior decisions P2/P4, the fatigue signal is
`ext.context.used_percentage >= 60`. Issue #254 later added
`ext.context_budget.work_budget_percentage` to the wire, but that is the
soft work-budget ratio and is a different thing from the original fatigue
signal. Even if the choice between them changes in the future, the judgment
must not be scattered among callers.

## Decision

`fatigued` is an **orthogonal modifier, not a protocol state**. `fatigued`
does not appear in the wire `state`, nor is it added to the vocabulary of
`KnownState` / `expressionFor`. The dashboard keeps the original state
as the label and CSS variant, but passes `fatigued` to sprite resolution only
when fatigued and adds `data-fatigued` to the CSS face. Do not layer a CSS
modifier on the sprite itself.

Fatigue detection is confined to one function, `isFatigued(envelope)`.
At present it returns true only when capability
`supports_context_usage` is explicitly true and finite
`ext.context.used_percentage >= 60`. Missing or false capability,
missing context, and non-numeric values fail closed to false. If a future
decision adopts `work_budget_percentage`, replace only this function's body
and its tests.

Only `idle` and `waiting_input` are eligible for replacement by a
fatigue sprite. `disconnected`, working, done, and error retain their original
state. Do not add a separate early return for `disconnected`; use the
`FATIGUE_ELIGIBLE_STATES` allowlist as the sole decision mechanism. During
the implementation of issue #162, a mutation that deleted the early return
remained green, so the redundant early return was removed by こはく's decision,
and it was confirmed that a mutation mixing `disconnected` into the allowlist
makes TB-7 red.

A persona pack may declare the allowlisted optional sprite ID
`fatigued` in addition to the seven required states. The server validates
both inclusion of the seven required states and subset membership in required ∪
optional. Collection and cache-completeness checks use `manifest.states` as
the SoT: if the declared `fatigued.png` is missing, the pack is incomplete
and is re-extracted/rejected; extra undeclared PNGs are not exposed through the
manifest. Unknown IDs are rejected.

Generating `fatigued.png` and its provenance for actual personas belongs to
issue #163. This decision defines only the schema, acceptance, and display paths.

## Consequences

- Unsupported packs use the existing idle-sprite fallback, while the default
  persona gets a minimal fatigue expression through the CSS face.
- The wrapper's context-notice threshold and the dashboard's fatigue threshold
  are both 60, but they are independent constants on separate hosts for
  separate purposes and are not derived from each other.
- If fatigue must be extended to state transitions or chips/timeline, decide
  the display scope separately in a follow-up.
