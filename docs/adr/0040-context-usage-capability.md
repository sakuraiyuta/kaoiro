---
title: Context-window Use volume display to function driven and not  Code of Codex
status: accepted
date: 2026-07-16
opened: 2026-07-16
supersedes: []
superseded_by: null
related_specs: [protocol, plugin-model, agent-sdk-events, codex-sdk-events]
related_adrs: [21, 22, 32, 34, 35, 37, 39]
---

# ADR-0040 — Do not use context-window usage display to driven and  Code of Codex

## Status

Accepted (2026-16-16, Master Resolution → Fuji orchestration).
[phase-21-context-usage-capability](../plans/phase-21-context-usage-capability.md).

## Context

`ext.context` (`{used_tokens, max_tokens, used_percentage}`) is #16
Claude Code adapter derives from `Query.getContextUsage()` and stamps
Home `AgentDetail.svelte` `ctx` lines to placeholders to reach the SDK response
Fixed display of "acquired after initial response".

The following breakdown was confirmed in Fuji review (2026 -16, conversation `f4834340`):

1. **Codex Agent**codex adapter
`docs/specs/codex-sdk-events.md` L84
The implementation is only dead `threadEventToUsage`
It was not called once. The UI side does not include the engine name.
ed, and continued to deceive the operator.
2. Re  `turn.completed.usage.input_tokens` as
semantic defence**: (a) per-turn Not cumulative,
(b) to reduce the usage rate to the compaction method,
(c) `max_tokens`
There is no route (no `context_window` field in static catalog).
3. **Claude side trigger poor**`SDKResultMessage`
fire-and-forget calls `getContextUsage()` to switch init  /model
It was not called. The meter after init remains empty until the first result.
4. **UI doesn't see the engine name**: ADR-0034 F3
"Function Availability is determined by the capability field, and it is not judged by the   name."
context display

The corresponding direction is determined by the master decision, and the skeletal + details have been confirmed in subsequent reviews.
This ADR defines the decision.

## Decision

### D1. Capability-only gating

`ext.session_capabilities.supports_context_usage: boolean` with optional
Add the UI to determine the following:

- **absent**non-display (rolling upgrade)
prevent; do not confuse absent and `false`)
- **explicit `false`**(adapterJapanese terms non-response) → "unsupported" display
- **explicit `true`**+ `ext.context` Unarrival → "Acquired" placeholder
- **explicit `true`**+ `ext.context` Arrival → Existing meter

engine name (`ext.engine`) is not used for context display judgment
(ADR-0034 F3 Compliance)

### D2. Claude adapter is capability=true + trigger extension

- stamp `supports_context_usage: true` with `initialStatusExt()`.
- `#refreshContextUsage()` trigger:
  - **init  **: New `#refreshContextUsageForInit()` in initial + 1 retry
.ms backoff) transient race to reach re t
not empty the meter. bounded retry.
  - **Result**: Keep existing fire-and-forget.
  - **after model switch**: `#contextGeneration` bump + `#context = null` +
async re-fetch.lele snapshot
not allowed.
- Guards:
  - **inflight guard**(`#contextInflight`): coalesce trigger trigger.
  - **pending re-run**(`#contextRefreshPending`): caller dropped with guard
`finally` Notllll until the next natural trigger.
  - **generation guard**(`#contextGeneration`): model switch in-flight
refresh is destroyed by a mismatch. Fresh generation
refresh is automatically re-kicked with `finally`.
  - **dedup**: Excess state change without calling `emitState`

  - **close guard**: Don't kick again after `close()`.
`#statusExt`
Maintenance (the result of Fuji review S7).

### D3. Codex adapter does not pass capability=false +

- stamp `supports_context_usage: false` with `initialStatusExtFromCatalog`.
- `ext.context` is absolutely not stamped.
- substitute `turn.completed.usage.input_tokens` as   context
The proposal does not adopt based on M-A (semantics defence, above Context § 2).
- Supported `threadEventToUsage` helper and export,
dead code.
- Upstream Codex compaction telemetry (`token_count` event, etc.)
If confirmed, the ADR is supersede and the exact route will be considered.
Not supported by grep 0.

### D4. Wire schema

- Added `SessionCapabilitiesExt.supports_context_usage?: boolean`
(protocol/src/index.ts). The same open-schema extension as the existing 5 field.
`ext.context`
`used_percentage`)**No change**Home Backward compatibility.
- framexir (`wrapper_channel.ex` frame inspection / `agents_channel.ex`)
viewer secrecy) does not change to treat ext to opaque. Existing viewer hidden test
(`agents_channel_test.exs:1041-1085`) is non-re  with shape change.

### D5. Spec docs

- `docs/specs/protocol.md` Session capabilities section of L134-145
`supports_context_usage`
- `docs/specs/plugin-model.md` L32-37 with codex
ADR-0040
- `docs/specs/codex-sdk-events.md` L48 (`usage` field description) and L84
"usage (tokens) is reflected in ext" from (`turn.completed` → statederive)
Remove and switch to capability .

### D6. spike completed / Unverified items

`getContextUsage()` `sdk.d.ts:2378, 2985-`:

- signature: `Query.getContextUsage(): Promise<SDKControlGetContextUsageResponse>`
- response shape: `totalTokens / maxTokens / rawMaxTokens / percentage /
  model / categories[]` etc
- From the `initialize` control response of the SDK via control request
transport

'init   (turn 0) returns `totalTokens > 0`'
Not real system prompt + tools + MCP + memory files
d.ts / sdk source
Not possible. The reverification of the actual machine dogfood is done separately after phase-21 completion. failure
The behavior is crushed as the best-effort, and the UI stays gish as "in acquisition"
(M-A, Fuji review turn-3)

## Consequences

### Good impact

- The ctx line of the codex agent is displayed correctly with "unsupported" and does not deceive the operator.
- The old wrapper of rolling upgrade does not cause false information (absolute hide).
- Claude init trigger + bounded retry
UX Default.
- Ability-only gating is established and UI modification is unnecessary when capability is added.

### Cost

- Adding a Claude adapter trigger increases the SDK control request
1-2 times + 1 time per model switch). Inflight guard + dedup prevents waste ignition.
- The ctx line disappears while the old wrapper is running → the operator has a temporary UX difference. However,
Rolling upgrade
- Codex's future compaction telemetry support is an additional cost to revisit this ADR.

### Out of scope

- Exact `token_count` event on codex side rollout
path to projection. Current status   Not confirmed.
- Manual refresh path for context usage (current fire-and-forget only). UI
The request to add the refresh button is out of scope phase-21 (Fuji review S10).
- envel  contract test / JSON schema introduced. scope For expansion
(Fuji review O11)

## References

- Original conversation: `f4834340` (kuroe ↔ Home kickoff), `fb40967b` (implementation orch)
pending-permission authoritative source
Example of pattern)
- ADR-0034 F3: Principle that does not use the engine name to determine function availability
- ADR-0037 F6: bounded retry + pattern state flag pattern
- Wire spec: [protocol](../specs/protocol.md) L134-145
- Plugin routing: [plugin-model](../specs/plugin-model.md) L32-37
- Codex event contract: [codex-sdk-events](../specs/codex-sdk-events.md) L48, event
- Implementation plan: [phase-21-context-usage-capability](../plans/phase-21-context-usage-capability.md)
