---
title: Antigravity event reference
status: implemented
last_updated: 2026-09-18
description: The current agy stream-json to AdapterEvent, state, session, watchdog, model, and quota-projection contract.
---

# Antigravity event reference

## Process contract

The observed command shape was:

```text
agy --print "<turn text>" \
    --output-format stream-json \
    --print-timeout <duration> \
    [--conversation <conversation_id>] \
    [--model <slug>] [--effort low|medium|high] \
    --add-dir <agent cwd> --add-dir <per-agent customization dir> \
    [--dangerously-skip-permissions] --disable-slash-commands \
    </dev/null
```

For each turn the host runs `agy` with `--print`, `--output-format
stream-json`, `--print-timeout 24h`, `--disable-slash-commands`, both
`--add-dir` paths, and (after the first turn) `--conversation <id>`. A selected
model or effort is passed as `--model` or `--effort`; the permission broker may
add `--dangerously-skip-permissions`. The host closes stdin after spawn.

The measured process model was one `agy` child per turn. The first turn
created a conversation and its id arrived in `init`; later turns passed it by
`--conversation`. Node `child_process.spawn` with piped stdio and `setsid`
without a controlling TTY both worked. Leaving stdin open ended after roughly
three seconds with `result.status = "ERROR"`, `error: "timeout waiting for
response"`, and no assistant output, although the conversation persisted.

The resident alternative was measured but not adopted because it has no
in-band interrupt, permission, or model-switch channel. Its dated input shape
and unsupported-event negative control are in
[the evidence record](../../evidence/antigravity/cli-contract.md#raw-shapes-and-negative-controls).

`--disable-slash-commands` is passed for every instruction turn because print
mode otherwise expands prompt slash commands and skills. The registration
probe `-p /hooks` runs without it. `--print-timeout` accepts Go durations;
`24h` was accepted. `--mode accept-edits|plan` was accepted but did not change
`init.permission_mode`; its runtime effect was not established. `--sandbox`
was also accepted but did not demonstrate enforcement.

Interrupt terminates the child with `SIGTERM`; the conversation remained
resumable by id after observed ERROR-terminated turns. The exact mid-stream
signal output remains unmeasured, so an exit without `result` is an error.
An ordinary interrupt aborts only the active turn and preserves queued turns:
the drain loop runs each later turn under the new lifecycle generation with its
own delivery token. This is distinct from close or fail-stop, which retire
unstarted delivery batches with `reason: "interrupted"`. Antigravity rejects
attachments at `send()`, so its host queue never holds a temporary attachment
turn to discard.

The adapter parses one JSON object per stdout line. Malformed JSON, a
non-object, or an unknown `event` is ignored; a terminal child exit without a
parsed `result` becomes `agy_exit_without_result` rather than a successful
turn. The observed vendor shapes and their measurement limits are retained in
[the CLI contract evidence](../../evidence/antigravity/cli-contract.md).

## stream-json mapping

The following are the measured 1.1.26 shapes, one object per line:

```jsonc
{"event":"init","conversation_id":"<uuid>",
 "init":{"cwd":"/abs/path","permission_mode":"request-review",
         "tools":["ask_permission","ask_question","call_mcp_tool","run_command", "..."],
         "model":"gemini-3.6-flash-low",   // present only when --model was given
         "agent":"kaoiro"}}                // present only when --agent was given

{"event":"step_update","step_update":{
  "conversation_id":"<uuid>","step_index":1,
  "state":"ACTIVE|DONE|ERROR",
  "step_type":"user_input|agent_response|tool|system_message",
  "text_delta":"PONG",                       // agent_response only (may be absent)
  "tool_name":"run_command",                 // tool only
  "tool_info":{"name":"run_command","parameters":{"CommandLine":"ls -1"},
               "output":"a.txt\r\n",         // DONE, some tools
               "error":{"type":"TOOL_ERROR","message":"…"}},   // ERROR
  "duration_seconds":4.8,
  "usage":{"input_tokens":5718,"output_tokens":34,"thinking_tokens":32,
           "cache_read_tokens":8130,"total_tokens":5752}}}     // DONE agent_response

{"event":"result","result":{
  "conversation_id":"<uuid>","status":"SUCCESS|ERROR|CANCELED",
  "response":"PONG\n","error":"…",           // error present on ERROR
  "duration_seconds":4.9,"num_turns":1,
  "usage":{…},
  "denied_actions":[{"action":"command","display_name":"RunCommand"}]}}  // optional
```

`permission_mode` was observed as `request-review` by default and
`always-proceed` when `settings.json` set `toolPermission` accordingly.
`init.tools` had 57 names in 1.1.26 and was not permission-filtered.
`agent_response` streamed `text_delta` while `ACTIVE` and closed with `DONE`
plus usage; a thinking-only step could be `DONE` with `thinking_tokens > 0`
and no text delta. Tool steps were `ACTIVE` then `DONE` or `ERROR`;
`tool_info.parameters` held raw arguments such as `CommandLine`,
`AbsolutePath`, `DirectoryPath`, and `Query`. `output` was observed on DONE
for `run_command`, `grep_search`, `find_by_name`, and the `view_file` summary,
but is not guaranteed for every tool. ERROR carried `tool_info.error.message`.
`system_message` appeared on resumed conversations. `CANCELED` with
`denied_actions` after a permission auto-denial is a normal terminal turn.
Non-ASCII text pass-through came from an unverified changelog claim. Measured
baseline input usage was about 5.7k tokens for the system prompt.

| CLI observation | AdapterEvent and state meaning |
| --- | --- |
| `init` | The first `conversation_id` becomes the session id. |
| `step_update` `agent_response` `ACTIVE` | Emit assistant text/thinking deltas; state remains `thinking`. |
| `step_update` `agent_response` `DONE` | Emit usage when supplied and retain the final assistant content. |
| `step_update` `tool` `ACTIVE` | Emit tool-use data and enter `tool_running`; notify the watchdog for this `step_index`. |
| `step_update` `tool` `DONE` | Emit tool result and return to `thinking`; end watchdog tracking for the step. |
| `step_update` `tool` `ERROR` | Emit tool error/result and return to `thinking`; end watchdog tracking for the step. |
| `result` `SUCCESS` or `CANCELED` | Emit one successful terminal result and `done`. |
| `result` `ERROR` | Emit the terminal error and `error`. |
| hook gate awaiting an operator | Enter `waiting_permission` with `ext.pending_permission`. |
| bridge `ask_user_question` pending | Enter `waiting_input` with `ext.pending_question`. |

`system_message` is log-only. The adapter does not infer a new event type from
an unrecognized step. `ext.tool_name` is populated from `tool_name` while a
tool is active; its input is `tool_info.parameters`. `waiting_permission` and
`waiting_input` are wrapper states rather than native `agy` state names.

## Watchdog contract

`TurnWatchdog` has one active turn token. It records the oldest active tool
by `step_index`; a repeated `ACTIVE` preserves its original start time. It
uses these settings:

| Setting | Default | Minimum | Environment variable |
| --- | --- | --- | --- |
| inactivity | 30 minutes | 60 seconds | `KAOIRO_ANTIGRAVITY_TURN_WATCHDOG_INACTIVITY_MS` |
| interrupt grace | 60 seconds | 1 millisecond | `KAOIRO_ANTIGRAVITY_TURN_WATCHDOG_ABORT_GRACE_MS` |
| tool wall-clock deadline | 10 minutes | 1 second | `KAOIRO_ANTIGRAVITY_TOOL_TIMEOUT_MS` |

All values are integer milliseconds and are bounded by the Node timer maximum.
An inter-agent delivery retains its own watchdog token; an operator instruction
gets a synthesized token, which inter-agent bookkeeping does not treat as a
delivery. Stream progress extends the inactivity bound only and never the
absolute tool deadline.
On inactivity or tool expiry the watchdog requests interruption; after grace
it fail-stops host admission. A tool deadline emits a lifecycle record with
the step index and tool name, then the terminal turn is projected as
`error_during_execution` with `error_detail: "tool_timeout"`. An
inter-agent delivery in that turn receives `peer_error.code: "timeout"`.
The warning is `[kaoiro] antigravity turn watchdog tool timeout: …` with
token, step, tool, elapsed time, and threshold; the lifecycle record is
`{"event":"tool_timeout",…}` with index/name/timing only, never raw tool
input. It SIGTERMs the child through the existing interrupt path, then reuses
the abort grace and fail-stop. The terminal state moves `error` to
`waiting_input`; this remains the existing wire path rather than a new type.

Every parsed tool `ACTIVE` must be correlated to a `step_index` and tool name.
If either cannot be proven, the wrapper does not leave an untracked tool
running: it sends SIGTERM through the same fail-closed path used for an
unprovable completion (ADR-0057 F4b). The deadline is a last safety net, not a
scheduler. A healthy background operation that remains `ACTIVE` beyond the
ten-minute deadline is still terminated with the whole turn; a visible error
is preferred to a silent `tool_running` that only an operator kill can end.

## Models and usage

The host starts with the Antigravity catalog snapshot and refreshes it through
`agy models`. Its parser accepts `slug<TAB>display name` and a bare slug. A
failed, timed-out, or malformed probe leaves the existing snapshot intact.
Operator-declared extra models are merged into both the initial and refreshed
catalog.

The adapter projects usage from `agent_response` and terminal `result` data
where present. It does not advertise `supports_context_usage`, because there
is no per-model context-window contract.

The dated catalog formats, model/effort CLI observations, and slash-command
response shape are in [the evidence record](../../evidence/antigravity/cli-contract.md#raw-shapes-and-negative-controls).
Context-window size itself is not exposed; the last
`agent_response.usage.input_tokens` is only an approximation.

## Conversation storage and host prerequisites

`--continue` is not used because it is ambiguous across agents on one host;
the wrapper serializes turns instead. The measured storage/authentication
paths and vendor limits are in
[the evidence record](../../evidence/antigravity/cli-contract.md#raw-shapes-and-negative-controls).
`agy` must be on PATH. The runner probes `agy models` at registration, and a
version change requires the vendor observations to be re-measured.

## Rate-limit projection

On a terminal error, the adapter recognizes a quota condition only when the
error contains a `RESOURCE_EXHAUSTED` or HTTP 429 marker and a complete compact
`Resets in` duration token (`NhNmNs`, with any subset in that order). Invalid,
spaced, fractional, reordered, or otherwise extended tokens fail closed to the
ordinary API error path.

For a recognized token, the host emits `peer_error` with `code: "rate_limit"`,
adds the reset delay to the current Unix time, and publishes:

```json
{"rate_limits":{"seven_day":{"status":"blocked","utilization":1,"resets_at":0}}}
```

The turn terminal is `blocking_limit`. `resets_at` is the calculated Unix
second, not the literal zero shown above. The real `stream-json`
`result.error` shape carrying both marker and duration has not been captured;
the accepted parser grammar is deliberately fail-soft and is documented with
its evidence limit in [the CLI contract evidence](../../evidence/antigravity/cli-contract.md).

## Related pages

- [Antigravity adapter architecture](../../architecture/antigravity-adapter.md)
- [Antigravity tools and permissions](antigravity-tools-permissions.md)
- [Protocol reference](../../specs/protocol.md)
