---
title: Make the LaunchDialog model catalog live with a short-lived SDK probe + runner memory cache (Option E)
status: accepted
date: 2026-07-15
opened: 2026-07-15
supersedes: []
superseded_by: null
related_specs: [protocol, plugin-model]
related_adrs: [23, 32, 35, 37, 40]
---

# ADR-0039 — Make the LaunchDialog model catalog live with a short-lived SDK probe + runner memory cache (Option E)

## Status

Accepted (2026-07-15, approved by マスター). Implementation is
[phase-20-engine-catalog-live-probe](../plans/phase-20-engine-catalog-live-probe.md).

## Context

[ADR-0037](0037-claude-model-catalog-live-refresh.md) F1 reduced the Claude model
catalog in LaunchDialog to a BOOTSTRAP containing only one `default` entry. The
reason was the chicken-and-egg constraint that the Register path cannot call
SDK.supportedModels() because no wrapper Query has been created. Combined with the
fact that F2’s live path (`ext.models` measured by
`AgentHost.#refreshSupportedModels()`) works only per agent, this fixed the
LaunchDialog opened by a new operator to “default” alone.

Investigation through kaoiro peers (2026-07-15) found the following:

- The `Query` interface of `@anthropic-ai/claude-agent-sdk@0.3.208` has
  `initializationResult(): Promise<SDKControlInitializeResponse>` /
  `supportedModels(): Promise<ModelInfo[]>` / `close(): void`.
- `SDKControlInitializeResponse.models` already contains the catalog.
- `Query` requires `prompt: string | AsyncIterable<SDKUserMessage>`, and control
  requests work only in streaming input mode (only when an `AsyncIterable` is
  supplied). Passing an AsyncIterable that never resolves sends no user_message;
  after init completes, only the control request can be issued and then closed.
- An empirical spike (phase-20-1) measured that a short-lived probe without sending
  a prompt works: init+supportedModels ~1.4s, complete subprocess cleanup after
  close, zero `~/.claude/projects/` difference, no tmpdir contamination, and
  OAuth/keychain authentication succeeds (details are in the phase-20-1 record).

Therefore, ADR-0037’s “impossible in principle” is more precisely “impossible
under the register-only premise (never create a query)”. A **short-lived SDK probe**
on the runner can enrich the Register-path catalog.

Constraints:

- Keep the Codex-side decision from [ADR-0035](0035-codex-model-catalog-and-mid-session-switch.md)
  F1: a static catalog, based on operator plan declaration and independent of runtime
  probes (technically impossible because `codex doctor` cannot return entitled
  models). Apply the live probe only to Claude.
- `settingsSources` was not found in SDK 0.3.208 `Options` (real measurement,
  confirmed by 藤 turn-5), and user settings are always loaded even in the probe
  subprocess. Minimise side effects with cwd isolation + `mcpServers: {}` /
  `tools: []` / `hooks: undefined`, etc. Do not use `--bare`: it skips keychain
  reads and disables OAuth (a previous proposal was withdrawn).
- As with Codex `AGENTS.md` peer-first routing (ADR-0038), the probe subprocess
  uses the auth context held by the runner. Assume that runner auth and the wrapper
  auth used when the operator spawns an agent point to the same account. A
  multi-account host retains the risk of account mismatch (the same structure as
  ADR-0038).

## Decision

### F1 — Option E: runner-only orchestration (no server cache)

Make the runner memory cache the catalog SoT. Reject Option D, which adds a
per-host warm-cache GenServer to the server (it adds (host, engine) precedence
decisions / TTL / probe-wrapper consistency checks / writes through the envelope
path, without value matching the complexity). Complete the design with existing
`HostRegistry` engine storage and register retransmission through
`RunnerLink.updateRegister()`.

### F2 — Extract a short-lived probe CLI into `@kaoiro/claude-code`

Create `wrapper/claude-code/src/probe.ts` and publish it as
`bin: kaoiro-claude-probe`. The runner starts it as a child process with
`spawn(process.execPath,
[require.resolve('@kaoiro/claude-code/dist/probe.js'), ...])`,
keeping the direct dependency on `@anthropic-ai/claude-agent-sdk` inside the
wrapper side (the runner package does not add the SDK as a dependency). The probe
returns one line of JSON on stdout and uses exit 0 = success / 1 = failure.

### F3 — Use init.models as the primary probe source, supportedModels() as fallback

Because the response from `initializationResult()` already includes the catalog in
`SDKControlInitializeResponse.models`, use it first. Call `supportedModels()` only
when init.models is empty / undefined / missing, providing resilience to changes in
the SDK response shape. Do not fetch the same control request twice unnecessarily
(the design point from 藤 turn-5).

### F4 — Probe Options: minimise side effects while retaining OAuth/keychain

Start the SDK query with these Options:

- `cwd`: a newly created isolated tmpdir
  (`os.tmpdir()/kaoiro-claude-probe-<pid>-<ts>`), deleted in finally. Prevent
  project settings / CLAUDE.md activation / session-file contamination.
- `mcpServers: {}` / `tools: []` / `allowedTools: []` / `disallowedTools: []`
  / `agents: {}` / `additionalDirectories: []` / `hooks: undefined`.
- Do not specify `env` (the SDK inherits `process.env`) to preserve keychain /
  OAuth / API-key authentication paths.
- `settingsSources` was not found in SDK 0.3.208 (measured); user settings are
  always loaded. There is no additional suppression mechanism.

Do **not** adopt the `--bare` equivalent (it skips keychain reads and disables
OAuth).

### F5 — Runner memory cache: TTL 1h, last-known-good, deduplication

`runner/src/claude_catalog_cache.ts` is a memory-only cache of engine →
`{ models, fetchedAt }` (no disk persistence). The default TTL is one hour. Only
the runner evaluates TTL (the client requests auto-refresh each time and the runner
decides whether to skip).

- `force=false` (LaunchDialog auto-refresh): skip the probe and immediately return
  `ok=true` when the cache is fresh; run the probe on stale/missing cache.
- `force=true` (LaunchDialog manual button): run the probe regardless of TTL.
- Concurrent refreshes are consolidated into one subprocess through a runner-level
  Mutex + shared in-flight Promise (deduplication).
- Do not update the cache on probe failure (retain last-known-good). Retry on the
  next refresh request.

### F6 — Protocol events: `refresh_engine_catalog` + `catalog_result`

Add these two types to `protocol/src/index.ts`:

- `RefreshEngineCatalog { version, engine, request_id, force? }` — client →
  server → runner. Address host_id by topic (agents_channel determines the runner
  topic from the payload’s `host_id`).
- `EngineCatalogResult { version, host_id, engine, request_id, ok, reason?,
  models_count? }` — runner → server → operators (agents:lobby, operator-only).
  Failure uses the closed vocabulary (`EngineCatalogFailReason` = `auth_failed` /
  `spawn_failed` / `cli_error` / `invalid_output` / `timeout` /
  `unsupported_engine`).

`models_count` is a size-only signal for the toast and does not contain model names
or other details (the catalog itself travels in the existing `hosts` broadcast).

### F7 — Keep the server as a thin relay

Add `handle_in("refresh_engine_catalog", ...)` to `agents_channel.ex` using the
existing `relay_to_runner_guarded` pattern (operator-only, strip host_id and
broadcast to `runner:<host_id>`). Add `handle_in("catalog_result", ...)` to
`runner_channel.ex` using the existing `forward_to_operators` pattern (stamp host_id
and broadcast to `agents:lobby`). Delegate engine validation to the runner (Option E
makes runner the SoT; server remains engine-agnostic). Add `catalog_result` to
`agents_channel` `intercept` and `handle_out` to guarantee operator-only delivery.

### F8 — Client: auto-refresh on open + Claude-only button + default fallback

When `engine === "claude-code" && hostId !== ""`, `LaunchDialog.svelte` fires
`connection.refreshEngineCatalog(hostId, engine, false)` automatically. The manual
button uses `force=true`. Show the button only when Claude is selected (Codex has a
static catalog, so it has no meaning there). On probe failure, retain the existing
one-entry `default` fallback (LaunchDialog already renders with
`engineModels ?? []`).

The catalog naturally repopulates through the `hosts` broadcast produced when the
runner calls `updateRegister`. A `catalog_result` toast (models_count on success /
reason on failure) can be handled by hooking `onCatalogResult` at the parent layer,
but keep this phase minimal and display errors inside LaunchDialog (a detailed toast
is future work).

## Consequences

### Positive

- The Claude model catalog in LaunchDialog follows live measurements, so new models
  such as Sonnet 5 appear without manual updates.
- Complete within the existing `RunnerLink.updateRegister()` + `HostRegistry`
  upsert + `hosts` broadcast boundary, without adding a server-side cache.
- Keep the SDK direct dependency in the wrapper package; the runner only spawns an
  engine-agnostic child process, minimising runner changes when engines are added.
- Preserve every authentication path (OAuth / keychain / API key) by not adopting
  `--bare`.
- Keep TTL / deduplication in runner memory with minimal complexity (no server cache
  or disk persistence).
- Zero session/history contamination (zero files measured in the spike), with no
  cost (the control request does not call REST).

### Negative

- A multi-account host may point runner auth and the wrapper auth used by the
  operator to different accounts, so catalog mismatch remains possible (not on a
  single-account host).
- The cache is empty when the runner starts. The first LaunchDialog open runs the
  probe and causes ~1.5s of waiting time (shown by the auto-refresh spinner).
- SDK subprocess spawn overhead (~1s) occurs on cache misses.

### Neutral

- Keep the `default` fallback, so LaunchDialog remains usable even when probing
  fails (auth not configured, etc.).
- Leave the Codex catalog unchanged (ADR-0035 F1 retained).
- Re-evaluate the no-server-cache design if future requirements arise, such as
  multiple runners sharing one engine catalog.

## Alternatives Considered

| Option | Decision |
|--------|----------|
| Option A: Resident WarmQuery in the runner | Reject. Even if subprocesses are pre-warmed in startup(), a Query can be promoted only once and cannot be reused for multiple refreshes. The maintenance cost of a resident subprocess is not justified. |
| Option C: Server-side warm cache primary | Reject. `(host, engine)` precedence / TTL / probe-wrapper consistency checks / envelope-path writes add complexity without matching value (藤 turn-3). Runner-cache last-known-good provides equivalent resilience. |
| Option D: Hybrid (server cache primary + runner probe fallback) | Reject. It is the combined proposal with C as primary; once C is rejected, it is unnecessary. |
| REST `/v1/models` (`@anthropic-ai/sdk`) | Reject. It is unavailable in OAuth-only environments without `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`. The SDK subprocess has a broader auth path. |
| Adopt the `--bare` equivalent for the probe | Reject. It skips keychain reads and disables OAuth, causing probe auth failure in マスター’s environment (藤 turn-5 correction). |
| Implement the probe directly in the runner package | Reject. A direct runner dependency on `@anthropic-ai/claude-agent-sdk` breaks the engine boundary (regresses ADR-0032 F1 separation). |
| Validate the engine on the server side | Reject. Under Option E the runner is SoT; the server remains an agent-agnostic relay (ADR-0023 convention). |

### F9 v2 (2026-07-15, v1 rejected in 藤 review turn-5) — Immediate refresh for a fresh-idle wrapper

v1 (below) had a problem in which the initial-spawn path (A) did not refresh the
current AgentDetail view on ↻ (`refresh_engine_catalog` updated only the runner
cache and misleadingly meant “apply on next restart”). v2 adds:

- **Short-lived wrapper-side probe (B)**: extract
  `wrapper/claude-code/src/probe-client.ts` as a side-effect-free reusable launcher
  (consolidate the old `runner/src/claude_probe.ts` here; the runner uses it by
  import = one SoT, 藤 D1b). Gate probe CLI entrypoint `probe.ts` with
  `import.meta.url === process.argv[1]` so importing the library does not run main.
- **`refreshCatalogFor()` on the host**: when `#query!==null`, use existing
  `#refreshSupportedModels()` (SDK authoritative); when `#query===null`, fall back
  to `runClaudeProbe()` (child subprocess). On success, update `#models`, set
  `#modelsSucceeded=true`, and emit `#emitState` to send ext.models immediately,
  dynamically updating model/effort choices in the same AgentDetail. Coalesce
  concurrent manual refreshes into one execution through in-flight deduplication;
  each caller receives the shared outcome.
- **`refresh_models_result` envelope (D2a)**: add a new envelope type with payload
  `{request_id, ok, reason?, models_count?}`. Emit it when wrapper
  `refreshCatalogFor()` completes; make it operator-only (do not include it in the
  existing handle_out viewer allow-list, so it is automatically dropped = fail-closed).
- **Add request_id to the `refresh_models` control payload**: the existing control
  has only agent_id; the client adds a UUIDv4 when firing it, the wrapper→server ack
  passes it through, and the wrapper-side `refresh_models_result` envelope correlates it.
- **Client pending map**: create `makeRefreshPendingStore` in instance scope and
  make `connection.refreshModels()` return `Promise<RefreshModelsResult>`. Ignore
  unrelated request_id values; use a client-side timeout (45s, above the wrapper’s
  35s); drain on disconnect/error.
- **Defensive validation of A’s row shape**: in `wrapper/core/src/persona.ts`,
  validate each row per field and make a defensive copy of `claude_engine_catalog`.
  Loudly reject malformed rows.
- **AgentDetail `refreshModels()`**: remove Promise.all + `refreshEngineCatalog`
  (the source of misleading behavior). Await one `connection.refreshModels(agent_id)` → wrapper.retrySupportedModels();
  display reason when result.ok=false; keep button loading until the result arrives.
  Do not synchronise to runner cache this time (separate scopes: runner cache =
  LaunchDialog/future spawns, wrapper #models = current agent).

Side-effect boundaries (v2):

- The wrapper→probe child subprocesses are the only two processes running together
  immediately after launch (~1s); complete cleanup follows close (pinned by spike +
  probe-client test).
- The SDK-authoritative contract (when #query exists) is non-regressed and reuses
  existing `#refreshSupportedModels`.
- Do not create a runner-cache update path as a by-product of the wrapper probe
  (藤 turn-7). Runner cache remains independently updated by LaunchDialog manual
  refresh.
- Codex non-regression: unregister the `refresh_models` control on Codex (no
  refreshCatalogFor on the host; the Codex adapter does not accept refresh_models).

### F9 v1 (2026-07-15) — Transport initial catalog to the fresh-idle wrapper

After the initial shipment, dogfooding observed two symptoms:

- The model switcher in the left AgentDetail pane remained at one `default` entry
  after startup (LaunchDialog had already become live under F2-F8).
- The effort-switch button on the same screen did not appear initially (without a
  rich model set, the effort_levels source was too sparse).

Root causes: (a) the initial `#models` in `wrapper/claude-code/src/host.ts` was
hard-coded `claudeBootstrapCatalog()`, (b) the existing ↻ in `AgentDetail` reached
the running wrapper through `connection.refreshModels(agent_id) → wrapper.retrySupportedModels()`; it did nothing for a fresh-idle wrapper because
`deferQueryUntilFirstInput` left `#query=null`; `#refreshSupportedModels()` was a no-op, and (c) runner
`ClaudeCatalogCache` supplied only the Register path and did not relay into
`WrapperConfig` at spawn time.

Add:

- Add `WrapperConfig.claude_engine_catalog?: EngineModelInfo[]`
  (`protocol/src/index.ts`). Relay runner live-cache last-known-good at
  spawn/restart/relaunch.
- Validate shape only and set it in `wrapper/core/src/persona.ts`.
- In the `wrapper/claude-code/src/host.ts` constructor, set
  `#models = config.claude_engine_catalog ?? claudeBootstrapCatalog()`. Make the
  initial `state_change.ext.models` rich so AgentDetail can surface multiple
  models + each model’s effort_levels immediately after startup. Existing
  `supportedModels()` success continues to overwrite it through F2.
- Add `getClaudeEngineCatalog?: () => EngineModelInfo[] | null | undefined`
  (live getter) to `SupervisorOptions` / `SupervisorRuntimeUpdate` in
  `runner/src/supervisor.ts`; add `claudeEngineCatalog` as the seventh argument to
  `resolveWrapperConfig`; pass the cache getter at all four call sites. For
  engine !== "claude-code" / null / undefined / empty array, omit it from
  WrapperConfig and fall through to bootstrap.
- Pass `getClaudeEngineCatalog: () => claudeCatalog.getStale()` to the supervisor
  in `runner/src/cli.ts`, and specify the same getter again in hot-reload
  `updateRuntimeConfig`.
- Extend `dashboard/src/lib/AgentDetail.svelte` `refreshModels()` to fire two paths
  in parallel when the Claude engine is selected: (i) existing `refreshModels`
  (for a running wrapper; effectively a no-op for fresh-idle), and (ii)
  `refreshEngineCatalog(hostId, "claude-code", true)` to update runner cache live
  (applied on the next restart/spawn). Do not fire it for Codex (static catalog).

Side effects / boundaries:

- Preserve ADR-0039’s SoT contract (runner owns catalog SoT). Only transport cache;
  do not add a new wrapper probe or server-side warm cache.
- Empty catalog / cache miss (cold start) uses the bootstrap fallback for the same
  UX as LaunchDialog.
- Once SDK measurement succeeds, it is authoritative (no F2 contract change or
  regression).
- Codex non-regression: do not pass a codex_engine_catalog equivalent through the
  `parsed.engine === "claude-code"` gate.

### F10 (2026-07-31 addendum) — Pass canonical IDs through the probe path too

Following the addition of `EngineModelInfo.resolved_model` in
[ADR-0037](0037-claude-model-catalog-live-refresh.md) F9, pass the same field
through this ADR’s probe path. The targets are F3’s projection (`probe.ts`
`projectModel()`) and the `host.ts` `#executeManualRefresh()` used by F9 v2
fresh-idle manual refresh. `probe-client.ts` `parseProbeStdout()` passes rows
through as objects, so no implementation change is needed there; add a regression
test to prevent a future whitelist from silently dropping the field.

The F5 runner memory cache passes `EngineModelInfo[]` through unchanged. F6 / F7
event / relay paths are also unchanged, and the server (Elixir) is untouched because
`runner_channel.ex` validates and retains engines only in the `%{"id", "models"}`
shape.

Separate wire and UI. `resolved_model` is **passed through** even in catalog rows on
the Register path (probe → cache → register payload). But **do not display it in
LaunchDialog**. The cache’s value is from the last successful probe and can remain
after TTL expiry, while init-after measurement has different precision; in
particular the `default` row follows the account recommendation and can make the
displayed value differ from the launched result. Do not stop passing it through:
changing the row shape by path would force consumers to branch on anything other
than “absent = unknown”. Make display a separate UX decision and externalise it to
Gitea [issue #166](https://github.com/sakuraiyuta/kaoiro/issues/166) (details are in
the relevant section of [plugin-model](../specs/plugin-model.md)).

## Implementation

[phase-20-engine-catalog-live-probe](../plans/phase-20-engine-catalog-live-probe.md).
Implement through kaoiro peer delegation by kuroe, with fuji responsible for review
and Git decisions. Commit / push / branch require fuji approval.

The empirical spike in Phase 20-1 (2026-07-15) reconfirmed this ADR’s premise:
short-lived probing without sending a prompt works on SDK 0.3.208, with zero
session-file difference, zero tmpdir contamination, complete subprocess cleanup
after close, and successful OAuth authentication.

An independent real probe run by the kaoiro peer fuji also reconfirmed the result
(redacted record): PASS / exit 0 / elapsed ~1.59s / 6 models / zero file-count
difference under `~/.claude/projects` / no personal-information output / no probe
residual process. Confirmed that the F4 Options configuration (cwd isolation +
`mcpServers: {}` / `tools: []` / retained OAuth) works in the operator’s real
environment as measured.
