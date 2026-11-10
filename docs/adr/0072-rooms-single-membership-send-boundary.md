---
title: Rooms with single membership and a server-side send boundary
status: accepted
date: 2026-11-10
opened: 2026-11-10
supersedes: []
superseded_by: null
related_specs: [rooms, conversations, directory]
related_adrs: [30, 50]
---

# ADR-0071 — Rooms with single membership and a server-side send boundary

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
