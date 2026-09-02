---
title: Restart-resilient display history — reconnect replay, IA sidecar, and epoch replacement
status: accepted
date: 2026-08-08
opened: 2026-08-08
supersedes: []
superseded_by: null
related_specs: [protocol, protocol-inter-agent, architecture, deployment]
related_adrs: [12, 14, 30, 36]
---

# ADR-0051 — Restart-resilient display history — reconnect replay, IA sidecar, and epoch replacement

## Status

Accepted (2026-08-08. All 10 must-fix items from ふじ's two specification-review
rounds were incorporated and approved; final approval by マスター)

## Context

### Observation from dogfooding (2026-08-08)

After the server's Docker container restarts, displays become inconsistent
between operator terminals:

- A dashboard tab that stayed open from before the restart continues to show
  pre-restart logs that no longer exist on the server (ghost display), because
  the client-side merge (`projectAndMergeHistory`) preserves the local
  buffer.
- A newly opened tab is nearly empty (because the volatile ring buffer was
  lost).
- Recent work logs do not return to any terminal unless the wrapper is started
  in resume mode.

### Clarified requirements (マスター decision, 2026-08-08)

- Every operator terminal must show the same screen and logs.
- An F5 reload must restore the display, including the operator's own sends,
  agent replies, and IA messages.
- The above must hold across a server restart.
- At the same time, durable state held by the server must be reduced as far as
  possible. The source of truth for history belongs on the wrapper host
  (engine transcript + the IA sidecar introduced by this ADR).

The current specification ([ADR-0014](0014-session-resume-and-restore.md) A4)
largely satisfies these requirements while the server is running, but
restart resilience was out of scope. Server-side persistence of all history
([#24](https://github.com/sakuraiyuta/kaoiro/issues/24)) remains rejected and
is not changed by this ADR.

### Correction of description drift

ADR-0014 states that `inter_agent_message` cannot derive routing metadata
back from formatted user text injected into the SDK and cannot be reconstructed
from JSONL, and made server-side DETS-backed `InterAgentHistory` the
source of truth on that basis (issue #102). In the current implementation, the
inbound framing injected on the receiving side contains
`conversation_id` / `turn_number` / kind / sender / body in full
(via `formatInboundMessage`), so “cannot derive back” has drifted from
the implementation. However, using display/model-facing text parsing itself as
the restoration mechanism is brittle (format changes can make past history
unreadable and can cause misparsing), so it is not adopted (see Alternatives).

## Decision

### D1 — The wrapper host's composite SSOT is the source of truth (A4 extension)

The source of truth for conversation history is a **composite SSOT** on the wrapper
host:

- Normal transcript: the engine transcript (Claude Code =
  `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, Codex =
  rollout file).
- Structured IA: the **IA sidecar** colocated with the engine transcript (D3).

The server's display history remains a “volatile projection that can be
discarded and reconstructed from the wrapper host”. Issue #24 (durable server
persistence of all history) remains rejected. Durable state on the server is
minimized — this ADR removes `InterAgentHistory` DETS (D3) and adds no
durable display state (`ClearWatermarks` remains as-is; see D3-4).

### D2 — Replay is server-led through a hydration handshake

The server manages the **hydration state** of each agent within the projection
lifecycle (in AgentStates, volatile on every boot) and uses it as the basis for
requesting replay. “The display history has zero entries” is not used as a
trigger — after a partial replay (a few entries sent after reset followed by a
disconnect), a nonzero count could incorrectly establish completion and lose the
rest.

- **States**: Each agent has `unhydrated` /
  `in_flight(replay_id, channel_owner)` / `hydrated`. All agents
  start as `unhydrated` on boot.
- **Join handshake**: In the wrapper channel join response (or a hydration
  control immediately after join), the server determines and returns **whether
  replay is required + a server-assigned `replay_id`**. A wrapper
  connecting to a new server starts replay only after receiving this verdict
  (it does not perform the current unconditional startup replay against a new
  server — “unconditional startup replay” and “no unnecessary replay when
  hydrated” cannot both be achieved when the wrapper cannot know beforehand
  whether replay is required).
  - `required: false` (hydrated) → do not replay. A wrapper's prior
    knowledge is not needed to ensure that ordinary reconnection while the
    server is alive does not trigger unnecessary replay.
  - `required: true` → use the returned `replay_id`
    **consistently** in `history_reset` / `replay_ia` /
    `history_replay_complete`. Dashboard reset/complete pairing and
    the server's hydration transition refer to the same ID, leaving no race
    from ID ambiguity.
- **Legacy fallback**: Only when the join response has no verdict (old server,
  capability absent), the wrapper performs startup replay with a
  wrapper-assigned ID as before.
- **Completion transition is CAS**: Transition to `hydrated` only when
  the replay_id and channel owner in
  `history_replay_complete` match the `in_flight` record. If the
  channel for that owner disconnects while `in_flight`, return to
  `unhydrated` and request replay again on reconnection. Termination or
  completion from a stale old connection is ignored by CAS and cannot roll back
  the new connection's attempt.
- **Fresh session**: If no session_id has been assigned or no transcript
  exists, the wrapper responds with an empty replay
  (`history_reset` → immediate `history_replay_complete`), allowing
  the server to reach `hydrated`.
- **Wrapper-side single-flight**: Run only one attempt; if another request
  arrives while it is running, respond when the running attempt completes.
- **Conditions that invalidate hydrated** (2026-08-08 addendum, あお Q1;
  a gap in the initial version): The server explicitly invalidates hydration
  **only for an operator-originated transition carrying
  resume_session_id** (the binary session_id branch of restore,
  the live switch of resume_session, or disconnected resume), and
  requests replay at the next join. Do not invalidate for `/new`,
  `/clear`, or fresh restore, because invalidation there would make the
  empty-replay `history_reset` break the display retention / marker
  behavior of ADR-0036 F3. Do not invalidate for crash-restart (runner-autonomous
  relaunch without going through the server) either, because the same session
  continues and the projection is already populated.

Replay covers only the current session. Reconstructing past sessions (before
`/new` or `/clear`) is out of scope (an accepted constraint, D7).
Both engines already have transcript replay implementations
(`wrapper/claude-code/src/history.ts` /
`wrapper/codex/src/history.ts` + `rollout.ts`).

### D3 — Remove `InterAgentHistory` DETS through an IA sidecar

#### D3-1 Per-pane projection contract (shared by live and replay)

Unify the server's volatile IA projection into a **per-pane projection/upsert
API**, with live ingress (normal IA accept) and replay ingress
(`replay_ia` from D3-3) sharing the same contract. After DETS removal,
this projection handles both live display and F5 restoration (replacing the
current “AgentStates sender history + DETS fan-out” structure).

- **At live accept**: The server processes validate → **assign an ingress
  stamp** → upsert the sender pane + receiver pane with the same stamp →
  routing (peer push), in that order (stamp assignment and projection update
  occur **before** the peer push from `route_inter_agent`; this causal order
  is fixed by the spec). Validation includes routing preflight such as
  participant / quota checks, and **every check that can establish rejection**
  occurs before projection upsert. Routing after upsert is only peer push; the
  protocol wording (30-2) and server test pin that rejected IA does not remain
  in a pane (a non-blocking note from ふじ's second-round approval).
- A server-synthesized envelope (an error notification sent directly by the
  server with `agent_id: "server"`) is upserted only into the recipient
  pane.
- The clear filter (D3-4) and final pane cap (D6) are also applied along this
  path, so live and replay cannot diverge.
- **Upsert identity is `ingress_stamp|pane_agent_id`**. The sender and
  receiver copies of the same IA share a stamp and differ only in pane. Replay
  retry is idempotent as an upsert to the same key. Do not use
  `conversation_id|turn_number` as identity — a server-synthesized
  notification always has turn_number=0 and can occur multiple times in
  the same conversation and pane, causing collisions (see Alternatives).

#### D3-2 Recording (append to sidecar)

The wrapper appends the structured `inter_agent_message` envelope to a local
sidecar file together with the ingress stamp assigned by the server (in the same
directory as the engine transcript, roughly `<session-id>.ia.jsonl`; the
exact path and schema are finalized in the protocol-inter-agent revision).

- **Receiving pane**: Append when the delivery from the server is received
  (before SDK injection). The delivered envelope carries the stamp assigned in
  D3-1. It is acceptable for a phantom to remain only in the sidecar if
  injection fails (it records the fact that delivery occurred). A
  server-synthesized envelope is recorded the same way on the receiving side.
- **Sending pane**: Record on the **transport (Phoenix push) acceptance ack**.
  After validate → stamp assignment → per-pane projection update → routing
  accept, the server returns `{ingress_stamp}` as the reply to that
  push, and the wrapper appends **when the ack arrives**. Do not use the MCP
  tool result (`send_to_agent`'s response) as the server ack — the
  current tool result is a locally generated string, and with
  `wait_for_response=true` it does not return until the peer replies or
  times out, so delaying the append that long can cross a session generation
  (ふじ's second-round must-fix 3). Waiting for the peer reply in MCP remains a
  separate promise. On reject / timeout / lost ack, do not record in the sidecar;
  show that fact in the tool result (loss is accepted and exposed with a stderr
  warning).
- Skip a corrupt or truncated final row and emit a stderr warning (fail-soft).
  fsync is not required. Fix the sidecar path to the transcript directory,
  sanitize session_id, and do not follow symlinks.

#### D3-3 Restoration (replay-only ingress)

Restore the sidecar through a **display-replay-only W→S ingress**, and do not
use the normal `envelope` path. The normal path causes another push to the
destination wrapper through `route_inter_agent` → SDK reinjection, which
would rerun the conversation rather than restore history. It also cannot send an
envelope saved by the receiving side under the sender identity because of the
`agent_id != topic` guard.

- A new message (the name is finalized in the protocol revision; for example,
  `replay_ia`) carries
  `{pane_agent_id, original_envelope,
  ingress_stamp, replay_id}` in the replay stream. `replay_id` is the
  server-assigned ID from D2.
- After verifying that the wrapper for the topic owns the pane, the server
  upserts through the D3-1 projection contract: it does not touch routing,
  ConversationStates, peer-wrapper push, or SDK injection at all.
- **Pane ownership**: Each wrapper restores only its pane-local view from its
  own sidecar (the sender pane from the sender's sidecar, the receiver pane from
  the receiver's sidecar). One pane can recover independently while the other
  is offline. Duplication from both sides holding the same IA is prevented by
  the `ingress_stamp|pane_agent_id` upsert.
- The same upsert replaces the projection during a resume (reset → replay)
  while the server is alive. Accordingly, `preserve_inter_agent` in
  `history_reset` is **retired as a semantic**, but the wire field is
  explicitly sent as `false` during the compatibility period — old
  dashboards interpret omission as `true`, so simply deleting it would
  leave old IA in place after reset on a new server (see D6 rollout; physically
  removing the field is a later phase after old client tabs are gone).

#### D3-4 Consistency with the clear boundary (ingress stamp)

The IA visibility cutoff for `/clear` and `clear_history` is
determined in the server's ingress-order domain as specified by F3 of
[ADR-0036](0036-session-lifecycle-commands.md). Assigning a new ingress order
when re-ingesting a sidecar would resurrect IA that has already been cleared,
so:

- The ingress stamp is assigned at live accept as in D3-1 and is a value from a
  durable, globally unique ingress-order domain. The wrapper stores it
  verbatim and returns it unchanged during replay.
- During replay ingestion, the server compares the saved stamp with durable
  `ClearWatermarks` (the existing DETS, retained) and applies per-pane
  hiding.
- A row without a stamp (legacy / corrupt) is **discarded fail-closed**. Falling
  back to comparing the wrapper clock's `ts` would reintroduce the
  clock-skew problem and is forbidden.

#### D3-5 Session lifecycle (unassigned period, /new,
/clear, and deletion)

- **Period before session_id assignment**: A fresh wrapper has no
  session_id until its first turn, and IA can arrive during that
  period. Append to a **pending journal** during this period, then bind
  (rename) it to that session's sidecar once session_id is confirmed.
  Namespace the pending journal by **`{agent_id, reset_generation}`** so
  concurrent fresh wrappers and rollbacks in the same cwd cannot collide (the
  exact path is finalized in the spec). An orphan journal that crashes before
  binding is not replayed and is GC'd at the next startup (fail-closed).
- **`/new` and `/clear`**: Immediately stop appending to the old
  generation and switch to a new generation (the next pending journal → new
  session sidecar). Return to the old generation only during reset rollback.
- **Agent deletion**: Purging the server-side store does not remove transcripts
  or sidecars from the wrapper host. As with engine transcripts, explicitly state
  that “host-local artifacts remain” (consistent with ADR-0030 deletion semantics).
- Do not migrate existing `InterAgentHistory` DETS data; discard it
  (accepted under the dogfooding premise). Abolish cross-session restoration of IA
  history and unify it with other history as “current session only”. This is an
  **intentional regression** from the current behavior (consistent with D7 (b)).

### D4 — Client resynchronization through a projection epoch (ghost fix)

- **Epoch source**: Assign an opaque UUID-like value when AgentStates is
  initialized (**bound to the projection lifecycle**). It changes not only on
  container restart but also when AgentStates itself crashes, so there is no
  false claim that the projection was lost while the epoch stayed the same
  (the limitation is D7 (d)). Do not use a sequential value or timestamp that
  could collide across restarts.
- **Client algorithm** (do not make this a simple replacement — it would drop
  valid live envelopes delivered to the new connection immediately after join
  and before the history push):
  1. From join onward, buffer **live envelopes received on this connection**
     separately from the old baseline.
  2. If the epoch in the `history` push differs from the retained value,
     discard the old baseline (enumerate all derived history state: display logs,
     clearWatermarks, resume replay markers, unread/new markers, etc.) and merge
     only authoritative history + the new-connection buffer.
  3. If the epoch matches, merge as before (`mergeHistories`).
  4. If the epoch is absent (old server), fall back to the old behavior (ghosts
     remain, but compatibility is preserved).

### D5 — Separate process restoration from display restoration

- **Restoring the agent process** (resume-spawn) remains explicit operator action
  ([ADR-0030](0030-agent-directory-and-explicit-restore.md) / issue #41).
- **Restoring the display projection** is automatic (D2). When the wrapper is
  alive and reconnects, the timeline returns without operator action.
- History for an offline agent (wrapper stopped) remains empty until the resume
  action. Since the tile shows offline, there is no UX contradiction; wanting to
  see the history effectively coincides with wanting to “restore and continue”.

### D6 — Unified cap and rollout

- **Cap**: Set the display-history cap to the newest 200 envelopes in the
  **final projection** after the server merges transcript rows and IA
  chronologically, deduplicates, and filters them per pane. Even if the sources
  provide transcript 200 + sidecar 200, do not produce a combined 400. Apply
  the same cap to the receiver pane. Remove the IA cap exemption (issue #102).
- **Rollout**: The change spans three layers — server / wrapper / client
  (eight combinations) — and **deployment order is not arbitrary**. Main
  degradation modes during a mixed rollout: a new wrapper + old server has no
  stamp in its ack and cannot record to the sidecar (IA in this window cannot
  be restored); a new server (DETS removed) + old wrapper has no sidecar and
  therefore worse durability than today; an old client misbehaves according to
  its interpretation of the epoch and omitted `preserve_inter_agent`.
- This phase adopts an **atomic maintenance rollout** on the dogfooding premise.
  Fix these operational conditions:
  1. Send no IA during the maintenance window (stop all agents, then update
     server / wrapper / dashboard together).
  2. Reload every dashboard tab after the update (leave no old JS tab).
  3. Explicitly send `preserve_inter_agent` `false` during the compatibility
     period as in D3-3; physically remove it in a later phase.
- If a staged rollout becomes necessary (future long-term multi-host operation),
  use this reference sequence: (1) compatible server (add stamp/ack/hydration/
  `replay_ia` + temporary DETS dual-write) → (2) update wrappers
  (start sidecars) → (3) update clients → (4) confirm no old wrappers remain,
  then remove DETS on the final server. Do not implement this in the current
  phase.

### D7 — Accepted constraints (explicit)

- (a) History for an offline agent is not displayed until the resume action.
- (b) Only the current session is restored after a restart. IA is the same
  (cross-session restoration abolished, D3-5).
- (c) The timeline is blank for the few seconds from server restart until
  wrapper reconnection + replay completion.
- (d) An AgentStates-only crash (the root supervisor is one_for_one) does
  not guarantee full recovery: the epoch changes, but an existing dashboard
  connection receives no history push, so **ghosts may remain until the next
  reconnect / F5**. Rehydration of the wrapper is also delayed until the next
  wrapper join. The “no stale merge” guarantee applies only to clients that join
  after the epoch changes. Full recovery targets container / server process
  restarts.
- (e) Sidecar recording durability is as in D3-2 (accept loss when the sender's
  ack is lost and a phantom when receiving-side injection fails; no fsync).
- (f) Rollout depends on the atomic maintenance operating conditions in D6.

### D8 — Protocol and existing-document amendments

The protocol additions and changes are these five points:

1. Replay requirement + server-assigned `replay_id` in the wrapper
   channel join response (or hydration control) (D2).
2. W→S replay-only IA ingress (`replay_ia` provisional, D3-3).
3. Ingress stamp: attach it to delivered envelopes and return it in the sender
   acceptance ack (Phoenix push reply) (D3-1 / D3-2).
4. Projection epoch in the `history` push (D4).
5. `preserve_inter_agent` in `history_reset`: semantic retired;
   explicitly send `false` during the compatibility period (D3-3).

Existing documents to amend:

- [ADR-0014](0014-session-resume-and-restore.md) A4's IA “cannot derive
  back” description and the issue #102 addendum (add a reference to this ADR).
- [ADR-0036](0036-session-lifecycle-commands.md) F3 (replace the DETS-ledger
  premise for the IA visibility cutoff with the sidecar + stamp approach).
- [protocol](../specs/protocol.md): the
  `preserve_inter_agent` / `InterAgentHistory` descriptions and the
  purge-store count for `delete_agent`.
- [ADR-0030](0030-agent-directory-and-explicit-restore.md) D6's store-count
  description (already drifted; synchronize it with the current state here).
- [deployment](../specs/deployment.md): eight DETS paths → seven.

## Consequences

### Positive

- Across a server restart, a live agent's timeline is restored without
  operator action. Identical display on every operator terminal and full F5
  restoration are achieved.
- The server's durable state is reduced (`InterAgentHistory` DETS removed).
- Ghost displays in stale tabs are eliminated (D4).
- Live and replay use the same per-pane projection contract, removing the
  display-path split (the current dual structure of sender history + DETS
  fan-out).
- The principle “source of truth on the wrapper host, projection on the server”
  is consistently applied without exception as a composite SSOT.

### Negative

- IA history across sessions regresses from the current behavior (D3-5,
  intentional).
- The wrapper gains implementation for sidecar recording, reading, and
  generation management (which can be shared in agent-common).
- There are five protocol additions/changes, and rollout depends on the
  operational condition of atomic maintenance (D6).
- The blank period immediately after restart (D7 (c)).

### Neutral

- The transcript replay path and dedup boundary
  (`history_reset` /
  `history_replay_complete`) reuse existing mechanisms.
- Impact on the threat model is minor: the hydration verdict discloses no new
  information from S→W, `replay_ia` updates only the projection after
  pane-ownership verification, and the sidecar is host-local (the same
  responsibility boundary as the transcript, T1). The operator-only delivery
  restriction for IA metadata (T2) is unchanged.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| Option A: Make display history durable on the server (re-open #24) | A transcript copy becomes a second source of truth, introducing drift-consistency problems with /clear, cap, and replay. The only advantages are “immediate display of offline-agent history” and “retention of past sessions”, which do not justify the consistency cost of two sources of truth |
| Option C: Keep the current behavior + fix ghosts only | History loss after a restart remains, failing the マスター requirement for identical display on all terminals across restarts |
| B-1: Restore IA by parsing injected framing text | Permanently accepts the fragility of treating display/model-facing text as a serialization format (past history becomes unreadable after format changes; misparsing; engine-specific tool_use shape differences) |
| Keep IA DETS | Implementation cost is zero, but it leaves an exception to the “minimize server state” principle. The sidecar cost (small to medium) removes that exception, so DETS is removed |
| Replay IA through the normal `envelope` path | `route_inter_agent` pushes again to the destination wrapper → SDK reinjection, so history restoration becomes conversation rerun. It also conflicts with the `agent_id != topic` guard (ふじ's first-round must-fix 1) |
| Replay trigger = “display history has zero entries” | After a partial replay and disconnect, a nonzero count can incorrectly establish completion and permanently lose entries (ふじ's first-round must-fix 2) |
| Retain unconditional startup replay (no join verdict) | Cannot coexist with “no unnecessary replay when hydrated”; pairing between the wrapper-assigned ID and server-assigned ID remains ambiguous and leaves a race (ふじ's second-round must-fix 2) |
| Use the MCP tool result as the sending-side sidecar's server ack | The tool result is a locally generated string and, with `wait_for_response=true`, does not return until the peer replies; appending can cross a session generation (ふじ's second-round must-fix 3) |
| Dedup identity = conversation_id|turn_number|pane | Server-synthesized notifications always have fixed turn_number=0 and collide when repeated in the same conversation and pane (ふじ's second-round must-fix 4) |
| Immediately delete the `preserve_inter_agent` field | Old dashboards interpret omission as `true`, so old IA remains after reset on a new server (ふじ's second-round must-fix 5) |
| Determine the clear boundary by comparing the wrapper's `ts` | Reintroduces the already-resolved clock-skew problem (ふじ's first-round must-fix 3) |
| Simply discard all local state on epoch mismatch | Also loses valid live envelopes delivered to the new connection before history arrives (ふじ's first-round must-fix 4) |

## Related

- Specs / ADRs to amend: see D8.
- Implementation plan: [phase-30](../plans/phase-30-history-restart-resilience.md).
- Related issues:
  [#24](https://github.com/sakuraiyuta/kaoiro/issues/24)
  (remains rejected),
  [#41](https://github.com/sakuraiyuta/kaoiro/issues/41)
  (explicit restore, unchanged),
  [#50](https://github.com/sakuraiyuta/kaoiro/issues/50)
  (replay path),
  [#102](https://github.com/sakuraiyuta/kaoiro/issues/102)
  (IA DETS, removed by this ADR).
- Specification review: ふじ, first and second rounds, 2026-08-08 (conversation
  0b5c31a4).
