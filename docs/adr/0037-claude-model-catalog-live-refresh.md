---
title: Unify the Claude model-catalog live path through SDK measurement and reduce the launch-bootstrap default floor
status: accepted
date: 2026-07-14
opened: 2026-07-14
supersedes: []
superseded_by: null
related_specs: [plugin-model, protocol]
related_adrs: [32, 34, 35, 39, 40]
---

# ADR-0037 — Unify the Claude model-catalog live path through SDK measurement and reduce the launch-bootstrap default floor

## Status

Accepted (2026-07-14, approved by マスター). Implementation is
[phase-18-claude-model-catalog-live](../plans/phase-18-claude-model-catalog-live.md).

## Context

The `BOOTSTRAP` constant in `wrapper/claude-code/src/catalog.ts` is a static
snapshot taken from `@anthropic-ai/claude-agent-sdk`’s `supportedModels()` on
2026-07-13 (approximately SDK 0.3.187, as noted in the comment). It supplies the
initial Claude-side catalog values referenced at three locations:

- `runner/src/config.ts:288` — `engines[].models` in the Register envelope, the
  path that advertises an engine-specific catalog to the server (Elixir) at runner
  boot
- `wrapper/claude-code/src/host.ts:116` — the `models` field in the initial
  presence message
- `wrapper/claude-code/src/host.ts:279` — the initial value of `AgentHost.#models`.
  After SDK init completes, `#refreshSupportedModels()` (`host.ts:1231`) overwrites
  it with the SDK’s measured result.

As of 2026-07-14, Anthropic is releasing a new model generation including Claude
Sonnet 5 (`claude-sonnet-5`), but the BOOTSTRAP snapshot still reflects Sonnet 4.6
and has not followed. Manually updating the BOOTSTRAP snapshot each time a model
is added is no longer realistic.

Phase 18-2 measurement (a `query.supportedModels()` dump on SDK 0.3.208,
2026-07-14) reconfirmed the premise of this ADR: (a) the `value: "default"` row is
resolved by the SDK to `resolvedModel: "claude-opus-4-8[1m]"` (the account’s
recommended model at the time), establishing that the “`default` alias never
rots” premise holds; (b) `sonnet[1m]` and `claude-opus-4-7` were already absent
from the measured array, while `sonnet` resolved to `claude-sonnet-5` — drift in
the BOOTSTRAP snapshot was confirmed by real data.

On the other hand, completely removing BOOTSTRAP has a structural obstacle: it is
used by two paths that cannot be treated uniformly.

| Path | Corresponding call site | SDK measurable? |
|---|---|---|
| **(i) Register path** | `runner/src/config.ts:288` → `dashboard/src/lib/LaunchDialog.svelte` | **Impossible in principle** — when the host connects, neither the wrapper process nor an SDK Query exists. Spawning is needed to obtain the catalog, but the catalog is needed before spawning (chicken and egg). |
| **(ii) ext.models path** | `wrapper/claude-code/src/host.ts:116, 279` → `dashboard/src/lib/AgentDetail.svelte` | **Possible** — after init, `#refreshSupportedModels()` replaces it with a measurement. |

Path (i) has no live wrapper process, so there is structurally no opportunity to
call `supportedModels()`. We need a decision that accepts this chicken-and-egg
constraint while removing maintenance burden.

The Codex-side catalog (`wrapper/codex/src/catalog.ts`) has already decided in
[ADR-0035](0035-codex-model-catalog-and-mid-session-switch.md) F1 that catalog
advertisement does not depend on runtime probing. `codex doctor --json` reports only
auth mode, not plan tier or the entitled model set, so a measured implementation is
technically impossible as well. This ADR is limited to the Claude-side catalog and
does not regress Codex.

## Decision

### F1 — Reduce BOOTSTRAP to the minimal floor of one `default` entry

From `BOOTSTRAP` in `wrapper/claude-code/src/catalog.ts`, remove all six entries
`opus[1m]`, `claude-fable-5[1m]`, `sonnet`, `sonnet[1m]`, `haiku`, and
`claude-opus-4-7`, leaving only the `default` entry. It is the enumeration of all
models that rots; the `default` alias is SDK semantics that resolves to the
“account-recommended model” and therefore does not rot.

### F2 — Make the Claude live path a single SDK measurement

Make the result of `#refreshSupportedModels()` (`host.ts:1231-1249`) after SDK init
completes the sole source of truth for `AgentHost.#models`. Treat BOOTSTRAP before
init as a “loading-equivalent floor”, and contractually overwrite it with the
measured result after init. The `state_change.ext.models` advertisement also uses
that same measured result.

### F3 — Leave the Codex catalog unchanged

Retain the decision in [ADR-0035](0035-codex-model-catalog-and-mid-session-switch.md)
F1: a static catalog based on an operator plan declaration, independent of runtime
probe. Do not modify `wrapper/codex/src/catalog.ts` or `resolveCodexCatalog`. Do not
require measurement on the Codex side merely for uniformity (technically impossible
because `codex doctor` does not return entitled models).

### F4 — Keep the protocol schema as-is

Keep `EngineCatalogEntry.models` in `protocol/src/index.ts` as
`EngineModelInfo[]` (an array that may be empty). Do not make it `models?` optional
or add a readiness flag. There are two reasons:

1. A flag that distinguishes Codex’s “meaningful empty catalog” (ADR-0035 F1
   returns `[]` for unknown auth / no plan) from Claude’s “not loaded” would break
   the fail-closed default.
2. `LaunchDialog.svelte:127` already accepts an empty array (`?? []`), so no
   client-side loading UI is needed.

### F5 — Temporarily advertise FULL_EFFORT for the `default` entry’s `effort_levels`

After reduction, temporarily advertise the current
`["low", "medium", "high", "xhigh", "max"]` for the `default` entry’s
`effort_levels`. Accept the UX discrepancy in which choices change before versus
after init (five levels before init, then potentially fewer depending on the measured
default model). This follows the current effort-switcher source for a fresh idle
agent (`AgentDetail.svelte:369` comment) so it does not break, and is not the
permanent optimal solution. Track post-implementation observations in
[claude-effort-levels-init-transition](../open-questions/claude-effort-levels-init-transition.md).

### F6 — Retry policy: three automatic retries + one toast + silent thereafter + permanent manual button

Formalise recovery after `#refreshSupportedModels()` fails. The current behavior
only silently returns `#modelsRequested = false` in a fire-and-forget path
(`host.ts:1247`), lacking a reliable retry trigger. Use two layers:

1. **Automatic bounded retry**: automatically retry at the next turn received, up to
   **three times**. After reaching the limit, stay silent (do not show a banner
   continuously).
2. **Manual retry**: always provide a “Refetch model list” button in the model
   switcher UI, so the operator can explicitly trigger it. A button trigger resets
   the retry count.
3. **Notification**: when the limit is reached, notify failure once with a
   dismissible toast. Do not show another toast for later automatic retry failures.

The precise UI placement (retry-button position and toast appearance) is decided in
the phase-18-3 implementation PR.

### F7 — Upgrade the SDK in a preceding PR, then reduce BOOTSTRAP

The `@anthropic-ai/claude-agent-sdk` installed in the `wrapper` package is currently
0.3.162 (`^0.3.162` is specified and the lockfile fixes it). The latest npm version
is approximately 0.3.208. **First** land an SDK upgrade PR, and verify the measured
`supportedModels()` result and the SDK resolution semantics of `model: "default"`.
Then use those measurements as the basis for a follow-up BOOTSTRAP-reduction PR.

Do not perform both in one PR, so behavior changes from the SDK upgrade can be
separated from the effects of reducing BOOTSTRAP.

### F8 — Fallback when a persisted model identifier is absent from the SDK measurement

If a `model` identifier persisted in session state / config (for example,
`sonnet[1m]`) is absent from the SDK measurement after startup, fall back to
`default` during startup validation and emit a notification event to the UI. Decide
the notification granularity (one toast / session log / explicit dialog) in the
phase-18-3 implementation PR.

At this ADR’s creation (2026-07-14), persisted values were assumed to be aliases
only, but after the F9 addendum either aliases or canonical IDs may occur. Check in
two passes: exact `value` match → `resolved_model` match; fall back only when neither
matches. If a canonical ID matches multiple rows, it is **valid when at least one
row matches**, and must not roll back: persistence validation asks whether the
identifier exists in the catalog, not which row owns it. Keep the wire value of
`switch_error.reason` as `"persist_alias_unknown"` for compatibility.

### F9 (2026-07-31 addendum) — Pass canonical ID through catalog rows and make matching two-pass

The measured `resolvedModel` values (`default` → `claude-opus-4-8[1m]`, `sonnet`
→ `claude-sonnet-5`) from Context were dropped in projection and never appeared on
the wire. This caused two concrete problems:

1. F8 persistence validation checked only exact `value`, so a persisted canonical ID
   was misclassified as an “unknown catalog alias” and rolled back to `default`.
2. When `#model` became canonical (init / status reports canonical, the operator
   directly calls `setModel` with canonical, or the value arrives at next startup
   through a resume snapshot), catalog matching missed on every path. The actual
   representation of `model` in `system/init` has not been observed (see below), so
   this is a conditional defect based on the existence of paths where canonical IDs
   may appear.

Add optional `resolved_model?: string` to `EngineModelInfo` and change matching to
“exact `value` match → `resolved_model` match” in two passes.

The canonical side may have **multiple matches**. A real probe resolves `default`
and `opus[1m]` to the same canonical ID, so this is normal, not an exception.
Therefore pass (2) returns all matching rows and folds them per use: membership /
persistence validity is valid with at least one match; the effort domain is the
intersection across matches (empty if even one row lacks `effort_levels`);
`supports_effort_switch` is `false` when that intersection is empty; the UI uses
alias primary + canonical secondary only for exactly one match, while for multiple
matches it displays the raw canonical ID as primary and sets model-menu
`aria-selected` to `false` on every row (the attribute exists but none is selected).
Send / retain the input representation regardless of match count.

Reject selecting the first match. It is deterministic but has no semantic basis,
and would display a pinned `opus[1m]` as floating `default` — the same semantic
destruction as the rejected normalisation below, performed in the display path
rather than the send path. The detailed rule is in the relevant section of
[plugin-model](../specs/plugin-model.md).

F4’s “keep the protocol schema as-is” concerns the `EngineCatalogEntry` container
shape (array, possibly empty); adding one optional row field does not conflict with
it. Old producers omit the field and old consumers simply drop it, preserving
backward compatibility.

Also make **input-representation preservation** an explicit contract. Use catalog
matching only to decide the effort domain and unknown-model status; preserve exactly
the string received from the caller for the value sent to the SDK and for storage.
Do not normalise in either alias ↔ canonical direction — canonical → alias is not
one-to-one, and normalisation would turn an `opus` pin into a floating `default`
selection.

Real, tokenless measurement on 2026-07-31 confirmed that a canonical ID is accepted
by both pre-init `Options.model` and live `Query.setModel()`. The representation of
`model` in `system/init` is unresolved because observing it incurs cost; keep tests
such that either alias or canonical is safe.

The specification SSOT is the relevant section of [plugin-model](../specs/plugin-model.md),
and measured raw values are in [agent-sdk-events](../specs/agent-sdk-events.md).
Do not show canonical IDs in LaunchDialog because of precision differences (the
register path uses the last-known-good cache from the last successful probe and may
remain unchanged after TTL expiry); externalise this to Gitea
[issue #166](https://github.com/sakuraiyuta/kaoiro/issues/166).

## Consequences

### Positive

- Eliminate manual BOOTSTRAP snapshot updates whenever models such as Sonnet 5 are
  added.
- Make SDK measurement the single source of truth for the Claude live path, accurately
  reflecting account-dependent resolution (plan / team / entitled model).
- Keep the change local without touching protocol schema / server / client / Codex,
  with the affected area centred on the Claude wrapper. **Addendum (2026-07-31, F9):**
  this “local” claim is partly broken by F9. The actual state now keeps server and
  Codex unchanged while adding one optional field (`resolved_model`) to the
  `EngineModelInfo` row in protocol, and changing the client’s `modelsFrom` projection
  plus model-row display and matching. The container shape (F4) and no-change server /
  Codex remain.
- Retain the `default` entry as a safe fallback, so model selection never has zero
  entries either before or after init.

### Negative

- Accept the UX discrepancy that an effort selected before init can disappear from
  the choices after init (F5, [claude-effort-levels-init-transition](../open-questions/claude-effort-levels-init-transition.md)).
- In LaunchDialog, before init only “Default” is shown, so a specific model such as
  Sonnet 5 cannot be preselected. Select it through a post-init mid-session switch.
  **Addendum (2026-07-31, [ADR-0039](0039-engine-catalog-live-probe.md))**: this
  constraint is resolved. The runner’s short-lived probe + memory cache normally
  provides a rich live-probe catalog in LaunchDialog, allowing a specific model to
  be preselected. “Default” alone is shown only when no successful cache exists
  (cold start / first probe failure).
- Wrapper complexity increases by the retry implementation.

### Neutral

- Codex catalog behavior does not change (ADR-0035 F1 is retained).
- Protocol schema (`EngineCatalogEntry`) is unchanged and backward compatibility is
  fully preserved.
- BOOTSTRAP reduction depends on the SDK upgrade (F7); Sonnet 5 support depends on
  SDK follow-up.

## Alternatives Considered

| Option | Decision |
|--------|----------|
| Remove BOOTSTRAP entirely + introduce comprehensive loading UI | Reject. (i) The Register path cannot measure because no SDK Query is created (chicken and egg); loading soft-lock risk; loss of the `default` effort_levels source; expansion to seven layers of protocol / server / client / tests / docs. **Addendum (2026-07-15, ADR-0039):** “cannot measure” precisely means impossible under the “register-only (never create a query)” premise. A short-lived SDK probe on the runner (create a query in streaming input mode, then supportedModels() after init and close) can enrich the Register catalog. ADR-0039 adopts that path (Option E) while retaining the minimal BOOTSTRAP floor. |
| Keep the current behavior (manually update the BOOTSTRAP snapshot) | Reject. Manual updates on every model addition are not realistic (the breakage immediately after Sonnet 5 is an example). |
| Make `EngineCatalogEntry.models?` optional or add a readiness flag | Reject. It confuses Codex’s meaningful empty state with Claude’s not-loaded state and breaks the fail-closed default. `LaunchDialog.svelte:127` already accepts empty, so it is unnecessary. |
| Unify measurement including Codex | Reject. Regresses the settled decision in ADR-0035 F1; `codex doctor --json` does not return entitled models and it is technically impossible. |
| Upgrade the SDK and reduce BOOTSTRAP in the same PR | Reject. Mixed behavior changes make impact separation difficult. |
| Set effort_levels of the `default` entry to empty (disable the pre-init effort switcher) | Reject. It is inconvenient to configure effort before init and removes the fresh-idle-agent switcher source. |
| Fix effort_levels of the `default` entry to three levels: low/medium/high | Reject. It prevents using xhigh/max before init and sacrifices too much expressiveness. |
| No retry limit | Reject. SDK bugs could cause unbounded calls. |
| Always show a failure banner | Reject. Excessive for idle agents and misleading. |
| Be completely silent on failure | Reject. The user would not notice that it is broken. |

## Implementation

Implement in three phases (SDK upgrade + measurement verification / wrapper changes /
client UI changes) under [phase-18-claude-model-catalog-live](../plans/phase-18-claude-model-catalog-live.md).
Phase 18-2 measurement (2026-07-14) already confirmed that the `default` alias
resolves to `claude-opus-4-8[1m]` (see Context in this ADR).
