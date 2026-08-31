---
title: /new/clear as primary session lifecycle command
status: accepted
date: 2026-07-12
opened: 2026-07-12
supersedes: []
superseded_by: null
related_specs: [protocol, architecture, threat-model]
related_adrs: [12, 14, 20, 34, 43]
---

# ADR-0036 — treating /new/clear as first class session lifecycle command

## Status

Accepted (2026。-12, master decision). 
[phase-17-session-lifecycle-commands](../plans/phase-17-session-lifecycle-commands.md)。
phase-15 After initial completion, the master decides the implementation order with phase-16.

**Supplement (2026 -28)**: F1 and F6 of this decision
[ADR-0043] (0043-agent-initiated-session-reset.md) has been revised.  operator
Add the deferred reset with the agent's own permission while maintaining the existing semantics of the origin.

## Context

kaoiro Composer can complement the slash command reported by com, but
Not interpreted. `/new` and `/clear` reach the wrapper as normal `send_instruction`,
Codex does not change thread ID or context by just one turn prompt.
Home measured 2026-11-11. Claude/Codex
S /execintegration not via, so even if you pass a string to the left side, you can use session lifecycle operation.


In Home's actual survey, kaoiro also sends `/new` to see past conversations in the same Codex session
and session boundary did not occur. Disconnect -> resume
Verified. Codex native `/new` (display holding + fresh task)
The meaning difference between `Ctrl+L` and `/delete` is the official specification.
It is not actual measurement that execution of native command over kaoiro. In the same process
The path to null the session ID and make the next turn `startThread()` is unrealized.
It does not assume that it is established.

### © 2019 Claude Agent SDK`/compact`Japanese term

[Claude Agent SDK 0.3.220 interprets `/compact` in streaming input mode as CLI native slash command and executes manual compact. Therefore, the above “Claude/Codex does not pass CLI native slash command parser” is limited to the actual measurement of Codex. Claude does not apply this fault.

In the same day [phase-28 real machine acceptance](../plans/phase-28-agent-initiated-session-ops.md# actual machine acceptance result-Home2026-28-28), manual compact via `request_compact` from the agent was also established in the main session. De  two additional points.

- **`compact_metadata.post_tokens` is optional**(`post_tokens?: number`), and there is no guarantee that it always exists. In the actual aircraft, the `SDKCompactBoundaryMessage` of in-process was not the same event on the session jsonl written by CLI, but the expression is different by the fact (field name is different from snake case / camelCase). The implementation that handles compact reductions is correct in-process message and has a path to degrade when `post_tokens` falls.
- **manual compact is contextual and can reach a few minutes**Home 13.7 sec @ ~22k s @ 168.8 sec @ ~293k s. The UI / tool description of the session lifecycle operation does not promise the required number of seconds, and the expression "running at the next turn boundary" and "complete observation with boundary event".

To start a new conversation while the operator is the same agent/persona/cwd, delete the current agent and
respawn is required. not text input, but displayhistory, resume pointer,
wrapper process, the first-class control operation to switch the new SDK session
Comment

This ADR determines:

1. How to intercept slash command?
2. How to generate fresh session in both directions?
3. Display difference between `/new` and `/clear`.
4. Handling of the old sessionses route and `SessionPointers`.
5. Common protocol and session capability boundary.
6. Behavior during turnexecution.

## Decision

### F1 — client first class control + server protection reject

dashboard input after trim**Close**`/new` or `/clear` only when attaching
send operator-only control event:

```text
session_reset { agent_id, mode: "new" | "clear" }
```

arguments (`/new foo`), multiple lines, and attach are not interpreted as session reset.
However, since the error transmission of reserved command is silent, it does not flow to the left side,
`send_instruction` handler also detects anexact `/new` and `/clear` without attachment,
`reserved_session_command` For the former client, the upgrade to the dedicated event
Contact Us Don't get a wrapper to reparse user text. protocol control and model input
It is because the meaning changes after mixing responsibilities and passing through client/ valid validation.

If you want to send exact string to model for descriptive purposes, code block or escape the beginning
Use `\/new`/`\/clear` to avoid reserved exact。. phase-17
Don't make a special route that sends anexactRoute by removing it. Defending Command


**Supplement (2026 -28, ADR-0043)**: The starting point of F1 is extended to the agent itself in addition to the operator.
`request_session_reset` MCP tool and wrapper→ event control event
user text reparse and the meaning of the command defense are not changed.

server verifies operator role, agent existence, live owner, capability, current state,
relay the reset request with `request_id`. client push`:ok`
only, the display change waits for the authoritative completion broadcast described below.

### F2 — Sharing both slices with fresh relaunch

session reset extends the CO supervisor route of the existing `resume_session` and the same agent
Entry**kill + fresh relaunch**(without resume session id) By:

- Claude starts a new `query()` without `resume` option.
- Codex starts with `startThread()` instead of `resumeThread()`.
- Agent id, personala, cwd, maintain your business, model, effort, permission mode, sandbox,
network accessphasephase-15 Same as D8 snapshot**Lastly, it was effective**Start
Don't rewind to launch value.
- Don't mix the old SDK process in-memory context/queue/tool state into the new session.

For reset only, the implementation of reinitializing the long-life loop of each adapter is not collected. Claude
streaming query and codex per-turn exec are implemented separately, and leave of queue/pending tool
hard to prove. Reuse vis supervisor as a process lifecycle SSOT.

server takes the `session_reset_pending` lock of the agent unit at the start of reset, followed by
instruction、model/effort switch、permission_mode switch、resume_session
(switch session), deny duplicate resets with `session_reset_pending`
(**2026 -12 ε In the race analysis during implementation, Detect the leakage of resume session and repair**、
race to `AgentsChannel.handle_in("resume_session")`
`guard_against_reset_pending`.
broadcast `session_reset_completed` only when the connection of the fresh wrapper is confirmed,
Release lock. If the codex thread/rollout ID is not counted until the first turn, fresh
`to_session_id` is nullable
Marker/pointer of the same request ID in the first ID report.

When fresh spawn/timeoutfailure, the old session ID saved by ses expresses the old session.
tryicic rollback. loud broadcast after rollbacksuccess
UI history/boundary/pointer This is a silent dressing success
instead of fallback, it is a restoration of the failed transaction. only if the rollback itself fails
Disconnected agent and display both errors.

wrapper/previous rollout
tool/question/permission correlation andlele completion are not mixed to new session. Freshness
wrapper is mana/developer instructions, lastly effective model/effort/permission,
Re  the sandbox/network and MCP config from the regular spawn route. Value SSOT Phase-15 D8
The latest effective snapshot, including the mid-session model/effort switchsuccess value of phase-16.

"Re-applying from ordinary spawn routes" const tes [ADR-0014 F1] (0014-session-resume-and-restore.md): `ResetSessionCommand.resume_snapshot?` is included by the server, and  server `applyResumeSnapshot` pure helper reflects P0 privileged three axis (Codex `sandbox` / `network_access`, Claude `permission_mode`) to a fresh DE5. `model` / `effort` is preserved in sanitized snapshot and is also included in drift calculation, but apply is P1.

### F3 — /new maintains display, /clear resets the display projection of the agent

Both modes create a new SDK session, and the old session file (host JSONL/rollout) holds
The difference between the display side is:

- `/new` — keep display projection. `session_boundary` marker
append at the end, followed by the SDK output. The old log and structured IA are
- `/clear` — pane display of the agent**empty**Home Normal log and IA bubbles are not distinguished
all drops and leave only `session_boundary` marker. IA opponent pane #106
durable ledger because per-pane `ClearWatermarks` hide
(`InterAgentHistory` DETS) does not delete (the IA remains in the pane of the opponent agent).
The engine session file (JSONL/rollout) is not deleted and the old session is picker.
resume Leave it possible.

**2026 08 Correction:**IA visibility cutoff
[ADR0051](0051-history-restart-resilience.md) supersede was done in D3-4.
`ClearWatermarks` defines the ing  stamp of the server
Restore from the host sidecar to per-pane projection. server
`InterAgentHistory` Remove DETS.

`server` `AgentStates` is the SSOT of the display projection and only the client local store
Don't getJapanese termd. reconnection. /clear
`SessionResets.confirm_connection/2` returns `SessionStarts.advance_transition/3`
`{order, display}` to `ClearWatermarks.record/3`
`adopt_session_start_watermark` and `AgentStates.clear_history_with_boundary/2`
squeezing history to one line. fsync-gated `ClearWatermarks`
leave watermark even if it crashes (same as `M7-a`).

marker `{mode, previous_session_id?, to_session_id?, request_id, ts}`
payload for operator. `to_session_id` is added after ID is confirmed and lazy
null. `session_reset_completed` `/clear`
Add `clear_watermark`(ISO ts) only when live client does not wait for reload
update watermark map. ADR-0021
limits to the operator and does not leak the payload containing the session ID. operator `clear_history`
(#48) and /clear**Features**(The former is the other session log purge of the current session, the latter is
maintain the current API as the agent's pane marker + marker retention.

### F4 — SessionPointers add explicit detach, as it is the latest one

[ADR-0014] (0014-session-resume-and-restore.md) Maintain the latest pointer contract of F3,
pointer stack After fresh relaunchsuccess, `SessionPointers` has the old session ID
**explicitly update toachil**and cwd/  keep. Current `record(..., nil)`
is a merge semantics that stores the existing session ID, so it is aoperhronous dedicated operation in phase-17
(`detach_session/1`, etc.) When fresh wrapper reports a new session ID
Normal record route updates the latest pointer.

ses session and existing session picker/
`resume_session` Don’t make a dedicated “ Japanese term” stack. history on server
Maintain ADR-0014 F2/F3/A4 to candidate SSOT for host session files without duplicate.
You can add sh、cut only once from completion toast to `previous_session_id`.
This is not pointer stack, it is treated as a shortcut to the existing `resume_session` and is not MVP.

After reset, the first instruction is the normal state even if the session ID is not specified. pointer=nil
"reset and next turn to confirm fresh ID", and do not implicit fallback to the old pointer.

### F5 — ProHomet Home with capability advertise

ses4-session-capabilities-advertisement.md

```text
supports_session_reset: boolean
session_reset_modes: ("new" | "clear")[]  // supports=trueRequired・Non-empty
```

`supports_session_reset=false` can be omitted. modes
If not specified or empty, fail-closed as invalid advertising and disable the UI.
Reject this combination with the adapter's stamp test.

wrapper/wrapper/wrapper provides F2 fresh relaunch and completion handshake
stamp true. unstamp/false disables UI command with fail-closed and typed exact
command does not flow to 。 as `unsupported_session_reset`. dashboard with 4 people
Not judged.

`/new``/clear` is another kaoiro local command from `ext.slash_commands`, but
function=true and merge to the completion candidate only when the corresponding mode enumeration. This is the same name
Even if command is reported, the meaning of kaoiro control is priority, and it does not duplicate display.

### F6 — refused when busy. Do not auto interrupt・queue

Only `idle` or `waiting_input` are allowed to accept reset. `thinking`
`tool_running`, `waiting_permission`, `waiting_question`, `sending`, etc.
`agent_busy`

`error` There is a demand for resetting and partitioning the agent of the state, but with other non-idle state in MVP
reject. after realizing old process/rollback semantics
Become an extension candidate.

No reset after auto interrupt. tool When the write interruption and context destruction are bundled in one operation
High impact on errors. queue If it is delayed after long turn completion,
The operator misidentifies the following destinations: If required, the operator expresses the existing interrupt,
`waiting_input` Check return and resend reset.

server acquires F2 pending lock at the same time as state verification and prevents TOCTOU with new instruction.
wrapper/wrapper also verifies the reset request's generation/request ID andlele completion
ignore.

**Supplement (2026 -28, ADR-0043)**: If the agent itself requires an approved reset,
When the tool call, only the reservation is accepted, and it fires after the completion of the turn. operator
busy denial, auto interrupt adopt, queue adopt is not changed.

### F7 — SSOT protocol event and failure

control flow:

```text
client -> server: session_reset {agent_id, mode}
server -> runner: reset_session {agent_id, mode, request_id}
runner -> server: session_reset_result {agent_id, mode, request_id, ok, reason?}
server -> clients: session_reset_started | session_reset_completed | session_reset_failed
```

`session_reset_started`Displays "New session" in the UI. Existing
、- life lifecycle event
pending lock to SSOT. wrapper process to state machine
not to mix.

server pending lock, Agentdisplaysdisplay change, SessionPointers detach, client broadcast
SSOT wrapper/S  session file of process lifecycle
SSOT Do not duplicate the same history or pointer stack on each layer.

error reason closed vocabulary (`agent_busy`, `unsupported_session_reset`,
`session_reset_pending`, `runner_unavailable`, `spawn_failed`, `rollback_failed`,
`timeout`) returns to loud and silent to old session dressing fallback or success to ses prompt
Pro。t resume. stderr
`[wrapper session] command=<mode> from=<id> to=<id|null> result=<ok|failed|rolled_back>`
1 line.

## Consequences

### Positive

- The same agent/persona/cwd can be replaced with the equivalent conversation partition.
- Close Claude/Codex difference to fresh relaunch, and client only see capability.
- After `/clear`, the old session can be resume from the picker.
Don't delete it. reset only the pane display of the agent, and the IA opponent pane
hide to per-pane with watermark.
- busy operation is immediately rejected, no delay reset or implicit interrupt occur.

### Negative

- control handshake crosses all layers of client/。/wrapper/wrapper.
- A short disconnected window occurs to restart the wrapper process at reset.
- `SessionPointers` is required to add an explicit detach operation toilil.
- If the codex fresh thread ID is lazy until the first turn, the boundary ID is confirmed two steps.

### Neutral

- pointer remains the latest one, and the previous session list continues to enumerate.
- `/clear` does not delete the SDK session file. The full removal function is out of scope of this ADR.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
|wrapper`user_message`Interpreting slash with top matching|mix of model input and control responsibilities, drift for literal text and chattament|
|client only|Exact command of old/ex client is attached to the command line. server defense reject required|
|Change only sessionId to null with adapterinHome|Codex is close to but is a.metrical to Claude long life query. It is difficult to prove the complete set of queue/tool/pending state|
| `/clear`delete host session file|It is destructive operation which is not resumeable, and it is difficult to predict from the name. Reset only the pane display of the agent and hold the host session file (JSONL/rollout)|
|Save previous session stack on server|Duplicate with ADR-0014 F3/A4 last pointer + host enumeration SSOT. Return with existing picker|
|reset when busy|write/tool interruption and context destruction occur by one click. Request the explicit interrupt of the operator|
|queue reset when busy|Delaying after execution is difficult to predict and misunderstand the following destination|
|Resetfailure does not restore the old session and stops with disconnected|The UI can be changed toicic transaction, and the old session can be resume safely with idle. Only disconnected when the rollback fails|
|Features`lifecycle_commands`object AgHomeated into one|The display policy is fixed by mode on protocol. ADR-0034 boolean + optional modes pattern can reuse existing UI judgment and fail-closed semantics|

## Implementation

[phase-17-session-lifecycle-commands](../plans/phase-17-session-lifecycle-commands.md)
implement.

### Handling of actual survey items (as of phase-17 chunk γ, 2026 -12)

F2's "completion" and Codex thread only when checking fresh wrapperconnection
ID lazy The behavior of gammaJapanese term-5/6)**assumption**
Include coded as follows: Composer intercept
`/new``/clear` by operator
If necessary, this ADR will be used for searching.

- **Codex thread ID**:   `session_reset_result`
set `to_session_id` to optional / nullable, and the codex is fresh
send `null` at spawn. `SessionResets`
`broadcast_completed` payload `SessionResetCompleted.to_session_id`
`null` The first envel  of the fresh session is session id
The current `SessionPointers.record` path is the latest pointer when reported
In order to update, the pointer side is determined naturally by the existing route. marker
backward patch (δ 17-7 to `AgentStates` boundary marker
`to_session_id` reflects the first envel  on the fresh side when implementing the UI
to add.
- **Same process  generation**: vis supervisor takes child every time
kill + fresh spawn `startThread()`
→ The route to switch `resumeThread()` is not collected in this ADR (F2 "fresh"
The policy to integrate the SDK difference in relaunch. In-process
If it is determined that it can be fully iso  even with a switch, it will be a cost reduction candidate, but at γ point,
Unverified and unadopted.
- **Old event iso **: Three-stage protection. (a)   supervisor
Stop the old wrapper process with child kill (former rollout / tool response /
permission requests are not delivered to the fresh process), (b) wrapper
`AgentStates`
dedupe, (c) server `SessionResets` in latest session id
request id / phase mismatch
(F7) Prevents any of the three-stages in two other steps.   side generation
counter is not introduced, and the child process layer kill is the main defense.

### F2 "connection confirmation" implementation sharing (chunk γ two-phase completion)

`SessionResets`:spawning|:awaiting connect`
`:awaiting_connect`
migration only (broadcast does not fire), `session_reset_completed` is
`WrapperChannel.after_join` to `SessionResets.confirm_connection/2`
Fire over. 60 sec timeout is spawn stage ( spa ok not received) and connection
wrapper join unconfirmed
`session_reset_failed { reason: "timeout" }`  Japanese term
phase is only completed when confirming the fresh wrapper connection of this ADR F2
`runner.ok=true` is misunderstood as completion
completed if wrapper is dead on the fresh spawn  
explicitly avoid risk.
