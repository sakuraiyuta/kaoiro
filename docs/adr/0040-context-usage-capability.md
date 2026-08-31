---
title: Make context-window usage display capability-driven without projecting estimated Codex usage
status: accepted
date: 2026-07-16
opened: 2026-07-16
supersedes: []
superseded_by: null
related_specs: [protocol, plugin-model, agent-sdk-events, codex-sdk-events]
related_adrs: [21, 22, 32, 34, 35, 37, 39]
---

# ADR-0040 — Make context-window usage display capability-driven without projecting estimated Codex usage

## Status

Accepted (2026-07-16, decision by マスター → orchestration by 藤). Implementation is
[phase-21-context-usage-capability](../plans/phase-21-context-usage-capability.md).

## Context

`ext.context` (`{used_tokens, max_tokens, used_percentage}`) was derived by the
Claude Code adapter from `Query.getContextUsage()` for #16 and stamped into the
state. The `ctx` row in `AgentDetail.svelte` displayed the fixed placeholder
「初回応答後に取得」 until the SDK response arrived.

The following failures were confirmed in the 藤 review (2026-07-16,
conversation `f4834340`):

1. **Permanent spinner on Codex agents**: The Codex adapter had no path that
   stamped `ext.context` (the docs at `docs/specs/codex-sdk-events.md` L84 said
   that the wrapper reflected it, but the implementation only had the dead
   `threadEventToUsage` and was never called from the host). The UI kept showing
   「初回応答後に取得」 without an engine-name branch, continuing to mislead the
   operator.
2. **Using `turn.completed.usage.input_tokens` as an estimate is a semantic
   failure**: (a) it is per-turn input only, not cumulative context, (b) it
   decreases immediately after compaction and therefore reports the false
   information that usage has gone down, (c) it excludes reasoning / output
   tokens, and (d) there is no path for `max_tokens` (the static catalog also has
   no `context_window` field).
3. **Weak trigger on the Claude side**: Previously, `getContextUsage()` was
   called fire-and-forget only when an `SDKResultMessage` arrived; it was not
   called immediately after init or immediately after a model switch. The meter
   remained empty after init until the first result arrived.
4. **The contract that the UI does not inspect engine names was not established**:
   context display alone did not follow ADR-0034 F3's rule that “feature
   availability is determined by a capability field, never by engine name.”

The direction of the response was decided by マスター, and the skeleton and
details were finalized in subsequent reviews. This ADR records that decision.

## Decision

### D1. Capability-only gating (no engine-name branch)

Add optional `ext.session_capabilities.supports_context_usage: boolean`, and have
the UI make the following determinations from this field alone:

- **absent** (old wrapper) → hide the ctx row (to prevent misleading information
  during rolling upgrade; do not conflate absent with `false`)
- **explicit `false`** (adapter declares that it is unsupported) → display
  “unsupported”
- **explicit `true`** + `ext.context` not yet received → display the “loading”
  placeholder
- **explicit `true`** + `ext.context` received → existing meter

Do not use the engine name (`ext.engine`) in context display decisions in UI code
(comply with ADR-0034 F3).

### D2. Claude adapter sets capability=true and expands triggers

- Stamp `supports_context_usage: true` in `initialStatusExt()`.
- Triggers for `#refreshContextUsage()`:
  - **Immediately after init**: use the new `#refreshContextUsageForInit()` for
    the initial attempt plus one retry (100ms backoff). Do not give up on the
    init-time fetch because of a transient race, and do not leave the meter empty
    until a result arrives. The retry is bounded and does not cross close / a
    generation boundary.
  - **Every result**: keep the existing fire-and-forget behavior.
  - **After a successful model switch**: bump `#contextGeneration`, set
    `#context = null`, and asynchronously re-fetch. Since `max_tokens` can differ
    between models, do not accept a stale snapshot.
- Guards:
  - **inflight guard** (`#contextInflight`): coalesce concurrent triggers.
  - **pending re-run** (`#contextRefreshPending`): a caller dropped by the guard
    automatically kicks again in `finally`. It does not stall until the next
    natural trigger.
  - **generation guard** (`#contextGeneration`): discard an in-flight refresh
    during a model switch when the captured generation mismatches. The fresh
    generation's refresh automatically kicks again in `finally`.
  - **dedup**: when the value is identical to the previous one, do not call
    `emitState` and do not emit an unnecessary state_change.
  - **close guard**: do not kick again after `close()`.
- Keep the existing lazy stamp of `#statusExt` on every state_change as the
  authoritative stamp (do not touch the rate_limits / cost conventions; this is
  the result of the 藤 review S7 decision).

### D3. Codex adapter sets capability=false and does not project estimates

- Stamp `supports_context_usage: false` in `initialStatusExtFromCatalog`.
- Never stamp `ext.context`.
- Do not adopt the proposal to substitute `turn.completed.usage.input_tokens` as
  estimated context based on M-A (semantic failure, Context §2 above).
- Delete the leftover, never-implemented `threadEventToUsage` helper and export,
  as well as the corresponding test in `test/adapter.test.ts` (dead code).
- If upstream Codex's compaction telemetry (`token_count` event, etc.) becomes
  settled in the future, leave room to supersede this ADR and consider an exact
  path. It is currently unsupported, with zero grep results.

### D4. Wire schema and backward compatibility

- Add optional `SessionCapabilitiesExt.supports_context_usage?: boolean`
  (protocol/src/index.ts), as an open-schema extension alongside the existing
  five fields.
- Do not change the existing three-field wire shape of `ext.context`
  (`used_tokens` / `max_tokens` / `used_percentage`). Preserve backward
  compatibility.
- Make zero changes on the Elixir side (`wrapper_channel.ex` frame validation /
  `agents_channel.ex` viewer redaction), which treats ext as opaque. The existing
  viewer-redaction test (`agents_channel_test.exs:1041-1085`) is insensitive to
  the shape change and remains non-regression coverage.

### D5. Synchronize the spec docs

- Add `supports_context_usage` to the session_capabilities section at
  `docs/specs/protocol.md` L134-145.
- Add Codex's explicit false stamp and a reference to ADR-0040 at
  `docs/specs/plugin-model.md` L32-37.
- Withdraw “reflect usage (tokens) into ext” from `docs/specs/codex-sdk-events.md`
  L48 (description of the `usage` field) and L84 (`turn.completed` → state
  derivation), and switch to advertising the capability.

### D6. Separate spiked / unverified items

The following has been confirmed by d.ts inspection for `getContextUsage()`
(`sdk.d.ts:2378, 2985-`):

- signature: `Query.getContextUsage(): Promise<SDKControlGetContextUsageResponse>`
- response shape: `totalTokens / maxTokens / rawMaxTokens / percentage /
  model / categories[]` etc
- transport succeeds through control_request after the SDK's `initialize`
  control_response arrives

**“Calling it immediately after init (turn 0) returns `totalTokens > 0`” is an
expectation, not an observation.** Since system_prompt + tools + MCP +
memory_files already consume context, a non-zero value is reasonable to expect,
but d.ts / SDK source cannot establish it. Re-verify on a real machine during
dogfood separately after phase-21 completes. On failure, swallow the error as
best-effort and leave the UI stuck at “loading” (M-A, 藤 review turn-3).

## Consequences

### Benefits

- The ctx row for Codex agents is correctly shown as “unsupported” and does not
  mislead the operator.
- The old wrapper during a rolling upgrade does not show misleading information
  (it hides the row unconditionally).
- The Claude-side init trigger plus bounded retry fixes the UX failure where the
  meter remained empty until the first result.
- Capability-only gating is established, so adding an engine does not require a
  UI change.

### Costs

- Adding Claude adapter triggers increases SDK control_requests (1–2 immediately
  after init + 1 per model switch). The inflight guard + dedup prevent needless
  firing.
- The ctx row disappears while an old wrapper is running, causing a temporary UX
  difference for the operator. It resolves automatically when the rolling upgrade
  completes.
- Supporting future Codex compaction telemetry costs another revisit of this ADR.

### Remaining scope (out of scope)

- A path to put Codex rollout's `token_count` events (when upstream adds them)
  into an exact projection. Deferred because the current spec is unsettled.
- A manual refresh path for context usage (currently fire-and-forget only). The
  request for a refresh button in the UI is outside phase-21 scope (藤 review S10).
- Introducing an envelope contract test / JSON schema. Deferred because it would
  expand scope (藤 review O11).

## References

- Original conversations: `f4834340` (kuroe ↔ 藤 kickoff), `fb40967b` (implementation orch)
- ADR-0022: pending-permission authoritative source (precedent for the every-state_change stamp pattern)
- ADR-0034 F3: principle of not using engine names to determine feature availability
- ADR-0037 F6: precedent for the bounded retry + persistent state flag pattern
- Wire spec: [protocol](../specs/protocol.md) L134-145
- Plugin routing: [plugin-model](../specs/plugin-model.md) L32-37
- Codex event contract: [codex-sdk-events](../specs/codex-sdk-events.md) L48, 84
- Implementation plan: [phase-21-context-usage-capability](../plans/phase-21-context-usage-capability.md)
