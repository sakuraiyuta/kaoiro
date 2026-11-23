---
title: Antigravity events
description: How the Antigravity host runs agy over ACP with one process per input, and how ACP updates, the prompt response and stop routes map to kaoiro events and turn outcomes.
status: provisional
last_updated: 2026-11-23
related: [protocol, antigravity-adapter]
---

# Antigravity events

The `antigravity` engine hosts `agy acp` (Agent Client Protocol) with one
`agy` process per input. The decision and the measurements behind it are in
[ADR-0078](../../adr/0078-antigravity-over-acp.md). The permission gate,
hooks, kaoiro tools, retirement and known limitations are in
[Antigravity tools and permissions](antigravity-tools-permissions.md).
Unless another file is named, the code is
`wrapper/antigravity/src/host.ts`.

## Definition

### Main API and process model

```text
agy acp --add-dir <customization dir> [--sandbox] --dangerously-skip-permissions
```

- `--sandbox` is passed for `read-only` and `workspace-write` and omitted for
  `danger-full-access`. `--dangerously-skip-permissions` is always passed,
  so `agy` never asks; the PreToolUse hook is the only check
  ([permission](antigravity-tools-permissions.md#permission-hooks-are-the-approval-channel)).
- The child is spawned detached, in its own process group, in the agent's
  cwd. Its environment is the wrapper's with the agent marker, the
  [non-interactive tool variables](antigravity-tools-permissions.md#tool-children-prompts-disabled-absolute-tool-deadline-issue-350),
  and `KAOIRO_GATE_SOCKET`, `KAOIRO_GATE_NONCE` and `KAOIRO_GATE_DEADLINE_MS`
  for the hook; `CODEX_HOME` is removed. Its stderr is drained, not
  forwarded.
- **A generation serves one input.** A generation is one `agy acp` process
  with its ACP connection, gate socket and kaoiro tool host. Every input gets
  a new generation, which is retired once the input settles. The next
  generation is spawned only after the previous process exited, so no
  process, tool host or bearer is shared between inputs.
- **Start sequence**, for every input, in this order:
  1. wait until the previous process exited, then for permission
     synchronization; capture a staged permission switch
     ([evidence](#permission-switch-evidence));
  2. rewrite the customization directory; start the kaoiro tool host and the
     gate socket;
  3. check `agy`'s hook list and refuse the start on a mismatch
     ([hook list](antigravity-tools-permissions.md#hooks-and-the-hook-list));
  4. spawn; `initialize`; then `session/new` with the cwd, the kaoiro MCP
     server and the persona as `_meta.antigravity.systemPrompt.append`, or
     `session/resume` with the session ID, the cwd and the MCP server;
  5. apply the model and level ([models](#models-effort-usage-rate-limits));
  6. wait for an authenticated `tools/list` from `agy` until 15 s after the
     attach response (one already received counts), else the start fails,
     also while the model step is still pending;
  7. run the inter-agent `prepareInput` check, which may skip the input
     (no prompt, no result);
  8. hand one `session/prompt` with the input text, unchanged, to the ACP
     client; the prompt's window opens when its line's write begins.
- **One prompt at a time.** Inputs are drained in order; the next prompt is
  written only after the previous input settled. A `send()` with
  attachments is rejected (`attachments_unsupported`).
- **Start ownership.** An input owns its start until its first stop, the
  readiness bound above, or its settlement. Afterwards no further start step
  begins, no further `initialize`, `session/new`, `session/resume` or
  `session/set_config_option` is sent, and a step that completes late writes
  nothing: no permission capture, session ID, recovery record or model
  outcome; a listener it opened is closed. Steps 7 and 8 run in one block:
  ownership is checked before `prepareInput` and again after it returns,
  so a stop during the check settles the input by that stop's route (an
  interrupt gives `interrupted`), even when the check skipped the input.
- **The window** of a prompt runs from the start of its `session/prompt`
  line's write until the input settles. Before it (the start, and a prompt
  still queued behind an earlier write) and after it (retirement), activity
  is not projected onto a turn.

### ACP updates and their classes

`wrapper/antigravity/src/acp_events.ts` classifies each `session/update`:

| Class | Updates | Handling |
|---|---|---|
| activity | `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update` of the generation's session | In the window: projected (below) and counted as watchdog progress. Outside: an `out_of_turn_event` record with the kind and call ID only |
| control | `available_commands_update`, `usage_update`, `config_option_update`, `current_mode_update`, `session_info_update` | Never projected; in the window, counted as watchdog progress |
| other | any other variant, and any update whose `sessionId` is not the generation's session | An `out_of_turn_event` record `other:<variant>`; never projected |

- Tool updates of the generation's own session also feed call verification,
  in and outside the window
  ([verification](antigravity-tools-permissions.md#call-verification-and-gate-faults)).
- `session/request_permission` is answered `cancelled`
  (`wrapper/antigravity/src/generation.ts`). In the window it also stops the
  input (route `permission`) and the input fails with
  `antigravity_unexpected_permission_request`; outside the window it is only
  recorded. Any other request from `agy` has no handler, and the ACP SDK
  answers it with a JSON-RPC error. Every other incoming line, in and
  outside the window, leaves one `out_of_turn_event` record by its form
  only, and is never projected: `other:<method>` for a request or
  notification (`other:unnamed` without a usable method name; a request
  named `session/update` or a notification named `session/request_permission`
  is recorded too), `unknown:batch` for any JSON array, after which the
  client closes the connection, `unknown:oversized` for a line over 4 MiB,
  and `unknown:malformed` for anything else. A last line without a newline
  counts as a line.

### State derivation

| Observation (in the window) | kaoiro state and log |
|---|---|
| `send()` accepts input while the agent is at rest | `sending` |
| `agent_message_chunk` with text | `thinking`; the text accumulates into an `assistant` log entry, flushed before the next tool entry and at settlement |
| `agent_thought_chunk` | `thinking`; no text is logged |
| `tool_call` | `tool_running`; a `tool_use` log entry with the call ID, the vendor's `name` (else the ACP `title`) and `rawInput`; the call's per-tool deadline starts |
| `tool_call_update` `completed` or `failed` | `tool_result`, back to `thinking` once no call is pending; a `tool_result` log entry with the text content (else `rawOutput.output`); the per-tool deadline ends |
| A native hook ask or a kaoiro tool approval waits for the operator | `waiting_permission` with `ext.pending_permission` while at least one wait is open; `tool_running` after the last one ends |
| `ask_user_question` waits for the operator | `waiting_question` with `ext.pending_question` |
| A Stop hook request | answered by [the Stop answer](antigravity-tools-permissions.md#the-stop-hook-answer); no event |
| Outcome success | `done`, then `waiting_input`; a result log entry with the prompt's reply text |
| Outcome error | `error`, then `waiting_input`; a result log entry with `is_error`, `error_subtype: error_during_execution` and `error_detail` |
| A latched gate fault | every state publication shows `error` until the wrapper restarts |

When the attached session ID differs from the last one announced, the host
reports it to the server and the CLI prints one
`[kaoiro] transcript: agent=… engine=antigravity session=… path=…` line on
stdout.

### Delivery acknowledgement

- The ACK (`onTurnStart`) is emitted once per prompt, on the first of: the
  write callback of the `session/prompt` line succeeding; the prompt's
  response, including a JSON-RPC error response; or first-seen activity in
  the window (a message or thought chunk, or a tool update with a call ID
  not seen before). Control updates do not confirm. The ACK acknowledges the
  turn's inter-agent deliveries
  ([delivery](../inter-agent/delivery.md#dispatch-confirmation-ledger-issue-237)),
  writes the `turn_start` lifecycle record and starts the turn watchdog.
- With no confirmation within the pre-ACK bound (the watchdog's inactivity
  timeout), the input is stopped by route `pre_ack`. A write that failed or
  a connection that closed before any confirmation also fails the input.
  These inputs fail as `antigravity_delivery_unconfirmed`, with
  `receipt_unknown` when the prompt line was attempted; nothing is resent.
  A prompt still queued behind an earlier write at the pre-ACK bound was
  never attempted: it settles unread, without `receipt_unknown`, and a
  captured permission switch fails with `restart_failed`.
- A confirmation after the input settled has no effect. A write failure
  after the ACK does not withdraw it; the ACK does not promise a result.

### Turn outcome

The outcome is decided once, when the input settles, by the first row that
applies. A later interrupt, update, fault or process exit does not change
it.

| Row | Condition | Outcome |
|---|---|---|
| 1 | The host closed (close or watchdog fail-stop) | Stale: no result is published. After close the turn end carries no error; after a fail-stop nothing is published for the active input |
| 2 | The customization directory changed (checked at settlement once a process started) | Error `antigravity_customization_tampered`; it also latches a gate fault |
| 3 | An operator interrupt targeted the input | `interrupted` |
| 4 | The start failed | Error with the start-failure detail (below); `permission_sync_timeout` has its own result |
| 5 | Delivery was never confirmed | Error `antigravity_delivery_unconfirmed` |
| 6 | A gate fault found during the input | Error `antigravity_gate_unobserved_tool:<tool name>` |
| 7 | The per-tool deadline expired | Error `tool_timeout` |
| 8 | An unexpected `session/request_permission` | Error `antigravity_unexpected_permission_request` |
| 9 | The child process reported an error | Error `antigravity_cli_process_error: <detail>` |
| 10 | The connection closed, or the input was stopped, with no response | Error `agy_exit_without_result` |
| 11 | A JSON-RPC error answered the prompt | Error `antigravity_auth_required` for the captured `-32000` "Authentication required", else `antigravity_api_error: <message>` |
| 12 | The response's stop reason is `end_turn` | Success |
| 13 | Any other stop reason | Error `antigravity_stop_reason:<reason>` |

A waiting inter-agent sender gets `interrupted` for row 3, `receipt_unknown`
for row 5 when the line's write began (whatever its size), `timeout` for row
7, and `api_error` for row 11 and for a row 4 failure caused by a JSON-RPC
error, whatever the message says. A start failure keeps the errors it wraps
(a model switch keeps its own and its restore's, a refused resume its
response), and those decide: the captured "Authentication required" error
among them gives `antigravity_auth_required`, any other JSON-RPC error keeps
the detail and gives `api_error`. Every other detail goes through the shared
classifier: `api_error`, unless the text names a rate limit or a context
overflow ([peer error codes](../inter-agent/errors.md)).

| Start-failure detail | Cause |
|---|---|
| `antigravity_cli_unavailable:<reason>` | No usable `agy` executable |
| `antigravity_hooks_refused:<reason>` | The hook list check failed: `registration_mismatch`, `foreign_stop_hook:<file>`, `timeout`, `stopped`, `nonzero_exit`, `invalid_json` or `spawn_failure:<detail>` |
| `antigravity_cli_spawn_failure: <detail>` | The spawn threw |
| `antigravity_auth_required` | Attach or a model step was answered with the captured "Authentication required" error |
| `antigravity_api_error: <message>` | Another JSON-RPC error answered `initialize`, `session/new` or `session/resume`; a waiting peer gets `api_error`, also when the message mentions 429 |
| `antigravity_cli_process_error: <detail>` | The child process failed during the start, for example a spawn that found no executable (no process, so the queue goes on at once) |
| `antigravity_resume_failed` | `session/resume` was answered `-32603`; the recovery checkpoint refuses the launch while the input owns its start |
| `antigravity_resume_echoed_another_session` | The resume response echoed another session ID |
| `antigravity_model_not_applied:<slug>` | The committed model could not be applied; `api_error` when a JSON-RPC error refused it |
| `antigravity_model_restore_failed: <reason>` | A model switch failed and the previous pair could not be restored |
| `kaoiro MCP server did not connect` | No authenticated `tools/list` within 15 s of the attach response, whichever start step is then pending |
| `permission_sync_timeout` | Permission synchronization did not settle |

A start failure fails only its own input; the next queued input starts a new
generation.

### Stopping an input

An operator interrupt closes the permission and question brokers, so every
pending wait is cancelled. It then stops the active input only; queued input
is kept and runs on a new generation. With no active input it stops nothing
and writes no record.

| Route | Trigger | With the prompt open | Before the prompt is written |
|---|---|---|---|
| `interrupt` | Operator interrupt | `session/cancel`; SIGKILL to the process group if the prompt has not settled when the abort grace ends | SIGTERM, SIGKILL after the abort grace; no cancel; a handed prompt settles at once |
| `watchdog` | Inactivity timeout or per-tool deadline | `session/cancel`; the watchdog owns the grace and fail-stops when it ends | Not reachable: the watchdog starts at the ACK |
| `gate_fault` | A gate fault | As `interrupt` | As `interrupt` |
| `permission` | `session/request_permission` in the window | As `interrupt` | Not reachable |
| `close` | Host close, including the wrapper's SIGTERM | SIGTERM, SIGKILL after the close grace; the input settles at once | SIGTERM, SIGKILL after the close grace; a handed prompt settles at once |
| `pre_ack` | The pre-ACK bound | As `close` | As `close`, for a prompt queued behind an earlier write |
| `fail_stop` | The watchdog's abort grace ended | SIGKILL to the process group; the input settles at once | Same |

- Before its write begins, a prompt already handed to the ACP client never
  reaches `agy` once its input stops: the process's stdin is closed before
  the input settles, so a queued line cannot follow an earlier write that
  completes later. A prompt whose write began is not affected.
- Only the first route of an input sends `session/cancel` and arms a
  deadline. A later route sends no second cancel and never restarts or
  lengthens it; neither a late response nor progress clears it. `close` and
  `pre_ack` can still shorten the child's grace.
- After the input settles the generation is retired
  ([retirement](antigravity-tools-permissions.md#retirement-and-command-cleanup)).
  Unless a stop already started ending the child, it gets SIGTERM and, after
  the shorter of a pending cancel deadline's remaining time and the close
  grace, SIGKILL. The `generation_ended` record carries the serial, the end
  reason and the exit code or signal.
- The abort grace is the watchdog's abort grace (default 60 s); the close
  grace is 2 s, below the runner's 5 s reset-relaunch grace. Both watchdog
  settings and the tool deadline are in the
  [runner configuration](../configuration/runner.md).
- The `agy` process is signalled only through its process group, and a
  failed group signal has no PID fallback. The hook-list and `agy models`
  probes are not detached and are signalled by PID. Every signal target must
  be a live child with an integer PID of at least 2 that is not the wrapper
  (`wrapper/antigravity/src/subtree_termination.ts`).

Terminal host states:

- **Close** closes admission, rejects every queued input as `closed`, stops
  the active input, and removes the customization directory once the last
  process exited.
- **Watchdog fail-stop** closes admission and SIGKILLs the active process
  group. Each queued input with a turn token gets one turn end with
  `cancellation: watchdog_fail_stop`; queued input without one is rejected as
  `watchdog_fail_stopped`. The active input is left for operator recovery
  and the recovery checkpoint is blocked.
- **Gate fault** rejects queued and later input as `gate_broken`
  ([gate faults](antigravity-tools-permissions.md#call-verification-and-gate-faults)).

Lifecycle records go to stderr as `[kaoiro][antigravity-lifecycle]` JSON
lines (`wrapper/antigravity/src/cli.ts`): `turn_start`,
`interrupt_requested` (pending permission, pending question, child PID),
`interrupt_settled` (exit code and signal when the child already exited,
elapsed time), `send_not_started` (with its reason), `tool_timeout`,
`gate_fault`, `gate_fault_retirement_failed`, `generation_ended` and
`out_of_turn_event`. They never carry the input text or tool input.

### Permission switch evidence

The permission lifecycle and its statuses are defined in
[permission state](../protocol/permission-state.md#requested-submitted-and-effective-state).
This engine applies a switch by starting the next generation with it:

- At the start of an input, after permission synchronization, the latest
  staged selection (`set_permission`, or a `permission_sync` `next` that was
  never applied) becomes the launch configuration. `permission_control`
  becomes `applying` with `submitted` = revision, requested cell and
  `execution_id` = the turn token.
- **Evidence** is the prompt's response (any stop reason) or its first-seen
  activity. Control updates, a JSON-RPC error and the ACK are not evidence.
- With evidence and an engine-observed session ID (the `session/new`
  response, or the ID echoed by the `session/resume` response), the status
  becomes `applied` with `effective` and a `permission_applied` lifecycle
  event is sent. With evidence but no observed ID, the status becomes
  `unknown` with reason `no_observed_session`.
- Without evidence when the input settles: nothing reached `agy` (a failed
  start or a prompt never attempted) gives `failed` with reason
  `restart_failed` and no `rolled_back_to`; otherwise `unknown` with reason
  `rpc_error`, `connection_closed` or `delivery_unconfirmed`. Every report
  keeps `submitted`.
- A selection that did not reach `applied` stays staged and the next input
  captures it again; the failed input itself is not resent. A newer
  selection that arrives while one is `applying` stays `pending` until the
  next input captures it. Nothing blocks dispatch.
- A selection over the launch ceiling is refused at once with `failed`,
  reason `exceeds_launch_ceiling` and `rolled_back_to`, and a
  `permission_failed` lifecycle event.

### Session / conversation resume and enumeration

- The first input of a new agent creates the session with `session/new`.
  Every later input, and the first input of a wrapper launched with a
  resume session ID, attaches with `session/resume`; `session/load` is not
  used. A resume answered `-32603` fails the start and refuses the launch at
  the recovery checkpoint.
- With `agy` 1.5.14, `session/resume` echoes the session ID, keeps the
  persona sent at `session/new`, and resets the model to the account
  default; conversations created by `agy`'s print mode attach the same way
  ([measured](../../evidence/antigravity/agy-1.5.14-acp-measurements-2026-11-22-setup-and-sessions.md#p10-resume-persona-and-print-mode-conversations)). The host
  therefore applies the model at every start, and an echo naming another
  session fails the start.
- `agy` keeps its conversations in its own data directory under the user's
  home; the wrapper does not enumerate them. The transcript path printed at
  session start is built by `wrapper/antigravity/src/transcript_path.ts`.
  The conversation store also holds the bearer of a generation's tool host
  ([enforcement boundaries](../security/enforcement-boundaries.md#antigravity-engine--the-wrapper-is-the-only-enforcement-point)).

### Models, effort, usage, rate limits

- The model value is the kaoiro slug. At every start the host reads the
  pair `agy` reports right after attach (session config options `model` and
  `thought_level`) and applies the committed slug
  (`wrapper/antigravity/src/model_selection.ts`). The slug splits into the
  whole slug when it is a `model` option value; else `<base>-<level>` with
  the longest `<base>` that is one; else the whole slug as a `model` value
  for `agy` to judge. The host sets `model` and checks the reported value,
  then, when a level is needed and offered, sets `thought_level` and checks
  it. A committed slug that cannot be applied fails the start. The account
  default (`""`) sends nothing.
- `setModel` stages the value, shown as `ext.pending_model`, for the next
  start, where it is applied as one switch:

  | Result | Effect |
  |---|---|
  | Both steps verified | Committed; `model_source` becomes `config` |
  | `-32602` before the model changed | `ext.switch_error` with `reason: control_rejected`; nothing applied |
  | A later step failed | The previous pair is restored and verified; `ext.switch_error` with the reason and `rolled_back_to` (the committed slug) |
  | The restore failed | The start fails |

  A switch to `""` (the account default) sends nothing: the next start
  commits it and keeps the pair `agy` reported right after attach. A value
  staged while a switch is in flight stays pending for the next start; the
  switch in flight neither clears it nor reports a `switch_error` over it.
- `supports_effort_switch` is false and `setEffort` is refused: the level is
  part of the slug.
- The catalog comes from `agy models`, run once when the host is created
  (one `<slug>` or `<slug><TAB><display name>` per line; any other output
  keeps the fallback snapshot), merged with `antigravity.extra_models`. The
  fallback snapshot lists 15 slugs and the account default
  (`wrapper/antigravity/src/catalog.ts`). The wrapper accepts any value the
  server forwards; `agy` decides.
- The host publishes no `rate_limits` and runs no usage probe. A
  `usage_update` is a control update and is not projected. How `agy` reports
  a rate limit over ACP is not measured, so nothing is classified as one: a
  JSON-RPC error, during the start or as the prompt's answer, reaches the
  operator as `error_detail` and a peer as `api_error`, also when its message
  mentions 429.

### Authentication and host requirements

- Configure [supported Cloud authentication](../../operations/runner-install.md#antigravity-authentication).
  The runner checks the declaration before launch; the version probe is
  independent of that check. See the
  [1.5.14 measurements](../../evidence/antigravity/agy-1.5.14-authentication.md).
- A start or prompt answered with the captured `-32000` "Authentication
  required" error fails as `antigravity_auth_required`; only that exact form
  is classified so.

## Constraints

- No attachments: `send()` rejects them.
- No context usage is published.
- No effort switch; the level is part of the model slug.
- `approval: on-failure` is refused when the host is created.

## Wrapper-exit recovery

The runner's [launch-owned recovery checkpoint](../protocol/runner-control.md#wrapper-exit-session-recovery)
records native candidates before first-turn completion and distinguishes
confirmed live/explicit attach from candidate fallback. The host reports
each attached session to the checkpoint, closes when the checkpoint rejects
it, and confirms the session when an input succeeds. The engine boundary and
refusal exceptions in that contract apply independently of display history
replay.
