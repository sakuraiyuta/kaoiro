---
title: Codex exec event reference
status: accepted
last_updated: 2026-09-18
related: [protocol, plugin-model, system-overview, claude-events]
---
<!-- markdownlint-disable MD033 -->

# Codex adapter — Codex SDK event specification

## Backend scope

Codex defaults to the exec SDK path documented below. Runner-local
`codex.backend = "app-server"` explicitly selects the app-server adapter for
subsequent wrapper launches/resumes; its pinned notification mappings and
acceptance evidence are in [ADR-0058 Appendix C](../../evidence/codex-app-server/stage1-compatibility.md#appendix-c--stage-1-compatibility-gate-2026-09-18-jst)
and the [wrapper README](../../../wrapper/codex/README.md). Both paths preserve
queued IA, fixed `approval=never`, permission observation, and the existing
log/result/lifecycle wire. App-server does not silently fall back to exec.

## Purpose

Establishes the **actual event/callback specification** of the TypeScript Codex
SDK used by the Codex adapter (currently `@openai/codex-sdk` 0.153.4 in
[`pnpm-lock.yaml`](../../../pnpm-lock.yaml))
([adapter contract](adapter-contract.md)), and defines its derivation to kaoiro state
([protocol](../../specs/protocol.md)). This specification is paired with the Claude version
in [agent-sdk-events](claude-events.md) and is converted to the common
`AdapterEvent`.

**Status: accepted** — In addition to validation of type definitions, SDK
implementation, bundled binary, and upstream `rust-v0.144.1` source
(2026-07-10), it was promoted to accepted after running a real turn from the
dashboard with ChatGPT-plan authentication on 2026-07-11. Three points settled
by live verification are recorded in [“Live verification notes”](../../evidence/codex/exec-contract.md#live-verification-notes-2026-07-11-chatgpt-plan-authentication).
Those measurements and the explicitly labeled 0.144.1 type inventory retain
their original version scope; they are not a new live verification of 0.153.4.
The current backend boundary and bridge policy are described separately below.

## Definition

The opt-in app-server projection is specified separately in
[the Codex wrapper internals](../../../wrapper/codex/README.md) and
[ADR-0058 Appendix C](../../adr/0058-codex-app-server-turn-steer.md).
Normal launch defaults to the exec mapping below; the explicit backend selector
described above also makes app-server available. The app-server path
reuses its known-item adapter functions, but preserves phase-aware final text,
all completed assistant rows, and the app-server terminal status independently.

### Main API and process model

```typescript
import { Codex } from "@openai/codex-sdk";

const codex = new Codex({ config: { developer_instructions: "..." } });
const thread = codex.startThread({ sandboxMode: "workspace-write" });
const { events } = await thread.runStreamed(prompt);
for await (const ev of events) {
  // ev.type: thread.started | turn.started | item.started | item.updated
  //        | item.completed | turn.completed | turn.failed | error
}
```

- **Process model (important)**: The SDK has no resident session. Every call to
  `thread.run()` / `thread.runStreamed()` **spawns a new
  `codex exec --experimental-json` subprocess**, and later turns resume with
  `codex exec resume <thread_id>`. stdin closes directly after writing the
  prompt — **there is no path for a caller to provide input during execution**
  (neither approval nor extra input). Interrupt a turn by killing the process
  through `TurnOptions.signal` (AbortSignal).
- **`Codex(options)`** — `codexPathOverride` / `baseUrl` / `apiKey` (injected as
  env `CODEX_API_KEY`) / `config` (arbitrary `--config key=value` override,
  supplied on every run) / `env`.
- **`codex.startThread(threadOptions)`** — `model` / `sandboxMode` /
  `workingDirectory` / `skipGitRepoCheck` / `modelReasoningEffort` /
  `networkAccessEnabled` / `webSearchMode` / `approvalPolicy` (serialized as a
  CLI `--config approval_policy=...` override; the wrapper pins `never`, below)
  / `additionalDirectories`.
- **`codex.resumeThread(id, threadOptions)`** — Resume an existing thread. Pass
  the UUID retained by the wrapper as the opaque `session_id` value
  ([ADR-0014](../../adr/0014-session-resume-and-restore.md)).
- **`thread.id`** — UUIDv7 string populated after initial `thread.started`
  (for example, `019f4bdb-d821-7631-aee1-ec7982060311`).

### ThreadEvent variants (actual 0.144.1 types)

| type | Meaning | Main fields |
|---|---|---|
| `thread.started` | Thread-start notification | Only `thread_id` (**does not carry** model / sandbox / cwd) |
| `turn.started` | Turn start | (none) |
| `item.started` | One item starts | `item` (ThreadItem, initial state in_progress) |
| `item.updated` | Item update | `item` |
| `item.completed` | Item completion | `item` |
| `turn.completed` | Turn completion | `usage` (input/cached_input/output/reasoning_output tokens. **No USD cost**. **Note**: `input_tokens` contains only per-turn input, shrinks with compaction, and excludes reasoning/output, so its semantics **differ from context utilization**. Do not repurpose it for context ([ADR-0040](../../adr/0040-context-usage-capability.md), phase-21)) |
| `turn.failed` | Turn failure | `error.message` |
| `error` | Fatal error on stream | `message` |

ThreadItem variants (`item.type`):

- `agent_message` — text (model utterance)
- `reasoning` — text (summarized reasoning)
- `command_execution` — command / aggregated_output / exit_code / status
- `file_change` — changes[] (path, kind=add|delete|update) / status
- `mcp_tool_call` — server / tool / arguments / result? / error? / status
- `web_search` — query
- `todo_list` — items[] (text, completed)
- `error` — message (nonfatal item)

`Thread.runStreamed()` reads only stdout from one `codex exec` tied to that
`Thread`. The SDK 0.144.1 `ThreadEvent` union has neither child-thread events
nor an item's origin / child-thread ID, so the SDK contract has no path to pass
child-thread items into the parent stream. Therefore a `todo_list` received by
one `CodexHost` is treated as belonging to its own parent thread. If a future
SDK adds child-originated events, explicitly verify provenance before wiring
them to tasklist.

**Note**: The `dynamic_tool_call` item assumed during drafting does not exist.
Every kaoiro tool call is observed as `mcp_tool_call` (server="kaoiro")
through the MCP bridge in [ADR-0032](../../adr/0032-codex-adapter.md) F5.

### State derivation

Derivation from Codex ThreadEvent → kaoiro state ([protocol](../../specs/protocol.md))
passes through the common `AdapterEvent` ([adapter contract](adapter-contract.md)):

| ThreadEvent | kaoiro state | Notes |
|---|---|---|
| `thread.started` | `session_init` — update envelope `session_id` with `thread_id` | The event has no model / cwd. An explicit model is the spawn-time value; resolve the account default from each turn's rollout `turn_context.payload.model` and stamp it to wrapper `ext` (do not promote a default value into an explicit next-turn selection) |
| `turn.started` | `thinking` | Equivalent to directly after Claude sends a user message |
| `item.started` (agent_message / reasoning) | `thinking` | Output starts |
| `item.completed` (agent_message) | Emit `log` (kind=assistant, text) | Protocol log envelope |
| `item.started` (command_execution) | `tool_running` | Execution in sandbox (no approval occurs, [ADR-0033](../../adr/0033-permission-model-dual-axis.md) F3) |
| `item.completed` (command_execution) | `log` (kind=tool_result, tool_name=shell, output=aggregated_output) | |
| `item.started` (file_change) | `tool_running` | Applying patch |
| `item.completed` (file_change) | `log` (kind=tool_result, tool_name=edit) | |
| `item.started` (mcp_tool_call, server=kaoiro, tool=ask_user_question) | `waiting_question` — `question_request` envelope ([ADR-0027](../../adr/0027-askuserquestion-envelope.md)) issued by bridge → wrapper handler | Valid because the turn blocks until the MCP response |
| `item.started` (mcp_tool_call, server=kaoiro, tool=send_to_agent, etc.) | `tool_running` | Inter-agent tool, through common Tool description layer |
| `item.started` (mcp_tool_call, another server) / (web_search) | `tool_running` | |
| `item.started` / `item.updated` / `item.completed` (todo_list) | No state effect; emit parent agent's `task_type=tasklist` whole-list snapshot | Do not turn into transcript log. Map `completed: boolean` to protocol `pending` / `completed` (issue #178, tasklist addendum in [protocol](../../specs/protocol.md)) |
| `item.completed` (reasoning) | No state effect | Logging is optional (not adopted in MVP) |
| `item.completed` (error item) | No state effect; record as `log` equivalent | Nonfatal |
| `turn.completed` | `done` → `waiting_input` — issue envelope `type=result`. Because USD is unavailable, **do not include** `ext.cost` for Codex. Also **do not include** `ext.context` ([ADR-0040](../../adr/0040-context-usage-capability.md) phase-21), because `usage.input_tokens` is only per-turn input and not context utilization. Advertise “unsupported” to UI with `ext.session_capabilities.supports_context_usage=false` | Success `AdapterEvent` consumed by the shared state machine |
| `turn.failed` / `error` | `error` — issue `state_change(error)` | Equivalent to Claude SDKResultMessage(error_*) |

Do not settle rollout resolution of an account-default model at `turn.started`,
which may mistake the prior turn's `turn_context` for the current value;
background-refresh it after `turn.completed`. Filesystem retries do not block a
terminal state or acceptance of the next turn. For an unresolved turn, omit
`model` / `model_source` rather than retaining the preceding turn's
account-default model, treating dashboard “awaiting confirmation” and field
omission in `whoami` as the same unknown state. When a later retry resolves it,
first use a generation guard to verify it will not overwrite a new turn, then
restamp current state. The resolved value is display metadata and does not pin
the next turn's `ThreadOptions.model`.

### Permission (no approval flow exists)

The wrapper explicitly sets `approvals_reviewer="user"` on the SDK client and
`approvalPolicy="never"` for new and resumed threads. Both are CLI `--config`
overrides that take precedence over host `config.toml` defaults. An unconfigured
`codex exec` must not be assumed to force `never`: host
`approvals_reviewer="auto_review"` can change its effective policy to
`on-request`. The SDK/exec path has no approval-request callback wired into
kaoiro. Therefore:

- Codex permissions expose sandbox and network controls with approval fixed to
  `never` ([ADR-0033](../../adr/0033-permission-model-dual-axis.md) F3). The wrapper
  checks rollout observations against the requested settings.
- A permission-policy mismatch can produce `waiting_permission` to block further
  execution. This is a permission gate, not an interactive tool approval;
  `pending_permission` and `permission_decision` are not used for Codex tool
  approval.
- A command needing escalation outside the sandbox is automatically denied and
  returned to the model as failure (the model attempts an in-sandbox alternative).
- Track upstream exec approval support (feature flag `exec_permission_approvals`,
  in development) in [open-questions/codex-exec-approval-upstream](../../open-questions/codex-exec-approval-upstream.md).

### Session / thread resume and enumeration

- Storage: Retain the `thread_id` (UUIDv7) obtained at initial `thread.started`
  as kaoiro `session_id`, and write it to `AgentStates` / `SessionPointers`
  ([ADR-0014](../../adr/0014-session-resume-and-restore.md)).
- Resume: Resume with `codex.resumeThread(thread_id)` on a restore instruction.
- Enumeration: Asynchronously walk
  `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` newest-first as a
  fixed-depth date tree, matching the `cwd` field in the first `session_meta`
  line (confirmed with real files). Existence checks return early on a match and
  do not block the runner event loop in hot paths for spawn / resume /
  `switch_session` (#97). Do not depend on the internal index in
  `~/.codex/state_5.sqlite`.
- History replay (#103): Because SDK `resumeThread()` does not re-emit past
  events, the wrapper projects rollout `response_item` to user / assistant /
  tool_use / tool_result logs. Codex 0.144.1 code-mode tools persist as
  `custom_tool_call{name:"exec"}` regardless of actual tool type; their actual
  name remains only in `tools.<name>(...)` in `input`. For a single call,
  recover that name and normalize `exec_command` to `shell`, as in the live
  display. When multiple or unknown, do not infer and fall back to `shell`.
  In addition to the legacy string form, accept the `input_text[]` form of the
  corresponding `custom_tool_call_output.output`, and reconstruct actual output
  without the code-mode runner header as tool_result.

### session_capabilities advertisement timing (2026-07-11, [ADR-0034](../../adr/0034-session-capabilities-advertisement.md) F1, phase-15)

Stamp `ext.session_capabilities` **from the first state_change directly after
spawn without waiting for `thread.started`** (ADR-0034 F1). This follows from
the process model in this specification:

- Because `codex exec` spawns a new process every turn, `thread.started` **does
  not arrive until the first turn occurs**. The CodexHost run loop sleeps idle
  awaiting `#wake` while its queue is empty, and `thread.started` never fires
  during that time.
- When unstamped, the UI fails closed by interpreting “no capability” (attachment
  button disabled, question-dialog features displayed “unsupported”). Waiting
  for session_init equivalent makes a directly started Codex agent display
  incorrectly as “unsupported.”
- Mitigation: Assemble capabilities at adapter construction (Codex uses
  `supports_attachments: true` / `attachment_types: ["image"]` /
  `supports_user_input_dialog: true`) and stamp
  them in `ext` of the first state_change (idle announce, issued by cli.ts).
  Retain the same ext on later state_change and update values that can change
  when they change (symmetric with Claude).

This is the same path as the optimistic-stamp principle of phase-15 15-4b/4c.
`supports_model_switch` / `supports_effort_switch` were implemented in phase-16
(host verified 2026-07-13). Within `session_capabilities`, the adapter updates
advertisement as needed according to catalog-resolver output
([ADR-0035](../../adr/0035-codex-model-catalog-and-mid-session-switch.md) F4,
[plugin-model](../../specs/plugin-model.md)).

### Tool definition (MCP bridge)

On the Codex side, provide `wrapper/agent-common`'s common Tool description
layer (JSON Schema + handler) through the stdio MCP bridge bundled in
`@kaoiro/codex` ([ADR-0032](../../adr/0032-codex-adapter.md) F5):

The following is a bridge-configuration excerpt, not the complete Host setup.
Both backends use the shared
[`BRIDGE_MCP_POLICY`](../../../wrapper/codex/src/bridge_policy.ts): the bridge is
required, so startup failure fails the turn rather than silently omitting kaoiro
tools. See the [Host setup](../../../wrapper/codex/src/host.ts) and
[startup measurements](../../evidence/codex-app-server/session-and-bridge.md#ci-follow-up-required-bridge-startup).

```typescript
const codex = new Codex({
  config: {
    developer_instructions: personalityPrompt,
    mcp_servers: {
      kaoiro: {
        command: process.execPath,
        args: [bridgeScriptPath],
        env: { KAOIRO_BRIDGE_SOCKET: socketPath },
        required: true,
        startup_timeout_sec: 30,
        default_tools_approval_mode: "approve",
        tool_timeout_sec: 310,
      },
    },
  },
});
```

- The bridge is a stdio MCP server that codex spawns for each turn. It connects
  to the parent wrapper through an env Unix socket and forwards tool calls
  (`ask_user_question` / `mcp__kaoiro__send_to_agent` / `list_agents` /
  `whoami`) to the wrapper-side common handler.
- The Claude adapter maps the same (name, description, inputSchema, handler)
  to a Zod schema + `createSdkMcpServer`. SoT is the common Tool description
  layer in wrapper/agent-common.

### System-prompt equivalent (persona personality injection)

Use config key `developer_instructions` ([ADR-0032](../../adr/0032-codex-adapter.md)
F3, live demonstrated 2026-07-10):

- It is **appended** to base instructions as a developer-role message (confirmed
  in rollout files).
- Do not use `instructions` / `model_instructions_file`, because they **replace**
  base instructions (upstream strongly discourages them too).
- AGENTS.md (cwd / `$CODEX_HOME`) is also an append path, but kaoiro does not
  use it because it dirties the user's working repository.
- No interference with built-in `personality` configuration
  (none/friendly/pragmatic; exec default pragmatic) was observed in live
  verification on 2026-07-11 ([the live verification record](../../evidence/codex/exec-contract.md)).

The `personality.md` from [personas](../../specs/personas.md) is shared unchanged by both
engines ([ADR-0032](../../adr/0032-codex-adapter.md) F3).

## Constraints

- **MUST**: Use the Codex thread ID (UUIDv7) directly as `session_id`; do not
  give it a custom prefix ([ADR-0032](../../adr/0032-codex-adapter.md) F8).
- **MUST**: Stamp `ext.permission = {sandbox, approval}` at spawn with approval
  fixed to `never` ([ADR-0033](../../adr/0033-permission-model-dual-axis.md)).
- **MUST NOT**: Write `CODEX_API_KEY` / ChatGPT login information to config JSON
  / envelopes / logs ([ADR-0032](../../adr/0032-codex-adapter.md) F7).
- **MUST NOT**: Use `instructions` / `model_instructions_file`, which replace
  base instructions.
- **SHOULD**: Track cwd on a best-effort basis
  ([codex-cwd-extraction](../../open-questions/codex-cwd-extraction.md)); MVP may
  display a fixed startup cwd.

## See Also

- Related specs: [protocol](../../specs/protocol.md), [extensions](../../architecture/extensions.md),
  [architecture](../../architecture/system-overview.md), [agent-sdk-events](claude-events.md)
  (paired with Claude version)
- ADR: [ADR-0032](../../adr/0032-codex-adapter.md) (introducing Codex adapter),
  [ADR-0033](../../adr/0033-permission-model-dual-axis.md) (two permission axes)
- Open questions: [codex-cwd-extraction](../../open-questions/codex-cwd-extraction.md),
  [codex-exec-approval-upstream](../../open-questions/codex-exec-approval-upstream.md)
- Plan: [phase-14-codex-adapter](../../plans/phase-14-codex-adapter.md)

## Migration links

- [Dated exec verification](../../evidence/codex/exec-contract.md)
