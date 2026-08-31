---
title: Additional codex adapter and materialise of wrapper multi-package structure
status: accepted
date: 2026-07-10
opened: 2026-06-26
supersedes: []
superseded_by: null
related_specs: [plugin-model, protocol, architecture, personas, codex-sdk-events, agent-sdk-events]
related_adrs: [17, 22, 23, 33, 34, 35, 37, 38, 39, 40]
---

# ADR-0032 — Materialise of codex adapter and wrapper multipackage structure

## Status

Accepted (2 steps from [phase-13-wrapper-multipackage-restructure](../plans/phase-13-wrapper-multipackage-restructure.md) to [phase-14-codex-adapter](../plans/phase-14-codex-adapter.md)).

## Context

The wrapper is now a Claude implementation that imports `@anthropic-ai/claude-agent-sdk` directly in a single `@kaoiro/wrapper` package (`wrapper/src/host.ts:7`). OpenAI codex CLI (`@openai/codex-sdk` 0.144.1, Node ≥ 18)

There were already three additional engine trays:

- [ADR-0017](0017-wrapper-multientity-packages.md) is set to accept pnpm workspace for `wrapper/core` + AI agent common layer + concrete adapter.
- [ADR-0023](0023-host-runner-architecture.md) D3 indicates "`@kaoiro/wrapper`'s rename will be forwarded before the codex version is added."
- open-questions/spawn- -ionion (completely merged and removed in this ADR) added `SpawnRequest`/`SpawnMessage` `engine`, wrapper launcher engine → wrapper solution, Launch engine engine select, model/effort/persona engine dependencies, and track checklists have already been developed. This ADR transfers its decision to execution.

On the other hand, go to phase-12 and the postponement condition of ADR-0017 "The main function is complete" is filled (dashboard / persona pack / broker / subagent task /   all operation). Codex A natural window that performs three-layer rethe relevant entryation, rename, and the relevant entry select wiring at once.

Corres ence with the Claude Agent SDK for Codex SDK (as of 2026 , `@openai/codex-sdk` 0.144.1 / `@anthropic-ai/claude-agent-sdk` 0.3.162):

|| Claude Agent SDK | Codex SDK |
|---|---|---|
|Main API| `query()`async generator| `Codex().startThread()` → `thread.run()` / `thread.runStreamed()` (**New spawn with every turn `codex exec`**After the second turn`exec resume <id>`) |
| Resume | `resume: sessionId` | `codex.resumeThread(id)` |
|Pets allowed| `permissionMode`(default/acceptEdits/bypassPermissions/plan/dontAsk/auto)| `sandbox_mode` × `approval_policy`Biaxial. approval policy`never`forced to**No path to caller to request approval** ([ADR-0033](0033-permission-model-dual-axis.md) Context) |
| Model | `claude-*` | `gpt-5.6-sol`(default) /`terra` / `luna` / `gpt-5.5` / `gpt-5.4(-mini)`etc. (Catalog is updated on server side, without enumeration API)|
|| `ANTHROPIC_API_KEY` / Claude subscription | `CODEX_API_KEY` env / ChatGPT login (`~/.codex/auth.json`).`OPENAI_API_KEY`is not used for execution authentication in 0.144 (for pipe to login)|
|System prompt| `systemPrompt.append` | config `developer_instructions`AGENTS.md (append)|
|Tools| `tool()` + Zod, in-process MCP | **No dynamicTools in the TS SDK**Note config override`mcp_servers.*`) in per-run|
| Streaming | `SDKMessage` (system/assistant/result/stream_event) | `ThreadEvent`(thread.*/turn.*/item.*)| [codex-sdk-events](../specs/codex-sdk-events.md)
| Hooks |PreToolUse / CwdChanged etc.|v0.116 introduced exes (unex  on exec/S )|

(2026 -10 Added: `@openai/codex-sdk` 0.144.1 We have revised F5/F6. )

## Decision

### F1 — Split wrapper into 4 packages (ADR-0017 material)

The wrapper directory is pnpm workspace and is divided into the following four packages:

- **`wrapper/core` (`@kaoiro/wrapper-core`)**— Entity Independence. transport / envelope  outer frame +version / identity / persona / connection / state reporting lifecycle / config / CLI frame (`cli.ts` engine non-dependent part).
- **`wrapper/agent-common` (`@kaoiro/agent-common`)**— AI Agent Common Layer. state machine (`state.ts`), `EngineAdapter` interface, common tool description layer (F , permission broker, instruction conversion, common event type. Claude / Codex
- **`wrapper/claude-code` (`@kaoiro/claude-code`)**Claude Code CLI Transplant and rename existing `wrapper/src/host.ts`/`wrapper/src/adapter.ts`. Claude (fast mode / CwdChanged   / native AskUserFeaturesstion / permission single axis → biaxial image table) is closed here.
- **`wrapper/codex` (`@kaoiro/codex`)**— Codex specific adapter (new).

Current `@kaoiro/wrapper` renames to `@kaoiro/claude-code` ([ADR-0023](0023-host-runner-architecture.md) D3 declarationexecution). As an existing `wrapper/src/adapter.ts` predetermined engine boundary, it is promoted as `EngineAdapter` interface of `wrapper/agent-common`, and the Claude implementation is transferred to the Claude adapter package.

### F2 — extended to two-axis permission model

[ADR-0033](0033-permission-model-dual-axis.md) Added `sandbox` (read-only/workspace-write/danger-full-access) and `approval` (untrusted/on-request/granular/never) fields to `state_change.ext.pending_permission`. UI (Launchdisplay / AgentDetail) The `wrapper/claude-code` adapter holds the image table to the two-axis. ADR-0033

### F3 — persona is not engine

`personality.md` and stand-up (7 state expressions) are shared with both engines. In Claude, injected to the SDK `systemPrompt.append` ([ADR-0029](0026-persona-personality-injection.md) via [ADR-0026](0029-persona-server-sot-and-pack-distribution.md)), and in Codex, config key**`developer_instructions`**Pass to (2026 -10:: Demonstrate the actual behavior appended to base instructions as a developer role message in the rollout file. base instructions****`instructions` / `model_instructions_file` engine separate persona pack (`kuroe-claude` / `kuroe-codex` etc.) and `personality.md` engine separate sections are not available for the first time.

Codex has a built-in `personality` config (none/friendly/pragmatic, exec default pragmatic) that can interfere with the persona tone. Q1 Check the `none` specification when validating.

Codex-side injections have been verified by 2026 20-11 (formerly Q1 close): kuroe (master-called, secretary-tuning) and ao (first-person, “my”, normal-concise) are clearly differentiated on Codex adapter, and `developer_instructions` injections are faithful to persona separately. The built with built-in `personality` config (exec default pragmatic) was not observation, and the `none` specification was unnecessary.

### F4a — capabilities field values

register payload, `SpawnRequest.engine`, `SpawnMessage.engine`, and launch engine engine select to determine the value set:

`claude-code`
`codex` — Codex CLI Adapter

`capabilities: ["claude"]` is renamed to `claude-code`. Compatible windows (2026 -10 confirmed, old Q6 close): The old value `claude` is**1 Release window**In the server side register handler, the `claude-code` is normalized and depre  warn is issued. Remove the normalization case in the next release and switch to strict rejection (the same style as the persona legacy window of [ADR-0031](0031-runner-persona-trust-mode.md)).

### F4bc — EngineCapability interface

`wrapper/agent-common` sets the following interface:

```ts
interface EngineCapability {
  // engine 一意識別子。capabilities フィールドと同値
  id: "claude-code" | "codex";
  // 起動可能なモデル一覧 (dashboard の三段選択用)
  supportedModels(): ModelInfo[];
  // effort オプション (fast mode / reasoning_effort 等の engine 固有 tuning)
  effortOptions?(): EffortInfo[];
}
```

`ext.model` / `ext.effort` of envelope  remains the engine vocabulary (not mapping). Launch  is composed of three-tier options:   → model → optional effort.

Codex initial implementation (2026 (20-11):

- **`supportedModels()` is empty catalog (using account default model)**Note Initially
bundled catalog catalog curated static list (`gpt-5.6-sol`, etc.)
2026Chat-11 Verification of the actual machine **ChatGPT-plan Certification (First route of the project, F7)
The specified model is rejected by 400/404 and the acceptable model set is the account
Dependently, the SDK is not enumerated** (bundled catalog is for API keys).
If it is empty catalog, Launch  does not provide model select, and wrapper is
`model` is used (reliably working with both authentication).
The value of the explicit model is reintro  at the time the reliable catalog source appears by authentication
(Former Q5 codex-model-effort-catalog is closed, and future support is
[ADR-0035](0035-codex-model-catalog-and-mid-session-switch.md)
mid-session switch Current status of Codex Ecosystem (model availability by plan,
Athe relevant entrymetrical in two modes, the information particle size of `codex doctor`
[codex-model-catalog](../specs/codex-model-catalog.md)
- **effort is not displayed in the current UI by empty catalog**Note future model catalog
`ext.models` `effort_levels`
Maintain policy (E-B).

[ADR-0035](0035-codex-model-catalog-and-mid-session-switch.md)
This F4bc because the hostlicit specification success of curated trio was included in the host actual machine verification
Revise the empty catalog to catalog filed in phase-16. until phase-16 is completed
Keep empty catalog behavior.

#### F4bc supplement (2026-11-11, model solution path for phase-15)

In the actual operation verification after phase-14 completion, if the resolved model / source is not visible to the UI / log, and the shared env leaked between the engine to become an accident. The priority of the model solution, the source display, and env separation are clarified as a supplement to this F4bc. [phase-15-wrapper-ux-parity](../plans/phase-15-wrapper-ux-parity.md) D1/D7

- **Solution priority**`env` `config.model (kaoiro.config.json)` engine account / SDK default I re the lower if the top is specified.
- **source Vocabulary**: envelope  `ext.model source: "launch"| "env" | "config" | "default"` Note stamp the relevant entry.UI (AgentDetail) Note「Account Default」Label judgment engine Name  (e89fa98 (private Gitea history) Note Codex Special) Note `ext.model source == "default" to remove the  .
- **1 line stderr at startup**: Output `[wrapper resolved] engine=... model=<name>(source=...) ...` at CLI startup. Expose to the operator log in the tee route of  .
- **en**: Single shared env `KAOIRO_WRAPPER_DEFAULT_MODEL` separation by engine:
Claude CLI
Codex CLI
- The old `KAOIRO_WRAPPER_DEFAULT_MODEL` depre  (Claude CLI reads the value depre  warn to stderr, and Codex CLI is completely ignored) → removal in the next release (like [ADR-0031](0031-runner-persona-trust-mode.md) personas legacy / [ADR-0032](0032-codex-adapter.md) F4a `claude` legacy). rewrite dev.sh to env by engine
- Source: Single-shared env flows to Codex spawn with `scripts/dev.sh` `KAOIRO_WRAPPER_DEFAULT_MODEL=claude-opus-4-7`, and is an accident source ([codex-model-catalog](../specs/codex-model-catalog.md) certification athe relevant entrymetry) based on 400/404 in the ChatGPT-plan authentication path. engine separate env prevents structural
- **Handling unsolved models**(Both engine): If the specified model is denied by the engine side (400/404 of Codex ChatGPT-auth, invalid alias of Claude), and silent fallback are not booted loud fail. Don't confuse "Unspecified → default delegation" and "Expression → Deny".

### F5 — Common Tool Description Layer Delivers to Codex with MCP bridge (2026 (20-10)

"JSON Schema (definition) + handler function" pair in `wrapper/agent-common` is unchanged. Revise the transport route:

- **Claude Adapter**— Zod conversion + `createSdkMcpServer` in-process registration (as usual).
- **Codex Adapter**`dynamicTools`**TS SDK**`@kaoiro/codex`**stdio MCP bridge**Contains the execution body. The wrapper registers bridge with config override (`mcp_servers.kaoiro.command` + `env`, authentic binary-certified) for each spawn, and the bridge forwards connection and tool calls to the parent wrapper process via unix socket passed by env to the common handler on the wrapper side. `codex exec` is a process for each turn, so codex is spawn for each turn and reconnection to socket every time.

The inter-agent tools (`mcp__kaoiro__send_to_agent` / `list_agents` / `whoami` and `wrapper/src/inter_agent.ts`) that are currently provided in the Claude SDK are transferred to the common layer and provided in a single implementation to both engines.

"Codex is another process MCP server" that was rejected in the first article, is adopted in the bridge form because the premise (dynamicTools is in the SDK) was broken. However, the first article is repelled, "Dualize tool implementation" does not occur — bridge is only transferred, and the handler body remains the agent-common SSOT. The future SDK contains dynamicTools, which can be directly connected with the bridge.

**Automatic approval of MCP tool (2026 -11)**: `codex exec` forces approval policy to `never` ([ADR-0033](0033-permission-model-dual-axis.md)), so MCP tool calls are automatically denied as "user cancel MCP tool call" by default. The wrapper auto-approves only the kaoiro tool with `mcp_servers.kaoiro.default_tools_approval_mode: "approve"` (reception value is 4 values of `auto` / `prompt` / `writes` / `approve`, only `approve` to execution tool). The kaoiro tool will gate the operator with the wrapper provided (per-call approval on the Claude side, ask user question is the operator prompt itself), so this auto-approving is not allowed to expand any code execution.

### F6 — AskUser stion equivalent

Claude continues to use the SDK native tool (current `wrapper/src/host.ts:762-765` is maintained on `wrapper/claude-code`). Codex provides `ask_user_question` via F5 MCP bridge. Since the MCP tool call blocks the turn to the response, the `waiting_question` state is established in Codex (it is important as a dialogue channel with the operator if the approval flow falls in [ADR-0033](0033-permission-model-dual-axis.md)). Normalize the tool call to `question_request` envelope  with the wrapper. [0027-askuserquestion-envelope](0027-askuserquestion-envelope.md)

### F7 — authentication is currently attacked

Codex authentication reads the wrapper process from the parent environment (2026 -10):

- ChatGPT login session — `codex login` looks natural with `~/.codex/auth.json` cache, parent home inheritance. Primary route of this project.
- `CODEX_API_KEY` — the operator is exported to the parent shell (env takes precedence over auth.json). `OPENAI_API_KEY` is used for execution authentication in 0.144**Not Used**( pipe name only for pipe input to `codex login --with-api-key`).

config RunnerConfig does not fill any config JSON (`/tmp/kaoiro-runner-*/`) on spawn. Fix temp file leak risk at SIGKILL with the same treatment as the existing Claude side.

### engine separation

`SessionPointers` on the server side continues to hold as the engine-opaque string ([ADR-0014](0014-session-resume-and-restore.md) schema unchanged). engine adapter interprets and resumes your session id:

Claude adapter
- Codex adapter — `codex.resumeThread(id)`

's cwd subdivision session enumeration ([ADR-0014](0014-session-resume-and-restore.md) F6) is also implemented by engine:

Claude adapter
- Codex adapter — scan `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` and match with `cwd` of the first line `session_meta` (2026-10-10 confirmed: check the layout and the presence of `session_meta.cwd` in real files. `state_5.sqlite` index does not depend on internal). The scan traces async filesystem API in the new order of the fixed depth date tree, and the presence confirmation returns earlier at the same time, and the enumeration does not block the loop event (#97).

### F9 — cwd notification contract

`wrapper/agent-common` `EngineAdapter` interface has a `onCwdChanged(newCwd)` equivalent   contract. Engine:

- Claude adapter — Existing CwdChanged   co ity (actually unstable with the [issue #92](https://github.com/sakuraiyuta/kaoiro/issues/92) SDK bug wait).
- Codex adapter — Fixed cwd display that is not implemented in MVP and is temporarily launched. Extraction approach candidates are tracked by [open-questions/codex-cwd-extraction](../open-questions/codex-cwd-extraction.md).

### F10 — 2 phase split

The implementation is divided into two phases:

- **[phase-13-wrapper-multipackage-restructure](../plans/phase-13-wrapper-multipackage-restructure.md)**— materialise only this ADR F1. Fully maintaining existing Claude behavior (Codex implementation zero, boundary only).
- **[phase-14-codex-adapter](../plans/phase-14-codex-adapter.md)**— F2-F9 [ADR-0033](0033-permission-model-dual-axis.md) schema change, common tool description layer construction, Codex adapter implementation, engine solution of launcher, dashboard engine select activation and model/effort three-stage selection, capacity rename. open-questions Q1-Q5

## Consequences

### Positive

ADR-0017 `wrapper/core` does not have an AI concept, and can be packaged trays for future non-AI entities ([plugin-model](../specs/plugin-model.md)).
- The effect of adding the engine is closed in the adapter package and the core is not resurgical.
- Codex adapter plug-in without changing existing state abstract / envelope  schema / server / dashboard (two-axis permission extension is handled by independent [ADR-0033](0033-permission-model-dual-axis.md)).
- The function field is actually consumed (Launch engine engine select, launch launcher solution).

### Negative

- Package rephaseation (phase-13) increases PR units due to existing behavioral immutations (full movement of import routes and package names).
- Codex adapter (F2-F9) The acceptance of phase-14 is included until the actual behavior confirmation of the representative persona × main functions.
- Codex persona injection is not validation (Q1). phase-14 Q1 solution is included.

### Neutral

- The current `wrapper/src/adapter.ts` predetermined the virtual adapter interface, so the gradient cost to the EngineAdapter interface is small.
- Distribution ([ADR-0018](0018-runner-distribution.md)) is an existing argument that handles multiple wrapper bundles approach with issue #70, and does not include new arguments in this ADR.

## Alternatives Considered

### F1 (Granularity of engine abstraction)

| Option | Why rejected |
|--------|--------------|
|Only the AgentAdapter interface is cut in the current wrapper and the package split is postponed|The Claude dependency of the AI common layer (permission broker / instruction) remains intact, such as the Permission biaxial of Codex`state.ts`Easy to dye. Resurgical when peeling off to three layers later. ADR-0017 postponement conditions are already filled|
|another PoC lipo codex single precedence|Double mounting costs when importing and abstraction of mainstream|

### F2 (permission model abstract)

| Option | Why rejected |
|--------|--------------|
|Act preset common abstract (`default/accept-edits/auto-shell/plan-only/yolo`Other|Codex The expression of the two axis is crushed into a single axis and the semantics mapping table will eventually become the openest of open-question|
|engine Exposure to the UI|The dashboard display is a different set of permissions for each engine, and envelope  schema / server validation is the engine|

### F3 (persona shared)

| Option | Why rejected |
|--------|--------------|
| `personality.md`Note`## for-claude` / `## for-codex`Section|Early agreement cost large, complication of package creator operation|
|engine separate pack (`kuroe-claude` / `kuroe-codex`) |pack The number of zips is doubled only for engine minutes, and maintenance collapse|

### F4a (capabilities name)

| Option | Why rejected |
|--------|--------------|
| `anthropic-claude-code` / `openai-codex`prefix|Redundant, operator visual degradation, multiple engines in the same engine are not common|
|Current value`claude`permission|claude is a Meaning Axial Weight to read as an Anthropic LLM model family|

### F4bc (model / effort abstract)

| Option | Why rejected |
|--------|--------------|
|tuning abstract (`speed / balanced / deep-reasoning`) |fast mode and reasoning effort unimageable, table is open-questionHomeest|
|engine|Preset Definition Maintenance Cost + SDK Compensation|

### F5 (MCP provided)

| Option | Why rejected |
|--------|--------------|
|Pass directly to the dynamicTools of the Codex SDK| ****— DynamicTools does not exist in the TS SDK 0.144.1 (2026ation-10 type definition and implementation). The choice to wait for the SDK addition is unknown, and the bridge asset can be used for every handler SSOT after direct connection, so it is less profit to wait|
|engine tool|tool Make sure to touch two places when adding|
|Codex MVP with no tools|Codex agent is not able to interact with questions and inter-agents. If the approval flow falls, ask user question is the lifeline of the dialogue and is not acceptable|

### F6 (AskUserQuestion)

| Option | Why rejected |
|--------|--------------|
|Both engines are also provided for self-delivery.|Claude SDK|
|Codex does not support AskUser stion|Degrading the ability to revise Codex agent without question to operator|

### F7 (Certified)

| Option | Why rejected |
|--------|--------------|
|enginedentials storage by engine|config config is a secret storage, multiple host operation complexity|
|config JSON|SIGKILL at rmSync before leak risk|

### F8 (resume separation)

| Option | Why rejected |
|--------|--------------|
|engine prefix|Existing session id migration is required for all clients and prefix semantics are penetrated into all routes|
|Codex does not support resume|ADR-0014 Engine Athe relevant entrymetric|

### F9 (cwd hook)

| Option | Why rejected |
|--------|--------------|
|wrapper/claude-code|UI UI|
|Remove cwd tracking functionality from the specification|Claude No rationality of side operation |

### F10 (phase split)

| Option | Why rejected |
|--------|--------------|
|1 phase|Single PR hypertrophy, rethe relevant entryation and re  of codex implementation are simultaneously progressed to focus on risk|
|3+ phase|F2-F9 phase boundary becomes ambiguous and the number of reviews increased|

## Related

- Origin: open-questions/spawn- -ionion (2026-06-26, fully merged and removed to the book ADR, and the "Resolved Action" checklist is written in [phase-14-codex-adapter](../plans/phase-14-codex-adapter.md) acceptance criteria.
- : [phase-13-wrapper-multipackage-restructure](../plans/phase-13-wrapper-multipackage-restructure.md), [phase-14-codex-adapter](../plans/phase-14-codex-adapter.md), [phase-15-wrapper-ux-parity](../plans/phase-15-wrapper-ux-parity.md) (F4bc supplement implementation).
-CO ADR: [0017](0017-wrapper-multientity-packages.md) (materialise in this ADR), [0022](0022-pending-permission-authoritative-source.md) / [0033](0033-permission-model-dual-axis.md) (permission biaxial), [0023](0023-host-runner-architecture.md) D3 (rename execution), [0001](0001-agent-sdk-integration.md) (Claude SDK Adopt), [0027](0027-askuserquestion-envelope.md) (question envelope.), [0014](0014-session-resume-and-restore.md) (resume), [0034](0034-session-capabilities-advertisement.md) (element of engine neutralization pattern by session capabilities).
-CO:s: [plugin-model](../specs/plugin-model.md), [protocol](../specs/protocol.md), [architecture](../specs/architecture.md), [personas](../specs/personas.md), [agent-sdk-events](../specs/agent-sdk-events.md) (Claude version), [codex-sdk-events](../specs/codex-sdk-events.md) (Codex version, new version).
- Open questions (phase-14): [Q4 codex-cwd-extraction](../open-questions/codex-cwd-extraction.md), [codex-exec-approval-upstream](../open-questions/codex-exec-approval-upstream.md) (2026.-10 new). The former Q1 (personality infusion effectiveness) is close to 2026-11-11 actual machine validation, and the former Q2 (envelope  schema) / Q3 (UI vocabulary) / Q5 (model catalog) / Q6 (compatible windows) resolved with 2026 SDK-10 real SDK validation + SDK-elicitation and close (requested to this ADR and [ADR-0033](0033-permission-model-dual-axis.md)).
