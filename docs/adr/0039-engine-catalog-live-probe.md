---
title: Launch the relevant entry model catalog with short-live SDK probe +   memory cache (Option E)
status: accepted
date: 2026-07-15
opened: 2026-07-15
supersedes: []
superseded_by: null
related_specs: [protocol, plugin-model]
related_adrs: [23, 32, 35, 37, 40]
---

# ADR-0039 — Launch Model model catalog with short-live SDK probe +  live memory cache (Option E)

## Status

Accepted (2026.-15, master decision).Note
[phase-20-engine-catalog-live-probe](../plans/phase-20-engine-catalog-live-probe.md).

## Context

[ADR-0037](0037-claude-model-catalog-live-refresh.md) F1 is Launch
Reduced Claude model catalog to BOOTSTRAP for `default` 1 entry. Reason
"register path is not wrapper Query, so the SDK.supportedModels() is
It is a live of chicken and egg that can not be called, which is a live path of F2 (`ext.models`)
`AgentHost.#refreshSupportedModels()` only for per-agent
Always "default" the Launch  that the fresh operator opens in conjunction with the fact that it does not work
fixed only.

kaoiro er crossover investigation (2026 -15) found the following:

- `@anthropic-ai/claude-agent-sdk@0.3.208` `Query` interface
  `initializationResult(): Promise<SDKControlInitializeResponse>` /
`supportedModels(): Promise<ModelInfo[]>` / `close(): void`
- `SDKControlInitializeResponse.models` contains catalog.
- `Query`string|AsyncIterable<S UserMessage>`
control request specified streaming input mode (`AsyncIterable`)
if only works). not resolve If you specify AsyncIterable, user message is
It can be close by tapping only control request after init completion.
- Empirical spike (phase-20-1) has a short-lived probe
init+supportedModels ~1.4s, close after subprocess complete cleanup,
`~/.claude/projects/` Difference 0, tmpdir Pol  0, OAuth/keychain success (Details)
phase-20-1).

Accordingly, "in principle impossible" of ADR-0037 is exactly "register-only premise (query
is not possible onrate**SDK Probe**Note
When running, the catalog of the register path can be richened.

As :

[ADR-0035](0035-codex-model-catalog-and-mid-session-switch.md)
Holding a static catalog of F1 (`codex doctor`)
operator plan live probe
Claude
- SDK 0.3.208 `Options` does not find `settingsSources`
Note turn-5 confirm), user settings are always loaded on probe subprocess.
Minimizing side effects is cwd isolation + `mcpServers: {}` / `tools: []` / `hooks: undefined`
permission `--bare` skips keychain reads to return OAuth
Cannot be used for probes. (I have proposed incorrectly in the previous survey but has been withdrawn.)
Codex `AGENTS.md`
subprocess uses the auth context that   keeps.   auth and
assume that the auth of the wrapper that the operator spawns points to the same account.
multi-account host has the risk of account mismatch (same as ADR-0038).

## Decision

### F1 — Option E:  -only orchestration (without   cache)

catalog SoT is   memory cache. server to per-host warm cache
Adding GenServer Option D leaves (`(host, engine)` precedence judgment /
TTL / probe and wrapper consistency check / write to envelRoute path
not worth meeting complexity. `HostRegistry`
`RunnerLink.updateRegister()`

### F2 — short-lived probe CLI`@kaoiro/claude-code`Cut out

`wrapper/claude-code/src/probe.ts`
permission   as child process`spawn(process.execPath,
[require.resolve('@kaoiro/claude-code/dist/probe.js'), ...])`start
Close the direct dependency to `@anthropic-ai/claude-agent-sdk` to the wrapper side (
package does not add dependency to the SDK. probe is one line JSON to stdout
return the result, exit 0 = success / 1 = failure.

### F3 — probe fallback with supportedModels()

`initializationResult()`
probe is used first because it is already included. init.models empty / undefined / missing
Add `supportedModels()` only if (S  response shape resistant to change).
Don’t get the same control request wasted double (design pointed out of Rattan turn-5).

### F4 — Probe Options: Minimum side effects + OAuth/keychain retention

Start SDK query with the following options:

- `cwd`: tmpdir (`os.tmpdir()/kaoiro-claude-probe-<pid>-<ts>`),
Delete with finally. project settings / CLAUDE.md ignition / session file contain..
- `mcpServers: {}` / `tools: []` / `allowedTools: []` / `disallowedTools: []`
  / `agents: {}` / `additionalDirectories: []` / `hooks: undefined`.
- `env` Unspecified (S  inherits `process.env`) — keychain / OAuth / API-key
auth Hold the route.
- `settingsSources` is not found in the SDK 0.3.208 and user settings
Always loaded. No additional deter .

`--bare`****skip keychain reads to return OAuth.

### F5 — runner memory cache: TTL 1h,last-known-good,dedup

`runner/src/claude_catalog_cache.ts` is the engine → `{ models, fetchedAt }`
memory-only cache TTL Default 1 hour. TTL
only (client throws auto-refresh every time, and   is
skip).

- `force=false` (Launch  auto-refresh):
`ok=true`Homele/
- `force=true` (Launch  manual button): Probe execution with TTL ignore.
-  -level Mutex + in-flight Promise Share 1 subprocess
dedup.
- Do not update cache when probe failure (retain last-known-good). Next refresh request
I can challenge again.

### F6 — protocol event: `refresh_engine_catalog` + `catalog_result`

`protocol/src/index.ts` adds the following two types:

- `RefreshEngineCatalog { version, engine, request_id, force? }` — client →
server host id is addressing (agents channel is
topic from `host_id` of payload.
- `EngineCatalogResult { version, host_id, engine, request_id, ok, reason?,
  models_count? }` — runner → server → operators (agents:lobby, operator-only).
failure is closed vocabulary (`EngineCatalogFailReason` = `auth_failed` /
  `spawn_failed` / `cli_error` / `invalid_output` / `timeout` /
  `unsupported_engine`).

`models_count` is a size-only signal for toast, and does not include details such as model names
`hosts`

### F7 — server closes to thin relay

`agents_channel.ex` `handle_in("refresh_engine_catalog", ...)`
Add to `relay_to_runner_guarded` pattern (operator-only, host id)
`runner:<host_id>` to broadcast) `runner_channel.ex`
`handle_in("catalog_result", ...)` with existing `forward_to_operators` pattern
Add (host id stamp to `agents:lobby`). engine validation
delegate to   (Option E with  engine SoT,  engine is engine-agnostic).
`intercept` and `handle_out`
operator-only guarantees the delivery.

### F8 — client: auto refresh on open + Claude limited button + default fallback

`LaunchDialog.svelte`
`connection.refreshEngineCatalog(hostId, engine, false)`
fire. Manual button is fired with `force=true`. Claude engine
Display only when selected (Codex does not mean static catalog or Codex). Probe failure
when pre-existing `default` 1 entry fallback (Launch  is
`engineModels ?? []`

catalog body `hosts` broadcast of the result runner called `updateRegister`
repopulated naturally. `catalog_result` toast (success time models count /
failure reason) can handle `onCatalogResult` in the parent layer,
In this phase, the minimum implementation is set to the error display in Launch  (more
toast

## Consequences

### Positive

- Launch Model Claude model catalog follows live survey (Sonnet 5, etc.)
New model can be displayed without manual update).
- Existing `RunnerLink.updateRegister()` + without adding Server-side cache
`HostRegistry` `hosts`
- Probe closes the SDK directly dependencies to the wrapper package and the engine is engine-agnostic
only child process spawn. Minimize  engine changes when adding engine.
- All auth routes of OAuth / keychain / API-key are not collected (`--bare`)

- Close TTL / dedup to TT memory and minimize complexity (TT cache / disk)
persist None).
- session/history zero files (0 files in keke), no charge (control)
REST not called in request).

### Negative

- Multi-account host wrapper auth and operator spawn wrapper auth
may point to a different account, and the catalog can be lost with probe and wrapper
risk (not generated with a single account host).
- Runner cache empty when running. The first Launch  open
~1.5s wait timedisplay (display with auto-refresh spinner).
- SDK subprocess spawn's overhead (~1s) occurs when cache miss.

### Neutral

- `default` fallback is preserved, so it can be probe failure environment (auth unset, etc.)
Launch
- ADR-0035 F1
- Design without server-side cache is the same engine for future requirements (multiple  engines)
re-evaluate if catalog is shared.

## Alternatives Considered

| Option | Decision |
|--------|----------|
|Option A:   Resident Warm ry|Reject. Even if subprocess is pre-warm in startup(), Query escalation is limited to one time, and can not be used for multiple refresh. subprocess maintenance|
| Option C: server-side warm cache primary |Reject. (host, engine) The consistency of precedence / TTL / probe and wrapper is increased, and the write to envelRoute path is not worth the complexity.   cache last-known-good resilience is equivalent|
| Option D: hybrid (server cache primary + runner probe fallback) |Reject. A composite with C primary above. No need when you leave C|
| REST `/v1/models` (`@anthropic-ai/sdk`) |Reject. OAuth-only environment`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`Not available. SDK subprocess|
| `--bare`adopt to probe|Reject. To skip keychain reads and return OAuth, the probe becomes auth failure in the master environment (Fuji turn-5 correction)|
|Directly implement probe to   package|Reject.  `@anthropic-ai/claude-agent-sdk`The engine boundary can be broken if it is directly dependent on (return ADR-0032 F1 separation)|
|engine validation|Reject.   is SoT with Option E. The server should keep the agent-agnostic relay (ADR-0023 custom)|

### F9 v2 (2026-15-15, Fuji review turn-5, v1 is rejected) — instant refresh of fresh-idle wrapper

v1 (below) is the initial spawn route (A) only, the current screen is
`refresh_engine_catalog` does not update only   cache
Fixed an error). v2 adds:

- **wrapper side short life probe (B)**: `wrapper/claude-code/src/probe-client.ts`
extracted as reusable launcher without side effects (formerly `runner/src/claude_probe.ts`)
= SoT uniformization, Note D1b) Probe CLI
entrypoint `probe.ts`
The library import does not run main.
- **host `refreshCatalogFor()`**: `#query!==null`
`#refreshSupportedModels()` (S  authoritative)
`runClaudeProbe()` (child subprocess) success `#models`
send ext.models immediately with update + `#modelsSucceeded=true` + `#emitState`,
Dynamic update of the same AgentDetail model/effort option. in-flight dedup
concurrent manual refresh is 1 execution to coalesce, each caller is shared
Receive outcomes.
- **`refresh_models_result` envelope (D2a)**: New envelope  type, payload =
`{request_id, ok, reason?, models_count?}` wrapper
`refreshCatalogFor()` only (existing handle out)
viewer allow-list automatically drop = fail-closed).
- **`refresh_models` add request id for control payload**: Existing control
Only agent id, client is UUIDv4 fire, wrapper→cli ack
Corres s with the transmittance and wrapper side `refresh_models_result` envelope .
- **client pending map**: `makeRefreshPendingStore` in instance scope
`Promise<RefreshModelsResult>`
Note unrelated request id ignore, client-side timeout (45s, wrapper) 35s
top), disconnect/error.
- **AHome  shape defensive validation**: `wrapper/core/src/persona.ts`
per-field  + defensive
copy. malformed
- **AgentDetail `refreshModels()`**: Promise.all + `refreshEngineCatalog`
Abolished (the source of false induction). await single `connection.refreshModels(agent_id)`,
result.ok=false is a UI display, button loading is
Maintenance. the relevant entry cache =
  LaunchDialog/future spawn,wrapper #models = current agent).

Side Effect Boundaries (v2):

- wrapper→probe child subprocess only for launch   (~1s)
Complete cleanup (with keke + probe-client test)
- SDK authoritative contract (#query) is non-re ,
`#refreshSupportedModels`
- wrapper cache does not create an update path as a byproduct of probe wrapper
(Fuji turn-7) Launch  manual refresh
- Codex non-re : `refresh_models` control is unregister (host) on Codex
codex adapter does not receive refresh models).

### F9 v1 (2026 -15) — initial catalog transport to fresh-idle wrapper

The following two symptoms were observated in the first shipment after dogfood:

- AgentDetail Left pane model switch to `default` 1 entry
(F2-F8)
- The same screen effort switch button is not displayed for the first time (without the Rich model group)
effort levels due to poor source

Cause: (a) `wrapper/claude-code/src/host.ts` `#models` initial value
`claudeBootstrapCatalog()` Hardcode, (b) `AgentDetail`
`connection.refreshModels(agent_id) → wrapper.retrySupportedModels()`
running wrapper, but fresh-idle wrapper is `deferQueryUntilFirstInput`
for `#query=null` `#refreshSupportedModels()` is no-op, (c)
`ClaudeCatalogCache` only supplies to register routes, and when spawn `WrapperConfig`
I did not put it.

Contents:

- Add `WrapperConfig.claude_engine_catalog?: EngineModelInfo[]`
(`protocol/src/index.ts`)  live live cache last-known-good
spawn/restart/relaunch
- Shape-only validation + set with `wrapper/core/src/persona.ts`.
- `wrapper/claude-code/src/host.ts` constructor
  `#models = config.claude_engine_catalog ?? claudeBootstrapCatalog()`.
When AgentDetail is started because it becomes rich from the first `state_change.ext.models`
Multiple models + each effort levels can be surfaced. SDK
`supportedModels()` success will continue to overwrite the existing route (F2).
`SupervisorOptions` / `SupervisorRuntimeUpdate`
`getClaudeEngineCatalog?: () => EngineModelInfo[]| null | undefined`
`claudeEngineCatalog`
Pass cache getter on an additionalSite Map call site. engine == "claude-code" /
null / undefined / empty array falls to boots
Close
`getClaudeEngineCatalog: () => claudeCatalog.getStale()`
pass to supervisor and getter in hot-reload `updateRuntimeConfig`
Respecify.
- `dashboard/src/lib/AgentDetail.svelte` `refreshModels()`
Claude engine Determination extends to 2 routethe relevant entry ignition: (i) Existing `refreshModels`
(real no-op for running wrapper, fresh-idle), (ii)
`refreshEngineCatalog(hostId, "claude-code", true)`
live update (reviewed with next restart/spawn). Codex does not ignite (static catalog).

Side Effects / Boundaries:

- ADR-0039 SoT contract ( catalog is catalog SoT) is maintained. cache
New probe / server-side warm cache
- catalog empty / cache miss (cold start) is launched in boots  fallback
UX
- If the SDK is success, then authoritative (not recursive).
- Codex non-re : `parsed.engine === "claude-code"` gate with codex   catalog
not flowing.

### F10 (2026 -31) — Transmit canonical ID

[ADR-0037](0037-claude-model-catalog-live-refresh.md) F9
`EngineModelInfo.resolved_model` has been added, and this ADR probe path
Transmit the field. F3 projection (`probe.ts` `projectModel()`)
`host.ts` `#executeManualRefresh()`
2 places. `probe-client.ts` `parseProbeStdout()` passes object as object
No need to change the implementation, but the re  test to prevent the future of whitelisting and
permission

memory cache of F5 is unchanged because `EngineModelInfo[]` is used.
F6 / F7 event / relay is unchanged and event is `runner_channel.ex`
`%{"id", "models"}` is not touch because it only verifies the shape of the engine.

wire and UI. `resolved_model`
**Trans **(probe → cache → register payload) Launch
not display in UI. cache's "last-successed probe point" resolution
`default`
The line is because the display value and the startup result are misaligned with account recommendation. If the shape of the consumer changes depending on the route, the consumer side is
"absent = unknown" display is independent UX judgment and

[issue #166](https://github.com/sakuraiyuta/kaoiro/issues/166)
to ex ation (for more details)
[plugin-model](../specs/plugin-model.md).

## Implementation

[phase-20-engine-catalog-live-probe](../plans/phase-20-engine-catalog-live-probe.md).
kaoirothe relevant entryer delegation is implemented by kuroe and fuji makes a review and Git decision
Note commit / push / branch

Phase 20-1 empirical spike (2026 -15)
prompt A short-lived probe was established in the SDK 0.3.208.
tmpdir  0, close after subprocess complete cleanup, OAuth authentication success.

kaoiro probeer (fuji)'s independent real probe execution also admits the results (redact recorded):
PASS / exit 0 / elapsed ~1.59s / 6 models / `~/.claude/projects`
Difference 0 / No personal information output / No probe residual process. F4 Options Configuration
(cwd isolation + `mcpServers: {}` / `tools: []` / OAuth retention) is the operator
Ensure that it works as a real-time environment.
