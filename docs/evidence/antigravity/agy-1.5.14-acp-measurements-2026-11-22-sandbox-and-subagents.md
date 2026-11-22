---
title: Antigravity 1.5.14 over ACP — teardown, sandbox scope and subagents (2026-11-22/23)
status: measured
last_updated: 2026-11-23
---

# Antigravity 1.5.14 over ACP: teardown, sandbox scope and subagents

Part of the ACP measurement record for
[issue #1238](https://github.com/sakuraiyuta/kaoiro/issues/1238). The common
setup (binary, ADC authentication, isolation, redaction, cleanup), the prompt
totals and the case index are in
[setup and sessions](agy-1.5.14-acp-measurements-2026-11-22-setup-and-sessions.md).
Hooks, turn end and the Stop hook are in
[hooks and turns](agy-1.5.14-acp-measurements-2026-11-22-hooks-and-turns.md).

Times are seconds from sending the prompt unless stated. Processes were
observed inside the probe's PID namespace.

## C3: commands left after retirement

Launch: `agy acp --add-dir <custom> [--sandbox] --dangerously-skip-permissions`;
the allow-all PreToolUse hook; no Stop hook;
`gemini-3.1-flash-lite-preview`. Cases are named
`c3-<route>-<command>-<sandbox>` (for example `c3-term-promoted-sandbox`).
The model started `sleep 137` with `run_command`. The route was applied
either to a foreground command (`WaitMsBeforeAsync` 60000, 6 s after the
start) or to a promoted one (5000, 9 s after the start; the turn had already
ended `end_turn`). One run per cell. "Left" means both the `bash -c` and the
`sleep` processes were alive right after `agy` exited and 5 s later.
Prompts: 10 for the ten runs.

| Route | Command | Without `--sandbox` | With `--sandbox` |
|---|---|---|---|
| SIGTERM, then grace (close grace 2 s) | Foreground | Gone (`agy` exited in 0.58 s) | Gone (0.54 s) |
| SIGTERM, then grace | Promoted | **Left** (`agy` exited in 0.52 s) | Gone (0.60 s) |
| Immediate SIGKILL to `agy`'s group | Foreground | **Left** | Gone |
| Immediate SIGKILL | Promoted | **Left** | Gone |
| `session/cancel` only | Foreground | Gone in about 0.1 s; response `cancelled` | Not measured (undetermined) |
| `session/cancel` only | Promoted (turn already `end_turn`) | Gone in about 0.1 s | Not measured in C3; see below |

Observed:

- Without `--sandbox` the command (`bash -c`) was a child of `agy` in its
  own session and process group. With `--sandbox` its parent was not `agy`
  but a helper process, and the command was gone once `agy` ended. In the
  subagent batch the parent was a child `agy` process in its own process
  group and in `agy acp`'s session; the notes infer it is the sandbox
  helper from the same shape in this C3 run (see Subagents).
- `session/cancel` stopped the promoted task even after the prompt had
  ended.
- Later, `r8-d9-cancel-sb` (`--sandbox`, the Stop hook holding the prompt;
  see [hooks and turns](agy-1.5.14-acp-measurements-2026-11-22-hooks-and-turns.md#d9-conditions))
  measured cancel with a promoted command: cancel at 16.335 s, response
  `cancelled` at 16.345 s, command gone at 16.426 s. The subagent run
  `r12-s3-cancel-sb` saw the same (below).

Verdict: negative without `--sandbox` (three routes leave the command:
SIGTERM with a promoted command, SIGKILL with either); positive with
`--sandbox`.

Inferred: in production a command left this way stays on the host as an
orphan; in the measurement the namespace exit cleaned it up.

Not measured: a foreground command under `session/cancel` with `--sandbox`;
the state at the child's exit after a cancel; variance (one run per cell).

## P3: sandbox scope and approved bypass

### Method

Hooks: a PreToolUse hook that allows and records the arguments; in the deny
case, `deny-bypass` (denies a `run_command` with `BypassSandbox: true`),
checked beforehand with fake payloads (true denied; false, absent and the
allow mode allowed). `session/request_permission` was answered `cancelled`.
No Stop hook (except in the M4 follow-up, recorded in
[hooks and turns](agy-1.5.14-acp-measurements-2026-11-22-hooks-and-turns.md#m4-effective-stop-hook-set)).
Model flash-lite, lowest thinking level. Prompts: 7 for the batch, including
the M4 follow-up (not recorded per case).

A marker script, placed in the workspace and run by the model as
`bash ./p3probe.sh <tag>` through `run_command`, printed one line
`P3M <tag> <check> <result>` per check:

| Kind | Checks |
|---|---|
| Write (5 places) | cwd; customization directory; a randomly named file in the system temporary directory; `~/.cache`; `~/other` (in the home, outside the workspace and the customization directory) |
| Read (2 places) | A planted fake `~/.ssh/p3-id` and `~/other/readme.txt`, both non-secret markers |
| Network (3 kinds) | A loopback listener opened by the probe; raw TCP to `www.google.com:443`; `curl https://www.google.com/generate_204`, using proxy variables when present |
| Other | Names (only) of proxy variables; `Seccomp` and `NoNewPrivs` from `/proc/self/status`; uid |

After each run the probe checked from outside the sandbox that the written
files existed and whether the listener got a connection; the temporary file
was deleted by its exact name. Tool controls without `agy`: positive
(`p3-dry`, the script run directly outside a sandbox: every check ok,
matching the outside check, no temporary residue); negative (unwritable
paths: the script reported the write, read and loopback failures).

The sandbox and no-sandbox runs used one prompt with six steps: (1) run the
marker script synchronously; (2) after `sleep 3`, run it again in the
background with `WaitMsBeforeAsync` 500; (3) `write_file` inside the
workspace; (4) `write_file` outside it; (5) `read_file` outside it; (6) call
the kaoiro whoami stub. The no-sandbox run also asked for the list of tool
names.

### Results

"skip" is `--dangerously-skip-permissions`. Write and read columns are in
the order of the method table.

| Case | Launch | uid | Write cwd / custom / temp / cache / home | Read ssh / home | Loopback / TCP / HTTPS | Seccomp | Permission requests |
|---|---|---|---|---|---|---|---|
| `p3-sandbox` | `--sandbox` + skip | 0 | ok / ok / ok / ok / ok | fail (ENOENT) / ok | fail / fail / 204 (proxy) | 2 | 0 |
| `p3-sandbox-user` | `--sandbox` + skip | 1000 | ok / ok / ok / ok / ok | fail (ENOENT) / ok | fail / fail / 204 (proxy) | 2 | 0 |
| `p3-nosandbox-user` (negative control) | skip only | 1000 | ok / ok / ok / ok / ok | ok / ok | ok / ok / 204 (direct) | 0 | 0 |
| `p3-bypass-user` | `--sandbox` + skip, `BypassSandbox: true` | 1000 | ok / ok / ok / ok / ok | ok / ok | ok / ok / 204 (direct) | 0 | 0 |
| `p3-denybypass-user` | `--sandbox` + skip, hook denies the bypass | 1000 | Did not run (0 files seen from outside) | — | — | — | 0 |
| `p3-sandbox-auto-noskip-user` (diagnostic) | `--sandbox`, no skip, mode `auto` | 1000 | ok / ok / ok / ok / **fail (ENOENT)** | fail / **fail** | fail / fail / **name resolution failed** | 2 | 1 (`mcp_kaoiro_whoami`) |

For the sandboxed runs with skip the notes record `Seccomp: 2` and
`NoNewPrivs: 1`.

Observed:

- Every write result matched the outside check.
- Background (promoted) runs of the script gave the same results as the
  synchronous runs.
- With skip (`p3-sandbox`, `p3-sandbox-user` and the no-sandbox run),
  `agy`'s own `write_file` also wrote outside the workspace. `read_file`
  outside the workspace ended `completed`; what it read does not appear in
  the ACP updates, so whether the content was read is not confirmed. In the
  diagnostic run the model used `mkdir` instead of step 4 and it failed
  with a sandbox error, so `write_file` without skip was not measured.
- In one run the model passed `IsDaemon: true` to `run_command`; the hook
  record shows the argument name.
- The kaoiro MCP stub was callable under the sandbox with skip. In the
  diagnostic run, mode `auto` sent `session/request_permission` for the
  call; answered `cancelled`, the call `failed` and the turn ended
  `end_turn`.
- The diagnostic run's sandbox error read: "There were sandbox errors … you
  can run the command again with `BypassSandbox` set to true to request
  explicit user permission."
- The hook payload carries `BypassSandbox` as `true` or `false`.
- Asked for tools that can run commands, the model named `run_command`,
  `manage_task` and the subagent family (`invoke_subagent`,
  `define_subagent`, `manage_subagents`, `swarm`, `run_workflow`). This is
  the model's own report, not a tool inventory.

Approved-bypass lifetime (`p3-bypass-user`). The prompt ran three
`run_command` calls: the marker script with `BypassSandbox: true`;
`sleep 121` with `BypassSandbox: true`, in the background with
`WaitMsBeforeAsync` 500; `sleep 122` without bypass, background, 500. 3 s
after the response (7.9 s, `end_turn`) the probe sent SIGTERM to `agy`'s
process group with a 2 s grace.

| Moment | Bypass background (`sleep 121`) | Sandboxed background (`sleep 122`) |
|---|---|---|
| Before SIGTERM | Alive (pid 87 and 88; session and group 87) | Alive (pid 114 and 115; session and group 114) |
| 5 s after `agy` exited (0.6 s after SIGTERM) | **Alive** | Gone |

The surviving processes were recorded, then stopped by PID.

Bypass denied (`p3-denybypass-user`): the call `failed` with empty output
and 0 markers were seen from outside. The model's reply carried the deny
reason `DENYBYPASS-5c1e: …` and `DONE` (the prompt forbade retrying).

Verdicts:

| Question | Verdict |
|---|---|
| Under the launch flags (`--sandbox --dangerously-skip-permissions`), is a sandboxed `run_command` confined to the workspace? | Negative: writes succeeded in all five places; HTTPS went through `agy`'s proxy. Contained: `~/.ssh` hidden, raw sockets, the seccomp filter. Same for uid 0 and 1000, synchronous and background |
| Diagnostic: without skip, in mode `auto` | Matched the vendor description (workspace, artifacts and the temporary directory readable and writable, no network, no files outside the workspace): the other home directory hidden and `mkdir` failed with a sandbox error; no network from name resolution on; the cache, temporary directory, cwd and customization directory (through `--add-dir`) writable. A permission request came for the kaoiro MCP call |
| Approved bypass (hook allows) | Runs outside the sandbox: every marker succeeded, no permission request. Its background command survived SIGTERM with grace (own session and group); the sandboxed background command of the same run did not |
| Hook denies the bypass | Does not run; the reason reaches the model; no permission request |

Inferred: the notes attribute the gap between the vendor description and
the launch flags to `--dangerously-skip-permissions`; the diagnostic run
removed that flag and set mode `auto` together. The customization directory
is writable from inside the sandbox in every launch because `--add-dir`
makes it a workspace root.

Not measured: whether sensitive directories other than `~/.ssh` (for
example `~/.config`) are hidden with skip (only a fake `~/.ssh` was
planted); the proxy's rules (one HTTPS URL only); `write_file` without
skip; the modes `default`, `accept-edits` and `plan` with skip; a read-only
cell; commands run by subagents or through `manage_task send_input`; an
approved bypass under SIGKILL or cancel. Each case ran once.

## Subagents: P6 (ii) and the subagent runs

### Without a Stop hook (2026-11-23)

Cases `p6-sub-allow` and `p6-sub-deny`. Launch: no `--sandbox`; no Stop
hook; uid 1000 with no capabilities; flash-lite at the lowest thinking
level. PreToolUse: allow all (`p6-sub-allow`) or deny a `run_command`
containing `SUB-` (`p6-sub-deny`). The prompt had `invoke_subagent` run
`echo SUB-<random> > <cwd>/sub-<random>.txt`. Prompts: 1 each.

Hook records in `p6-sub-allow`:

| Call | ACP `tool_call` | Hook `conversationId` | Decision |
|---|---|---|---|
| `invoke_subagent` (parent) | Yes | The parent's `sessionId` | Allow |
| `run_command` (inside the subagent) | **No** | **The subagent's conversation ID** | Allow (the marker file appeared) |
| `send_message` (subagent to parent) | No | The subagent's conversation ID | Allow |

Observed:

- `p6-sub-deny`: the inner `run_command` was denied. The subagent reported
  that it could not run the command because of a security restriction and
  created the same file with `write_file`, which also passed the hook and
  was allowed.
- In both runs the parent prompt ended `end_turn` after about 20 s with a
  reply saying it was waiting for the subagent's report; the report arrived
  later as an `agent_message_chunk` outside the prompt.
- In one run the model put `Model: flash_lite` in the `invoke_subagent`
  arguments.

Verdict: positive for the hook (inner calls pass PreToolUse and a deny
holds), with an observation against V3: the inner hook's `conversationId`
is the subagent's own and the inner calls do not appear in ACP.

### With the probe's L5 and L10 emulation (2026-11-23)

Launch: uid 1000 with no capabilities; flash-lite at the lowest thinking
level. Hooks emulating the design:

- PreToolUse denies any request arriving outside an open prompt (L5);
  `r12-s2-nosend` also denies `send_message` by name. It records the name,
  ID, `conversationId`, the payload's top-level key names, string fields
  whose names contain parent, root or subagent, and the marker value the
  probe planted in the environment of the `agy acp` process.
- Stop (`window-own`, L10) answers continue only inside the prompt window,
  for its own conversation ID, with `NO_TOOL_CALL`, `fullyIdle` false and
  fewer continuations than the cap; for another conversation ID it answers
  stop and does not count. Cap 10; 4 in `r12-s4-settle-resume`.
  `r12-s4b-settle-resume` used `window-own-release`: once the probe saw the
  subagent's command it set a mark and the parent's next Stop answered
  stop.

The probe sampled processes in the PID namespace every 100 ms and stopped
subagent commands and child `agy` processes only by PID, after recording
them. Tool self-tests without `agy` (`r12-subdry`, `r12-subdry2`, positive
and negative once each): the Stop modes, the PreToolUse deny and record
modes, and the PID stop (planted `sh -c 'sleep 61; …'` and `sleep 61`
stopped with 0 left; an unrelated `sleep 62` untouched).

| Case | Condition | Prompts (tokens) | Observed |
|---|---|---|---|
| `r12-s1-hold` | `--sandbox`, `sleep 23`, cap 10. Then the same session resumed without a prompt and watched 20 s (negative control) | 1 (83,258) | `fullyIdle` false during the parent's 4 continues. The parent made up a report, then `manage_subagents list` and `kill` stopped the subagent (its command was gone too). The subagent's only hook was its `run_command`. 0 hooks in the 20 s after resume |
| `r12-s1b-hold` (rerun) | `--sandbox`, `sleep 6`, the parent told not to stop the subagent | 1 (112,627) | 4 parent continues, then `fullyIdle` true and the real report (the stub's `request 5`) arrived inside the prompt. 7 subagent hooks (`run_command`, `read_file` 2, `mcp_kaoiro_whoami` 2, `send_message` 2), all allowed and inside the window. The subagent's Stop ran once (`fullyIdle` true). The parent also made up a report midway, read the subagent's transcript and asked it to continue with `send_message` |
| `r12-s2-nosend` | As `s1b`, `send_message` denied | 1 (122,796) | The subagent's `send_message` was denied twice. The parent read the transcript and returned the real result (`request 4`) inside the prompt. 5 parent continues |
| `r12-s3-cancel-sb` | `--sandbox`, `sleep 137` (promoted after 5 s), `session/cancel` 5 s after the command was seen | 1 (60,174) | The prompt answered `cancelled` in 12 ms. 31 ms later the helper `agy`, `bash` and `sleep 137` were gone. 0 updates and 0 hooks in the 15 s after the cancel; 0 left after retirement |
| `r12-s4-settle-resume` | No `--sandbox`, `sleep 61`, cap 4. After the prompt settled: retire, resume, wait 20 s, then an "OK" prompt | 2 (143,310 and 12,713) | The subagent's loop ended through its own Stop (`fullyIdle` false, answered stop) while its background command ran. The parent ran `sleep 61` itself and woke the subagent with `send_message`; the subagent stopped its command with `manage_task kill`, ran only `echo` and reported. After retirement the parent's `sleep 61` was left; it was stopped by PID (0 left). 0 hooks after resume |
| `r12-s4b-settle-resume` (rerun) | No `--sandbox`, `sleep 63` (promoted after 5 s), `window-own-release`: settle as soon as the command is seen and retire at once. Resume, wait 20 s, then an "OK" prompt | 2 (19,821 and 9,174) | The prompt settled about 2.6 s after the command started and the process was retired. The subagent's command, still in its foreground phase, was gone 100 ms after SIGTERM (0 left). After resume, in the 50 s before and after the prompt: 0 hooks, updates or commands, and 0 marker lines. The thinking mentioned a stop notice |

Hooks against ACP, all six runs:

| Hooks | Count | Shown as ACP `tool_call` | With the planted marker | With a field naming a parent |
|---|---|---|---|---|
| Parent's conversation ID | 24 | 24 | 24 | 0 |
| Another (subagent's) conversation ID | 21 | 0 | 21 | 0 |

Process shape:

- With `--sandbox` every command, the parent's or a subagent's, ran under a
  child `agy` of `agy acp`, in its own process group and in `agy acp`'s
  session. `c3-term-promoted-sandbox`, which has no subagent, has the same
  shape, so the notes infer that this child is the helper that runs
  commands in the sandbox, not a subagent. (The first report after `s1`
  called it a subagent process; the notes correct this.)
- Without `--sandbox` a subagent's command was a direct child of
  `agy acp` in its own session, like the parent's commands.
- No `agy` process of the subagent's own appeared in any run.

Observed and verdicts:

| Question | Verdict | Observed |
|---|---|---|
| S1: can a hook with another conversation ID be tied to the process? | Positive | All 45 hooks in 6 runs, including the 21 with another conversation ID, carried the marker planted in the `agy acp` environment. Every payload had the same 10 top-level keys (the documented contract) and no field naming a parent. The subagent ran inside the `agy acp` process |
| S2: does the report arrive when `send_message` is denied? | Positive (1 run) | Both `send_message` calls were denied; the real result appeared in the parent's reply inside the prompt; the parent had read the subagent's transcript under `agy`'s home with `read_file` |
| S3: are the subagent's calls absent from ACP? | Positive | 0 of 21 appeared in ACP; 24 of 24 of the parent's did. Each subagent side effect (3 marker lines, 3 `tools/call` at the stub) was preceded by an allowing hook with the subagent's conversation ID |
| S4.1: does the prompt stay open while the subagent runs? | Positive (2 runs) | The parent's Stop saw `fullyIdle` false while the subagent ran (all 6 runs); it turned true when the subagent ended and the real report arrived inside the prompt (`s1b`, `s2`). The subagent's loop called Stop with its own conversation ID (3 runs) |
| S4.2: cancel and retirement | Cancel positive (`--sandbox`); retirement positive for a foreground command; a background command undetermined | `s3` and `s4b` as above. A subagent background command alive at retirement could not be produced (in `s4` the subagent stopped its own) |
| S4.3: the next turn | No automatic restart observed (1 run) | `s4b`: 0 hooks, updates and commands before and after the prompt |

Model behaviour seen in these runs: the parent made up a report before the
subagent finished (`s1`, `s1b`); the made-up report held the marker from
the prompt but not the stub's real reply (`probe-agent (request N)`) and no
marker file existed, so it was distinguishable. While waiting, the parent
used `manage_subagents` (`list`, `kill`) and `manage_task list`; it stopped
the subagent (`s1`) or ran the same command itself (`s4`).

Inferred, not measured:

- In `s4` the parent's `sleep 61` was promoted to the background: its ACP
  call was still `in_progress` when the parent's loop ended. Like C3's
  promoted command without `--sandbox`, it survived SIGTERM.
- In `s4b` the stop notice probably reached the model (the thinking said it
  saw a system message about stopped agents and tasks).
- S2: whether `agy` itself would have delivered the report is
  undetermined; the parent read the transcript.
- A subagent's background command at retirement without `--sandbox` falls
  in the same range as the parent's promoted commands in C3 (not produced).

Cleanup: the processes left after retirement were the 2 in `s4` (the
parent's `bash -c sleep 61` and `sleep 61`), stopped by PID; 0 left in every
run. After the runs, 0 marker files and 0 `sleep` processes on the host
(listing only), and 0 disposable HOMEs.
