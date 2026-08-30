---
title: Claude Code adapter — Agent SDK event specification
description: Actual message/callback specification of the TypeScript Claude Agent SDK and its verified derivation mapping to kaoiro state.
status: accepted
related: [protocol, plugin-model, architecture, subagent-tasks]
---
<!-- markdownlint-disable MD033 -->

# Claude Code adapter — Agent SDK event specification

## Purpose

Establishes the **actual message/callback specification** of the TypeScript
Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) used by the Claude Code
adapter ([plugin-model](plugin-model.md)), and defines its derivation to
kaoiro state ([protocol](protocol.md)). Verified against the official
documentation (code.claude.com / platform.claude.com; 2026-06).

## Definition

### Message sequence (query() / Query)

`query()` returns a `Query` (= `AsyncGenerator<SDKMessage, void>`) and yields
the following sequentially.

```typescript
type SDKMessage =
  | SDKAssistantMessage         // type: 'assistant'
  | SDKUserMessage              // type: 'user'(tool_result を含む)
  | SDKUserMessageReplay
  | SDKResultMessage            // type: 'result'
  | SDKSystemMessage            // type: 'system', subtype: 'init'
  | SDKPartialAssistantMessage  // type: 'stream_event'(部分更新)
  | SDKCompactBoundaryMessage;
```

| Variant | type / subtype | Main fields |
|---|---|---|
| SDKSystemMessage | system / init | session_id, model, tools[], cwd, permissionMode, mcp_servers, slash_commands |
| SDKAssistantMessage | assistant | message(APIAssistantMessage: content contains text/thinking/tool_use), parent_tool_use_id, error? |
| SDKUserMessage | user | message(APIUserMessage: includes tool_result), parent_tool_use_id |
| SDKPartialAssistantMessage | stream_event | event(RawMessageStreamEvent) — only with `includePartialMessages: true` |
| SDKResultMessage | result | subtype, is_error, num_turns, total_cost_usd, usage, duration_ms, result(success)/ errors(failure) |

`SDKResultMessage.subtype`: `success` | `error_max_turns` |
`error_during_execution` | `error_max_budget_usd` |
`error_max_structured_output_retries`.

Tool results are returned not as separate messages but as **`SDKUserMessage`
(a tool_result block in content)**.

### Task (subagent/workflow) messages

The parent session yields the lifecycle of subagents / local workflows started
by the Task tool as additional `type:"system"` subtypes. kaoiro derives these
into subagent/workflow notifications ([subagent-tasks](subagent-tasks.md),
[ADR-0019](../adr/0019-subagent-workflow-entity-and-task-envelope.md)).

| subtype | Main fields |
|---|---|
| task_started | task_id, description, subagent_type, task_type, workflow_name, tool_use_id, skip_transcript, **prompt** (undocumented; unwired) |
| task_progress | subagent_type, usage{total_tokens,tool_uses,duration_ms}, last_tool_name, summary |
| task_notification | status(completed/failed/stopped), summary, usage, **output_file** (undocumented; unwired) |
| task_updated (**undocumented; out of scope**) | task_id, status(pending/running/completed/failed/killed/paused — broader than F3's four values) |

`task_started.prompt` (the complete instruction to the started subagent) and
`task_notification.output_file` (a local file path) are undocumented fields
whose existence was found by SDK observation, but they are not wired to the
`task` envelope (rationale and source: [ADR-0047](../adr/0047-task-envelope-schema.md)
addendum). `task_updated` is a fourth subtype whose `status` is broader than
the coarse four-value lifecycle of [ADR-0019](../adr/0019-subagent-workflow-entity-and-task-envelope.md)
F3, and is outside v1 scope (that ADR's addendum).

These do **not enter** `KaoiroState` (they do not change the parent state).
They are derived separately into the dedicated `task` envelope
([subagent-tasks](subagent-tasks.md); implemented — stage 1 (wrapper), stage 2
(server), stage 3 (dashboard overhead ring)).

**Observed record (task_notification terminal guarantee, issue #170)**: SDK
`0.3.220`, captured 2026-08-09. A disposable script captured a real `query()`
stream and verified that `task_notification` is always emitted along all four
paths: (a) natural subagent completion, (b) `Query.stopTask(taskId)` (emits a
`task_notification` with `status: "stopped"`, as documented), (c) parent-session
interrupt, and (d) `Query.backgroundTasks(toolUseId?)` (emits a
`task_notification` on settlement after being backgrounded). Paths through
`task_updated` also always converge on `task_notification` at termination.

### Permission callback (canUseTool)

```typescript
type CanUseTool = (
  toolName: string,
  input: ToolInput,
  options: { signal: AbortSignal; suggestions?: PermissionUpdate[] }
) => Promise<PermissionResult>;

type PermissionResult =
  | { behavior: 'allow'; updatedInput: ToolInput; updatedPermissions?: PermissionUpdate[] }
  | { behavior: 'deny';  message: string; interrupt?: boolean };
```

With `permissionMode: 'default'`, `canUseTool` is called for tools not decided
by a rule/mode. kaoiro leaves the Promise pending, waits for client-UI approval
or denial, and returns `behavior` = the driver for `waiting_permission`.

`toolName === "AskUserQuestion"` takes a separate path. It carries structured
questions (`AskUserQuestionInput`: `questions[].{question, header, multiSelect,
options[].{label, description, preview?}}`) to a dedicated dashboard dialog
and waits for the operator's selection = the driver for `waiting_question`.
It returns the answer to the SDK as
`{ behavior: "allow", updatedInput: { ...input, answers: { [質問文]: 選択 label } } }`
(deny on cancel / timeout / close), and the model receives it as
`AskUserQuestionOutput`. See [ADR-0027](../adr/0027-askuserquestion-envelope.md).

Evaluation order: PreToolUse Hook → Deny → Allow → Ask → Permission Mode →
canUseTool → PostToolUse.

> **Verification note (2026-06, SDK 0.3.162, headless live run)**: In the
> initial observation, `canUseTool` did not fire in any configuration tested,
> but **a follow-up experiment (2026-06-11, issue #1) confirmed the ask path
> fires**. Settled behavior:
>
> - When `canUseTool` is specified, the SDK always passes
>   `--permission-prompt-tool stdio` to the CLI (observed in sdk.mjs). The path
>   itself is not broken.
> - Before reaching ask, a tool call can be resolved automatically by preceding
>   gates: `allowedTools` permission, the safe-command classifier, auto-allow
>   for in-sandbox operations (observed: even with `allowedTools: ["Read"]`,
>   Bash `echo` runs without passing through canUseTool), and various auto-deny
>   cases (denial surfaces in a `system`/`permission_denied` message with
>   `decision_reason_type`).
> - **`canUseTool` fires for an operation escalated to ask**. The observed
>   minimal reproduction uses `permissionMode: "default"` + `settingSources: []`
>   and asks Bash to write outside the sandbox (`touch ~/...`); it fires and
>   the denial message is reflected in tool_result.
>
> **Implications**: (1) The primary defense limiting tools remains
> `allowedTools` (a local ceiling; [threat-model](threat-model.md)).
> (2) `waiting_permission` is driven in practice only by dangerous operations
> that cannot be resolved automatically or occur outside the sandbox, so the
> approval UI (Phase 3) operates only where human approval is required — as
> designed. The previous non-firing observation occurred because every tested
> operation was resolved by a preceding gate.

#### Commands for manual verification (canUseTool firing boundary)

To verify the broker → permission dialog → client approval path through the
dashboard on a real machine, a command is needed that reaches `canUseTool`
without being stopped by the SDK's built-in safe Bash classifier. Observed
boundaries (2026-06-22, verification for #59):

| Example | Path |
|---|---|
| `hostname` / `echo X` / `[ -f X ] && echo Y` | Classifier judges safe → auto-approve |
| `mkdir -p /tmp/...` | Treated as within the sandbox → auto-approve |
| `for f in ...; do ...; done` | Cannot statically analyze control syntax → ask → `canUseTool` fires |
| `curl --version` | Network-command name → ask → `canUseTool` fires |

For the most stable firing with no side effect, use **`curl --version`** (no
actual communication, small output, always succeeds). With default
`settingSources`, the SDK does not read `~/.claude/settings.json`, so a user's
settings allow list and PreToolUse hooks (such as `approve-compound-bash.sh`)
do not apply to SDK sessions through the wrapper — the boundaries above are
solely from the SDK's built-in classifier.

### Control (gap 1 settled)

- Multi-turn control: in **streaming-input mode**, which passes an
  `AsyncIterable<SDKUserMessage>` as the `query()` prompt, additional messages
  can be sent to the running session.
- Interrupt: `Query.interrupt(): Promise<void>`.
- Mode change: `Query.setPermissionMode(mode)`.
- Observation (message sequence) and control (input + interrupt + canUseTool)
  **complete in the same Query** (no separate mechanism needed). This settles
  ADR-0001's “details settled during implementation.”

`PermissionMode`: `default` | `acceptEdits` | `bypassPermissions` | `plan`
(and, depending on the environment, `dontAsk` / `auto`).

#### Notes on switching model / effort (#54 live verification, 2026-06-25, SDK 0.3.187)

The model / effort of a running session can be switched from the same `Query`
in streaming-input mode. Boundaries settled by a headless live run:

- **Getting options**: `supportedModels(): ModelInfo[]`. Each `ModelInfo` has
  `value` (API alias) / `displayName` / `description` / `supportsEffort` /
  `supportedEffortLevels`. The live return values were `default` / `opus[1m]` /
  `sonnet` / `sonnet[1m]` / `haiku` (only haiku does not support effort).
  The slash-command list is separately available from `supportedCommands()` /
  init's `slash_commands` (#34). Bare `/model` and `/effort` do not surface as
  SDK control and are only input text, so the dashboard constructs the
  selection UI from these lists.
- **Selection before the first turn (#107)**: Because `supportedModels()` waits
  for Query initialization, it cannot supply the catalog before an idle-wait
  spawn. Runner registration and the wrapper's first idle `ext.models`
  advertise an observed SDK 0.3.187 snapshot as an optimistic bootstrap, so
  LaunchDialog / AgentDetail can choose the first turn's model / effort. After
  SDK initialization, replace it with the account-aware `supportedModels()`
  return and retain no bootstrap-only option. The fable wire value observed on
  2026-07-13 was `claude-fable-5[1m]`; effort was
  `low|medium|high|xhigh|max`. Bootstrap does not guarantee entitlement; an SDK
  control rejection is displayed loudly as `switch_error`. The idle-wait
  wrapper delays Query creation itself until first input and buffers
  `set_model` / `set_effort` in startup Options meanwhile. Thus selection does
  not race SDK initialization and applies to the first turn itself.
- **Switching model**: `Query.setModel(value)`. `value` is the alias above. It
  succeeds without an exception.
- **Follow-up observation of canonical IDs (2026-07-31, SDK 0.3.220)**: A
  `Query` with `Options.model = "claude-sonnet-5"`, an isolated temporary
  directory, and a never-yielding prompt produced a successful
  `initializationResult`. However, that result's keys did not include `model`.
  During eight seconds of iterator observation without a first user input,
  only `hook_started` / `hook_response` appeared; `system/init` did not.
  Therefore this observation does not settle the representation (alias /
  canonical) of `model` returned by init. After initialization,
  `await q.setModel("claude-sonnet-5")` completed without an exception.

  kaoiro's preservation of the input representation is not an inference about
  the SDK's init representation; it is a contract at the wrapper boundary.
  Catalog aliases / `resolvedModel` are used only as matching metadata;
  `setModel`, startup `Options.model`, and state `#model` preserve the caller's
  string. Neither alias→canonical nor canonical→alias rewrites it.
- **Switching effort**: There is no dedicated setter;
  `Query.applyFlagSettings({ effortLevel })` is used. The value range is
  `EffortLevel = low|medium|high|xhigh|max` (`maxThinkingTokens` is deprecated).
  The `Settings.effortLevel` type stops at `xhigh`, but the runtime accepts all
  values through `max` without exception (verified by a live run).
- **Application granularity**: Both apply **to subsequent turns** (no session
  restart needed) = per next message. This settles #54's open question,
  “session-wide / per next message.”
- Broker path: the wrapper exposes options in `state_change.ext.models`, and
  receives and applies server → wrapper `set_model` / `set_effort` control
  ([protocol.md](protocol.md)).

### Hooks used (optional; auxiliary)

`PreToolUse` / `PostToolUse` / `Notification` / `UserPromptSubmit` / `Stop` /
`SubagentStop` / `SessionStart` / `SessionEnd` / `PreCompact`. State derivation
is mostly covered by the message sequence + `canUseTool`; hooks are auxiliary.

The `CwdChanged` hook (#64) is the only path that reflects cwd changes after
init in `state_change.ext.cwd` by piggyback (messages other than `init` do not
carry cwd). The hook emits no envelope; it assigns `#cwd` synchronously and
stamps it on the next `state_change` (the same pattern as `pending_permission`).

### State-derivation mapping

| kaoiro state | Derivation trigger (SDK) |
|---|---|
| `idle` | Receives `SDKSystemMessage` (init), before awaiting the next input |
| `sending` | Outside the SDK: when the wrapper accepts an operator instruction into the input queue (rest state only). The first `SDKAssistantMessage` exits it to thinking/tool_running (#32) |
| `thinking` | `SDKAssistantMessage` content is only text/thinking. Finer granularity comes from `stream_event` (`includePartialMessages`) |
| `tool_running` | From tool_use appearing in `SDKAssistantMessage` until corresponding `SDKUserMessage` (tool_result) |
| `waiting_permission` | During a `canUseTool` call (Promise pending) |
| `waiting_question` | During a `canUseTool` call with `toolName === "AskUserQuestion"` (Promise pending), [ADR-0027](../adr/0027-askuserquestion-envelope.md) |
| `waiting_input` | After `SDKResultMessage`, while streaming input awaits the next message |
| `done` | `SDKResultMessage` subtype `success` (instant → `waiting_input`) |
| `error` | `SDKResultMessage` subtype `error_*` / is_error, or `SDKAssistantMessage.error` |
| `disconnected` | Outside the SDK (wrapper ↔ server disconnect; derived server-side) |

`system/task_*` (subagent/workflow) **does not map** to `KaoiroState` — it does
not change the parent state and derives separately to a dedicated envelope
([subagent-tasks](subagent-tasks.md)).

### session_capabilities and optimistic stamps (2026-07-11, [ADR-0034](../adr/0034-session-capabilities-advertisement.md) F1 / phase-15 15-4b)

This establishes the post-startup stamp contract on the Claude side. Without
waiting for `SDKSystemMessage(init)`, stamp all of them from the first
state_change directly after spawn (the idle announce emitted by cli.ts):

- **`ext.session_capabilities`**: Assemble it when constructing the adapter and
  stamp it from the first state_change (symmetric with Codex. Waiting for
  session_init makes a Codex agent display incorrectly by failing closed, so
  both engines use the same contract). Initial Claude values are
  `supports_attachments: true` / `supports_user_input_dialog: true`
  (unconditional). Add a branch once the SDK makes it conditional.
- **`ext.model` / `ext.model_source`**: **Optimistically stamp** the resolved
  startup value from config / launch (`SpawnMessage.model`) / env
  (`KAOIRO_CLAUDE_CODE_DEFAULT_MODEL`). On receiving `SDKSystemMessage(init)`
  or `SDKStatusMessage`, overwrite **only the value** (for example, Claude
  expands an alias to a canonical name), while preserving `model_source` as
  launch/env/config (do not change it to default — it would lie about the
  value's source). If unspecified, there is no stamp directly after startup;
  `model` + `model_source="default"` first appear upon `SDKSystemMessage(init)`.
- **`ext.permission_mode`**: Optimistically stamp startup
  config.permission_mode, and overwrite only its value on receiving
  `SDKStatusMessage`. Also stamp the two-axis conversion (`ext.permission`)
  at the same time (the mapping table in ADR-0033 F2).
- **`ext.fast_mode`**: Optimistically stamp the value from launch at startup,
  and overwrite it at `SDKSystemMessage(init)` and each `SDKResultMessage`
  (`cooldown` is observed only in result).
- **`ext.effort` / `ext.effort_source`**: **An exception** — stamp only when an
  explicit startup value (`config.effort` / `SpawnMessage.effort`) exists. When
  unspecified, the wrapper does not stamp because it does not know the SDK
  default (the Claude Agent SDK does not put the default effort value in an
  event). Display it immediately only when explicit; otherwise await SDK
  reporting.
- **`ext.cwd`**: The existing CwdChanged-hook pattern (piggyback a cwd change
  after init onto the next state_change through synchronous assignment, lines
  187–190).

Implemented in phase-15 15-4b by removing the null guard on `#statusExt` in
`wrapper/claude-code/src/host.ts` (host.ts:842–852) only when explicitly
specified. Necessary ext values appear in a state_change directly after startup
even before `SDKSystemMessage` (init) arrives.

## Constraints

- SHOULD: Use `includePartialMessages: true` when fine-grained `thinking`
  detection is needed.
- MUST: Represent `waiting_permission` with the pending `canUseTool` Promise
  and resolve it through a UI response.

## Open Questions

None. The common-envelope type/payload design is settled in
[ADR-0010](../adr/0010-protocol-precisification.md).

## See Also

- Related specs: [protocol](protocol.md), [plugin-model](plugin-model.md),
  [architecture](architecture.md), [subagent-tasks](subagent-tasks.md)
- ADRs: [0001](../adr/0001-agent-sdk-integration.md),
  [0019](../adr/0019-subagent-workflow-entity-and-task-envelope.md)
- Sources: code.claude.com/docs/en/agent-sdk/typescript and others (verified
  2026-06)
