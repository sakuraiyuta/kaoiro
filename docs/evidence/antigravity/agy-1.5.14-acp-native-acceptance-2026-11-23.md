---
title: Antigravity 1.5.14 native acceptance over ACP
status: measured
last_updated: 2026-11-23
---

# Antigravity 1.5.14 native acceptance over ACP

The opt-in acceptance test of the ACP host
([ADR-0078](../../adr/0078-antigravity-over-acp.md),
[issue #1238](https://github.com/sakuraiyuta/kaoiro/issues/1238)) drove the
real `agy` against the provider on 2026-11-23. The test is
`wrapper/antigravity/test/acp_native.test.ts`; the raw log is kept outside
the repository and is available on request.

## Conditions

| Item | Value |
|---|---|
| Code | commit `dd0d094d` for the first run (the host as of `69712d4a`); commit `8578dc6f` for the one retry of N9, which changed only that case's command |
| `agy` | 1.5.14, run from a read-only copy; sha256 `37873b8062391b6202a3d3199ec012abc9e53aab720d26cd65699441497d8c94` before and after the run |
| Model | `gemini-3.1-flash-lite-preview`; `agy` offers it no thinking level, so none was set |
| Authentication | a service-account key through ADC (`AGY_ADC_AUTH=true`, `GOOGLE_APPLICATION_CREDENTIALS`); the key's contents were not read |
| Isolation | private user, mount and pid namespaces. The user's real home and the session bus were hidden behind empty mounts; a fresh HOME under the user's home, the worktree and the key directory (read-only) were the only visible parts. A probe inside the namespaces saw neither the real `agy` settings directory, nor the installed `agy`, nor the session bus, all of which exist outside; the key file was readable and not writable |
| Composition | the production CLI with a stand-in server link; host and gate from their defaults. The test wrapped the gate's handlers, the spawn and the tool host only to record what they did |
| Redaction | all output passed a credential-shape filter before it was written; planted fake bearer, access-token, API-key and JWT values were masked and a plain line was kept |
| Prompts | 13: 12 in the first run (90.9 s for the whole file) and 1 for the N9 retry. Token counts were not recorded |

## Results

Verdicts come from the gate, operator-dialog, wire and workspace records,
never from the model's prose. Each judge has negative controls that run
without the opt-in (a passing record, failing records, a record without the
call the case needs).

| Case | Cell | What happened | Verdict |
|---|---|---|---|
| N1 operator rejection, turn goes on | workspace-write, on-request, network on | `run_command` asked; the operator stand-in rejected it; the hook answered deny; the turn ended with a result | pass |
| N2 read-only write | read-only | `write_file` denied by the gate; no file written; result | pass |
| N3a network off | workspace-write, on-request, network off | `run_command` denied without a dialog; no file written; `agy` launched with `--sandbox` | pass |
| N3b network on | workspace-write, on-request, network on | `run_command` asked and was approved; the command wrote its file; `agy` launched with `--sandbox` | pass |
| N4 `BypassSandbox` | workspace-write, on-request, network on | `run_command` with `BypassSandbox: true` asked and was approved; the command wrote its file | pass |
| N5 kaoiro tool | workspace-write, on-request, network off | `mcp_kaoiro_whoami` allowed with no dialog; result | pass |
| N6 background output | danger-full-access, never | `run_command`, two Stop requests answered `continue` while the model polled with `manage_task` and read the output, then `stop`; the command's output was in the reply | pass |
| N7 subagent report | danger-full-access, never | `invoke_subagent`; the subagent's own calls arrived with another conversation ID (`send_message` denied as agent-internal, `mcp_kaoiro_*` allowed); two `continue`, then `stop` for the subagent's and the parent's loops; the report text was in the reply | pass under the first judge; undetermined under the current one; pass on the rerun (below) |
| N8 cancel during a subagent | danger-full-access, never | the interrupt came once the subagent's `run_command` hook was seen; the turn ended `interrupted`; no `agy` process was alive afterwards | pass |
| N9 cancel during a held prompt | danger-full-access, never | first run (`sleep 120; echo late`): the first Stop request was answered `stop`, so the prompt was never held and the case could not be judged. Retry (`sleep 20; echo kaoiro-n9-done`, same wording): `run_command` allowed, the Stop request answered `continue`, the interrupt ended the turn `interrupted`, and no `agy` process was alive afterwards | pass on the retry |
| N10 permission switch | workspace-write to danger-full-access | the first turn's `agy` had `--sandbox`; after `set_permission` the second turn ran on a new process without it, and the permission state became `applied` | pass |

### Judges changed after the implementation review

The first N7 judge passed when the reply held a marker that the parent's own
prompt contained, so it could pass without any report from the subagent.
The current N7 judge places a random value in a workspace file that no
prompt names, and passes only when a subagent call naming that file was
allowed, the parent used no tool that could read it, the parent's prompt was
held (a Stop `continue`), and the reply holds the value. The N7 record above
has no subagent read of such a file, so it is undetermined under the current
judge. The N6 judge now also requires a parent `manage_task` or `read_file`
after the first `continue`; the N6 record above has both, so its verdict is
unchanged.

N6 and N7 were run again under the current judges on commit `3e983b84`,
under the conditions above, with a budget of 4 prompts (one retry each).
Each passed on its first attempt; 2 prompts were used. Conversation IDs are
shown by their last 8 characters; the marker is not printed.

| Case | Parent session | Gate record (in order) | Verdict |
|---|---|---|---|
| N6 | `59590eb8` | `run_command` allow, Stop `continue`, `manage_task` allow, `read_file` allow, `manage_task` allow three times, Stop `stop`; all from the parent; the reply held the command's output | pass |
| N7 | `3f4f7bb4` | parent `invoke_subagent` allow; subagent `a87b938e`: `run_command` and `read_file` naming the marker file, allowed; parent Stop `continue` twice; parent `manage_task` and `manage_subagents` only; subagent `send_message` denied three times; Stop `stop` for the subagent, then for the parent; the reply held the marker | pass |

The judges' negative controls run in the same file without the opt-in, as
part of the package's test suite (the live run itself selected only N6 and
N7). They include an N7 record whose reply holds the marker with no subagent report
(undetermined) and N6 records without a parent read after the `continue`
(undetermined).

### Judges tied to their claims (implementation review round 2)

The second implementation review found judges whose witnesses did not show
their case's claim. The records now carry one sequence number per trial, the
full session, conversation and call IDs, the dialogs' tool input, the host's
projected `tool_result` logs and results as the server link received them,
the host's gate faults counted until the case closed, and the calls of the
kaoiro `whoami` handler. The printed record keeps ID tails, counts, order
and match results, never a path, an output or N6's value.

- N1, N3b and N4 tie the command, its dialog and its file together. The
  gate hands a call's arguments to the dialog unchanged, so the dialog's
  input must equal the arguments of the call it answered; a dialog for
  another command that names the same file or token does not count. N3b and
  N4 do not pass when a write tool wrote the file.
- N5 needs exactly one allowed call and exactly one run of the `whoami`
  handler.
- N8 interrupts once the subagent's command has created its own file, and
  claims only that the turn and every spawned `agy` end; the record counts
  spawned `agy` processes, not every command.
- N6 is narrowed to what kaoiro and the wire show (operator decision,
  2026-11-23; criteria P1-P7 in
  [issue #1238](https://github.com/sakuraiyuta/kaoiro/issues/1238), comment
  7091356206). With the real gate and Stop hook: the gate allowed the fixed
  background command R (`WaitMsBeforeAsync` 5000), the only allowed parent
  command, with no parent subagent call; the parent's prompt was held by a
  Stop `continue` after R, and a parent `manage_task` status query with a
  task ID passed the gate after that; R's random value reached the host
  after the `continue` and before the result, and is in the parent's
  successful reply as a complete value (the rule that finds it in the
  output); no gate fault until the case closed. Beside the rows the record
  keeps each parent status query's TaskId and each parent read by index,
  with the gate's actual decision, and the read count; it decides nothing.
  Not claimed: that
  the parent took the value from the task it queried, or that a read
  retrieved it. `agy` 1.5.14's status and read completions carry no output,
  so the record cannot show which tool result gave the model the value.

The earlier N1, N3b, N4, N5, N6 and N8 records lack these fields, so they
need a new sample; N2, N3a, N7, N9 and N10 keep theirs. A case is accepted
only on `pass`; an undetermined trial is not a pass. Before its first
prompt the live suite runs the registered hook entry with an empty payload
and stops unless it answers the documented deny.

### New sample under the current judges (implementation round 3)

N1, N3b, N4, N5, N6 and N8 were run again on commit `22433283` under the
conditions above (the same `agy` copy, its sha256 unchanged after every run),
one case per invocation, each in a fresh disposable HOME. The budget was 8
prompts with one retry for N4 and N6; every case passed on its first attempt,
and 6 prompts were used. Sequence numbers count within one trial; IDs are
shown by their last 8 characters; N6's value is not printed.

| Case | Record (in order) | Verdict |
|---|---|---|
| N1 | the dialog named the command and the operator stand-in rejected it; `run_command` denied by the gate; Stop `stop`; a result; no file | pass |
| N3b | the dialog named the command and was approved; `run_command` allowed; Stop `stop`; the command's file was written; `agy` launched with `--sandbox` | pass |
| N4 | `run_command` with `BypassSandbox: true` approved and allowed; Stop `stop`; the command's file was written | pass |
| N5 | `mcp_kaoiro_whoami` allowed with no dialog, and the `whoami` handler ran once; Stop `stop`; a result | pass |
| N6 | parent session `c9553ea9`: R allowed (seq 2), Stop `continue` (3), `manage_task` status query allowed (4), R's `tool_result` with one complete value (6), Stop `stop` (7), the successful result (8) holding that value; no gate fault. Rows P1-P7 all pass | pass |
| N8 | parent `define_subagent` and `invoke_subagent` allowed, Stop `continue`; the subagent's `run_command` allowed under another conversation ID; the interrupt came once its file existed; the turn ended `interrupted`; no `agy` process was alive afterwards | pass |

After each run the test found 1 file in the disposable HOME holding that run's
tool-host bearer (`agy`'s own store); the harness's shape scan found no
private key, access or refresh token, JWT or API key there. Each HOME was
deleted after the scan.

### Sample after the round-3 review (implementation round 4)

The judges changed as described above for N1, N3b, N4 (the dialog bound to
its call), N5 (exactly one), N6's P6 (a complete value) and N6's read
record. N1, N3b, N4 and N6 were run again on commit `d01275b0` under the same
conditions, one case per invocation. The budget was 6 prompts with one retry
for N4 and N6; every case passed on its first attempt, and 4 prompts were
used. In the printed dialogs, `=#<call>` names the gate call whose arguments
equal the dialog's input.

| Case | Record (in order) | Verdict |
|---|---|---|
| N1 | `run_command` denied by the gate; its dialog rejected, bound to that call (`=#20731017`); Stop `stop`; a result; no file | pass |
| N3b | `run_command` allowed; its dialog approved, bound to that call (`=#07446599`); Stop `stop`; the command's file was written; `agy` launched with `--sandbox` | pass |
| N4 | `run_command` with `BypassSandbox: true` allowed; its dialog approved, bound to that call (`=#68880261`); Stop `stop`; the command's file was written | pass |
| N6 | parent session `15a32390`: R allowed (seq 2), Stop `continue` (3), `manage_task` status query allowed (4), R's `tool_result` with one complete value (6), `read_file` allowed (7), Stop `stop` (9), the successful result (10) holding that value as a complete value; no gate fault. Rows P1-P7 all pass. Record: one status query (t1, allowed at 4), one read (allowed at 7) whose arguments hold no queried TaskId | pass |

N5's round-3 record (one allowed `mcp_kaoiro_whoami`, one handler run, no
dialog, a successful result) passes the exactly-one rule; N8's judge did not
change. The bearer and shape scans after each run found the same as in
round 3, and each HOME was deleted.

## `edit_file` hook requests

On 2026-11-23 the implementation review ran one `read-only` case through the
N2 harness: a single `edit_file` call on an existing file. ACP showed the
call, the gate recorded no hook request for it, and the generation ended in
a gate fault. The reviewer later traced this to the harness: the runner
entry that the managed hook command starts had not been built, so the hook
could not run and no request reached the gate. It is a harness failure,
not a finding about `agy` or the host; the live suite now checks the hook
entry before its first prompt.

Four further prompts, on commit `4efbd56a` under the conditions above, each
asked for one `edit_file` call on a seeded file. The test recorded every
gate-socket connection (event, tool name, argument names and types, the
answer) and every ACP tool update, then was restored.

| Run | Cell | Call | Hook request | Answer | ACP status | File |
|---|---|---|---|---|---|---|
| E1 | read-only | existing text, absolute `Path` | `Path`, `Replacement`, `Target` (strings) | deny (`kaoiro: read-only sandbox`) | failed | unchanged |
| E2 | workspace-write, on-request | existing text, absolute `Path` | same | allow | completed | edited |
| E5 | read-only | text not in the file | same | deny | failed | unchanged |
| E6 | workspace-write, on-request | text not in the file; the model sent a relative `Path` | same | allow | failed (`agy`: the path must be absolute, after the hook) | unchanged |

- Observed: every `edit_file` call reached the PreToolUse hook (4 of 4),
  with the session's conversation ID, before `agy` ran it, and none ended
  in a gate fault.

## Transcript path

The wrapper prints the transcript path
`<HOME>/.gemini/antigravity-cli/brain/<session id>/.system_generated/logs/transcript_full.jsonl`
(`wrapper/antigravity/src/transcript_path.ts`). The HOME listings kept from
the 1.5.14 measurement runs over ACP
([setup](agy-1.5.14-acp-measurements-2026-11-22-setup-and-sessions.md))
were checked against it on 2026-11-23, with no new prompt: in 60 runs that
had both a listing and a session ID on the wire, the file existed at that
path and its directory name equalled a `sessionId` of the same run (60 of
60). Negative control: pairing each listing with the next run's wire log
matched 0 of 60.

## Observations and inferences

- Observed: every hooked call of the parent and of the subagent reached the
  gate; the subagent's calls carried a conversation ID that was not the
  session's, as the design expects (V7).
- Observed: after the first run, 13 files in the disposable HOME held one of
  the 12 tool-host bearers the run minted (`agy`'s own conversation store);
  after the retry, 1 file held its 1 bearer. Each HOME was deleted after the
  scan. A retired generation's bearer authorizes
  nothing, because its tool host is closed.
- Inferred, not measured: in the first N9 run the model started the
  command in a way `agy` did not track as background work (for example a
  shell `&`), so the Stop request reported the loop idle. The plan allowed
  one retry for N4, N6 and N7; one retry of N9 was approved separately, and
  N9 was the only case retried.
