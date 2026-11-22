---
title: Antigravity 1.5.14 over ACP — hooks, turn end and the Stop hook (2026-11-22/23)
status: measured
last_updated: 2026-11-23
---

# Antigravity 1.5.14 over ACP: hooks, turn end and the Stop hook

Part of the ACP measurement record for
[issue #1238](https://github.com/sakuraiyuta/kaoiro/issues/1238). The common
setup (binary, ADC authentication, isolation, redaction, cleanup), the prompt
totals and the case index are in
[setup and sessions](agy-1.5.14-acp-measurements-2026-11-22-setup-and-sessions.md).
Teardown, the sandbox and subagents are in
[sandbox, teardown and subagents](agy-1.5.14-acp-measurements-2026-11-22-sandbox-and-subagents.md).

Times are seconds from sending the prompt unless stated. Every ACP launch
here used `--dangerously-skip-permissions`. Prompts per case are given where
the notes give them; otherwise the batch total is quoted.

## P1: PreToolUse hook, IDs and order

Launch: `agy acp --add-dir <custom> [--sandbox] --dangerously-skip-permissions`;
`gemini-3.1-flash-lite-preview`. A recording PreToolUse hook wrote a start
and an end line per call and recorded whether it could connect to a unix
socket in HOME. Its modes: `allow`; `deny-first-command` (denies the first
`run_command` with a fixed reason); `hold:<seconds>` (waits, then allows).
The hook decisions were checked without `agy` before the runs. Sandbox flag:
`--sandbox` for `r8-d9-sb`; not recorded for the `r8-p1-*` runs. Prompts
per case: not recorded (18 for the P1-P10 batch).

| Case | Observed |
|---|---|
| `r8-p1-classes` | 5 calls (ACP kinds execute, edit, read, execute, other); hook names `run_command`, `write_file`, `read_file`, `run_command`, `mcp_kaoiro_whoami`. From `tool_call` to hook start 35-37 ms; to the hook decision 4-5 ms more. `echo P1RUN-$(date +%s%3N)` ran 8 ms after the hook decision. The MCP `tools/call` arrived at 10.931 s, between the call's first update (10.886) and its completion (10.933) and after the hook decision (10.925). Response 12.45 s; 0 updates after the response. |
| `r8-p1-deny` | The model put two commands into one call; it was denied (`failed`, 2.369 s). The reply quoted the reason (`DENYREASON-7f3a: …`) literally; then 2 calls were allowed and completed. Response 6.88 s, `end_turn`. |
| `r8-p1-nohook` (control) | No PreToolUse in `hooks.json`. 0 hook records. The call completed at 1.147 s. Response 1.989 s; a `session_info_update` 35 ms later. |
| `r8-p1-cancelhook` | The hook waited 30 s (start 2.44 s); `session/cancel` at 4.521 s. The call was `failed` at 4.530 s and the response `cancelled` at 4.534 s. The hook process was still alive 10 s later (no decision line was written). |
| `r8-p1-hooktimeout` | Hook timeout 3 s, hook waits 10 s. The call was `failed` 3.0 s later; the model saw `JSON hook "jsonhook__hooks_PreToolUse_0_0" failed: command failed: signal: killed`. The model retried once with the same result. Response 9.62 s, `end_turn`. |
| `r8-p1-parallel` | Two calls of the same command had different IDs and separate hook records. The second started when the first completed (2.343 s): `agy` ran them one after the other. |
| `r8-d9-sb` (PreToolUse part) | Under `--sandbox`, 16 hook calls (`run_command` 1, `manage_task` 13, `read_file` 2) all connected to the unix socket in HOME. All 16 hook IDs matched ACP `toolCallId` in both directions, and `conversationId` equalled `sessionId`. |

Verdicts:

| Question | Verdict |
|---|---|
| Hook for every sampled tool; `toolCall.id` = `toolCallId`, `conversationId` = `sessionId` (V2, V3) | Positive. Order: `tool_call`, hook, execution; the kaoiro MCP call falls inside its `tool_call` window |
| A deny returns the reason and the turn continues | Positive |
| No hook (control) | As expected: 0 hook records; calls completed unmatched |
| Cancel while the hook waits (V5) | Positive: `cancelled` 13 ms after the cancel; the waiting call `failed` |
| Hook timeout | Fails closed: the hook is killed, the tool does not run, the call `failed`, the turn continues |
| Identical calls | Positive: separate IDs and hooks; run sequentially |
| V1: nothing starts after the response | Positive: in the 6 `r8-p1-*` runs, 0 calls first seen after the response; the only update after a response was 1 `session_info_update` |

`session/request_permission` appeared in none of the 112 capture files of
the first three batches (all under `--dangerously-skip-permissions`).

Not measured: identical calls open at the same time (`agy` ran them in
order).

## P2: hook discovery

| Case | Launch | Prompts | Observed |
|---|---|---|---|
| `r8-p2-smoke` | `agy -p /hooks`, ADC | None (no model call) | With `--add-dir <ws> --add-dir <custom>` the PreToolUse hook was listed; with `--add-dir <ws>` only, `hooks: []`. Both exit 0. |
| `d9-smoke` | `agy -p /hooks`, ADC, a Stop hook added to the customization `.agents/hooks.json` | None (`num_turns` 0) | The Stop hook was listed (2.1 s). |
| `r8-d9-sb` | ACP with `--sandbox` | See D9 conditions | The hook reached the unix socket in HOME in 16 of 16 calls. |

Verdict: positive. Hooks are found only when the customization directory is
passed with `--add-dir`.

## P6 (i): invalid tool arguments

Case `p6-badargs`. Launch: no `--sandbox`; uid 1000 with no capabilities;
PreToolUse hook that allows and records; flash-lite at the lowest thinking
level. Prompts: 1.

Observed: one call passed a string for `WaitMsBeforeAsync` and one added an
unknown argument. For both, `agy` returned "Encountered error in tool
validation: invalid arguments …" to the model before any hook. ACP showed 0
`tool_call` updates for them and the hook ran 0 times.

Verdict: positive. There is no call to correlate, so no gate fault arises.

## C1: output of a long command

Question: does the output of a command promoted to the background reach the
model before the prompt response? Launch: no `--sandbox`; the allow-all
PreToolUse hook; no Stop hook; `gemini-3.1-flash-lite-preview`. Prompts:
2 for the two `c1` runs, 2 for `c1b`.

| Run | Setting | Observed | Verdict |
|---|---|---|---|
| `c1`, long | `sleep 21; echo <marker>`, `WaitMsBeforeAsync` 5000 | Command start 6.07 s; response `end_turn` 11.95 s while the process was alive. The reply was `*(Waiting for the background task to complete...)*`, without the marker. | Negative |
| `c1`, short (control) | `sleep 1; echo <marker>`, 5000 | The command ended after 1 s; the reply had the marker. | Positive (as expected) |
| `c1b` | As the long run; after the response a 30 s gap, then the next prompt | Response `end_turn` 10.94 s (reply: started as a background task, will report the output when done). Around the command's end (the process was gone at the 26.04 s sample; sampling every 100 ms), outside the prompt: `tool_call_update` `completed` (26.03 s), 2 `agent_message_chunk` updates with the marker (27.11 s) and a `usage_update`. In the next prompt the model answered the marker. | Negative (the marker came after the response) |

Observed: over ACP, `agy` ends the turn without waiting for a promoted task,
and re-invokes the model by itself, outside any prompt, when the task ends.
The stream-json behaviour recorded in
[issue #377](https://github.com/sakuraiyuta/kaoiro/issues/377) (the turn
stays open until background tasks finish) was not re-measured.

## D9: Stop hook feasibility

### Hook contract embedded in the binary

The `agy` 1.5.14 binary embeds the hook documentation
(`Lifecycle Hooks (hooks.json)`):

- Six events: `SessionStart`, `PreToolUse`, `PostToolUse`, `PreInvocation`,
  `PostInvocation`, `Stop`. `Stop` runs when the execution loop ends and has
  no matcher (handlers are listed directly).
- `Stop` input on stdin: `executionNum`, `terminationReason` (for example
  `NO_TOOL_CALL`), `error`, `fullyIdle` ("true if all background tasks are
  done"), `continuationActive`.
- `Stop` output on stdout: `{"decision":"continue","reason":"…"}` cancels
  the stop and returns to the loop, injecting `reason` as a system message;
  any other value stops.
- Hooks run synchronously through `sh -c` and block the loop; the default
  timeout is 30 s.
- The top-level keys of `hooks.json` are hook names. kaoiro's top-level
  `hooks` key is read as such a name (`/hooks` lists `name: "hooks"`).
- Binary type names carry the same fields (`StopHookArgs` with `FullyIdle`
  and `ContinuationActive`, `StopHookResult` with `Decision`) and
  `hookcaller.CallStopHook`.

### Feasibility runs

Launch as in C1: smoke test, `agy acp --add-dir <custom>`, no `--sandbox`,
`session/new`, model applied, readiness; the allow-all PreToolUse hook;
`gemini-3.1-flash-lite-preview`. Prompt: run `sleep <N>; echo
<marker>-$((40+2))` once with `WaitMsBeforeAsync` 5000, wait for it and
reply with the output line only. The output line differs from the command
text, so a match is the command's output. Stop hook modes: `record` (always
`{}`); `continue` (while `fullyIdle` is not true and below the cap, return
continue with the reason "A background command you started is still
running. Do not end your turn yet: wait for it to finish, then reply with
its result."; otherwise `{}`). After the response the probe waited for the
command to end and 15 s more. The hook decisions were checked without `agy`
first. Prompts: 6 for the six ACP runs (not recorded per case).

`usage` below is the number of `usage_update` notifications inside the
prompt window, a proxy for model calls, not billed tokens (`used` per
update 9k-15k).

| Run | Stop hook | Command | Start | Response | Command end | Output in reply | Output outside the prompt | `usage` | Stop calls (time, `fullyIdle`, decision) |
|---|---|---|---|---|---|---|---|---|---|
| `d9-nc` (negative control) | None | 21 s | 2.21 | 8.22 | 23.27 | No | 24.13 | 3 | None |
| `d9-record` | Record only | 21 s | 2.02 | 12.27 | 23.01 | No | 24.13 | 6 | 12.26 false stop; 24.44 true stop (outside the prompt) |
| `d9-cont-a` | Continue, cap 4 | 21 s | 2.63 | 24.23 | 23.70 | Yes | None | 25 | 8.58 false continue; 16.77 false continue; 24.22 true stop |
| `d9-cont-b` | Continue, cap 4 | 21 s | 3.02 | 25.66 | 23.98 | Yes | None | 14 | 8.88, 13.41, 20.33 false continue; 25.65 true stop |
| `d9-cont-max1` | Continue, cap 1 | 21 s | 2.71 | 13.12 | 23.77 | No | 24.18, 33.59 | 7 | 8.42 false continue; 13.12 false stop (cap); 24.26 false stop (outside); 33.73 true stop (outside) |
| `d9-cont-45` | Continue, cap 6 | 45 s | 3.33 | 51.51 | 48.31 | Yes | None | 19 | 9.19, 11.92, 18.88, 34.04 false continue; 51.50 true stop |

Tools the model called while waiting, inside the prompt window, besides the
one `run_command`:

| Run | `manage_task` status | `manage_task` list | Task log read | `schedule` | Other |
|---|---|---|---|---|---|
| `d9-record` | 2 | 0 | 1 | 0 | — |
| `d9-cont-a` | 17 | 1 | 2 | 0 | — |
| `d9-cont-b` | 4 | 0 | 3 | 0 | 1 log read with `cat` |
| `d9-cont-max1` | 1 | 0 | 1 | 1 (20 s) | — |
| `d9-cont-45` | 7 | 1 | 3 | 1 (30 s) | — |

Observed:

1. With the continue hook (3 runs) the response came 0.5-3.2 s after the
   command ended and the reply had the output line. The `run_command`
   `completed` update arrived inside the window. After the response there
   was 0 activity outside the prompt.
2. Exhausting the cap returns to the C1 behaviour (`d9-cont-max1`): after
   the first continue the model set a 20 s timer with `schedule` and ended
   the turn at 13.12 s (the hook stopped at the cap). The output arrived
   outside the prompt at 24.18 s, and after the timer fired at 32.52 s the
   model was invoked again outside the prompt (33.59 s).
3. In `d9-cont-max1` the hook call at 24.26 s (outside the prompt, after
   the command ended) had `fullyIdle` false.
4. Waiting depends on the model and polls a lot. `manage_task` has only
   `list`, `kill`, `status` and `send_input` (binary schema); no action
   blocks until a task ends. After a continue the model read the status and
   the task log repeatedly (status 4-17 times over a 21 s wait).
   `usage_update` counted 14-25, against 3-6 in the controls. The 45 s run
   counted 19; in that one run the count did not grow with the wait (the
   model used `schedule` for part of it).
5. `continuationActive` was false in all 18 Stop calls. `executionNum`
   counted up from 0 within a prompt and was 0 again in calls outside it.
6. The Stop hook also runs when `agy` re-invokes the model by itself
   (`d9-record` 24.44 s; `d9-cont-max1` 24.26 s and 33.73 s).
7. In all 6 runs the background `run_command` stayed `in_progress` until
   the command ended; `completed` arrived at 22.98-23.95 s (48.24 s in the
   45 s run). Where the response came first (`d9-nc`, `d9-record`,
   `d9-cont-max1`), that is after the response.
8. In `d9-cont-45`, after the continue at 34.04 s no update arrived until
   44.0 s (about 10 s). The cause is not visible on the wire
   (undetermined).
9. The Stop input had 13 keys: `artifactDirectoryPath`,
   `continuationActive`, `conversationId`, `cwd`, `error`, `executionNum`,
   `fullyIdle`, `hookEventName`, `lastUserInput`, `modelName`,
   `terminationReason`, `transcriptPath`, `workspacePaths`. The binary's
   `continuationCount` and `finalModelOutput` were not sent.
   `terminationReason` was always `NO_TOOL_CALL`.

Deadlines observed: the last hook record preceded the response by
0.006-0.010 s, so the hook's 30 s timeout does not bound the wait.
`WaitMsBeforeAsync` only decides when the command is promoted. While the
hook held the turn, ACP updates kept arriving; the largest gap between
updates inside the window was 5.67-6.13 s, and 10.03 s in the 45 s run.

Inferred, not measured:

- In item 3 the only pending task was the 20 s timer (set at 12.48 s,
  firing at 32.48 s by the timer record; item 2 gives 32.52 s), because the
  process samples showed the command gone at 23.77 s. A hook that continues
  while `fullyIdle` is false therefore also keeps the turn open for a timer
  the model scheduled.
- kaoiro's stream-json turn watchdog at develop b776a6b1
  (`wrapper/antigravity/src/turn_watchdog.ts` lines 7-11 and 24-26) has a
  30 min inactivity deadline and a 10 min per-tool wall-clock deadline that
  stream progress does not extend. If the ACP host keeps the same per-tool
  deadline, a background command longer than 10 minutes reaches it with or
  without D9. Only commands up to 45 s were measured.

Not measured in this batch: commands longer than 45 s, `--sandbox`,
cancel, a continue answered outside the prompt (the cap-1 run had used its
cap), `agy`'s own continuation limit (`MAX_FORCED_INVOCATIONS` exists as a
termination reason; 4 continues did not reach it), and the cause of the gap
in item 8. The next batch measured several of these.

### D9 conditions

Launch: the P1-P10 batch environment. The Stop hook gained the modes
`always`, `window` / `windowbad` (looks at a mark the probe sets only while
a prompt is open), `fail` and `sleep:<seconds>`; the reason text is `plain`
or `wait` (urges the model to wait with `command_status`). Prompts per
case: not recorded (18 for the batch).

| Case | Setting | Observed |
|---|---|---|
| `r8-d9-sb` | 21 s, `--sandbox`, continue cap 4 | Response 25.50 s, command end 23.97 s, output in the reply. The Stop hook continued at 8.88 and 16.22 and saw `fullyIdle` true at 25.49. |
| `r8-d9-agycap` | Short prompt with no tool, always continue (cap 40) | 11 Stop calls (`executionNum` 0-10), all continue. Just after the 11th (33.531 s) the response came, `end_turn` (33.538 s): `agy` honoured 10 continuations. The model believed the reason ("a background command is running") and repeated `manage_task list`, `manage_subagents list` and `ps aux`. |
| `r8-d9-wait45` | 45 s, reason `wait`, cap 6 | `command_status` 0 times. `manage_task status` 13 times and `list` once; the task log read 4 times. At 39.08 s the model stopped the task with `manage_task kill` (the command was gone at 39.18 s). Response 40.27 s, `end_turn`; the reply said the command hung and was stopped, with no output. |
| `r8-d9-cancel-nosb` | 40 s, continue (not distinguishing cancel), `session/cancel` 12 s after the command started | Cancel 14.120 s; response `cancelled` 14.128 s; command gone 14.201 s. The last Stop call was before the cancel (13.179 s). |
| `r8-d9-cancel-sb` | Same, `--sandbox` | Cancel 16.335 s; response `cancelled` 16.345 s; command gone 16.426 s. No Stop call after the cancel. |
| `r8-d9-outside-bad` (negative control) | 21 s; cap 1 inside the prompt, 1 continue outside | Inside: continue at 8.89, stop at the cap at 15.45, response 15.45 s with the command alive. The command ended at 23.74 s; its output arrived outside the prompt (24.31 s); the outside Stop call (24.35 s) continued, so the model thought outside the prompt, called a tool (25.75 s) and replied again. The outside Stop call at 26.64 s stopped. |
| `r8-d9-stopfail` | Short prompt; the Stop hook exits 1 with no output | Response `end_turn` right after the hook. |
| `r8-d9-stoptimeout` | Short prompt; the Stop hook waits 10 s, timeout 3 s | Hook start 2.87 s; response `end_turn` 5.84 s (2.97 s later). No end line from the hook (it was killed). |

Verdicts: D9 with `--sandbox` positive; `agy`'s own limit is 10
continuations (1 run; the hook input never showed
`MAX_FORCED_INVOCATIONS`, every call carried `NO_TOOL_CALL`); changing the
wait through the reason text negative; cancel positive with and without
`--sandbox` (no Stop call after the cancel, so a continue cannot override
it); continuing outside the prompt adds tool calls and replies that belong
to no prompt, as the control expected; a failing or timed-out Stop hook
ends the loop (the timeout delays the response). In the earlier
`d9-cont-max1`, where the hook answered stop outside the prompt, each
outside call ended after `agy`'s own single re-invocation;
`r8-d9-outside-bad` is its negative control.

### Cost of holding the prompt

Copied from the `usage` of each prompt response.

| Run | Input (uncached) | From cache | Output | Thinking | Total |
|---|---|---|---|---|---|
| `d9-nc` (no hook, 21 s) | 9,875 | 7,218 | 719 | 641 | 17,812 |
| `d9-record` | 38,173 | 7,224 | 1,055 | 776 | 46,452 |
| `d9-cont-a` | 38,591 | 230,995 | 2,422 | 1,152 | 272,008 |
| `d9-cont-b` | 24,424 | 99,306 | 2,431 | 1,696 | 126,161 |
| `d9-cont-45` (45 s) | 35,032 | 150,614 | 3,919 | 3,067 | 189,565 |
| `r8-d9-sb` | 33,113 | 176,729 | 1,645 | 997 | 211,487 |
| `r8-d9-wait45` | 38,448 | 241,357 | 6,552 | 5,431 | 286,357 |
| `r8-d9-agycap` (10 continuations) | 43,012 | 215,310 | 4,997 | 4,177 | 263,319 |
| Short prompts (`stopfail`, `persona`) | 8,122-8,384 | 0 | 113-161 | 112-150 | 8,235-8,545 |

The five runs that waited for a command used 126k-286k tokens per prompt
(24k-39k uncached input); the control without the hook used 17.8k (9.9k).

## M4: effective Stop hook set

Question: does the structured `/hooks` list of the smoke test show every
Stop hook that ACP will run?

Setup: the managed `hooks.json` in the customization directory held the
allow-all PreToolUse hook and a record-only Stop hook. A foreign Stop hook
(`always`, continuing up to 2 times, or `record`, each with its own record
file) was placed in one or more of: the workspace (`<cwd>/.agents/hooks.json`);
the global `~/.gemini/config/hooks.json` (a path found in the binary's
strings); a global plugin `~/.gemini/config/plugins/probeplug/hooks.json`
with or without a `plugin.json` manifest; `enabled: false`. The list was
taken with the production smoke-test arguments
(`agy -p /hooks --add-dir <cwd> --add-dir <custom> --output-format json`)
and with `--add-dir <custom>` only; both lists were identical in every run.
ACP was started with `--add-dir <custom>` and the workspace as cwd. Each ACP
run sent one short prompt (`Reply with exactly the word OK`). The M4 notes
do not name the model.

List-only cases (no prompt; paths are inside the disposable HOME):

| Case | List (name, enabled, source) |
|---|---|
| `m4-list-none` | `hooks` true `~/custom/.agents/hooks.json` (PreToolUse, Stop) |
| `m4-list-workspace` | `foreign` true `~/ws/.agents/hooks.json` (Stop); `hooks` (managed) |
| `m4-list-global` | `foreign` true `~/.gemini/config/hooks.json` (Stop); `hooks` (managed) |
| `m4-list-plugin` (no manifest) | `hooks` (managed) only |
| `m4-list-plugin2` (manifest) | `foreign` true `~/.gemini/config/plugins/probeplug/hooks.json` (Stop); `hooks` (managed) |
| `m4-list-disabled` | `foreign` **false** `~/ws/.agents/hooks.json` (Stop); `hooks` (managed) |

ACP runs without `--sandbox` (1 prompt each, 3 in total):

| Case | Placed | Listed | Stop hooks called | Response |
|---|---|---|---|---|
| `m4-acp-none` (control) | Nothing | Managed only | Managed once (1.46) | 1.47 s `end_turn`, reply `OK` |
| `m4-acp-mixed` | Workspace enabled (`always`); global disabled (`always`); plugin without manifest (`always`) | Workspace enabled; global disabled; plugin absent | Managed 3 times (1.21, 5.03, 6.46, all stop); workspace 3 times (continue at 1.25 and 5.07, stop at its cap at 6.50); global and plugin 0 times | 6.50 s `end_turn`, reply `OK` three times |
| `m4-acp-globalplugin` | Global enabled (`record`); plugin with manifest (`record`) | Both enabled | Managed once (1.62), global once (1.66), plugin once (1.70) | 1.70 s `end_turn` |

ACP run with `--sandbox` (`m4s-acp-sandbox`, in the P3 batch; uid 0; prompt
count not recorded per case, 7 for that batch). Placed: in the workspace an
enabled Stop (`always`, up to 2 continues) and a disabled second Stop;
global enabled (`record`); a plugin with a manifest (`record`) and one
without (`always`). The list was taken three ways (production arguments,
`--add-dir <custom>` only, production arguments plus `--sandbox`) and was
identical: enabled `foreign-global`, `foreign-plugin`, `foreign-workspace`
and `hooks` (managed); disabled `foreign-workspace-off`; the plugin without
a manifest absent.

| Stop hook | Called at | Decision |
|---|---|---|
| Global | 2.58, 8.08, 11.49 | Stop (record only) |
| Plugin with manifest | 2.61, 8.12, 11.53 | Stop (record only) |
| Managed | 2.65, 8.15, 11.56 | Stop (record only) |
| Workspace | 2.68, 8.19, 11.60 | Continue, continue, stop at its cap |
| Disabled workspace Stop; plugin without manifest | 0 times | — |

Response 11.61 s, `end_turn`; the reply was `OK` twice and one sentence
saying there was no background task.

Plugin sources and the list-to-spawn gap (2026-11-23; no `--sandbox`;
uid 1000):

| Case | Prompts | Observed |
|---|---|---|
| `m4x-sources-list` | 0 | List only, before `m4x-sources`. |
| `m4x-sources` | 1 | Plugins from the global `plugins.json`, from the workspace `.agents/plugins.json`, and with an `.antigravity-plugin/` or `.gemini-plugin/` manifest were all listed as enabled and were called over ACP. A plugin with `"disabled": true` was neither listed nor called. |
| `m4x-race` | 1 | After the list was taken with the smoke-test arguments, a Stop hook was placed in the workspace before spawn. It was not in the list but was called over ACP. |

Observed:

- In every ACP run (3 without `--sandbox`, 1 with it, plus `m4x-sources`)
  the Stop hooks called were exactly the enabled ones in the list.
  `enabled: false`, a plugin without a manifest and a `"disabled": true`
  plugin were never called.
- Another Stop hook's continue took effect while the managed Stop answered
  stop every time (2 of 2 continues in `m4-acp-mixed` and in
  `m4s-acp-sandbox`).
- Call order: without `--sandbox` the managed Stop came first and the
  others 35-42 ms later; in `m4s-acp-sandbox` the order was global, plugin,
  managed, workspace, 34-38 ms apart.

Inferred: every Stop hook is called before `agy` decides whether to
continue. Which decision wins between several Stop hooks was not measured
beyond one stop/continue pair, where continue won.

Verdict: positive within the roots tested; the managed Stop's cap and stop
cannot hold while another enabled Stop exists. A gap between the list and
spawn exists (`m4x-race`).

Not measured: `agy plugin install`; composition of foreign PreToolUse hooks;
the priority rule among several Stop hooks. Each case ran once.
