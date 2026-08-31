---
title: treats fatigue as a persona modifier with protocol state and separation
status: accepted
date: 2026-08-21
opened: 2026-08-21
supersedes: []
superseded_by: null
related_specs: [persona-pack-schema, personas, protocol]
related_adrs: [29, 40]
---

# ADR 4 — treat fatigue as protocol state and parsona modifier

## Status

Accepted

## Context

issue #162 is an agent with a high context usage and an existing working state.
I want to show with a fatigue expression without changing the reading. `fatigued` to `state` vocabulary
Adding the wrapper, wrapper, and dashboard state transitions, existing expressions, and rolling
upgrade the upgrade compatibility. On the other hand, fatigue is important as `thinking` and `done`
not executionstate.

sprite of persona pack was only 7 state. pack with picture for fatigue
Unsupported pack andFace face fallback without breaking the unknown state id
is required.

Fatigue signal is `ext.context.used_percentage >= 60` in  with the predetermined P2/P4.
issue #254 returns `ext.context_budget.work_budget_percentage` to wire
This is the ratio of the soft work budget, and it is another thing from the initial fatigue signal.
Even if it changes in the future, make sure to dissipate the decision to the caller.

## Decision

`fatigued`**modifier**wire on
`state` does not appear `fatigued`, and `KnownState`/`expressionFor` vocabulary
Not added. dashboard keeps the original state as label/CSS variant,
Pass `fatigued` to the sprite solution only when fatigue, and `data-fatigued` to theFace face.
sprite itself does not stack sp modifier.

Fatigue judgment is closed to `isFatigued(envelope)`. At present
`supports_context_usage` is explicitly true and
`ext.context.used_percentage >= 60` Features
Fail-closed to false, missing, or non-numeric. More
Even if `work_budget_percentage` is changed to the judgment, the body of this function and its test
Change only.

Only `idle` and `waiting_input` are used to replace the fatigue sprite.
`disconnected`, while working, complete, and error keep the original state. `disconnected` Priority
`FATIGUE_ELIGIBLE_STATES` allowlist
permission issue #162 Deleting early return with mu  in implementation is green
Remove redundant early return with Note arbitration, and go toallowlist
TB-7 is red.

mana pack must be 7 state, plus optional sprite id
`fatigued` server must include 7 in s and required to
Verify both partial sets. `manifest.states`
SoT andthe relevant entryd `fatigued.png` missing, re-extract or reject pack as incomplete
Undeclared extra PNG does not appear in manifest. Unknown id is rejected.

`fatigued.png` is the responsibility of issue #163.
This decision defines schema, acceptance, and display path only.

## Consequences

- Unsupported pack uses an existing idle sprite fallback and default persona
Get minimal facial fatigue expression.
- wrapper context notice threshold and dashboard fatigue threshold are the same
60 But it is an independent constant of another host and another purpose, and it is not mutual derive.
- If you need to spread fatigue to state transition or chip/timeline,
set follow-up to determine the display scope.
