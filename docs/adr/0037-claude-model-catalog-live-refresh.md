---
title: Claude model catalog live path SDK realization and launch boots  default floor reduction
status: accepted
date: 2026-07-14
opened: 2026-07-14
supersedes: []
superseded_by: null
related_specs: [plugin-model, protocol]
related_adrs: [32, 34, 35, 39, 40]
---

# ADR-0037 — Claude model catalog live path SDK Demonstration and launch boots  default floor reduction

## Status

Accepted (2026.-14, master decision).Home
[phase-18-claude-model-catalog-live](../plans/phase-18-claude-model-catalog-live.md).

## Context

`wrapper/claude-code/src/catalog.ts` `BOOTSTRAP` constant
`@anthropic-ai/claude-agent-sdk` `supportedModels()` to 2026-13-13
This is a static snapshot (equivalent to S  0.3.187).
The role is the initial value of the Claude side catalog referenced in the following three locations:

- `runner/src/config.ts:288` — `engines[].models` of Register envel .   boot
When server (Elixir) to engine separate catalog
- `wrapper/claude-code/src/host.ts:116` — presence `models` field
- `wrapper/claude-code/src/host.ts:279` — initial value of `AgentHost.#models`. SDK init
`#refreshSupportedModels()` (`host.ts:1231`)

2026 -14 Now Anthropic includes Claude Sonnet 5 (`claude-sonnet-5`)
BOOTSTRAP snapshot
None The operation to manually update the BOOTSTRAP snapshot every time the model adds


Phase 18-2 (`query.supportedModels()` dump in S  0.3.208, 2026-14-14)
`value: "default"`
resolved to `resolvedModel: "claude-opus-4-8[1m]"` (current account recommended model)
`default` alias does notHome permanently. (b) `sonnet[1m]`
`claude-opus-4-7` does not already exist, `sonnet` resolves to `claude-sonnet-5` —
drift of BOOTSTRAP snapshot was confirmed with real data.

"BOOTSTRAP Complete Abolition" has structural disorders: BOOTSTRAP is the following two routes
It is effective and can not handle both.

|Route|Call site|Is the SDK available?|
|---|---|---|
| **(i) register path** | `runner/src/config.ts:288` → `dashboard/src/lib/LaunchDialog.svelte` | **In principle impossible**— There is no wrapper process or SDK Query at host connection. You want to spawn to get a catalog, but you need a catalog before spawn (chicken and egg)|
| **(ii) ext.models route** | `wrapper/claude-code/src/host.ts:116, 279` → `dashboard/src/lib/AgentDetail.svelte` | **Available**— init after`#refreshSupportedModels()`Japanese term|

(i) `supportedModels()` because the wrapper process is not yet alive
There is no room to call. This hen and egg,s are accepted, and the maintenance burden is removed.
There is a required to decide.

`wrapper/codex/src/catalog.ts`
[ADR-0035](0035-codex-model-catalog-and-mid-session-switch.md) F1
"catalog advertisement is not dependent on the runtime probe".
`codex doctor --json` returns only to auth mode,
Real-time implementation is not technically possible because it does not return a set. Claude side catalog
codex.

## Decision

### F1 — BOOTSTRAP`default`minify to the minimum floor for only one entry

`BOOTSTRAP` to `opus[1m]`,
`claude-fable-5[1m]`, `sonnet`, `sonnet[1m]`, `haiku`, `claude-opus-4-7`
Delete the entry and leave the `default` entry only. In the "All Model Enumeration" part of ten
`default` alias refers to "account recommended model" as semantic on the SDK
It is a name solution, so it does not. permanently.

### F2 — centralize the Claude live path to the SDK

The source of truth of `AgentHost.#models` is completed after the SDK init
`#refreshSupportedModels()` (`host.ts:1231-1249`) prev
BOOTSTRAP is treated as "loading equivalent floor".
Overwrite contract. `state_change.ext.models`
Contact Us

### Codex catalog

[ADR-0035](0035-codex-model-catalog-and-mid-session-switch.md) F1
(operator plan static catalog, runtime probe non-dependent)
`wrapper/codex/src/catalog.ts` and `resolveCodexCatalog`
Don’t ask for actual codex implementation for unification (Technicalically `codex doctor`)
entitled

### F4 — protocol schema

`protocol/src/index.ts` `EngineCatalogEntry.models`
`EngineModelInfo[]` `models?` (optional)
Do not add the readiness flag. The following two points:

1. Return `[]` in unknown auth / no plan
ADR-0035 F1) and Claude confusing "unload" flag fail-closed
De  default
2. `LaunchDialog.svelte:127` has already allowed an empty array (`?? []`)
client side loading UI no need to add

### F5 — `default`Entry`effort_levels`FULL EFFORT

`effort_levels` of `default` entry after reduction is
`["low", "medium", "high", "xhigh", "max"]` options before and after init
Changed UX Z e (init prev 5 steps → init may be reduced depending on the actual default model)
is accepted trade-off. This is a new idle agent.
The source (`AgentDetail.svelte:369` comment) is a thrust to not break and permanent
Not the best solution. Observation after implementation
[claude-effort-levels-init-transition](../open-questions/claude-effort-levels-init-transition.md)
Japanese term

### F6 — retry policy: 3 times automatic + toast 1 degree + silent + manual button always

`#refreshSupportedModels()` explicitly contracts recovery design during failure. Current
Only return to `#modelsRequested = false` with silent fire-and-forget (`host.ts:1247`)
for lacking retry trigger. The following two steps:

1. **Automatic bound retry**: Next turn Max auto retry when receiving**3 times**Close
Test silent (no banner)
2. **Manual retry**: "Re  model list" button is always on the model switcher UI
You can explicitly trigger the operator. Button trigger limits
Recounting
3. **Notice**: Notice failure with toast as long as one time at the maximum reach (dis able). Next
Auto retry failure does not emit toast

Specific UI placement (retry button position, toast look) is implemented in phase-18-3 PR
Contact Us

### F7 — BootSTRAP reduced PR after SDK upgrade

`wrapper` package `@anthropic-ai/claude-agent-sdk` currently 0.3.162
installed (`^0.3.162`, lockfile fixed). npm Latest 0.3.208
SDK upgrade PR**Home**`supportedModels()`
Verify semantic for `model: "default"`. Based on this actual survey results
BOOTSTRAP PR PR

Avoid simultaneous PR implementation. Home SDK upgrade
to differentiate the effects.

### F8 — fallback if persisted model identifier is not supported

`model` identifier persist in session state / config, etc. (e.g.:
`sonnet[1m]`) If the SDK is not supported after startup, it will be used to `default` in startup verification.
fallback and issue a notification event to the UI. notification particle size (toast 1 degree / session log /
The explicit dialog) is determined by the implementation PR of phase-18-3.

When this ADR was established (2026 -14), the persist value was assumed to be alias only.
alias / canonical `value`
`resolved_model` Do with 2-pass matching, and only those that do not win either
fallback If canonical matches more than one line,
not rollback as valid** — persist validation asks:
"Is it possible to belong to any line?" `switch_error.reason`
The wire value must be `"persist_alias_unknown"` because it is compatible.

### F9 (2026 —-31 supplementation) — Transmit canonical ID to catalog catalog and 2-pass collision

`resolvedModel` (`default` → `claude-opus-4-8[1m]`,
`sonnet` → `claude-sonnet-5`) was dropped in projection and was not wired.
This produced two real harms:

1. F8 persist validation only for `value` full matching, persist canonical
alias not in catalog, and rollback to `default`
2. If `#model` is canonical (init / status reports canonical),
operator canonical directly `setModel` via resume snapshot
next start) The catalog projection will miss all routes. `system/init` `model`
This is because it is not observation (see below) which expression is actually
is conditional defect based on  "

`EngineModelInfo` adds `resolved_model?: string` to optional
Change to 2-pass of `value` full matching → `resolved_model` matching.

canonical**Multi-matching**Home `default` and `opus[1m]`
This is not an exception, but a default to solve canonical. pass (2)
Returns all matching lines and folds for each application: membership / persist validation is valid for more than one
effort domain is an intersection of matching lines (empty if `effort_levels` falls),
`supports_effort_switch` `false` if the intersection is empty, the UI matches
alias lord + canonical vice, and raw canonical when multiplex
`aria-selected` of the main display and model menu is set to `false`.
not selected). Send/Retention remains as input expressions are preserved regardless of the number of matches.

The first match adopt was rejected. decisive but meaningless, pinned
`opus[1m]` is displayed as `default`.
The same meaning breakdown as rejected will be committed in the display route rather than the transmission route.
[plugin-model](../specs/plugin-model.md)

F4
`EngineCatalogEntry`
and optional field addition to optional does not conflict with this. Old
The producer does not emit a field, and the old consumer is only dropped, so it can be kept backward compatible.

Close**Input**Make a contract. catalog of effort domain
Use only for deter  and unknown model deter , the value to send to S  and the value to be retained from the caller
Save the string as it is. alias ↔ canonical
canonical → alias is non-single, and if normalized, `opus` pin is `default` float
To become a pet.

canonical ID is both pre-init `Options.model` and live `Query.setModel()`
2026 20-31 `system/init`
`model` is undetermined because observation requires billing, either alias / canonical
I put it in a shape that pins the test even if it is returned.

[plugin-model](../specs/plugin-model.md)
[agent-sdk-events](../specs/agent-sdk-events.md) Launch  to canonical
The display has a precision difference (register path is last-known-good cache)
If the probe point value is not applicable for the reason, it may be placed even after the TTL exceeds
[issue #166](https://github.com/sakuraiyuta/kaoiro/issues/166)
to ex .

## Consequences

### Positive

- BOOTSTRAP snapshot manual update disappears every time the model addition (Sonnet 5, etc.)
- The source of truth of the Claude live path is centralized to the SDK
Dependency resolution (plan / team / model) is accurately reflected
- protocol schema / server / client / codex
Close the range to the center of Claude wrapper.**Supplement (2026 -31,F9)**: This
"localized" was partially broken with F9. current status is server unchanged / codex unchanged
`EngineModelInfo`Maintenance
Add `resolved_model`, client is `modelsFrom` projection and model lines
The display is changed. container type (F4) and server / codex
Home
- The `default` entry is kept safe and "model selection" both before and after init
Zero state

### Negative

- Selected effort before init will disappear from the option after init
  (F5,[claude-effort-levels-init-transition](../open-questions/claude-effort-levels-init-transition.md))
- In launch dialog, init will only show "Default", like Sonnet 5
pre-Model is not possible before init. mid-session after completion
Switch **S,ule (2026,-31)
[ADR-0039](0039-engine-catalog-live-probe.md))**: ThisHome has been resolved.
Short life probe + memory cache, usually live-probe
You can pre-Model a specific model in launch dialog. "Default"
If you don't have a success cache (cold start / initial probe failure)
Limited
- Increases the complexity of the wrapper side only for additional retry implementation (F6)

### Neutral

- The codex side catalog does not change (ADR-0035 F1 retention)
- protocol schema (`EngineCatalogEntry`) is unchanged and backward compatibility is completely maintained
- BOOTSTRAP reduction is based on the SDK upgrade premise (F7) and the SDK 5 support.

## Alternatives Considered

| Option | Decision |
|--------|----------|
|BOOTSTRAP Completely disco ed + loading UI|Reject. (i) register path is not generated by the SDK Query, so it is impossible to measure (chicken and egg), loading soft-lock risk,`default`The effort levels developed into 7 layers of source loss, protocol / server / client / tests / docs.**Supplement (2026 -15, ADR-0039)**: This "invalid" is not possible with "register-only premise (premises not to generate query)". runner generates a short-lived SDK probe (query) in streaming input mode, and then runs supportedModels() → close after init completes, catalog catalog richness of the register path. adopt this route (Option E) on ADR-0039 and BOOTSTRAP minimum floor is not set|
|BootSTRAP snapshot|Reject. Manual updates are notreality every time the model is added (e.g., the failure of Sonnet 5  )|
| `EngineCatalogEntry.models?`Optional or readiness flag added|Reject. confuse codex's meaningless sky and Claude's unload to destroy fail-closed default.`LaunchDialog.svelte:127`is not required because the empty is already allowed|
|Codex uniformity|Reject. ADR-0035 Leave the final decision of F1.`codex doctor --json`It is technically impossible to return model|
|SDK upgrade and BOOTSTRAP|Reject. It is difficult to cut influence by mixed behavior|
| `default`Empty entry effort levels (init pre effort switcher disabled)|Reject. fresh idle agent switcher source disappears|
| `default`Low/levelum/high 3-step fixing effort levels for entries|Reject. init does not touch xhigh/max before sacrificing expressiveness|
|retry No limit|Reject. Infinite call risk when the SDK bug occurs|
|always display banner when failure|Reject. idle agent|
|Completely silent at failure|Reject. Not noticed that user is broken|

## Implementation

[phase-18-claude-model-catalog-live](../plans/phase-18-claude-model-catalog-live.md)
3 phase (S  upgrade + real-time verification / wrapper refurbishment / client UI)
. `default` alias
`claude-opus-4-8[1m]` has been confirmed to be resolved (see Context section of this ADR for details).
