---
title: Plugin model
description: Two extension points—per-agent adapters and supplemental-processing filters—and the common event boundary into which they are inserted.
status: accepted
related: [architecture, protocol]
---
<!-- markdownlint-disable MD033 -->

# Plugin model

## Purpose

Defines two extension points (adapters / filters) and the common event boundary
into which both are inserted. Overall composition is in
[architecture](architecture.md).

## Definition

### Two extension points — design them separately

| Extension point | Role | Nature |
|---|---|---|
| **Adapter (per agent)** | Startup/control, native output → common-event translation and state derivation, reverse transformation of instructions | Dedicated interface holding process lifecycle and protocol translation. Claude Code version is an Agent SDK implementation ([ADR-0001](../adr/0001-agent-sdk-integration.md)) |
| **Filter (supplemental processing)** | Add properties to normalized common events (emotion, cost, hazard detection) | Agent-agnostic, ordered pipeline |

- Support for a future Codex, etc. is inserted as an **adapter** → **2026-07-10
  update**: The Codex adapter became an implementation target in
  [ADR-0032](../adr/0032-codex-adapter.md) and was implemented in
  [phase-14-codex-adapter](../plans/phase-14-codex-adapter.md).
- Filters operate only on common events, so the same filter sequence can be
  reused with any agent.
- This separation is essential to making “core = agent independent” work.
- Examples of additional properties: `ext.cost` (cumulative USD cost, #8,
  attached to result) and `ext.model` / `ext.context` / `ext.rate_limits`
  (Claude Code-specific metrics, #16, attached to state_change). Because the
  filter sequence is unimplemented, the Claude Code adapter presently attaches
  all of them directly (best effort only when exposed by SDK). `model` /
  `context` / `rate_limits` are CC-specific, so belong on the adapter rather
  than in a general filter. Move generalizable `cost`, etc. into agent-agnostic
  filters when the filter mechanism is introduced.
  - **Codex treatment of `ext.context`**
    ([ADR-0040](../adr/0040-context-usage-capability.md), phase-21): The Codex
    adapter does **not stamp** `ext.context` (because
    `turn.completed.usage.input_tokens` is only per-turn input and not context
    utilization; it does no estimated projection either). Instead it explicitly
    stamps `ext.session_capabilities.supports_context_usage=false`; UI decides
    “unsupported” only from capability (engine-name branching is prohibited,
    [ADR-0034](../adr/0034-session-capabilities-advertisement.md) F3). Claude
    stamps the same field `true`.

### Common event boundary

The boundary into which adapters and filters are inserted is itself the common
event / envelope ([protocol](protocol.md)).

```
[Agent native] --(Adapter: SDK→common)--> [Common event v0]
  --(Filter chain)--> [Server(状態保持)] --> [Client]
```

### Package structure and entity extension

The adapter/core separation is made a physical boundary as **three layers of
pnpm-workspace packages** ([ADR-0017](../adr/0017-wrapper-multientity-packages.md),
materialized by [phase-13-wrapper-multipackage-restructure](../plans/phase-13-wrapper-multipackage-restructure.md),
and settled in [ADR-0032](../adr/0032-codex-adapter.md) F1): entity-independent
core (`wrapper/core`) / AI-agent common layer `wrapper/agent-common` (state
machine, permission, instruction, `EngineAdapter` interface, common Tool
description layer) / concrete adapters (`wrapper/claude-code`,
`wrapper/codex`, `wrapper/antigravity` ([ADR-0057](../adr/0057-antigravity-adapter.md) F1),
and future databases, host monitors, etc.). State machine,
permission, and instruction are AI-specific and do not go in core. The eventual
aim is to visualize the state of diverse entities as characters, not just AI
(the broader aim is covered separately in vision).

`EffectiveStatusSnapshot` in `agent-common` is SoT for effective-configuration
projection in both AI adapters. Each host assembles `resolved: ResolvedSnapshotExt`
and engine-neutral `permission` once from engine-specific state; a common helper
projects them into the respective wire shapes of `state_change.ext` and
read-only `whoami`. It is a boundary preventing status fields being implemented
twice per adapter and omitted from one; unknown fields are omitted from both
paths.

### EngineAdapter interface

The `EngineAdapter` interface in the common AI-agent layer
`wrapper/agent-common` ([ADR-0032](../adr/0032-codex-adapter.md) F1, F4bc, F9)
declares the contract concrete adapters must implement:

- State derivation: engine-specific event stream (Claude `SDKMessage` /
  Codex `ThreadEvent`) → common `AdapterEvent`
- Control: `interrupt` / `setModel` / `applyFlagSettings` /
  `setPermissionMode` (delegated to the SDK for Claude; relaunch equivalent for
  Codex)
- Permission: bridge a `canUseTool`-equivalent callback to the permission broker
- cwd notification: `onCwdChanged(newCwd)` hook contract (implementation is
  engine-specific)
- Capability declaration: `supportedModels()` / `effortOptions?()`
  (`EngineCapability`)
- Convert the common Tool description layer (JSON Schema + handler pair) to
  engine-specific APIs (Claude: Zod + `createSdkMcpServer` in-process / Codex:
  `dynamicTools`)

### Session capability advertisement (2026-07-11, [ADR-0034](../adr/0034-session-capabilities-advertisement.md))

This path communicates **session-scoped capability** (auth mode / plan tier /
wrapper implementation differences) that an engine name cannot express to the
UI. Do **not add** a capability-getter hook to `EngineAdapter`; each adapter
builds `ext.session_capabilities` directly in its state-stamp path (equivalent
to `#statusExt`) and advertises it in the envelope
(ADR-0034 F4).

- **Reason**: A capability is not a “static fact” over the session lifetime;
  it is the composition of adapter implementation + spawn-time selection + auth
  mode. Building it inside the adapter in sync with state reflects reality, and
  keeps the envelope consistent as SoT (the principle in
  [ADR-0022](../adr/0022-pending-permission-authoritative-source.md)).
- **Stamp timing**: **from the first state_change** directly after spawn (do not
  wait for a session_init-equivalent event). Codex delays `thread.started` until
  the first turn because it spawns a new `codex exec` process every turn; waiting
  for session_init would make a newly started Codex agent display falsely as
  “no capability” under the fail-closed default
  ([codex-sdk-events](codex-sdk-events.md)). Claude also stamps from its first
  state_change for symmetry.
- **UI decision principle**: The UI must not determine capability from the
  engine name (`ext.engine`) (review prohibition,
  [ADR-0034](../adr/0034-session-capabilities-advertisement.md) F3). Look only
  at boolean / conditional arrays in `ext.session_capabilities`.
- **Current advertised values**:
  - `wrapper/claude-code`: `supports_attachments: true` /
    `supports_user_input_dialog: true` (unconditional; omit
    `attachment_types` = no type restriction)
  - `wrapper/codex`: `supports_attachments: true` /
    `attachment_types: ["image"]` / `supports_user_input_dialog: true`. The UI
    limits picker / paste / drop to images (changed from the original planned
    `false` when attachments were added in phase-14)
- **`supports_model_switch` / `supports_effort_switch`** (implemented in
  phase-16, 2026-07-13, [ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md)
  F4): Advertise whether `set_model` / `set_effort` are accepted mid-session.
  Claude is always `true` because its SDK supports them; Codex is `true` when
  the catalog resolver can return `EngineModelInfo[]` (auth mode and plan are
  known), and `false` when unknown / the catalog is empty. The engine updates
  the advertisement whenever catalog / auth mode changes.

### Claude model catalog live refresh and bootstrap default floor ([ADR-0037](../adr/0037-claude-model-catalog-live-refresh.md), implemented in Phase 18)

The Claude catalog is advertised through two paths: “(i) register” and “(ii)
`ext.models`”. Their SDK observability differs structurally, so treat them
separately.

| Path | Call site | SDK observable? | Source of truth |
|---|---|---|---|
| (i) register | `runner/src/config.ts` → `LaunchDialog.svelte` | Not inside wrapper (SDK Query not created; chicken-and-egg). Substitute a short-lived runner probe ([ADR-0039](../adr/0039-engine-catalog-live-probe.md)) | Runner memory cache of the last successful live probe (retain stale last-known-good after TTL expiry or later probe failures). Only when no successful cache exists use the bootstrap default floor in `wrapper/claude-code/src/catalog.ts` |
| (ii) `ext.models` | `wrapper/claude-code/src/host.ts` → `AgentDetail.svelte` | Yes (`#refreshSupportedModels()` observes after init) | Observed result of SDK `supportedModels()` |

(i)'s bootstrap was reduced to a minimal floor with one `default` entry (Phase 18-3,
`display_name: "Default (recommended)"`, neutral description
`"Account-recommended model · resolved after session start"`; `effort_levels` is
FULL_EFFORT as a placeholder). The assumption that the `default` alias resolves
to the “account-recommended model” and does not permanently rot was reconfirmed
by Phase 18-2 observation
(`resolvedModel: "claude-opus-4-8[1m]"`; details are in the
[ADR-0037](../adr/0037-claude-model-catalog-live-refresh.md) Context section).
At ADR-0037 time, (i)'s source of truth was only this bootstrap constant; after
the short-lived probe + runner memory cache from
[ADR-0039](../adr/0039-engine-catalog-live-probe.md), it became “observation
first; bootstrap is the floor only when no successful cache exists.” Note the
**last-known-good contract**: register / spawn receives
`ClaudeCatalogCache.getStale()`, which returns the last successful probe result
regardless of TTL. The TTL (default 1h) controls only whether to “probe again”
(`getIfFresh()`), not the supplied value itself. On probe failure, retain
existing cache entries and do not call `updateRegister`, so register remains on
its previous successful result rather than returning to bootstrap.

(ii) uses SDK observation as its single source of truth (Phase 18-4/5/6).
`#refreshSupportedModels()` performs an automatic bounded retry (three total,
counting init as trial 1; `MAX_MODEL_REFRESH_RETRIES = 3`) and retries on a
turn-driven `result` message. It is silent after the cap, emitting one
diagnostic breadcrumb through `process.stderr.write` only at the cap. An
operator manual retry starts `retrySupportedModels()` through the
`refresh_models` control message (client → server → wrapper), resetting the
counter / succeeded flag and kicking a refetch. The cap state derives
`EnvelopeExt.models_error?: boolean` as persistent state with derive-always
(` #modelsRetryCount >= MAX && !#modelsSucceeded`), consumed client-side by a
persistent class (`.cc-refresh-error` on the ↻ button) and a rising-edge tracker
(`sawModelsError`, mirroring `sawEffortReset`) that fires a transient
`switchNotice` a second time (also visible when a manual retry fails again). If
a persisted model identifier from session state / config / resume snapshot
(alias or canonical; two-pass matching since the F9 addendum) is absent from SDK
observations, startup validation (`#validatePersistModelAgainstCatalog()`, Phase
18-7) falls back to `default` and emits
`switch_error{reason: "persist_alias_unknown"}`; the client displays an info
tone: “The saved {req} is not in the current catalog; starting with default.”

The client retry button (↻) is always provided beside the switch button in
`AgentDetail.svelte` (Phase 18-9), but an `agentEngine === "claude-code"` gate
keeps it out of Codex (ADR-0035 has a static Codex catalog with no handler,
preventing a dead button). The same engine gate applies to `models_error`
derivation, so the client does not react even if a Codex adapter bug emits it
(defensive gate).

The UX mismatch in the `effort_levels` option set before and after init (five
levels before init → possibly fewer after init depending on the observed
default model) is an accepted trade-off (observation:
[claude-effort-levels-init-transition](../open-questions/claude-effort-levels-init-transition.md)).

The Codex-side catalog retains the final decision in
[ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md) F1 (a
static catalog independent of runtime probes) without change. The
protocol schema does not change the `EngineCatalogEntry` container shape
(`models: EngineModelInfo[]`, an array that may be empty) (ADR-0037 F4). The
ADR-0037 change added only `models_error?: boolean` to `EnvelopeExt`;
`SwitchErrorExt.reason` is an open string, so `"persist_alias_unknown"` required
only a docstring addition and no type change. Later, `resolved_model?: string`
was added optionally to `EngineModelInfo` rows (F9 addendum, below). F4 concerns
the container shape and is not violated by an optional row field.

### Transparent canonical IDs and two-pass catalog-row matching ([ADR-0037](../adr/0037-claude-model-catalog-live-refresh.md) F9 addendum, implemented 2026-07-31)

Pass upstream `ModelInfo.resolvedModel` (the concrete ID to which an alias
resolves, e.g. `sonnet` → `claude-sonnet-5`) through the wire as
`EngineModelInfo.resolved_model?: string`. This is read-only metadata;
**absent = unknown**. Collapse an empty string to absent so a value that matches
nothing is not published.

Pass it through all four paths below. If any is missing, the canonical ID is
visible on some paths but not others.

| Path | Call site |
|---|---|
| probe CLI | `wrapper/claude-code/src/probe.ts` `projectModel()` |
| live SDK | `wrapper/claude-code/src/host.ts` `#refreshSupportedModels()` |
| probe fallback (manual refresh) | Same `#executeManualRefresh()` |
| client | `dashboard/src/lib/protocol.ts` `modelsFrom()` |

**Matching rule (2-pass; canonical may match multiple rows)**: Search catalog rows
in this order: (1) exact `value` match → (2) if none, `resolved_model` match.
Do not collapse this into a one-pass OR condition. A canonical match can shadow an
explicit alias selection, yielding the wrong effort domain and display.

Multiple matches are expected, not exceptional. The live probe resolves `default`
and `opus[1m]` to the same canonical (`claude-opus-5[1m]`). Therefore pass (2)
**must return all matching rows, without stopping at the first**. Choosing the
first row may be deterministic but has no semantic basis, and would display the
pinned `opus[1m]` as the floating `default` — the same semantic corruption as
rejecting normalization in “Input representation preservation” below.

Fold matching results according to their use case:

| Use | Rule |
|---|---|
| membership / persist validity | Valid when **at least one** row matches |
| effort domain | **Intersection** of matching rows' `effort_levels`. If any row omits `effort_levels`, the result is **empty** (fail-closed). Exact `value` matches are always a single row, so use that row's levels |
| `supports_effort_switch` | **`false`** when the intersection above is empty. Do not infer `true` merely because a row was found |
| Active UI display | Show alias primary and canonical secondary **only when exactly one** row matches. For multiple matches, do not invent an alias: show the **raw canonical** as primary and omit the duplicate canonical secondary |
| model menu `aria-selected` | **`false` for every row** when multiple rows match. The canonical does not belong uniquely to any alias, so marking one selected would be misleading |
| Send / preserve | Preserve the input representation regardless of match count (below). Multiple matches do not affect the sent value |

The intersection fail-closed behavior matches the folding already used by client
effort Tier 3; it is not a new concept. In the common case where every row has the
same `effort_levels`, the intersection is those levels and behavior is unchanged.
Only contradictory rows degrade to the safe side. Union is rejected because it
would present invalid model/effort pairs and violate [ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md)'s prohibition on silent downgrade.

**Input representation preservation**: Preserve the exact string received from the
caller for the string `setModel()` sends to the SDK, startup `Options.model`, and
state `#model`. Catalog matching is used only to determine the effort domain and
whether a model is unknown; it is not grounds to rewrite the sent value. **Do not
normalize in either direction**, alias → canonical or canonical → alias. Canonical
→ alias is non-injective, so normalization would turn the pinned choice (`opus`)
into the floating account-recommended choice (`default`).

Implementation confines matching (`#findCatalogEntries`) and effort folding
(`#effortLevelsForCatalogEntries`) to one function each, shared by four wrapper
sites (`setModel` `invalidEffort` / `setEffort` / `supports_effort_switch` stamp /
`#validatePersistModelAgainstCatalog`) and the client (effort Tier 1 / model-row
display resolution / active selection). This resolves two defects:

- A persisted canonical (`claude-sonnet-5`) was rejected by validation that only
  checked exact `value` matches, rolling back to `default` with
  `switch_error{reason: "persist_alias_unknown"}`.
- When `ext.model` is canonical — init / status reports the canonical value and
  the “value-only overwrite” contract in [agent-sdk-events](agent-sdk-events.md)
  replaces `#model`, or an operator calls `setModel` with the canonical directly —
  catalog matching missed on every path, so `supports_effort_switch` was not
  stamped and the client's effort choices disappeared. Which representation
  SDK `system/init` actually returns (alias or canonical) is unobserved (below),
  so this is a conditional defect based on the existence of a path where a
  canonical value can enter.

**Display (separate wire and UI)**: Pass `resolved_model` through catalog rows
on the register path as well. Do not vary row shape by path, which would force
consumers to branch beyond “absent = unknown.” **UI display is limited to
`AgentDetail`**: show alias primary and canonical secondary only for exactly one
match (see the table above for multiple matches). Do not display it in
`LaunchDialog` (externalized to Gitea
[issue #166](https://github.com/sakuraiyuta/kaoiro/issues/166)). The register
path's `resolved_model` comes from the runner's last-known-good cache, the result
from its most recent successful probe, and remains after TTL expiry; its accuracy
therefore differs from `ext.models` observed after init. In particular, the
`default` row follows the account recommendation, so the displayed value can
diverge from the actual startup result. Presenting these two accuracy levels with
the same appearance would mislead users, so the presentation method is an
independent UX decision.

**Unobserved**: The representation (alias / canonical) of `model` returned by
SDK `system/init` is not settled. Observation requires first user input (and
incurs cost), so it has not been measured (scope and raw values are in the
follow-up measurement notes in [agent-sdk-events](agent-sdk-events.md)). Wrapper
tests pin that either representation works.

The Codex catalog is static and does not distinguish canonical from alias, so it
is unchanged. A row with absent `resolved_model` behaves as it did before the
field was added.

## Constraints

- MUST: Filters may touch only `payload` / `ext`; do not over-depend on the outer
  envelope (`version`, `agent_id`, `ts`, `type`, `state`).

## See Also

- Related specs: [architecture](architecture.md), [protocol](protocol.md)
- ADRs: [0001](../adr/0001-agent-sdk-integration.md), [0037](../adr/0037-claude-model-catalog-live-refresh.md)
