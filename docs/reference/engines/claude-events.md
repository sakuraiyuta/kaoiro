---
title: Claude events
description: Actual message/callback specification of the TypeScript Claude Agent SDK and its verified derivation mapping to kaoiro state.
status: accepted
last_updated: 2026-10-04
related: [protocol, plugin-model, architecture, subagent-tasks]
---
<!-- markdownlint-disable MD033 -->

# Claude events

## Purpose

Establishes the **actual message/callback specification** of the TypeScript
Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) used by the Claude Code
adapter ([adapter contract](adapter-contract.md)), and defines its derivation to
kaoiro state ([protocol](../protocol/state-machine.md)). Verified against the official
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
| SDKCommandsChangedMessage | system / commands_changed | commands (SlashCommand[]) |
| SDKAssistantMessage | assistant | message(APIAssistantMessage: content contains text/thinking/tool_use), parent_tool_use_id, error? |
| SDKUserMessage | user | message(APIUserMessage: includes tool_result), parent_tool_use_id |
| SDKPartialAssistantMessage | stream_event | event(RawMessageStreamEvent) — only with `includePartialMessages: true` |
| SDKResultMessage | result | subtype, is_error, num_turns, total_cost_usd, usage, duration_ms, result(success)/ errors(failure) |

`SDKResultMessage.subtype`: `success` | `error_max_turns` |
`error_during_execution` | `error_max_budget_usd` |
`error_max_structured_output_retries`.

Tool results are returned not as separate messages but as **`SDKUserMessage`
(a tool_result block in content)**.

### Account rate limits before the first turn

The wrapper emits its first idle `state_change` immediately. At idle, including
a resumed session, it
starts the existing isolated catalog probe with `--usage`; the probe's SDK
Query sends no user message and uses a private temporary cwd and minimal
Options. Its separate `/usage` request can return the five-hour and seven-day
account windows before the production Query is created. A usage failure or
timeout does not fail catalog collection. The host converts the probe's raw
0–100 utilization and ISO reset times in `#applyUsageRateLimits`, the same
method used after a production Query's `/usage` response, then emits a
follow-up idle state only if a window changed. The production Query remains
deferred until the first input. The runner's catalog probe does not request
usage. A missing account source leaves `rate_limits` absent.
Closing the host cancels an outstanding startup probe and terminates its
subprocess through the probe client's existing signal escalation.

The [live measurement](../../evidence/issue-408/2026-09-26-pre-turn-rate-limits.md)
records the SDK and startup results.

### Task (subagent/workflow) messages

The parent session yields the lifecycle of subagents / local workflows started
by the Task tool as additional `type:"system"` subtypes. kaoiro derives these
into subagent/workflow notifications ([tasks](../protocol/tasks.md),
[ADR-0019](../../adr/0019-subagent-workflow-entity-and-task-envelope.md)).

| subtype | Main fields |
|---|---|
| task_started | task_id, description, subagent_type, task_type, workflow_name, tool_use_id, skip_transcript, **prompt** (undocumented; unwired) |
| task_progress | subagent_type, usage{total_tokens,tool_uses,duration_ms}, last_tool_name, summary |
| task_notification | status(completed/failed/stopped), summary, usage, **output_file** (undocumented; used for origin correlation, not emitted on the task envelope) |
| task_updated (**undocumented; out of scope**) | task_id, status(pending/running/completed/failed/killed/paused — broader than F3's four values) |

`task_started.prompt` (the complete instruction to the started subagent) and
`task_notification.output_file` (a local file path) are undocumented fields
whose existence was found by SDK observation, but they are not wired to the
`task` envelope (rationale and source: [ADR-0047](../../adr/0047-task-envelope-schema.md)
addendum). `task_updated` is a fourth subtype whose `status` is broader than
the coarse four-value lifecycle of [ADR-0019](../../adr/0019-subagent-workflow-entity-and-task-envelope.md)
F3, and is outside v1 scope (that ADR's addendum).

These do **not enter** `KaoiroState` (they do not change the parent state).
They are derived separately into the dedicated `task` envelope
([tasks](../protocol/tasks.md); implemented — stage 1 (wrapper), stage 2
(server), stage 3 (dashboard overhead ring)).

A background Bash or Agent completion can resume the SDK without a new wrapper
input. The host registers candidates only for `task_started.is_backgrounded`
tasks, since a foreground Bash also emits `task_notification` without an
autonomous continuation. The parent host correlates the candidate with the subsequent root
`UserPromptSubmit` and `PreToolUse` hooks before authorizing an inter-agent
call. A prompt ID shared with a confirmed live wrapper turn retains that turn's
reply snapshot and terminal result; a fresh ID with no live owner starts an
independent notification turn from confirmed completed input. An unknown task,
subagent call, retired prompt ID, or unmatched result cannot borrow the newest
wrapper turn. Notification candidates received during a live turn are retained
until its terminal boundary; unmatched candidates release the next-input
barrier after a bounded 10-second wait.
For an Agent notification, the hook may strictly omit `<output-file>` or carry
the exact path from its SDK `task_notification` frame. Either form requires the
known one-use background-task candidate, matching session, task and parent tool
IDs, status, and SDK summary in `<result>`. A present but empty, duplicated,
malformed, or mismatched path is rejected; it is never treated as omission.
If a different notification prompt is rejected while a wrapper turn is live,
an originless result cannot prove which prompt ended. The host stops admission
and revokes inter-agent send authority while keeping the wrapper owner until
stream teardown. The wrapper reports `state=error` and stderr contains
`notification result ownership ambiguous` and `notification result fail-stop`.

#### Foreign root intervals

A root interval whose opener the host cannot name (for example a background
`Agent` hand-back turn) is a *foreign root occupancy*. It is established by a
fresh-prompt-ID root `UserPromptSubmit` hook that matches no wrapper input and
no pending notification, or, when no hook was seen, by a busy frame with
`parent_tool_use_id === null`; child frames never establish it. The host grants
no send authority to it: root calls stay `unbound_tool_call`. It holds the
next-input barrier (including a pending pushed receipt, which resolves as
`unknown(foreign_occupancy)`), pauses notification candidate clocks, and
suppresses the turn-backed-state warning. A same-ID notification hook folds
into it without a token.

Any result under a live interval (a wrapper turn, an admitted notification
turn or an occupancy) must carry a `result_index` above every index seen
earlier in the host run; the index is a run-wide sequence, so the boundary
survives a session rebind and a stale result never lowers it.

Each live interval has one session binding: the host's known session when the
interval opens, else the first session a hook or frame in it names. Every later
hook, frame and result, terminal or not, is checked against that binding, and
it is never replaced; the host learns a session only through that check. A
conflict is kept as interval ambiguity (the rebind cleanup does not erase it)
and stops admission at the interval's terminal; an occupancy that sees another
session, and a result without a session ID, stop admission at once. Only a
result preceded by no session evidence at all (a startup error) supplies its
own ID.

The occupancy ends only at a result of the same session that passes those
checks. The result is displayed; no
admitted-turn callback fires, its prompt ID is retired, and candidate clocks
are rearmed in full. `conversation_reset`, compaction boundaries and an
interrupt ACK are not terminals and keep the barrier.

While a wrapper turn, an admitted notification turn or an occupancy is live, a
fresh-ID root hook that is not the uniquely recognized wrapper input marks the
interval identity ambiguous. A uniquely recognized wrapper input is the live
wrapper turn's exact yielded text, from the same session, not `system`-sourced
and not also a full rendering of a pending notification. Once ambiguous, no
result settles or releases anything: the next terminal stops admission. An
exact repeat of a retired result (same UUID, complete origin including the
peer sender and hand-back flags, and outcome) is ignored; a reused
`result_index` with any other identity stops admission.

An occupancy failure (ambiguous interval, wrong session, missing or
regressing `result_index`, session rebind frame, stream EOF) stops admission
with no owning token and enters `error`; recovery is the procedure below. A
result without the task-notification origin at an admitted notification turn
stops admission the same way, but with that turn's token: the host does not
abort the SDK, so a running child subagent finishes its work. A
foreign occupancy has no time bound: the hold lasts as long as the root
computation.

### Live delivery receipts and root ownership

With [Claude phase-2 delivery controls](../configuration/wrapper.md#claude-phase-2-delivery-controls)
enabled and delivery modes v1 negotiated, the host can push an early peer
batch into a live streaming-input `Query` without starting another wrapper
turn. A server-granted yield first needs a successful `yield_claim`; the host
then pushes its message with `priority: "now"`. The running tool finishes
before the current turn's result, and the pushed message starts a root prompt
with a new turn owner. Ordinary input from that peer remains serialized
behind the root until it settles. See [Claude recipient handoff](../inter-agent/delivery.md#claude-recipient-handoff)
for reply tickets, stages, and scheduling bounds.
This receipt path grants a new root owner only for a hook matching the one-use
receipt. Unmatched continuation hooks retain the existing admission guards;
phase 2 does not admit an arbitrary new prompt ID.

Each push has a one-use receipt bound to the current session, host generation,
`Query`, eligible turn, and exact text digest. The trusted
`UserPromptSubmit` hook decides whether it was folded into the live turn,
started a new root, or has an unknown handoff. The root branch voids its
provisional fold tickets. A hook with the `fold_id` but a different digest is
recorded as `unknown(digest_mismatch)` and creates no owner. The original
turn's default reply snapshot does not advance for a fold; only a ticket
spent by an actual call credits that input to completed history.

After the old result, the input iterator holds the next queued root while a
pushed receipt is pending. A live task-notification turn pauses that receipt's
deadline. If the root hook remains absent past
`pending_receipt_root_timeout_ms`, the host records
`unknown(root_hook_timeout)` for the pushed item, cancels queued roots with
`receipt_timeout_fail_stop`, freezes tool origins and admission, and enters
`error`. Queued roots were not handed to the engine and settle with
`failed_before_handoff`. Late results cannot reopen the failed host. Stderr
diagnostics count root-hook timeouts and notification clock pauses; folded
recovery capacity evictions carry a reason and count.

A host that closes while a receipt is pending, by a fail-stop or a stop, stops
holding: a closed host ignores hooks, so the input iterator returns and the
root-hook timeout no longer fires. The receipt then settles as `unknown` from
what the SDK stream still reports (a session change or a foreign root
interval), and at the latest as `unknown(stream_eof)` when the stream ends.

The [E1–E4 native measurements](../../evidence/issue-429/2026-09-28-claude-fold-measurements.md)
establish the measured running-tool fold, byte-identical hook text, new root
after a text-only result, and `priority: "now"` cut under isolated settings.
They do not establish the phase-2 wrapper's complete behavior under the
operator's production settings. Keep mode advertisement off until the
production-settings R3 result-to-hook measurement supports the configured
root-hook timeout.

### Recovering a fail-stopped Claude wrapper

A fail-stopped host never admits input again, so recovery always means a new
wrapper process. (The pushed-root case in the table below freezes only
inter-agent admission and leaves the host open, but it also needs a new
process.) Under a runner, that process usually starts without operator action.

**Automatic path.** `AgentHost#failStopAdmission`
(`wrapper/claude-code/src/host.ts`) closes the host, cancels queued input that
has not reached the SDK, and wakes the input iterator. `AgentHost#input()`
then returns because the host is closed and its queue is empty, so the SDK
closes the CLI's input. The CLI finishes the turn it is running, if any, and
exits. The stream end runs `#finishHost("stream_eof")`, `host.run()` returns,
and `runClaudeCli` (`wrapper/claude-code/src/cli.ts`) reports the disconnect
reason `stop` and exits with code 0. The exit waits for the running turn,
which can take minutes. The runner's `Supervisor#onExit`
(`runner/src/supervisor.ts`) treats every exit it did not request (no stop,
restart or reset in progress) as a crash, whatever the exit code, and
`#relaunch` starts the wrapper again: up to `MAX_RESTARTS` (5) relaunches per
`RESTART_WINDOW_MS` (60 s) window. Any launch other than an automatic relaunch
(spawn or restore, restart, session switch, session reset, or reset rollback),
or an exit more than 60 s into the window, starts a new window. This applies
to the notification, foreign-interval, result-index, session-binding and
`root_hook_timeout` fail-stops alike. The `root_hook_timeout` fail-stop does
not exchange the `Query` inside the failed wrapper either: the old `Query`
never receives the cancelled root.

**Session after an automatic relaunch.** `#relaunch` passes the resume session
the runner recorded when it last launched the agent (spawn, session switch,
restore, or reset rollback). If that launch used `--resume`, the relaunch
resumes the same session. If it was a fresh launch (a new agent, or a session
reset in either mode, `new` or `clear`), the runner does not know the session
the wrapper started afterwards, and the relaunch starts another fresh session:
the conversation context is not carried over. The new wrapper's session report then replaces the server's session pointer, so a later
**復帰** resumes the new session as well. The earlier session stays on disk;
reattach it with a session switch (`resume_session`, relayed to the runner as
[`switch_session`](../protocol/runner-control.md)). Resuming the live session
on relaunch is issue #524.

**When the operator must act.**

| Case | Why | Action |
| --- | --- | --- |
| Turn watchdog fail-stop | The watchdog stops the host when a turn stays inactive past its limit and does not end within the interrupt grace, or when it cannot interrupt the turn or attribute it. Closing the CLI's input is not expected to end such a turn, so the wrapper may never exit. This is inferred from the code and has not been measured. | Use the procedure below. |
| Pushed root ownership unavailable | The coordinator could not adopt a pushed root (`InterAgentTurnCoordinator#adoptPushedRoot` found no lease, or the root token already had a batch). `runClaudeCli` freezes only inter-agent admission and sends; the host is not closed, reports no `error`, keeps accepting operator input, and the wrapper does not exit. | Use the procedure below. |
| Restart cap reached | An unrequested exit after 5 relaunches in the same window logs `exceeded restart cap; leaving down`, and the runner stops relaunching. | Remove the cause, then **復帰**. |
| Context lost after a fresh relaunch | See the session paragraph above. | Switch the agent back to its earlier session. |

The procedure: use the dashboard's **終了** action on the affected agent card
to terminate the wrapper: the runner sends the wrapper SIGTERM, and the
wrapper's `host.close()` aborts the SDK, which ends the CLI, escalating from
SIGTERM to SIGKILL if the CLI does not exit. Wait until the card shows `disconnected`; the server rejects restore
while that wrapper is still live. Then use the card's **復帰** action, which
resumes the session in the server's session pointer (a fresh session when the
pointer holds none). Confirm that the agent
reconnects and reports `idle` or `waiting_input` with a new live wrapper, and
that new input can be accepted.

On either path, the old wrapper's unresolved owner is settled on stream
teardown, once, before the new wrapper starts. A session reset cannot recover
the live `error` state: the reset endpoint accepts only `idle` or
`waiting_input`. The server's reply basis comparison remains in force after a
relaunch or restore, and a new wrapper generation admits input only after its
own join and reply-basis negotiation succeed.

The dated SDK 0.3.220 observation is preserved in
[Claude SDK boundary evidence](../../evidence/claude/sdk-boundaries-2026.md#task-notification-terminal-paths).

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
`AskUserQuestionOutput`. See [ADR-0027](../../adr/0027-askuserquestion-envelope.md).

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
> `allowedTools` (a local ceiling; [threat-model](../../architecture/security-threat-model.md)).
> (2) `waiting_permission` is driven in practice only by dangerous operations
> that cannot be resolved automatically or occur outside the sandbox, so the
> approval UI (Phase 3) operates only where human approval is required — as
> designed. The previous non-firing observation occurred because every tested
> operation was resolved by a preceding gate.

#### Commands for manual verification (canUseTool firing boundary)

The 2026-06 manual probe used `curl --version` under the wrapper defaults.
Its classifier paths and SDK setting boundary are in
[Claude SDK boundary evidence](../../evidence/claude/sdk-boundaries-2026.md#canusetool-firing-boundary).

### Control (gap 1 settled)

- Multi-turn control: in **streaming-input mode**, which passes an
  `AsyncIterable<SDKUserMessage>` as the `query()` prompt, additional messages
  can be sent to the running session.
- Interrupt: `Query.interrupt(): Promise<void>`.
- Mode change: `Query.setPermissionMode(mode)`.
- Process termination on `SIGTERM` (issue #391): the CLI's `SIGTERM` handler
  calls `close()` directly, never `interrupt()`. `close()` aborts an
  `AbortController` wired into `Options.abortController`, which drives the
  SDK's own subprocess escalation. The host also holds the direct CLI child
  until it exits or receives `SIGKILL` four seconds after host abort, before
  runner reset's five-second boundary. This does not contain a tool's
  `SIGTERM`-ignoring descendants. See
  [adapter-contract.md](adapter-contract.md#sigterm-handling-and-process-termination-timing)
  for the measured timing and the runner-grace interaction.
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
  init's `slash_commands` (#34). During fresh idle before the first turn, the
  startup probe's `initializationResult.commands` seeds `ext.slash_commands`
  with probe source priority, surfacing `/` completions immediately. Live
  `system/init`, `supportedCommands()`, and mid-session `commands_changed`
  messages supersede probe readings with live Query authority (issue #424).
  The probe projects each `SlashCommand` to its colon-qualified alias when it
  has one (`anthropic-skills:built-in-browser`), else to `name`. This rule is
  empirical: the SDK types do not define how init's `slash_commands` is
  spelled. Measured on SDK 0.3.284 (2026-10-01): the projected
  `initializationResult().commands` and live `system/init` `slash_commands`
  were both 145 entries, equal in order, with no difference either way. 33
  rows carried a colon alias, and 9 rows carried only colon-free aliases and
  kept `name`. Re-measured on SDK 0.3.289 (2026-10-04) against a loopback API
  with an isolated config (skills and plugins linked, no account-provided
  skills): 100 entries each, equal in order; no row carried a colon alias, so
  that branch of the projection was not exercised on 0.3.289. Re-measure this
  when the SDK is bumped. The probe runs in an
  isolated temporary cwd with no MCP servers, so project-scoped commands and
  MCP-provided commands are expected to be missing until the first live
  turn. This is inferred, not measured. If the probe fails, the list stays
  empty until the first turn's `system/init`, as before.
  Bare `/model` and `/effort` do not surface as
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
  ([protocol channels](../protocol/channels.md#directional-message-types-v0-settled)).

### Hooks (SDK surface; kaoiro wires only `CwdChanged`)

The SDK offers `PreToolUse` / `PostToolUse` / `Notification` /
`UserPromptSubmit` / `Stop` / `SubagentStop` / `SessionStart` / `SessionEnd` /
`PreCompact`. kaoiro does not consume them for state derivation: the message
sequence + `canUseTool` cover it, and the host registers only `CwdChanged`
(merged with caller-supplied hooks).

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
| `waiting_question` | During a `canUseTool` call with `toolName === "AskUserQuestion"` (Promise pending), [ADR-0027](../../adr/0027-askuserquestion-envelope.md) |
| `waiting_input` | After `SDKResultMessage`, while streaming input awaits the next message |
| `done` | `SDKResultMessage` subtype `success` (instant → `waiting_input`) |
| `error` | `SDKResultMessage` subtype `error_*` / is_error, or `SDKAssistantMessage.error` |
| `disconnected` | Outside the SDK (wrapper ↔ server disconnect; derived server-side) |

`system/task_*` (subagent/workflow) **does not map** to `KaoiroState` — it does
not change the parent state and derives separately to a dedicated envelope
([tasks](../protocol/tasks.md)).

### session_capabilities and optimistic stamps (2026-07-11, [ADR-0034](../../adr/0034-session-capabilities-advertisement.md) F1 / phase-15 15-4b)

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
`wrapper/claude-code/src/host.ts` (`#statusExt`) only when explicitly
specified. Necessary ext values appear in a state_change directly after startup
even before `SDKSystemMessage` (init) arrives.

## Constraints

- SHOULD: Use `includePartialMessages: true` when fine-grained `thinking`
  detection is needed.
- MUST: Represent `waiting_permission` with the pending `canUseTool` Promise
  and resolve it through a UI response.

## Open Questions

None. The common-envelope type/payload design is settled in
[ADR-0010](../../adr/0010-protocol-precisification.md).

## See Also

- Related specs: [protocol](../protocol/state-machine.md), [extensions](../../architecture/extensions.md),
  [architecture](../../architecture/system-overview.md), [tasks](../protocol/tasks.md)
- ADRs: [0001](../../adr/0001-agent-sdk-integration.md),
  [0019](../../adr/0019-subagent-workflow-entity-and-task-envelope.md)
- Sources: code.claude.com/docs/en/agent-sdk/typescript and others (verified
  2026-06)

## Input-bound inter-agent replies

See [the reply-basis contract](../inter-agent/reply-basis.md) for negotiated protection, native tool origin binding, inline recovery, and the staged rollout boundary.
