---
title: Treat /new and /clear as first-class session lifecycle commands
status: accepted
date: 2026-07-12
opened: 2026-07-12
supersedes: []
superseded_by: null
related_specs: [protocol, architecture, threat-model]
related_adrs: [12, 14, 20, 34, 43]
---

# ADR-0036 — Treat /new and /clear as first-class session lifecycle commands

## Status

Accepted (2026-07-12, approved by マスター). Implementation is
[phase-17-session-lifecycle-commands](../plans/phase-17-session-lifecycle-commands.md).
Start after phase-15 initial completion; マスター will decide the implementation
order relative to phase-16 when work begins.

**Addendum (2026-07-28)**: F1 and F6 of this decision were partially revised by
[ADR-0043](0043-agent-initiated-session-reset.md). Add deferred reset with permission
from the agent itself while preserving the existing operator-originated semantics.

## Context

The kaoiro Composer can autocomplete slash commands reported by an engine, but it
does not interpret the commands themselves. `/new` and `/clear` arrive at the
wrapper as ordinary `send_instruction`; in Codex, もも measured on 2026-07-11 that
they become a simple one-turn prompt and neither the thread ID nor context changes.
Both Claude and Codex use an SDK/exec integration that does not pass through the
CLI-native slash-command parser, so passing the string to the engine does not make
it a session-lifecycle operation.

In もも’s measurement, immediately after sending `/new` through kaoiro, the same
Codex session could still reference the previous conversation and no session
boundary occurred. In contrast, history continuity after disconnect → resume was
confirmed. The semantic differences of native Codex `/new` (keep display + fresh
task), `/clear` (clear terminal display + fresh task), `Ctrl+L` (clear display only),
and `/delete` (permanent deletion) were confirmed from the official specification,
but not by running native commands through kaoiro. The path that nulls the session
ID in the same process and uses `startThread()` for the next turn is also untested;
this ADR does not assume that path works.

### Addendum (2026-07-28 — Claude Agent SDK `/compact` measurement)

In [phase-28 Track S measurement results](../plans/phase-28-agent-initiated-session-ops.md#track-s-実測結果-もも2026-07-28)
on 2026-07-28, Claude Agent SDK 0.3.220 interpreted the string `/compact` as a
CLI-native slash command even in streaming input mode and performed a manual
compact. Therefore, the statement above that “neither Claude nor Codex passes
through a CLI-native slash-command parser” applies only to the Codex measurement;
do not apply it to Claude.

In the [phase-28 real-machine acceptance](../plans/phase-28-agent-initiated-session-ops.md#実機受け入れ結果-あお2026-07-28)
on the same day, manual compact through agent-originated `request_compact` also
succeeded in a production session. Record two additional findings:

- **`compact_metadata.post_tokens` is optional in the SDK type** (`post_tokens?: number`)
  and is not guaranteed to be present. It appeared in the in-process
  `SDKCompactBoundaryMessage` in real-machine testing, but was absent for the same
  event in the session jsonl written by the CLI; representation differed by
  artifact (field names also differed between snake_case / camelCase). Implementations
  handling compact reduction must treat the in-process message as authoritative and
  have a degrade path when `post_tokens` is absent.
- **Manual compact duration depends on context size and can reach several minutes**.
  Measurements were 13.7 seconds @ ~22k tokens versus 168.8 seconds @ ~293k
  tokens. UI / tool descriptions for session lifecycle operations must not promise
  a duration in seconds; say only “runs at the next turn boundary” and “completion
  is observed through a boundary event”.

At present, starting a new conversation with the same agent/persona/cwd requires
deleting and respawning the agent. What is needed is not text input but a first-class
control operation that coordinates the display history, resume pointer, wrapper
process, and new SDK session.

This ADR decides:

1. At which layer to intercept slash commands.
2. How to create a fresh session in both engines.
3. The display difference between `/new` and `/clear`.
4. The path back to the old session and how to handle `SessionPointers`.
5. The boundary between common protocol and session capabilities.
6. Behavior while a turn is executing.

## Decision

### F1 — Client first-class control + server defensive rejection

When trimmed input is **exactly** `/new` or `/clear` and has no attachment, the
dashboard sends an operator-only control event instead of ordinary instruction:

```text
session_reset { agent_id, mode: "new" | "clear" }
```

Do not interpret an argument form (`/new foo`), multiline input, or input with an
attachment as a session reset. However, to avoid silently passing an accidentally
sent reserved command to the engine, the server’s `send_instruction` handler also
detects exact `/new` / `/clear` with no attachment and loudly rejects it as
`reserved_session_command`. Prompt old clients to upgrade to the dedicated event.
Do not have the wrapper parse user text again: it mixes protocol-control and model-
input responsibilities and changes meaning after client/server validation.

To send the exact string to the model for explanatory purposes, use a code block or
escape the leading character as `\/new` / `\/clear`, avoiding the reserved exact
token. Phase-17 does not create a special path that removes the escape character
and sends an exact token. That would be a back door around reserved-command defence.

**Addendum (2026-07-28, ADR-0043)**: Extend F1’s origin from the operator to the
agent itself. An agent-originated reset goes through the `request_session_reset` MCP
tool and a wrapper→server control event, so the semantics of not reparsing user text
and defending reserved commands do not change.

The server validates operator role, agent existence, live owner, capability, and
current state, then relays the reset request to the runner with a unique
`request_id`. The client push `:ok` means acceptance only; display changes wait for
the authoritative completion broadcast described below.

### F2 — Commonise both engines through a fresh relaunch

Extend the runner supervisor path of existing `resume_session` so that session
reset **kills + freshly relaunches** the same agent entry (without
resume_session_id). This means:

- Claude starts a new `query()` without a `resume` option.
- Codex starts from `startThread()`, not `resumeThread()`.
- Keep agent_id, persona, cwd, and engine; start with the **last effective settings**
  for model, effort, permission mode, sandbox, network access, and so on, matching
  the phase-15 D8 snapshot. Do not roll back to launch-time values.
- Do not let in-memory context/queue/tool state from the old SDK process enter the
  new session.

Do not internally reinitialise each adapter’s long-lived loop only for reset. That
would create separate implementations for Claude’s streaming query and Codex’s
per-turn exec, making it difficult to prove that queued/pending tools are gone.
Reuse the runner supervisor as the SSOT for process lifecycle.

At reset start, the server acquires an agent-scoped `session_reset_pending` lock and
rejects subsequent instruction, model/effort switch, permission_mode switch,
resume_session (switch_session), and duplicate reset with `session_reset_pending`
(a missing resume_session enumeration was found in the race analysis during the
2026-07-12 ε implementation and added here; insert `guard_against_reset_pending`
into `AgentsChannel.handle_in("resume_session")` as a race closure).
Broadcast `session_reset_completed` and release the lock only when the runner
confirms the fresh wrapper connection. If Codex does not assign its thread/rollout
ID until the first turn, treat the fresh wrapper connection as “context reset
established”, put nullable `to_session_id` in the marker, and finalise the marker /
pointer for the same request ID when the first ID is reported.

If fresh spawn or timeout fails, use the old session ID saved by the runner to
explicitly resume the old session and attempt an atomic rollback. On successful
rollback, loudly broadcast `session_reset_failed`, leave UI history/boundary/pointer
unchanged, and release the lock. This is transaction recovery after failure, not a
silent fallback pretending success. Mark the agent disconnected and show both
errors only if rollback itself also fails.

Advance a generation/epoch for each reset request so late events, tool/question/
permission correlations, and stale completion from the old wrapper/rollout cannot
mix into the new session. The fresh wrapper reapplies persona/developer
instructions, last-effective model/effort/permission, sandbox/network, and MCP
config through the normal spawn path. The latest effective snapshot from phase-15
D8 is the SSOT, including successful mid-session model/effort switch values from
phase-16.

The concrete meaning of “reapply through the normal spawn path” is consolidated in
[ADR-0014 F1 addendum “reapply three privilege axes on resume”](0014-session-resume-and-restore.md):
the server includes `ResetSessionCommand.resume_snapshot?`, and the runner’s
`applyResumeSnapshot` pure helper applies the P0 privilege axes (Codex `sandbox` /
`network_access`, Claude `permission_mode`) to a fresh-equivalent `ParsedSpawn`.
Keep `model` / `effort` in the sanitised snapshot and in drift calculation, but apply
them at P1.

### F3 — /new keeps display; /clear resets the display projection for that agent

Both modes create a new SDK session and retain the old session file (host JSONL /
rollout). The display difference is:

- `/new` — preserve the display projection. Append a `session_boundary` marker to the
  end of existing history and continue with subsequent SDK output. Keep old logs and
  structured IA unchanged.
- `/clear` — **empty the pane display** for the agent. Drop all ordinary logs and IA
  bubbles without distinction, leaving one `session_boundary` marker. Hide the IA
  pane on the other agent using #106’s per-pane `ClearWatermarks`, but do not delete
  the durable ledger (`InterAgentHistory` DETS) (IA remains in the other agent’s
  pane). Do not delete the engine session file (JSONL/rollout); leave the old session
  resumable from the picker.

**Correction 2026-08-08:** The durable-ledger premise for the IA visibility cutoff
was superseded by [ADR-0051](0051-history-restart-resilience.md) D3-4.
`ClearWatermarks` compares against a server-assigned ingress stamp, and IA is
restored from the wrapper host sidecar into the per-pane projection. Remove the
server-side `InterAgentHistory` DETS.

Keep `server`-side `AgentStates` as the SSOT for the display projection. Do not merely
clear the client-local store, because reconnect would resurrect the deleted log.
On /clear completion, `SessionResets.confirm_connection/2` adopts the `{order, display}` returned by `SessionStarts.advance_transition/3` in
`ClearWatermarks.record/3` (the same form as operator `clear_history`’s
`adopt_session_start_watermark`), and reduce history to one marker line with
`AgentStates.clear_history_with_boundary/2`. Pass fsync-gated `ClearWatermarks`
first, leaving the watermark durable even on crash (the same policy as `M7-a`).

The marker carries `{mode, previous_session_id?, to_session_id?, request_id, ts}` in
the operator payload. Append `to_session_id` after the ID is known; permit temporary
null during lazy assignment. Add `clear_watermark` (ISO ts) only for `/clear` to the
`session_reset_completed` broadcast so a live client can update its watermark map
without waiting for reload. Restrict viewer notification to operators through
ADR-0021’s allow-list and do not leak payloads containing session IDs. Keep operator
`clear_history` (#48) and /clear as **separate features** (the former purges logs
from other sessions of the current session; the latter clears the agent’s entire
pane while retaining a marker), each with its current API.

### F4 — Keep only the latest SessionPointer; add explicit detach

Preserve the 1:1 latest-pointer contract in [ADR-0014](0014-session-resume-and-restore.md)
F3; do not add a pointer stack. After a successful fresh relaunch, explicitly detach
the old session ID in `SessionPointers` and update it to nil while retaining cwd /
engine. Current `record(..., nil)` has merge semantics that save the existing
session ID, so phase-17 adds a synchronous dedicated operation (`detach_session/1`,
etc.). When the fresh wrapper reports its new session ID, the normal record path
updates the latest pointer.

Resume the old session through the runner’s session enumeration under cwd and the
existing session picker / `resume_session`. Do not create a dedicated “go back one
step” stack. Keep ADR-0014 F2/F3/A4’s policy
of using host session files as candidate SSOT without duplicating history on the
server. A one-time shortcut from the completion toast to `previous_session_id` may
be added later, but treat it as a UI shortcut to existing `resume_session`, not a
pointer stack, and keep it out of the MVP.

After reset and before the first instruction, having no session ID assigned is
normal. Treat pointer=nil as “reset complete; fresh ID will be confirmed on the next
turn”; do not fall back implicitly to the old pointer.

### F5 — Prohibit engine branching through capability advertisement

Extend [ADR-0034](0034-session-capabilities-advertisement.md) F2 as follows:

```text
supports_session_reset: boolean
session_reset_modes: ("new" | "clear")[]  // supports=true時は必須・非空
```

Only when `supports_session_reset=false` may `session_reset_modes` be omitted. If
true but modes are missing or empty, reject the advertisement as invalid, fail
closed, and disable the UI. Reject this combination in adapter stamp tests too.

Stamp true only on sessions for which wrapper/runner/server provide F2’s fresh
relaunch and completion handshake. Unstamped/false fails closed: disable UI commands
and do not send typed exact commands to the engine; return
`unsupported_session_reset`. The dashboard does not decide from engine name.

`/new` and `/clear` are kaoiro-local commands distinct from the engine’s
`ext.slash_commands`, but merge into autocomplete candidates only when the
capability is true and the corresponding mode is listed. Thus, even if the engine
reports a same-named command, kaoiro-control semantics take priority and duplicate
display is avoided.

### F6 — Reject while busy; do not auto-interrupt or queue

Accept reset only in `idle` or `waiting_input`. Loudly reject `thinking`,
`tool_running`, `waiting_permission`, `waiting_question`, `sending`, and every
other executing state as `agent_busy`.

There is a need to reset an agent in `error` state to start over, but the MVP rejects
it like other non-idle states. Consider accepting reset from error after measuring
old-process / rollback semantics in a future extension.

Do not reset after an automatic interrupt. Combining tool-write interruption and
context destruction in one operation makes accidental impact too large. Do not
queue either: a reset delayed until a long turn finishes can cause the operator to
misidentify the destination of the next input. If needed, the operator explicitly
interrupts first, confirms return to `waiting_input`, and resends reset.

The server acquires the F2 pending lock together with state validation to prevent
TOCTOU with a new instruction. runner/wrapper also validate the reset request’s
generation/request ID and ignore stale completion.

**Addendum (2026-07-28, ADR-0043)**: When the agent itself requests an approved
reset, accept only a reservation during the tool call and fire it after that turn
completes. Do not change operator-originated busy rejection, no automatic interrupt,
or no queue.

### F7 — Make protocol events and failures the SSOT

Use this control-flow set:

```text
client -> server: session_reset {agent_id, mode}
server -> runner: reset_session {agent_id, mode, request_id}
runner -> server: session_reset_result {agent_id, mode, request_id, ok, reason?}
server -> clients: session_reset_started | session_reset_completed | session_reset_failed
```

While receiving `session_reset_started`, the UI displays “starting a new session”.
Do not add `starting_new_session` to the existing coarse `KaoiroState`; make the
server-owned lifecycle event and pending lock the SSOT. This keeps wrapper-process
replacement out of the engine state machine.

The server is the SSOT for the pending lock, AgentStates display change,
SessionPointers detach, and client broadcast. The runner is the SSOT for process
lifecycle, and wrapper/SDK session files are the SSOT for conversation history. Do
not duplicate the same history or pointer stack in each layer.

Return error reasons loudly from the closed vocabulary (`agent_busy`,
`unsupported_session_reset`, `session_reset_pending`, `runner_unavailable`,
`spawn_failed`, `rollback_failed`, `timeout`), and prohibit fallback to an engine
prompt or silent resume of the old session that pretends success. Also emit one
stderr line:
`[wrapper session] command=<mode> from=<id> to=<id|null> result=<ok|failed|rolled_back>`.

## Consequences

### Positive

- Start over with a CLI-equivalent conversation while keeping the same
  agent/persona/cwd.
- Keep Claude/Codex differences inside the runner’s fresh relaunch; the client sees
  only capabilities.
- After `/clear`, resume the old session from the picker without deleting the
  session file (JSONL/rollout). Reset only the agent’s pane display; hide the IA pane
  on the other agent per pane with a watermark.
- Busy operations are rejected immediately, with no delayed reset or implicit
  interrupt.

### Negative

- The control handshake spans every layer: client/server/runner/wrapper.
- Restarting the wrapper process during reset creates a short disconnected window.
- Add an explicit detach-to-nil operation to `SessionPointers`.
- If Codex lazily assigns its fresh thread ID until the first turn, boundary ID
  confirmation takes two stages.

### Neutral

- Keep only the latest pointer; continue enumerating old sessions through the runner.
- `/clear` does not delete the SDK session file. Complete deletion is out of this
  ADR’s scope.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| Interpret a slash when it matches the beginning of `user_message` in the wrapper | Mixes model-input and control responsibilities; literal text and attachment behavior would drift by adapter. |
| Intercept only in the client | Exact commands from old/external clients pass through to the engine; server defensive rejection is required. |
| Only null sessionId inside the adapter | Close to Codex but asymmetric with Claude’s long-lived query; hard to prove complete reset of queue/tool/pending state. |
| Delete host session files on `/clear` | Destructive and non-resumable, and difficult to infer from the name. Reset only the agent pane display and retain host session files (JSONL/rollout). |
| Store a previous-session stack on the server | Duplicates ADR-0014 F3/A4’s latest pointer + host-enumeration SSOT; the existing picker can go back. |
| Interrupt and reset while busy | A single click interrupts writes/tools and destroys context. Require explicit operator interrupt. |
| Queue reset while busy | Delayed destruction after execution completes is unpredictable, and the next input destination can be misidentified. |
| Stop disconnected after reset failure without restoring the old session | An atomic transaction can leave UI unchanged and the old session can safely resume while idle. Only a rollback failure should leave it disconnected. |
| Gather capabilities into one `lifecycle_commands` object | Display policy is fixed by mode at the protocol level. The ADR-0034 boolean + optional-modes pattern better reuses existing UI decisions and fail-closed semantics. |

## Implementation

[phase-17-session-lifecycle-commands](../plans/phase-17-session-lifecycle-commands.md)
implements this.

### Handling measurement items (phase-17 chunk γ, 2026-07-12)

The behavior around F2’s “completion only after confirming fresh-wrapper connection”
and Codex’s lazy thread-ID assignment was incorporated in the following form as an
**implementation assumption** during γ (17-5/6). Measure it on real hardware by
having the operator perform `/new` / `/clear` after δ (17-7/8/9) adds Composer
intercept and boundary UI, then add findings to this ADR if needed.

- **Codex thread-ID confirmation timing**: runner `session_reset_result` makes
  `to_session_id` optional / nullable, and Codex sends `null` at fresh spawn. The
  server (`SessionResets`) includes `SessionResetCompleted.to_session_id` as `null`
  in `broadcast_completed`. When the first envelope from the fresh session reports
  session_id, the existing `SessionPointers.record` path updates the latest pointer
  naturally. Add a follow-up patch to the marker (δ 17-7’s `AgentStates` boundary
  marker `to_session_id`) in the UI implementation by hooking the first fresh-side
  envelope.
- **Consecutive generation in one process**: the runner supervisor kills the child
  and fresh-spawns it on every reset (a separate process). Do not switch
  `startThread()` → `resumeThread()` in one process in this ADR (F2 integrates
  adapter differences through fresh relaunch). If measurement shows that in-process
  switching is sufficiently isolated, it can reduce cost later; at γ it is
  unverified and rejected.
- **Old-event isolation**: guarantee it with three layers. (a) runner supervisor
  child kill stops the old wrapper process (old rollout / tool response / permission
  requests cannot reach the fresh process); (b) the wrapper stamps session_id in the
  envelope, so server `AgentStates` deduplicates on latest session_id; (c) server
  `SessionResets` silently drops request_id / phase-mismatched resolve / confirm
  (F7). If one layer breaks, the other two defend. Do not add a runner-side
  generation counter; process-layer kill is the primary defence.

### F2 connection-confirmation responsibility (chunk γ two-phase completion)

Introduce `phase: :spawning | :awaiting_connect` in `SessionResets`. Runner
`session_reset_result { ok=true }` only transitions to `:awaiting_connect` (does
not broadcast); `session_reset_completed` is emitted through
`SessionResets.confirm_connection/2` from the fresh wrapper’s
`WrapperChannel.after_join`. The 60-second timeout covers both the spawn phase
(runner ok not received) and connection phase (wrapper join not confirmed), so a
stall in either phase becomes `session_reset_failed { reason: "timeout" }`. This
two-phase implementation takes F2’s wording “completion only after confirming fresh
wrapper connection” literally and explicitly avoids the approximate implementation
that treats `runner.ok=true` as completion (which could falsely report completed if
the wrapper dies immediately after fresh spawn).
