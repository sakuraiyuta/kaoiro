---
title: Codex adapter — Codex SDK event specification
description: Actual event/callback specification of the TypeScript @openai/codex-sdk and its derivation mapping to kaoiro state. Paired with the Claude version, agent-sdk-events.
status: accepted
related: [protocol, plugin-model, architecture, agent-sdk-events]
---
<!-- markdownlint-disable MD033 -->

# Codex adapter — Codex SDK event specification

## Purpose

Establishes the **actual event/callback specification** of the TypeScript Codex
SDK (`@openai/codex-sdk` 0.144.1) used by the Codex adapter
([plugin-model](plugin-model.md)), and defines its derivation to kaoiro state
([protocol](protocol.md)). This specification is paired with the Claude version
in [agent-sdk-events](agent-sdk-events.md) and is converted to the common
`AdapterEvent`.

**Status: accepted** — In addition to validation of type definitions, SDK
implementation, bundled binary, and upstream `rust-v0.144.1` source
(2026-07-10), it was promoted to accepted after running a real turn from the
dashboard with ChatGPT-plan authentication on 2026-07-11. Three points settled
by live verification are recorded under “Live verification notes” below.

## Definition

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
  `networkAccessEnabled` / `webSearchMode` / `approvalPolicy` (ineffective in
  exec; below) / `additionalDirectories`.
- **`codex.resumeThread(id, threadOptions)`** — Resume an existing thread. Pass
  the UUID retained by the wrapper as the opaque `session_id` value
  ([ADR-0014](../adr/0014-session-resume-and-restore.md)).
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
| `turn.completed` | Turn completion | `usage` (input/cached_input/output/reasoning_output tokens. **No USD cost**. **Note**: `input_tokens` contains only per-turn input, shrinks with compaction, and excludes reasoning/output, so its semantics **differ from context utilization**. Do not repurpose it for context ([ADR-0040](../adr/0040-context-usage-capability.md), phase-21)) |
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
through the MCP bridge in [ADR-0032](../adr/0032-codex-adapter.md) F5.

### State derivation

Derivation from Codex ThreadEvent → kaoiro state ([protocol](protocol.md))
passes through the common `AdapterEvent` ([plugin-model](plugin-model.md)):

| ThreadEvent | kaoiro state | Notes |
|---|---|---|
| `thread.started` | `session_init` — update envelope `session_id` with `thread_id` | The event has no model / cwd. An explicit model is the spawn-time value; resolve the account default from each turn's rollout `turn_context.payload.model` and stamp it to wrapper `ext` (do not promote a default value into an explicit next-turn selection) |
| `turn.started` | `thinking` | Equivalent to directly after Claude sends a user message |
| `item.started` (agent_message / reasoning) | `thinking` | Output starts |
| `item.completed` (agent_message) | Emit `log` (kind=assistant, text) | Protocol log envelope |
| `item.started` (command_execution) | `tool_running` | Execution in sandbox (no approval occurs, [ADR-0033](../adr/0033-permission-model-dual-axis.md) F3) |
| `item.completed` (command_execution) | `log` (kind=tool_result, tool_name=shell, output=aggregated_output) | |
| `item.started` (file_change) | `tool_running` | Applying patch |
| `item.completed` (file_change) | `log` (kind=tool_result, tool_name=edit) | |
| `item.started` (mcp_tool_call, server=kaoiro, tool=ask_user_question) | `waiting_question` — `question_request` envelope ([ADR-0027](../adr/0027-askuserquestion-envelope.md)) issued by bridge → wrapper handler | Valid because the turn blocks until the MCP response |
| `item.started` (mcp_tool_call, server=kaoiro, tool=send_to_agent, etc.) | `tool_running` | Inter-agent tool, through common Tool description layer |
| `item.started` (mcp_tool_call, another server) / (web_search) | `tool_running` | |
| `item.started` / `item.updated` / `item.completed` (todo_list) | No state effect; emit parent agent's `task_type=tasklist` whole-list snapshot | Do not turn into transcript log. Map `completed: boolean` to protocol `pending` / `completed` (issue #178, tasklist addendum in [protocol](protocol.md)) |
| `item.completed` (reasoning) | No state effect | Logging is optional (not adopted in MVP) |
| `item.completed` (error item) | No state effect; record as `log` equivalent | Nonfatal |
| `turn.completed` | `idle` — issue envelope `type=result`. Because USD is unavailable, **do not include** `ext.cost` for Codex. Also **do not include** `ext.context` ([ADR-0040](../adr/0040-context-usage-capability.md) phase-21), because `usage.input_tokens` is only per-turn input and not context utilization. Advertise “unsupported” to UI with `ext.session_capabilities.supports_context_usage=false` | Equivalent to Claude SDKResultMessage(success) |
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

`codex exec` forces `approval_policy=never` through a harness override (even
`-c approval_policy=...` is ineffective), and the JSON event stream has no
approval-request event. Therefore:

- A Codex agent's authority is **fixed on two axes at spawn**
  ([ADR-0033](../adr/0033-permission-model-dual-axis.md) F3): The wrapper stamps
  `ext.permission = { sandbox: <spawn-time selection>, approval: "never" }`.
- `waiting_permission` state, `pending_permission` ext, and
  `permission_decision` envelope do not occur for Codex.
- A command needing escalation outside the sandbox is automatically denied and
  returned to the model as failure (the model attempts an in-sandbox alternative).
- Track upstream exec approval support (feature flag `exec_permission_approvals`,
  in development) in [open-questions/codex-exec-approval-upstream](../open-questions/codex-exec-approval-upstream.md).

### Session / thread resume and enumeration

- Storage: Retain the `thread_id` (UUIDv7) obtained at initial `thread.started`
  as kaoiro `session_id`, and write it to `AgentStates` / `SessionPointers`
  ([ADR-0014](../adr/0014-session-resume-and-restore.md)).
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

### Live verification notes (2026-07-11, ChatGPT-plan authentication)

Three points found by starting real Codex agents (kuroe / ao) from the dashboard
and incorporated in implementation:

- **Model catalog is account default only (former; updated in phase-16)**:
  Under ChatGPT-plan authentication, every explicit `model` selection was
  rejected with 400/404 (the bundled catalog was for API keys), accepted models
  were account-dependent and could not be enumerated from the SDK. kaoiro made
  the Codex model catalog empty and omitted `model` to use the account default
  ([ADR-0032](../adr/0032-codex-adapter.md) F4bc). → **phase-16 update
  (2026-07-13, [ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md))**:
  Restore the catalog through an operator declaring `codex.chatgpt_plan` in
  `runner.config.json`; present Sol / Terra / Luna in LaunchDialog for Plus and
  above, and accept mid-session switching (for the mid-session-switch envelope
  contract, see `ext.pending_model` / `ext.effective` / `ext.switch_error` in
  [protocol](protocol.md); for Codex catalog details, see
  [codex-model-catalog](codex-model-catalog.md)).
- **MCP tools need auto-approval**: Under `codex exec` approval_policy=never,
  an MCP tool call defaults to “user cancelled MCP tool call.” Set
  `mcp_servers.kaoiro.default_tools_approval_mode: "approve"` to auto-approve
  kaoiro tools only ([ADR-0032](../adr/0032-codex-adapter.md) F5).
- **Envelope ordering for waiting_question**: Because the Codex adapter
  synchronously emits `state_change(waiting_question)` through
  `setPendingQuestion`, `QuestionBroker` sends the `question_request`
  notification **before** `onPendingChange`. Otherwise `question_request`
  without ext overwrites dashboard render state: no question dialog appears and
  the engine badge also disappears. Claude is unaffected because
  `setPendingQuestion` only stamps, while state_change is emitted separately.
- **Effectiveness of persona injection**: kuroe (calls the user “Master,”
  secretary manner) and ao (first-person “watashi,” plain style, concise) were
  clearly differentiated, confirming that `developer_instructions` injection
  works faithfully per persona (former Q1 closed). No interference with built-in
  `personality` configuration was observed, so `none` was unnecessary.

### session_capabilities advertisement timing (2026-07-11, [ADR-0034](../adr/0034-session-capabilities-advertisement.md) F1, phase-15)

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
  `supports_attachments: false` / `supports_user_input_dialog: true`) and stamp
  them in `ext` of the first state_change (idle announce, issued by cli.ts).
  Retain the same ext on later state_change and update values that can change
  when they change (symmetric with Claude).

This is the same path as the optimistic-stamp principle of phase-15 15-4b/4c.
`supports_model_switch` / `supports_effort_switch` were implemented in phase-16
(host verified 2026-07-13). Within `session_capabilities`, the adapter updates
advertisement as needed according to catalog-resolver output
([ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md) F4,
[plugin-model](plugin-model.md)).

### Tool definition (MCP bridge)

On the Codex side, provide `wrapper/agent-common`'s common Tool description
layer (JSON Schema + handler) through the stdio MCP bridge bundled in
`@kaoiro/codex` ([ADR-0032](../adr/0032-codex-adapter.md) F5):

```typescript
const codex = new Codex({
  config: {
    developer_instructions: personalityPrompt,
    mcp_servers: {
      kaoiro: {
        command: process.execPath,
        args: [bridgeScriptPath],
        env: { KAOIRO_BRIDGE_SOCKET: socketPath },
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

Use config key `developer_instructions` ([ADR-0032](../adr/0032-codex-adapter.md)
F3, live demonstrated 2026-07-10):

- It is **appended** to base instructions as a developer-role message (confirmed
  in rollout files).
- Do not use `instructions` / `model_instructions_file`, because they **replace**
  base instructions (upstream strongly discourages them too).
- AGENTS.md (cwd / `$CODEX_HOME`) is also an append path, but kaoiro does not
  use it because it dirties the user's working repository.
- No interference with built-in `personality` configuration
  (none/friendly/pragmatic; exec default pragmatic) was observed in live
  verification on 2026-07-11 (the “Live verification notes” above).

The `personality.md` from [personas](personas.md) is shared unchanged by both
engines ([ADR-0032](../adr/0032-codex-adapter.md) F3).

## Constraints

- **MUST**: Use the Codex thread ID (UUIDv7) directly as `session_id`; do not
  give it a custom prefix ([ADR-0032](../adr/0032-codex-adapter.md) F8).
- **MUST**: Stamp `ext.permission = {sandbox, approval}` at spawn with approval
  fixed to `never` ([ADR-0033](../adr/0033-permission-model-dual-axis.md)).
- **MUST NOT**: Write `CODEX_API_KEY` / ChatGPT login information to config JSON
  / envelopes / logs ([ADR-0032](../adr/0032-codex-adapter.md) F7).
- **MUST NOT**: Use `instructions` / `model_instructions_file`, which replace
  base instructions.
- **SHOULD**: Track cwd on a best-effort basis
  ([codex-cwd-extraction](../open-questions/codex-cwd-extraction.md)); MVP may
  display a fixed startup cwd.

## See Also

- Related specs: [protocol](protocol.md), [plugin-model](plugin-model.md),
  [architecture](architecture.md), [agent-sdk-events](agent-sdk-events.md)
  (paired with Claude version)
- ADR: [ADR-0032](../adr/0032-codex-adapter.md) (introducing Codex adapter),
  [ADR-0033](../adr/0033-permission-model-dual-axis.md) (two permission axes)
- Open questions: [codex-cwd-extraction](../open-questions/codex-cwd-extraction.md),
  [codex-exec-approval-upstream](../open-questions/codex-exec-approval-upstream.md)
- Plan: [phase-14-codex-adapter](../plans/phase-14-codex-adapter.md)
