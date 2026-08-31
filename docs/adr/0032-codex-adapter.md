---
title: Adding a Codex adapter and materialising a multi-package wrapper structure
status: accepted
date: 2026-07-10
opened: 2026-06-26
supersedes: []
superseded_by: null
related_specs: [plugin-model, protocol, architecture, personas, codex-sdk-events, agent-sdk-events]
related_adrs: [17, 22, 23, 33, 34, 35, 37, 38, 39, 40]
---

# ADR-0032 — Adding a Codex adapter and materialising a multi-package wrapper structure

## Status

Accepted (implementation is the two stages of [phase-13-wrapper-multipackage-restructure](../plans/phase-13-wrapper-multipackage-restructure.md) → [phase-14-codex-adapter](../plans/phase-14-codex-adapter.md)).

## Context

The wrapper is currently a Claude-only implementation in the single
`@kaoiro/wrapper` package, importing `@anthropic-ai/claude-agent-sdk` directly
(`wrapper/src/host.ts:7`). We want to add OpenAI’s Codex CLI
(`@openai/codex-sdk` 0.144.1, Node ≥ 18) as a second engine.

Three foundations for adding an engine were already in place:

- [ADR-0017](0017-wrapper-multientity-packages.md) had accepted and planned a
  three-layer pnpm workspace of `wrapper/core` + an AI-agent common layer +
  concrete adapters (work deferred “until the major features are in place”).
- [ADR-0023](0023-host-runner-architecture.md) D3 explicitly deferred renaming
  `@kaoiro/wrapper` until the Codex version was added.
- open-questions/spawn-engine-selection (opened 2026-06-26, fully merged into
  this ADR and deleted) had already prepared the wiring checklist: adding
  `engine` to `SpawnRequest`/`SpawnMessage`, resolving engine → wrapper in the
  runner launcher, an engine selector in LaunchDialog, engine-specific
  model/effort/persona handling, and the wiring checks. This ADR puts that
  decision into execution.

By phase-12, ADR-0017’s deferral condition “until the major features are in
place” had been met (dashboard / persona packs / permission broker / subagent
tasks / runner were all operational). The timing of adding Codex is therefore a
natural window for the three-layer reorganisation, rename, and engine-selector
wiring in one effort.

The correspondence between the Codex SDK and Claude Agent SDK (as of July 2026,
`@openai/codex-sdk` 0.144.1 / `@anthropic-ai/claude-agent-sdk` 0.3.162) is:

| Concept | Claude Agent SDK | Codex SDK |
|---|---|---|
| Main API | `query()` async generator (resident session) | `Codex().startThread()` → `thread.run()` / `thread.runStreamed()` (**spawn a new `codex exec` every turn**, `exec resume <id>` from the second turn onward) |
| Resume | `resume: sessionId` | `codex.resumeThread(id)` |
| Permissions | Single-axis `permissionMode` (default/acceptEdits/bypassPermissions/plan/dontAsk/auto) | Two axes, `sandbox_mode` × `approval_policy`. However, via exec, approval_policy is forced to `never` and **there is no path to return an approval request to the caller** ([ADR-0033](0033-permission-model-dual-axis.md) Context) |
| Model | `claude-*` | `gpt-5.6-sol` (default) / `terra` / `luna` / `gpt-5.5` / `gpt-5.4(-mini)`, etc. (catalog updated server-side, no enumeration API) |
| Authentication | `ANTHROPIC_API_KEY` / Claude subscription | `CODEX_API_KEY` env / ChatGPT login (`~/.codex/auth.json`). `OPENAI_API_KEY` is not used for runtime authentication in 0.144 (only for piping into login) |
| System-prompt equivalent | `systemPrompt.append` | config `developer_instructions` (appended as a developer-role message, verified) / AGENTS.md (append) |
| Tools | `tool()` + Zod, in-process MCP | **No dynamicTools in the TS SDK**. External MCP servers can be registered per run with a config override (`mcp_servers.*`) |
| Streaming | `SDKMessage` (system/assistant/result/stream_event) | `ThreadEvent` (thread.*/turn.*/item.*), details in [codex-sdk-events](../specs/codex-sdk-events.md) |
| Hooks | PreToolUse / CwdChanged, etc. | Hooks introduced in v0.116 (not exposed on the exec/SDK surface) |

(Added 2026-07-10: The table above was verified against the type definitions,
implementation, bundled binary of `@openai/codex-sdk` 0.144.1, and upstream
`rust-v0.144.1` source. Two assumptions from drafting were overturned — the
absence of dynamicTools and the unavailable approval flow — so F5/F6 were revised.)

## Decision

### F1 — Split the wrapper into four packages (materialise ADR-0017)

Make the wrapper directory a pnpm workspace and split it into these four packages:

- **`wrapper/core` (`@kaoiro/wrapper-core`)** — entity-independent. Transport /
  envelope shell + version / identity and persona / connection and state-reporting
  lifecycle / config / CLI shell (the engine-independent parts of `cli.ts`).
- **`wrapper/agent-common` (`@kaoiro/agent-common`)** — common AI-agent layer.
  State machine (`state.ts`), `EngineAdapter` interface, common Tool description
  layer (F5), permission broker, instruction conversion, and common event types.
  Shared by Claude / Codex.
- **`wrapper/claude-code` (`@kaoiro/claude-code`)** — concrete Claude Code CLI
  adapter. Port and rename the existing `wrapper/src/host.ts` /
  `wrapper/src/adapter.ts`. Claude-specific features (fast mode / CwdChanged hook /
  native AskUserQuestion / single-axis permission → two-axis mapping table) stay
  here.
- **`wrapper/codex` (`@kaoiro/codex`)** — concrete Codex adapter (new).

Rename the current `@kaoiro/wrapper` to `@kaoiro/claude-code`
([ADR-0023](0023-host-runner-architecture.md) D3’s declared rename). Because the
existing `wrapper/src/adapter.ts` has effectively anticipated the engine boundary,
promote it to the `EngineAdapter` interface in `wrapper/agent-common` and move
the Claude implementation into the Claude adapter package.

### F2 — Extend the common permission abstraction to two axes

As decided in [ADR-0033](0033-permission-model-dual-axis.md), add two fields to
`state_change.ext.pending_permission`: `sandbox`
(read-only/workspace-write/danger-full-access) and `approval`
(untrusted/on-request/granular/never). The UI (LaunchDialog / AgentDetail) also
displays two axes. The Claude 4-mode → two-axis mapping table is kept by the
`wrapper/claude-code` adapter. See ADR-0033 for details.

### F3 — Share personas independently of the engine

Share `personality.md` and the seven-state portrait set between both engines.
Claude continues to inject it into SDK `systemPrompt.append`
([ADR-0026](0026-persona-personality-injection.md) via
[ADR-0029](0029-persona-server-sot-and-pack-distribution.md)); Codex passes it
through the config key **`developer_instructions`** (confirmed 2026-07-10: rollout
files proved that it is appended to base instructions as a developer-role
message; do not use `instructions` / `model_instructions_file`, which would
**replace** base instructions). Do not have engine-specific persona packs
(`kuroe-claude` / `kuroe-codex`, etc.) or engine-specific sections in
`personality.md` initially.

Codex also has a built-in `personality` config (none/friendly/pragmatic, with
pragmatic as the exec default) that could interfere with persona tone. Confirm
whether `none` needs to be specified during Q1 verification.

Codex-side injection effectiveness (reproduction of tone and attitude) was
confirmed in real-machine verification on 2026-07-11 (old Q1 closed): kuroe
(addressing the user as “マスター”, secretary-like tone) and ao (first person
“わたし”, plain style, concise) were clearly differentiated on the Codex
adapter as well, and `developer_instructions` injection worked faithfully by
persona. No interference with the built-in `personality` config (exec default
pragmatic) was observed; specifying `none` is unnecessary.

### F4a — Capabilities field values

Confirm the value set used in the runner register payload, `SpawnRequest.engine`,
`SpawnMessage.engine`, and the LaunchDialog engine selector:

- `claude-code` — Claude Code CLI adapter
- `codex` — Codex CLI adapter

Rename the current register-payload value `capabilities: ["claude"]` to
`claude-code` (the UI that consumes it does not yet exist, so the cost is low).
Compatibility window (confirmed 2026-07-10, old Q6 closed): for **one release
window**, the server register handler silently normalises the old value `claude`
to `claude-code` and emits a deprecation warning. Switch to strict rejection by
removing the normalisation case in the next release (the same convention as the
persona legacy window in [ADR-0031](0031-runner-persona-trust-mode.md)).

### F4bc — EngineCapability interface

Put the following interface in `wrapper/agent-common`:

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

Keep `ext.model` / `ext.effort` in the envelope in engine vocabulary (do not map
them). Build LaunchDialog as three selections: “engine → model → optional effort”.

Initial Codex implementation (revised by real-machine verification on 2026-07-11,
old Q5 closed):

- **`supportedModels()` is an empty catalog (use the account’s default model)**.
  A curated static list based on the bundled catalog (`gpt-5.6-sol`, etc.) was
  originally planned, but real-machine verification on 2026-07-11 found that
  **ChatGPT-plan authentication (the project’s primary path, F7) rejects every
  explicit model specification with 400/404, and the allowed model set is
  account-dependent and cannot be enumerated from the SDK** (the bundled catalog
  is for API keys). With an empty catalog, LaunchDialog does not show a model
  selector, the wrapper does not send `model`, and the account default model is
  used (works reliably with both authentication modes). Reintroduce explicit model
  selection when a trustworthy catalog source for each authentication mode is
  available (old Q5 codex-model-effort-catalog is closed; the future approach and
  mid-session switch contract are decided in [ADR-0035](0035-codex-model-catalog-and-mid-session-switch.md)).
  The current Codex ecosystem situation (plan-specific model availability,
  asymmetry between the two authentication modes, and the information granularity
  of `codex doctor`) is recorded in [codex-model-catalog](../specs/codex-model-catalog.md).
- **Effort is currently hidden in the UI because the catalog is empty**. Preserve
  the policy (E-B) of integrating it into Claude’s `ext.models` `effort_levels`
  when a model catalog returns in the future.

[ADR-0035](0035-codex-model-catalog-and-mid-session-switch.md) revises this empty
catalog in phase-16 into a plan-declared catalog after host real-machine
verification after Plus enrollment confirmed explicit selection of the curated
trio. Until phase-16 is complete, retain the empty-catalog behavior in this section.

#### F4bc Addendum (2026-07-11, clarifying the model resolution path for phase-15)

Operational verification after phase-14 revealed cases where the resolved model /
source was not visible in the UI / logs and operators misidentified the current
state, as well as cases where a shared env leaked between engines and caused an
incident. This addendum to F4bc makes model-resolution priority, source display,
and env separation explicit. Implement it in [phase-15-wrapper-ux-parity](../plans/phase-15-wrapper-ux-parity.md) D1/D7.

- **Resolution priority** (both engines): `launch (SpawnMessage.model / CLI 位置引数)` > `env` > `config.model (kaoiro.config.json)` > engine account / SDK default. Ignore lower-priority values when a higher-priority value is specified.
- **Source vocabulary**: stamp `ext.model_source: "launch" | "env" | "config" | "default"` in the envelope. Replace the AgentDetail “account default” label check from an engine-specific branch (the Codex special case in e89fa98 (private Gitea history)) with `ext.model_source === "default"`, and remove the engine branch.
- **One startup stderr line**: output `[wrapper resolved] engine=... model=<name>(source=...) ...` at CLI startup. The runner tee path also exposes it in the operator log.
- **Separate env**: split the single shared env `KAOIRO_WRAPPER_DEFAULT_MODEL` by engine:
  - `KAOIRO_CLAUDE_CODE_DEFAULT_MODEL` — read only by the Claude CLI
  - `KAOIRO_CODEX_DEFAULT_MODEL` — read only by the Codex CLI
  - Deprecate the old `KAOIRO_WRAPPER_DEFAULT_MODEL` for one release window
    (Claude CLI reads it and warns to stderr; Codex CLI completely ignores it) →
    remove it in the next release (same pattern as the personas legacy window in
    [ADR-0031](0031-runner-persona-trust-mode.md) / [ADR-0032](0032-codex-adapter.md)
    F4a's `claude` legacy value). Rewrite dev.sh to use engine-specific env values too.
  - Rationale: the single shared env caused `KAOIRO_WRAPPER_DEFAULT_MODEL=claude-opus-4-7`
    in `scripts/dev.sh` to flow into Codex spawns, causing a 400/404 on the
    ChatGPT-plan authentication path ([codex-model-catalog](../specs/codex-model-catalog.md)
    documents the authentication asymmetry). Engine-specific env structurally
    prevents this.
- **Unresolvable model handling** (both engines): if an explicitly specified model
  is rejected by the engine (400/404 from Codex ChatGPT auth, invalid alias in
  Claude), fail loudly at startup without silently falling back. Do not confuse
  “unspecified → delegate to default” with “explicitly specified → reject”.

### F5 — Deliver the common Tool description layer to Codex through an MCP bridge (revised 2026-07-10)

Keep the JSON Schema (definition) + handler-function pair in
`wrapper/agent-common` as the SSOT. Revise the transport:

- **Claude adapter** — Zod conversion + in-process registration with
  `createSdkMcpServer`, as before.
- **Codex adapter** — the `dynamicTools` assumed in the draft **does not exist in
  the TS SDK**, so bundle a small **stdio MCP bridge** executable in
  `@kaoiro/codex`. For each spawn, the wrapper registers the bridge with a config
  override (`mcp_servers.kaoiro.command` + `env`, verified as accepted by the real
  binary); the bridge connects to the parent wrapper process over a Unix socket
  passed through env and forwards tool calls to the common handlers on the wrapper
  side. Since `codex exec` is a per-turn process, Codex spawns the bridge each
  turn as well and it reconnects to the socket each time.

Move the inter-agent tools currently provided inside the Claude SDK
(`mcp__kaoiro__send_to_agent` / `list_agents` / `whoami`,
`wrapper/src/inter_agent.ts`) into this common layer and provide one implementation
to both engines.

The draft’s rejected alternative “Codex through a separate-process MCP server” is
adopted in bridge form because its premise (dynamicTools exists in the SDK) failed.
However, the draft’s concern about “duplicating tool implementations” does not
apply — the bridge only forwards, while the handler body remains the agent-common
SSOT. If the SDK gains dynamicTools later, the bridge can be removed and direct
connection used; the handler SSOT is reusable.

**Automatic MCP-tool approval (real-machine verification 2026-07-11)**:
`codex exec` forces approval_policy to `never` ([ADR-0033](0033-permission-model-dual-axis.md)),
so MCP tool calls are automatically rejected by default as “user cancelled MCP
tool call”. The wrapper adds `mcp_servers.kaoiro.default_tools_approval_mode: "approve"` to auto-approve only kaoiro tools (the accepted values are `auto` /
`prompt` / `writes` / `approve`, and only `approve` executes tools). Kaoiro tools
are separately gated by the wrapper’s operator controls (per-call approval on the
Claude side; ask_user_question is the operator prompt itself), so this automatic
approval does not expand arbitrary-code execution.

### F6 — AskUserQuestion equivalent

Claude continues to use the SDK-native tool (the current special branch at
`wrapper/src/host.ts:762-765` remains on the `wrapper/claude-code` side). Codex
provides `ask_user_question` through the F5 MCP bridge. Because an MCP tool call
blocks the turn until a response arrives, Codex can also enter `waiting_question`
state ([ADR-0033](0033-permission-model-dual-axis.md) loses the approval flow, so
this is important as its interaction channel with the operator). The wrapper
normalises both tool calls to the common `question_request` envelope (consistent
with [ADR-0027](0027-askuserquestion-envelope.md), with no schema change).

### F7 — Keep current authentication

The wrapper process reads Codex authentication from its parent environment (path
corrected after runtime verification on 2026-07-10):

- ChatGPT login session — `codex login` caches it in `~/.codex/auth.json`, which is
  naturally visible through the inherited parent home. This is the project’s
  primary path.
- `CODEX_API_KEY` — exported by the operator in the parent shell (env takes
  precedence over auth.json). `OPENAI_API_KEY` is not used for runtime
  authentication in 0.144 (it is only the conventional name for piping input to
  `codex login --with-api-key`).

Do not put credentials in RunnerConfig or in the config JSON written by the runner
when spawning (`/tmp/kaoiro-runner-*/`). Treat it like the existing Claude side
and avoid temp-file leaks when SIGKILL occurs.

### F8 — Separate resume by engine

The server’s `SessionPointers` continues to retain session_id as an engine-opaque
string (schema unchanged per [ADR-0014](0014-session-resume-and-restore.md)). The
engine adapter interprets and resumes its own session_id:

- Claude adapter — existing SDK `resume: sessionId`
- Codex adapter — `codex.resumeThread(id)`

Session enumeration under the runner cwd ([ADR-0014](0014-session-resume-and-restore.md)
F6) is also engine-specific:

- Claude adapter — enumerate existing `~/.claude/projects/` JSONL
- Codex adapter — scan `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` and
  match by the `cwd` in the first line’s `session_meta` (confirmed 2026-07-10 by
  checking the layout and `session_meta.cwd` in real files; do not depend on the
  internal `state_5.sqlite` index). Traverse the fixed-depth date tree newest
  first with asynchronous filesystem APIs; return early when a match is found,
  and do not block the event loop during enumeration (#97).

### F9 — cwd notification contract

Give the `EngineAdapter` interface in `wrapper/agent-common` an
`onCwdChanged(newCwd)`-equivalent hook contract. Implementation is engine-specific:

- Claude adapter — continue the existing CwdChanged hook (operationally unstable
  while waiting for the SDK bug in [issue #92](https://github.com/sakuraiyuta/kaoiro/issues/92)).
- Codex adapter — not implemented in MVP; temporarily display a fixed startup cwd.
  Extraction candidates are tracked in [open-questions/codex-cwd-extraction](../open-questions/codex-cwd-extraction.md).

### F10 — Split into two phases

Implement in these two phases:

- **[phase-13-wrapper-multipackage-restructure](../plans/phase-13-wrapper-multipackage-restructure.md)** — materialise only F1 of this ADR. Preserve existing Claude behavior completely (zero Codex implementation; establish only the boundary).
- **[phase-14-codex-adapter](../plans/phase-14-codex-adapter.md)** — implement all F2-F9. Schema changes from [ADR-0033](0033-permission-model-dual-axis.md), build the common Tool description layer, implement the Codex adapter, resolve the engine in the runner launcher, enable the dashboard engine selector and three-stage model/effort selection, and rename capabilities. Resolve open-questions Q1-Q5 as part of this.

## Consequences

### Positive

- ADR-0017’s three-layer structure is realised as physical boundaries.
  `wrapper/core` contains no AI concepts, providing a package home for future
  non-AI entities ([plugin-model](../specs/plugin-model.md)).
- The impact of adding an engine stays inside its adapter package; the common
  layer and core do not need another operation.
- The Codex adapter is a plugin without changes to the existing state abstraction,
  envelope schema, server, or dashboard (the two-axis permission extension is
  handled separately in [ADR-0033](0033-permission-model-dual-axis.md)).
- The capabilities field is actually consumed (LaunchDialog engine selector and
  runner-launcher resolution).

### Negative

- Package reorganisation (phase-13) preserves existing behavior but makes the PR
  large (moving imports and package names throughout).
- The Codex adapter has a broad implementation scope (F2-F9). Phase-14 acceptance
  includes real-behavior checks for representative personas × core features.
- The effectiveness of Codex-side persona injection was initially unverified (Q1);
  resolving Q1 is part of phase-14 completion.

### Neutral

- Since the current `wrapper/src/adapter.ts` already anticipated the adapter
  interface, promoting it to EngineAdapter has a small cost.
- Distribution ([ADR-0018](0018-runner-distribution.md)) already tracks the
  multiple-wrapper-bundle approach in issue #70, so this ADR adds no new topic.

## Alternatives Considered

### F1 (granularity of the engine abstraction)

| Option | Why rejected |
|--------|--------------|
| Keep only an AgentAdapter interface inside the current wrapper and defer package splitting | The Claude dependency of the AI common layer (permission broker / state machine / instructions) would effectively remain, making Codex’s two-axis permissions bleed into `state.ts`. Splitting into three layers later would require another operation. ADR-0017’s deferral condition has already been met. |
| Start with Codex alone in a separate PoC repository | It avoids the mainline abstraction and creates duplicate implementation cost when merged. |

### F2 (permission-model abstraction)

| Option | Why rejected |
|--------|--------------|
| Common action-preset abstraction (`default/accept-edits/auto-shell/plan-only/yolo`, etc.) | It flattens Codex’s two-axis expressiveness into one axis, and the semantic mapping table becomes an open-question sink. |
| Expose engine-specific vocabulary directly in the UI | Dashboard permission display becomes a different set per engine, making envelope schema / server validation full of engine branches. |

### F3 (sharing personas)

| Option | Why rejected |
|--------|--------------|
| `personality.md` sections such as `## for-claude` / `## for-codex` | High early agreement cost and more complex pack-author operations. |
| Engine-specific packs (`kuroe-claude` / `kuroe-codex`) | The number of pack zips doubles with the number of engines, making maintenance unsustainable. |

### F4a (capabilities naming)

| Option | Why rejected |
|--------|--------------|
| `anthropic-claude-code` / `openai-codex` with vendor prefixes | Verbose, less readable to operators, and no multiple engines within the same vendor for now. |
| Keep the current value `claude` | “claude” can also be read as the Anthropic LLM model family, so the semantic axis is ambiguous. |

### F4bc (model / effort abstraction)

| Option | Why rejected |
|--------|--------------|
| Tuning abstraction (`speed / balanced / deep-reasoning`) | Fast mode and reasoning_effort cannot be mapped; the table becomes an open-question sink. |
| Engine-specific recommended presets | Preset-definition maintenance cost plus SDK-follow-up burden. |

### F5 (MCP delivery)

| Option | Why rejected |
|--------|--------------|
| Pass directly to Codex SDK dynamicTools (the draft’s adopted option) | **The premise failed** — TS SDK 0.144.1 has no dynamicTools (confirmed in type definitions and implementation on 2026-07-10). Waiting for an SDK addition has no known timing; bridge assets can reuse the handler SSOT even after direct connection is possible, so waiting has little benefit. |
| Place tool implementations side by side per engine | Every tool addition would touch two locations, guaranteeing divergence. |
| MVP without tools in Codex | Codex agents could neither ask questions nor have inter-agent dialogue, making the engines asymmetric. Since the lost approval flow makes ask_user_question the interaction lifeline, this is unacceptable. |

### F6 (AskUserQuestion)

| Option | Why rejected |
|--------|--------------|
| Provide it ourselves for both engines (discard Claude native too) | Lose the benefits of Claude SDK updates. |
| Leave AskUserQuestion unsupported in Codex | The Codex agent could not ask the operator, reducing its ability to revise its work. |

### F7 (authentication)

| Option | Why rejected |
|--------|--------------|
| Have the runner store engine-specific credentials | Runner config becomes a secret store and multi-host operation becomes more complex. |
| Embed credentials in config JSON | Risk of a leak before rmSync on SIGKILL. |

### F8 (separate resume)

| Option | Why rejected |
|--------|--------------|
| Add an engine prefix to session_id | Existing session_id migration would be needed in every client, and the prefix semantics would spread through every path. |
| Leave Codex without resume | The recovery experience in ADR-0014 would become asymmetric between engines. |

### F9 (cwd hook)

| Option | Why rejected |
|--------|--------------|
| Encapsulate cwd as a Claude-specific feature in wrapper/claude-code | Increases UI branching. |
| Remove cwd tracking from the specification | No good reason to freeze the Claude-side behavior. |

### F10 (phase split)

| Option | Why rejected |
|--------|--------------|
| Do everything in one phase | A single PR becomes bloated, and regression risk from the reorganisation and Codex implementation concentrates at once. |
| Split into 3+ phases | The phase boundary between F2-F9 becomes unclear and review count increases. |

## Related

- Origin: open-questions/spawn-engine-selection (opened 2026-06-26, fully merged
  into this ADR and deleted; its “actions when resolved” checklist was copied to
  the acceptance criteria of [phase-14-codex-adapter](../plans/phase-14-codex-adapter.md)).
- Implementation: [phase-13-wrapper-multipackage-restructure](../plans/phase-13-wrapper-multipackage-restructure.md), [phase-14-codex-adapter](../plans/phase-14-codex-adapter.md), and [phase-15-wrapper-ux-parity](../plans/phase-15-wrapper-ux-parity.md) (implementation of the F4bc addendum).
- Related ADRs: [0017](0017-wrapper-multientity-packages.md) (materialised by
  this ADR), [0022](0022-pending-permission-authoritative-source.md) /
  [0033](0033-permission-model-dual-axis.md) (two-axis permissions), [0023](0023-host-runner-architecture.md) D3 (execute the rename), [0001](0001-agent-sdk-integration.md) (adopt Claude SDK), [0027](0027-askuserquestion-envelope.md) (question envelope), [0014](0014-session-resume-and-restore.md) (resume), and [0034](0034-session-capabilities-advertisement.md) (extend the engine-neutralisation pattern through session capabilities).
- Related specs: [plugin-model](../specs/plugin-model.md), [protocol](../specs/protocol.md), [architecture](../specs/architecture.md), [personas](../specs/personas.md), [agent-sdk-events](../specs/agent-sdk-events.md) (Claude version), and [codex-sdk-events](../specs/codex-sdk-events.md) (new Codex version).
- Open questions (phase-14 period): [Q4 codex-cwd-extraction](../open-questions/codex-cwd-extraction.md), [codex-exec-approval-upstream](../open-questions/codex-exec-approval-upstream.md) (new 2026-07-10). Old Q1 (personality injection effectiveness) closed after real-machine verification on 2026-07-11; old Q2 (envelope schema) / Q3 (UI vocabulary) / Q5 (model catalog) / Q6 (compatibility window) were resolved and closed by real SDK verification + spec elicitation on 2026-07-10 (the decisions were added to this ADR and [ADR-0033](0033-permission-model-dual-axis.md)).
