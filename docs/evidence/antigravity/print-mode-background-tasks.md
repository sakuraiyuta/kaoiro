---
title: "agy --print and background-task promotion (issue #377)"
description: Measured on agy 1.2.7 — WaitMsBeforeAsync is clamped to 10 s by the CLI, an argv-prompt print run terminates promoted tasks 5 s after the model goes idle, --input-format stream-json waits for them instead and keeps context across turns in one process (no in-band interrupt), and run_command inherits the spawn PATH.
status: recorded
last_updated: 2026-09-21
related: [antigravity-adapter]
---

# agy `--print` and background-task promotion (issue #377)

Measured 2026-09-21 03:10–03:18 JST by kuroe on the dev host (WSL2, Linux
6.18), real `agy` 1.2.7 (`~/.local/bin/agy`, sha256
`9991515b6d5307bcf701069622b0537b6b206e605f3c891c0cf3a3d208dea8b0`), model
`gemini-3.8-flash-low`, run from a shell — **not** through the wrapper. The
argv shape mirrors `#turnArguments` in `wrapper/antigravity/src/host.ts`
(`--print <text> --output-format stream-json --print-timeout 24h
--disable-slash-commands --dangerously-skip-permissions --model … --add-dir
<scratch dir>`); the kaoiro gate hook was replaced by a logging PreToolUse
hook in `<scratch dir>/.agents/hooks.json` that appends its stdin payload to a
file and answers `{"decision":"allow"}`. One run per cell unless stated.
Scratch dir deleted after the page was written; the values below are
transcribed from the run output, the hook log and
`~/.gemini/antigravity-cli/brain/<conversation>/.system_generated/`.

## Summary

| # | Question | Answer (observed) |
|---|---|---|
| 1 | Does `--print` honour a large `WaitMsBeforeAsync` as a synchronous wait? | **No.** With the model emitting `WaitMsBeforeAsync: 300000` (hook log and transcript both show 300000) the CLI still promoted `sleep 20` to a background task after ~10 s. The tool schema text also tells the model the range is 500–10000, so an instructed model rounds to 10000 by itself. |
| 2 | Is there a flag / setting that disables promotion or lengthens the exit grace? | **None found.** `agy --help` (1.2.7) lists no such flag; a string inspection of the binary finds the fixed messages `root agent idle; waiting up to %s for %d background task(s)` / `terminating %d background task(s) on exit` and no `AGY_*` / settings key for them. Static search only — not a proof of absence. |
| 3 | Does `run_command` inherit the spawn environment's `PATH`? | **Yes**, with `~/.gemini/antigravity-cli/bin` prepended. A marker dir placed first on the spawner's `PATH` was second in the tool's `PATH` and its executable resolved. |
| 4 | Does `--input-format stream-json` change the exit behaviour? | **Yes.** With the prompt delivered as one NDJSON line on stdin (stdin closed immediately, one process per turn, same other flags), the turn's `result` event waited for the promoted task to finish, the model received the task output as a `system_message` step and continued, and no task was terminated. Same in a two-turn run on one process. |

## Observations

### Control — `WaitMsBeforeAsync: 5000`, argv prompt (probe A3)

Prompt: run `sleep 20; echo PROBE-A3-DONE` once with `WaitMsBeforeAsync`
5000, then reply `RESULT=<stdout or NONE>`.

- Hook log: `"WaitMsBeforeAsync":5000`.
- stream-json: step 2 `run_command` `ACTIVE`, never `DONE`; step 3
  `agent_response` `RESULT=NONE`; `result.status = SUCCESS`,
  `duration_seconds = 8.60`.
- stderr: `root agent idle; waiting up to 5s for 1 background task(s)` then
  `terminating 1 background task(s) on exit`. Wall clock 22.5 s, exit 0.

This reproduces the issue: the grace after the model's final text is **5 s**
(the issue body estimated ~10 s from the CLI log; the log at default
verbosity does not contain the grace line, stderr does).

### Instructed `WaitMsBeforeAsync: 300000`, argv prompt (probe B)

Same prompt with "set WaitMsBeforeAsync to 300000 and Blocking to true".

- Transcript step 1 (`PLANNER_RESPONSE`) args: `"WaitMsBeforeAsync": 10000`
  — the model rounded to the schema maximum on its own; no `Blocking` key was
  emitted.
- Behaviour identical to the control (`waiting up to 5s`, task terminated,
  `RESULT=NONE`, `duration_seconds = 12.95`).

The `run_command` parameter description embedded in the binary (two
variants, both present in 1.2.7): "Milliseconds to wait for the command to
finish before backgrounding it (500 to 10000)" and "Keep the value as small
as possible, with a maximum of 10000ms." A persona rule that asks for a
larger value is therefore working against the tool's own contract.

### Forced `WaitMsBeforeAsync: 300000`, argv prompt (probe B2)

Prompt told the model the schema text is outdated and to pass exactly
300000.

- Hook log and transcript step 1: `"WaitMsBeforeAsync":300000` (the value
  reached the CLI unmodified).
- Transcript timestamps: step 2 "Tool is running as a background task"
  created `18:13:58Z`; step 3 `RESULT=NONE` at `18:14:09Z` — 11 s after the
  tool started, i.e. the CLI waited its 10 s maximum, not 300 s.
- `.system_generated/tasks/task-2.log`: 0 bytes, mtime 03:14:09.1 JST; the
  process exited at ~03:14:15 after the 5 s grace, before `sleep 20` ended.
- stderr as in the control. `duration_seconds = 13.86`.

**Conclusion for question 1:** the clamp is in the CLI; instructing the model
cannot lift it.

### PATH inheritance (probe C)

Spawner `PATH` began with `<scratch>/bin:~/.local/bin:…`; `<scratch>/bin`
held an executable `kuroe377-marker` printing `KUROE377-MARKER-OK`. Prompt:
run `echo "PATH=$PATH"; command -v kuroe377-marker || echo NOT-FOUND;
kuroe377-marker` and echo the stdout verbatim.

- Model reply: `PATH=/home/yuta/.gemini/antigravity-cli/bin:<scratch>/bin:/home/yuta/.local/bin:/usr/local/sbin:…`,
  `<scratch>/bin/kuroe377-marker`, `KUROE377-MARKER-OK`.

So the wrapper's spawn `env.PATH` reaches the tool shell (agy only prepends
its own bin). Inferred, not measured here: the `which gh` failures in the
issue comment (agent `PATH` = `~/.gemini/antigravity-cli/bin:/usr/local/sbin:…`)
reflect the runner service's own `PATH` lacking `~/.asdf/shims`, not agy
rebuilding `PATH` from a login shell — seeding the spawn env is enough.

### `--input-format stream-json`, one turn, stdin closed at once (probe E)

`agy --print "" --input-format stream-json --output-format stream-json
--print-timeout 24h --disable-slash-commands --dangerously-skip-permissions
--model gemini-3.8-flash-low --add-dir <scratch>`; one line
`{"event":"user","message":{"role":"user","content":"…"}}` written to stdin,
then stdin closed. Prompt: run `sleep 20; echo PROBE-E-DONE` with
`WaitMsBeforeAsync` 5000; if promoted, reply `LAUNCHED` and end the turn.

- stream-json (seconds from spawn): step 2 `run_command` `ACTIVE` at 8.0 s,
  **`DONE` at 28.6 s**; step 3 `agent_response`; step 4 `system_message`;
  step 5 `agent_response`; `result` at 29.9 s with
  `response = "LAUNCHED\nRESULT=PROBE-E-DONE\n"`, `duration_seconds = 23.15`;
  exit 0 at 30.6 s.
- Transcript: step 3 `LAUNCHED` at `18:17:42Z` (5 s after the tool started
  at `18:17:37Z`), step 4 `SYSTEM_MESSAGE` and step 5 `RESULT=PROBE-E-DONE`
  at `18:17:58Z` — the CLI kept the turn open until the task finished and
  gave the model its output.
- `.system_generated/tasks/task-2.log`: 14 bytes, `PROBE-E-DONE`.
- stderr: empty — no `waiting up to` / `terminating` lines.

### `--input-format stream-json`, two turns on one process (probe D)

Same flags; turn 1 as in probe E, then 25 s after its `result` a second line
asking the model to read the task's status/log without running a new shell
command.

- Turn 1: tool `ACTIVE` 7.9 s → `DONE` 28.5 s; `result` at 29.8 s,
  `"LAUNCHED\nRESULT=PROBE-D-DONE\n"`.
- Turn 2 (sent at 55.6 s): the model used `view_file` on
  `.system_generated/tasks/task-2.log` and answered `RESULT=PROBE-D-DONE`
  at 58.6 s. stdin closed → exit 0 at 59.8 s. stderr empty.

### Negative controls and incidental findings

- Stream input message shape: `{"type":"user",…}` (no `event` key) →
  `result.status = ERROR`, stderr `error: stream input message is missing
  the "event" field`. The accepted shape is
  `{"event":"user","message":{"role":"user","content":"<text>"}}`.
- A PreToolUse hook that prints `{}` (no `decision`) is treated as a deny:
  step `ERROR`, `"tool call denied by pre-tool hook:"` (probe A2, discarded).
  Hook adapters must emit an explicit `decision`.
- Static: `agy --help` (1.2.7) exposes `--print-timeout` (whole-run limit)
  and `--input-format` (`text` | `stream-json`; "reads one NDJSON message per
  line from stdin and runs a turn for each; it requires
  `--output-format stream-json`"); nothing for background tasks.

## Persistent-process observations (stream input, one process, several turns)

Measured 03:20–03:32 JST, same binary / model / flags, for the ADR-0057 F2
alternative "one `agy` per session" (issue #377 decision). Each run one
process; times are seconds from spawn.

- **Event vocabulary.** Unknown `event` names (`interrupt`, `cancel`,
  `abort`, `stop`, `control`, `ping`, `keepalive`, `set_model`, …) are
  ignored with stderr `warning: ignoring unsupported stream input message
  event "<name>"`. `control_request` and `control_response` are recognised
  but rejected: stderr `error: stream input message event "control_request"
  is not supported yet`, a `result` with `status: "ERROR"`, and the process
  exits. There is therefore no in-band interrupt or control channel in 1.2.7.
- **Content blocks.** `message.content` accepts a string or an array of
  `{"type":"text","text":…}` blocks (reply `PONG-BLOCKS`).
- **Continuity.** One `init` per process; every turn ends with its own
  `result` carrying the same `conversation_id` and an incrementing
  `num_turns` (1 → 4). Turn 2 ("what did you reply before?") answered
  `PONG-BLOCKS` — context is kept in-process. A follow-up turn starts within
  ~0.1 s of the previous `result` (the first turn waits ~7.5 s for startup).
- **Line sent mid-turn.** A `user` line written while turn 3's
  `run_command` was `ACTIVE` was queued and ran as turn 4 immediately after
  turn 3's `result`; no interleaving. (Turn 3 showed a 24 s gap between the
  tool step's `DONE` at 34.1 s and the model's reply at 58.5 s; cause not
  isolated, one observation.)
- **SIGINT during a turn** (tool `ACTIVE`, ~4 s in): stderr
  `error: interrupted`, `result` `{"status":"ERROR","error":"interrupted",
  …}` at once, process exit code 1. The process does not survive an
  interrupt; a persistent design must respawn after one.
- **Resume after that exit.** A new process with `--conversation <same id>`
  under `--input-format stream-json` answered "what command were you asked
  to run?" with `sleep 9; echo S1-DONE`, `num_turns: 2`, exit 0 — resume
  works with stream input.

## Limits

- One run per cell (two for the stream-input mode: probes D and E). Not
  repeated across models; `gemini-3.8-flash-low` only.
- Run from a shell with a permissive logging hook, not through the wrapper's
  gate socket / `TurnWatchdog`; the wrapper's 10-minute tool deadline
  (`DEFAULT_TOOL_TIMEOUT_MS`) was not exercised against a long promoted task.
- Not measured: daemon tasks (`IsDaemon`), what the CLI does when a promoted task outlives
  `--print-timeout`, and whether the 5 s grace / 10 s clamp differ in other
  agy versions.
- "No flag / setting found" rests on `--help` and a `strings` search of the
  binary, not on documentation.
