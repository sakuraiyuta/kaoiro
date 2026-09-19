---
title: Session lifecycle contract
status: accepted
last_updated: 2026-09-19
description: Planned wrapper disconnect/reconnect cycles, session visibility semantics, resume/restore, and identity fields.
---

# Session lifecycle

### Planned wrapper cycle (issue #256)

The server reserves an in-memory `PlannedDisconnects` intent immediately before sending the
runner command on only three paths: operator or agent-self `session_reset`, live
`resume_session` (`switch_session`), and operator `restart` for a live agent. Each agent has
one `{transition_id, kind, phase, timer, targets}` entry. `targets` is the union of the
disconnect-time snapshot and senders bounced with `peer_reconnecting` during the planned
window. One target is a `{conversation_id, peer_id}` pair for one synthetic envelope; the
union is capped at 50. Conflicting lifecycle operations are rejected as `agent_busy`. A
reset that fails between intent allocation and runner send silently cancels the matching
`SessionResets` lock.

An owner-checked wrapper terminate advances the phase `announced → disconnected`, takes a
read-only snapshot of open-conversation peers, and sends IA `error.code=reconnecting`.
Tracked bounces take priority and only remaining slots are filled from the snapshot; skipped
pairs are recorded with their count and targets in a warning. In either phase, only a later
join whose non-empty `transition_id` exactly matches closes the intent and sends an error-free
`reconnected` inform to the same target union. The text says only that the peer is reachable,
not that a physical reconnection occurred; a mismatched token is never a return.
On intent timeout or terminal failure, if `AgentStates` is still `disconnected`, send
`error.code=disconnected` to the entire target union regardless of prior ordinary marks.
If an old or rollback wrapper is live, close the planned window with `reconnected` to the
same union instead of silently leaving bounced senders. `spawn_failed` means the rollback
wrapper started successfully, so keep the intent until a matching rollback join or timeout,
separate from issue #248 failure notification and connectivity; `rollback_failed` closes it
terminally.

IA to an active planned target is bounced as `peer_reconnecting` in preflight, before
ConversationStates, panes, or the delivery ledger. Active detection and adding
`{conversation_id, sender}` to the target union are atomic in one GenServer call; no bounce
is returned before recording the target. A registered pair consumes no new slot. After 50
slots, a new pair is rejected as `peer_reconnecting_capacity` without changing state and
does not promise a close notice. The wrapper reports a terminal `isError=true` tool failure:
the message was not accepted, no close notice will arrive for this attempt, and it may be
resent later with the same `conversation_id`. The common wrapper layer maps only admitted
`peer_reconnecting` to structured `peer_error.code=reconnecting` and waits for `reconnected`
without escalating; delivery gaps outside the planned window are issue #257.

Planned terminals mark and deliver only the bounded target union and never claim ordinary
targets later. Ordinary claims for unexpected disconnect retain the 50-conversation cap;
conflicts outside the planned window are issue #257.

Operator `stop` does not start a planned cycle and is not blocked by an active intent as
`agent_busy`. After role, size, and host-ownership guards it cancels the active intent,
sends terminal `disconnected` to its target union, then relays stop. Stop/restart first
validate `AgentId.host_id_from(agent_id) == host_id` before any intent mutation and reject a
mismatch as `agent_not_owned`; ordinary unexpected-disconnect claim rules are unchanged.

**Permission flow**: On `canUseTool`, the wrapper sets `state_change.ext.pending_permission`
and sends a compatibility `permission_request` envelope (the type table above), keeping the
Promise pending until `permission_decision`. The ext field remains authoritative, so it
survives intervening `state_change` events (thinking, tool_running, or session-init idle)
([ADR-0022](../../adr/0022-pending-permission-authoritative-source.md)).
No response means **wait indefinitely** by default, matching the SDK (no timeout; finite
timeouts are wrapper opt-in, with configuration in issue #60). A deny still keeps the
session alive. The server only relays instruction and approval **without interpreting their
contents**, remaining agent-independent. Delivery is not guaranteed: relay to a disconnected
wrapper is lost and the requester restores `ext.pending_permission` from the next join snapshot.

**Reconnect resynchronization**: After disconnect, the client simply rejoins the channel;
`snapshot` / `task_snapshot` / `delivery_snapshot` resynchronize all projections. The three
frames replace independently, and join start clears all three previous projections. If the
connection breaks midway, old and new generations are not mixed; only the received prefix is
shown. No diff tracking or resend request is needed (last-write-wins per agent_id). Ordering
and de-duplication use `seq` ([ADR-0011](../../adr/0011-phase3-reliability-and-auth.md)).
At join, the latest state and recent reply-log history (the server's **in-memory ring buffer**,
[ADR-0012](../../adr/0012-response-display-and-dashboard-scope.md)) are sent, restoring logs on
reload/reconnect. History is memory-only, but after a server restart the wrapper hydration
handshake rebuilds it automatically (see "Projection hydration and restart resilience",
[ADR-0051](../../adr/0051-history-restart-resilience.md); server-side disk persistence issue #24
remains rejected). The **source of truth for reply history is the wrapper host's composite
SSOT** (engine transcript + IA sidecar); the ring buffer is a rebuildable projection. During
replay, the wrapper reads the session transcript directly, maps `user`/`assistant` rows to
`log` envelopes and the IA sidecar to `replay_ia`, then overwrites server display history via
`history_reset` → replay ([ADR-0014](../../adr/0014-session-resume-and-restore.md) phase-2, #50).
The direct read is required because the SDK does not re-yield prior history into the
`query()` stream on resume.

#### Projection hydration and restart resilience ([ADR-0051](../../adr/0051-history-restart-resilience.md))

- **Hydration verdict**: The wrapper channel **join response** contains
  `hydration: { replay_required: boolean, replay_id? }`. The server decides from the
  per-boot volatile AgentStates status (`unhydrated` / `in_flight(replay_id, channel_owner)` /
  `hydrated`) and returns a server-generated `replay_id` when required. The wrapper starts
  replay only after the verdict and uses that ID consistently for `history_reset`, `replay_ia`,
  and `history_replay_complete`. Only an absent verdict (old server) falls back to legacy
  startup replay with a wrapper-generated ID. There is no dedicated S→W event: reconnect is
  a new join and the verdict always arrives in the join response.
- **Completion and retry**: `history_replay_complete` performs the CAS transition (see the
  event table). If the channel disconnects while `in_flight`, return to `unhydrated` and ask
  again on the next join. A fresh session (no session ID or transcript) uses an empty replay
  (`history_reset` followed immediately by complete).
- **Invalidating hydrated state**: The server discards hydration only for operator-initiated
  transitions carrying `resume_session_id` (`restore` resume branch or `resume_session`) and
  sets the next verdict to `replay_required: true`. `/new`, `/clear`, fresh restore, and a
  runner-autonomous crash restart do not invalidate it. See [ADR-0051](../../adr/0051-history-restart-resilience.md) D2.
- **Ingress-stamp wire shape**: The server ingress-order tuple is encoded in JSON as the
  **two-integer array `[us, seq]`**. The same shape is used by top-level envelope
  `ingress_stamp`, acceptance-ack replies, wrapper sidecar rows, and `replay_ia` items.
  Receivers strictly validate two integers and discard out-of-shape values fail-closed.
- **Projection epoch**: Join `history` push payloads carry `projection_epoch`, an opaque UUID
  assigned at AgentStates initialization. On mismatch, the client discards its old baseline
  (display logs, clearWatermarks, replay markers, unread state) and merges only authoritative
  history with live envelopes received on this connection. Matching epochs retain the old
  merge; absent (old server) falls back to legacy behavior ([ADR-0051](../../adr/0051-history-restart-resilience.md) D4).
  The live-buffer window runs only from each connection-generation join until that connection's
  first `history` push. Each new join drops the prior buffer and replay marker; live envelopes
  after the window closes are not buffered, preventing disconnected rows from reappearing on
  the next epoch mismatch (Fujino 30-10 must-fix M1).
- **`replay_ia` batch boundary**: The wrapper splits each push to **1,000,000 JSON bytes** or
  less and sends all chunks for one `replay_id` before `history_replay_complete`. A sidecar row
  that cannot fit alone is dropped fail-closed; otherwise Phoenix rejects the frame, complete
  never arrives, and every join resends the same row (Fujino 30-10 must-fix M4 / round-two should).
- **Per-pane projection contract**: Live IA display and replay restoration use the same per-pane
  upsert API. Live acceptance is ordered as validate (including every check that can reject,
  such as participant/quota) → assign ingress stamp → upsert both sender and receiver panes →
  push to the peer. See [directory event contracts](../inter-agent/directory.md#event-contracts).

### Session visibility semantics (#106 / ADR-0036 F3 restoration, 2026-07-24)

`/new` and an external session switch only fsync their start point in `SessionStarts`; they
do not change log/IA display or `ClearWatermarks`. In addition to its SessionStarts record,
`/clear` makes `SessionResets.confirm_connection/2` adopt `{order, display}` via
`ClearWatermarks.record/3` and reduces that agent's `AgentStates` history to one marker row.
The peer pane hides IA through a per-pane `ClearWatermarks` filter, comparing the cutoff
with the ingress stamp persisted on IA ([ADR-0051](../../adr/0051-history-restart-resilience.md)
D3-4). The durable `InterAgentHistory` DETS ledger was removed by that ADR; the wrapper
host's IA sidecar is authoritative. Operator `clear_history` (#48) remains a separate API
that broadcasts `history_cleared` to purge logs from other sessions of the current session.

Live clients update `/clear` from `session_reset_completed.clear_watermark`; the reload
path uses server-side `merged_histories` as SSOT. Neither `/new` nor `/clear` broadcasts
`history_reset` (resume replay only). Without a start point, operator `clear_history` warns,
leaves the watermark unchanged, and retains IA (never fall back to deleting current-session
IA). Existing `ClearWatermarks` DETS rows survive migration so hidden IA is not exposed
again; pre-M6 ISO-only rows remain until the next real clear.

### Session resume and restoration

See [Session ownership and continuity](../../architecture/system-overview.md#session-ownership-and-continuity)
for why wrapper restoration and recalling an existing session use one resume mechanism.

This adds resume mode to issue #22's `client -> server -> runner (boot service) -> wrapper`
path. Restore commands (spawn-with-resume) and session enumeration are defined with the
issue #22 runner specification ([ADR-0023](../../adr/0023-host-runner-architecture.md)) and
settled in the runner table below ([#66](https://github.com/sakuraiyuta/kaoiro/issues/66)).
The earlier phase-0 protocol change only added top-level `session_id` to the envelope; the
wrapper reports it and the server stores the `(agent_id, host, cwd, session_id)` pointer.

### Identity and persona (must)

 - `agent_id` is a stable ID fixed in configuration; do not use volatile runtime IDs.
 - `session_id` identifies an SDK conversation and is independent of agent_id (one agent to
   many sessions). The server keeps only the last session_id per agent as the default resume
   target; the host runner enumerates all candidates ([ADR-0014](../../adr/0014-session-resume-and-restore.md)).
 - `persona` (ID, display name, sprite) is selected by wrapper initial configuration; the user
   assigns personas to hosts/processes.
 - Server and client persist display and mood keyed by `agent_id` (and `persona.id`).
 - Details are in [ADR-0003](../../adr/0003-persona-identity-persistence.md); future rendering
   kinds (static diff, animation, 3D) may be added to `persona` ([ADR-0004](../../adr/0004-client-rendering-staged.md)).

## Related protocol topics

- [Envelope contract](envelope.md).
- [State machine](state-machine.md).
- [Model and effort state](model-effort.md).
- [Attachment wire contract](attachments.md).
- [Attachment rendering by engine](../engines/attachment-rendering.md).
- [Message topology](../../architecture/message-topology.md).
