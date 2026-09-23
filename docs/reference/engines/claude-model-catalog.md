---
title: Claude model catalog
description: Exact contract for Claude catalog refresh, canonical model identifiers, and two-pass catalog-row matching.
status: accepted
last_updated: 2026-09-23
related: [extensions, adapter-contract, protocol]
---

# Claude model catalog

The structural sources of truth are
[`EngineModelInfo` and `EngineCatalogEntry`](../../../protocol/src/index.ts);
this page defines the catalog contract around those types.

## Claude model catalog live refresh and bootstrap default floor ([ADR-0037](../../adr/0037-claude-model-catalog-live-refresh.md), implemented in Phase 18)

The Claude catalog is advertised through two paths: “(i) register” and “(ii)
`ext.models`”. Their SDK observability differs structurally, so treat them
separately.

| Path | Call site | SDK observable? | Source of truth |
|---|---|---|---|
| (i) register | `runner/src/config.ts` → `LaunchDialog.svelte` | Not inside wrapper (SDK Query not created; chicken-and-egg). Substitute a short-lived runner probe ([ADR-0039](../../adr/0039-engine-catalog-live-probe.md)) | Runner memory cache of the last successful live probe (retain stale last-known-good after TTL expiry or later probe failures). Only when no successful cache exists use the bootstrap default floor in `wrapper/claude-code/src/catalog.ts` |
| (ii) `ext.models` | `wrapper/claude-code/src/host.ts` → `AgentDetail.svelte` | Yes (`#refreshSupportedModels()` observes after init) | Observed result of SDK `supportedModels()` |

(i)'s bootstrap was reduced to a minimal floor with one `default` entry (Phase 18-3,
`display_name: "Default (recommended)"`, neutral description
`"Account-recommended model · resolved after session start"`; `effort_levels` is
FULL_EFFORT as a placeholder). The assumption that the `default` alias resolves
to the “account-recommended model” and does not permanently rot was reconfirmed
by Phase 18-2 observation
(`resolvedModel: "claude-opus-4-8[1m]"`; details are in the
[ADR-0037](../../adr/0037-claude-model-catalog-live-refresh.md) Context section).
At ADR-0037 time, (i)'s source of truth was only this bootstrap constant; after
the short-lived probe + runner memory cache from
[ADR-0039](../../adr/0039-engine-catalog-live-probe.md), it became “observation
first; bootstrap is the floor only when no successful cache exists.” Note the
**last-known-good contract**: register / spawn receives
`ClaudeCatalogCache.getStale()`, which returns the last successful probe result
regardless of TTL. The TTL (default 1h) controls only whether to “probe again”
(`getIfFresh()`), not the supplied value itself. On probe failure, retain
existing cache entries and do not call `updateRegister`, so register remains on
its previous successful result rather than returning to bootstrap.

Rebuilding the register on a Claude refresh must not change another engine's
catalog: Codex is re-derived fresh from the current auth mode and config on
every call, and Antigravity's live-probed catalog is threaded through
explicitly rather than defaulting to its pinned snapshot (issue #369).

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
[claude-effort-levels-init-transition](../../open-questions/claude-effort-levels-init-transition.md)).

The Codex-side catalog retains the final decision in
[ADR-0035](../../adr/0035-codex-model-catalog-and-mid-session-switch.md) F1 (a
static catalog independent of runtime probes) without change. The
protocol schema does not change the `EngineCatalogEntry` container shape
(`models: EngineModelInfo[]`, an array that may be empty) (ADR-0037 F4). The
ADR-0037 change added only `models_error?: boolean` to `EnvelopeExt`;
`SwitchErrorExt.reason` is an open string, so `"persist_alias_unknown"` required
only a docstring addition and no type change. Later, `resolved_model?: string`
was added optionally to `EngineModelInfo` rows (F9 addendum, below). F4 concerns
the container shape and is not violated by an optional row field.

## Transparent canonical IDs and two-pass catalog-row matching ([ADR-0037](../../adr/0037-claude-model-catalog-live-refresh.md) F9 addendum, implemented 2026-07-31)

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
would present invalid model/effort pairs and violate [ADR-0035](../../adr/0035-codex-model-catalog-and-mid-session-switch.md)'s prohibition on silent downgrade.

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
- Before issue #363, an init / status report could replace `#model` with a
  canonical value, so catalog matching missed on every path and
  `supports_effort_switch` was not stamped. That overwrite path is no longer
  current: with an explicit pick, reports are kept separately in
  `#engineModel`, `#model` retains the input representation, and the top-level
  display is derived after catalog comparison. An operator can still call
  `setModel` with a canonical value directly, so two-pass matching remains
  required.

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

**Measured**: On SDK 0.3.258, `system/init` and context-usage reports both use
the catalog's `resolvedModel` spelling. Wrapper tests pin that either reporting
representation works.

The Codex catalog is static and does not distinguish canonical from alias, so it
is unchanged. A row with absent `resolved_model` behaves as it did before the
field was added.

## The model list ships inside the bundled CLI, not kaoiro (issue #398, measured 2026-09-23)

kaoiro declares no Claude model of its own: the bootstrap floor is the single
`default` row, and both catalog paths read what the Claude Code CLI bundled with
`@anthropic-ai/claude-agent-sdk` reports. A new Anthropic model therefore reaches
kaoiro through an SDK version bump, not a catalog edit — the same conclusion the
Fable 5.1 rollout reached.

`wrapper/claude-code/src/probe.ts` was run directly on this host, `ok: true` and
`source: "init"` in both runs:

| `value` | `resolved_model` on SDK 0.3.258 (CLI 2.1.258) | `resolved_model` on SDK 0.3.280 (CLI 2.1.280) |
|---|---|---|
| `default` | `claude-opus-5[1m]` | `claude-opus-5-5[1m]` |
| `opus[1m]` | `claude-opus-5[1m]` | `claude-opus-5-5[1m]` |
| `claude-fable-5-1[1m]` | `claude-fable-5-1` | `claude-fable-5-1` |
| `sonnet` | `claude-sonnet-5` | `claude-sonnet-5` |
| `haiku` | `claude-haiku-4-5-20251001` | `claude-haiku-4-5-20251001` |

Claude Opus 5.5 arrives as a change of an existing alias' `resolvedModel`, not as
a new row. Two consequences follow from the two-pass matching above:

- A pin written as the **alias** (`opus[1m]`, `default`) keeps matching and
  silently moves to the newer model.
- A pin written in the **canonical** spelling (`claude-opus-5[1m]`) matches
  nothing once no row resolves to it. `#validatePersistModelAgainstCatalog()`
  then rolls the session back to `default`, pairs `model_source` back to
  `default`, and emits `switch_error{reason: "persist_alias_unknown"}`, which the
  client shows as an info-tone notice. That is the designed degradation, not a
  crash — but it means a canonical pin does not survive a generation change.
