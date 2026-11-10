---
title: Rooms with single membership and a server-side send boundary
status: accepted
date: 2026-11-10
opened: 2026-11-10
supersedes: []
superseded_by: null
related_specs: [rooms, conversations, directory]
related_adrs: [30, 50, 68, 73]
---

# ADR-0072 — Rooms with single membership and a server-side send boundary

## Context

Agents working on unrelated tasks shared one flat space: any agent could
message any other, and a mistaken `to` reached another team.
[Issue #537](https://github.com/sakuraiyuta/kaoiro/issues/537) asks for rooms
that group agents, limit sending to the same room, and are managed by the
operator. A room kept only in the dashboard or the wrapper would not bind
the send path, which the server decides. This record covers Phase 0;
agent-initiated move requests and room selection at launch are later phases.

## Decision

1. **Single membership, persisted on its own.** `KaoiroServer.Rooms` holds
   rooms and one room per `agent_id` as a single DETS record. It is separate
   from the identity ledger ([ADR-0030](0030-agent-directory-and-explicit-restore.md)):
   a room is not part of an identity, and one record lets a room deletion
   return all its members at once. An agent without a membership is in the
   lobby, so an installation that never uses rooms keeps its behavior and
   needs no migration.
2. **The directory stays global.** `list_agents` shows the agents of every
   room with their `room`; only sending is limited. An agent can see who
   exists and ask the operator for a move.
3. **Sending stays in the wrapper channel; the rule is re-checked at the
   record.** The channel that accepts a message owns its delivery
   reservation and the steps after the record, so the acceptance is not
   moved into another process. The same-room rule is checked early in the
   channel and again inside `ConversationStates`, in the call that records
   the message. The boundary is therefore the record: a message recorded
   before a move is delivered, and one recorded after it is refused.
4. **A move or delete is one `ConversationStates` call.** It saves the
   membership through `Rooms` and closes the conversations the change
   splits, from the memberships as saved. Two calls (save, then close) would
   let a second move run between them and hide the first one's closes. The
   closes reuse the conversation tombstone and the `conversation_closed`
   notice; no new termination path exists.
5. **Failures keep the server sending.** A failed save fails that request
   only and memory keeps the last saved state. A store that cannot be opened
   at start puts everyone in the lobby with a warning. A call that times out
   is reported as unconfirmed. There is no retry loop, journal or outbox.
6. **A member moved while offline is not notified.** Only a connected agent
   receives the room-change status notice.
7. **Rooms compose with per-pair permissions by AND**
   ([issue #189](https://github.com/sakuraiyuta/kaoiro/issues/189)). Neither
   one grants what the other refuses. Operator and admin controls are not
   subject to rooms ([ADR-0050](0050-principal-model-and-graded-access-control.md)).

## Consequences

- With the store unreadable at start, agents that were separated can message
  each other until the operator moves them again. Rooms prevent mistakes;
  they are not a boundary against a hostile agent.
- A failed save is not a durable rollback, and a save that completes after
  its timeout leaves split conversations open until an operator closes them.
  [Rooms](../reference/inter-agent/rooms.md#after-room_change_unconfirmed)
  states the manual step.
- A message accepted just before a move can be delivered after it, and a
  work operation applied before the second check is not rolled back.
- A room save runs inside the conversation tracker, so recording waits for
  it, bounded by the 2,000 ms save timeout.
- The existing list limits (200 agents in the join snapshot, 32
  directory-only entries, the frame size) bound what one view shows. Paging
  is not part of Phase 0.

## Alternatives considered

- **Rooms in the dashboard or wrapper only.** Does not bind the server's
  send path.
- **Membership inside the identity ledger, checked once before sending.**
  Ties a room to identity records and misses a move that lands after the
  check.
- **Running the whole acceptance inside `Rooms`.** Orders work operations
  and broadcasts with moves too, but the delivery reservation is bound to
  the accepting channel, and a fault in any send would then reach every
  agent.
- **Per-agent or per-room locks, generations, or a repair journal.** More
  machinery than the mistake-prevention goal needs.

## Amendment (2026-11-10, the director-requested peer session reset)

[Issue #1078](https://github.com/sakuraiyuta/kaoiro/issues/1078) extends the
same-room boundary from inter-agent messages to one more cross-agent
operation. `peer_session_reset_request`
([ADR-0068](0068-director-requested-peer-session-reset.md)) is refused across
rooms with `room_mismatch`, and with `rooms_unavailable` when the store does
not answer that one read. Measured before the change: the handler read no
membership at all, so a director reset an assignee that an operator had moved
to another room — in either order of the move and the assignment — and the
work item stayed active with the same epoch.

Three points differ from decision 3.

1. **Checked once, not twice.** A send's second check happens at the record
   inside `ConversationStates`; a reset has no equivalent record. The reset's
   single check sits immediately before the acceptance lock, its first side
   effect. That position also puts it after the handler's own
   `ConversationStates` read (`require_no_third_party_conversation`), so a
   move already queued ahead of the request has been saved by the time rooms
   are read, and that move stops the reset. Measured with a throwaway test
   during the implementation review (not committed): with the check in this
   position a queued move refuses the reset, and with the check moved to just
   after the authority read the same situation lets the reset through.
2. **After authority.** ADR-0068 D1 keeps every authority failure on
   `reset_not_authorized`. Deciding rooms first would answer `room_mismatch`
   to a requester that does not direct the work, which D1 forbids and which
   private rooms ([#1073](https://github.com/sakuraiyuta/kaoiro/issues/1073))
   would turn into a probe.
3. **The remaining window is accepted.** A move landing between the check and
   the acquisition does not stop that reset. Closing it would move the reset
   acquisition into the process every send waits on, and the outcome cannot be
   told apart from a reset acquired just before the move — a distinction this
   record's mistake-prevention goal does not need.

Decision 7 (rooms and per-pair permissions compose by AND) and the
consequences above are unchanged.

## Amendment (2026-11-10, the room a new agent starts in)

Room selection at launch, which the Context above places in a later phase,
is recorded in [ADR-0073](0073-initial-room-at-launch.md)
([issue #1081](https://github.com/sakuraiyuta/kaoiro/issues/1081)). No
decision of this record is replaced: decision 1 still makes the absence of a
membership mean the lobby, and decision 4 still routes every membership change
through one `ConversationStates` call. What changes is only **when** an
agent's first membership is written — before its launch reaches the runner,
rather than by an operator's move afterwards.
