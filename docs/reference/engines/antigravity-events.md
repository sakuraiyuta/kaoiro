---
title: Antigravity event reference
status: implemented
last_updated: 2026-09-18
description: The current agy stream-json to AdapterEvent, state, session, watchdog, model, and quota-projection contract.
---

# Antigravity event reference

## Process contract

For each turn the host runs `agy` with `--print`, `--output-format
stream-json`, `--print-timeout 24h`, `--disable-slash-commands`, both
`--add-dir` paths, and (after the first turn) `--conversation <id>`. A selected
model or effort is passed as `--model` or `--effort`; the permission broker may
add `--dangerously-skip-permissions`. The host closes stdin after spawn.

The adapter parses one JSON object per stdout line. Malformed JSON, a
non-object, or an unknown `event` is ignored; a terminal child exit without a
parsed `result` becomes `agy_exit_without_result` rather than a successful
turn. The observed vendor shapes and their measurement limits are retained in
[the CLI contract evidence](../../evidence/antigravity/cli-contract.md).

## stream-json mapping

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

`system_message` is log-only. The adapter does not infer a new event type from
an unrecognized step. The host creates `waiting_permission` and
`waiting_input` from the wrapper hook and bridge protocols, respectively;
they are not native `agy` state names.

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
On inactivity or tool expiry the watchdog requests interruption; after grace
it fail-stops host admission. A tool deadline emits a lifecycle record with
the step index and tool name, then the terminal turn is projected as
`error_during_execution` with `error_detail: "tool_timeout"`. An
inter-agent delivery in that turn receives `peer_error.code: "timeout"`.

## Models and usage

The host starts with the Antigravity catalog snapshot and refreshes it through
`agy models`. Its parser accepts `slug<TAB>display name` and a bare slug. A
failed, timed-out, or malformed probe leaves the existing snapshot intact.
Operator-declared extra models are merged into both the initial and refreshed
catalog.

The adapter projects usage from `agent_response` and terminal `result` data
where present. It does not advertise `supports_context_usage`, because there
is no per-model context-window contract.

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
