---
title: Rooms
description: Rooms and single membership - who can message whom, how an operator manages rooms, what a move or delete closes, the notices, and how the store fails.
status: provisional
last_updated: 2026-11-10
related: [directory, conversations, messages]
---

# Rooms

A room is a group of agents. An agent is in exactly one room, and the server
accepts `send_to_agent` only between agents in the same room. Rooms keep a
message from reaching the wrong team; they are not a permission system
([enforcement boundaries](../security/enforcement-boundaries.md#rooms)). The
decision record is [ADR-0072](../../adr/0072-rooms-single-membership-send-boundary.md)
([issue #537](https://github.com/sakuraiyuta/kaoiro/issues/537), Phase 0).

## Rooms and membership

- The lobby has the fixed id `lobby`. It always exists and cannot be deleted.
  Its `name` is `null` until an operator renames it; a client shows its own
  default label for `null`.
- Every other room has a server-generated UUID as its id and a name. The name
  follows the agent display name rule (at most 64 grapheme clusters and 256
  UTF-8 bytes, no control characters, not blank). Names need not be unique;
  the id identifies a room.
- An agent with no stored membership is in the lobby. A new agent, and every
  agent of an installation that has never used rooms, is therefore in the
  lobby, and with no room in use the server behaves as it did before rooms.
- Membership is keyed by `agent_id`. It survives a disconnect, a reconnect, a
  session reset, a restore under the same id, and a server restart.
  `delete_agent` removes it.
- The number of rooms and of members per room is not capped. The existing
  list limits still apply: the join snapshot of 200 agents, the 32
  directory-only entries of `list_agents`, and the 8 MB frame. Phase 0 adds no
  paging, so an agent that the dashboard does not list cannot be moved from
  it.
- Users are not members of a room. An operator's own controls reach every
  room.

## The same-room rule

The server refuses an inter-agent message whose sender and recipient are in
different rooms with `room_mismatch`. Nothing a wrapper sends (a payload or
`ext` field) takes part in the decision.

The rule is checked twice:

1. Early, in the wrapper channel, after `self_routing` and `unknown_agent` and
   before every other check. A refusal here changes nothing: no reachability
   notice is tracked, no delivery is reserved, no work operation runs, and no
   conversation or pane is touched.
2. Again inside `ConversationStates`, in the same call that records the
   message. Room changes run in that same process, so none can land between
   this check and the record.

The rule has no exception by message kind: a new or an existing conversation,
`done`, an error notice, `early` and `yield` delivery, and a message that
carries `work_id` or `work_control` are all refused. An agent that must
complete or cancel a work item across rooms cannot; the operator's
`work_control` on the dashboard channel still can.

Server-authored notices (`agent_id: "server"`) are not messages between
agents and cross rooms: a conversation closed by a move is announced to both
ends. Operator instructions, state, log and result envelopes, and history
replay are not subject to the rule.

If the server cannot read the rooms for one send (the store process did not
answer within 500 ms), that send alone is refused with `rooms_unavailable`.
The wrapper may retry it later.

### A move racing a send

The boundary is the moment the conversation records the message.

| Order | Outcome |
|---|---|
| The message is recorded, then the move runs | The message is delivered through the normal path, possibly after the move and after the close notice. The move closes the conversation. |
| The move runs, then the record | The record is refused with `room_mismatch` and the delivery reservation is released. If a `work_control` operation carried by the message was already applied, the reply is `work_applied_message_rejected` with `conversation_error: "room_mismatch"`, and the work operation stays applied. |

A message already handed to a wrapper or an engine is not recalled.

### The director-requested peer session reset

`request_peer_session_reset` ([session tools](session-tools.md)) is refused
across rooms as well, with `room_mismatch`
([issue #1078](https://github.com/sakuraiyuta/kaoiro/issues/1078)). When the
store does not answer that one read within 500 ms the reply is
`rooms_unavailable`, and the wrapper may retry it later.

Three things differ from a send.

- **The check runs after the authority check.** A requester that does not
  direct the work still gets `reset_not_authorized`, which keeps
  [ADR-0068](../../adr/0068-director-requested-peer-session-reset.md) D1's
  single word for every authority failure; a cross-room refusal says nothing
  about rooms to someone without the grant.
- **It runs once, immediately before the acceptance lock**, not twice. A send
  has a second boundary - the moment the conversation records the message -
  and a reset has no equivalent record. A move that lands between the check
  and the acquisition does not stop that reset, and the outcome cannot be
  told apart from a reset acquired just before the move.
- **A move does not revoke the grant.** The work item stays active with the
  same epoch, as [Managing rooms](#managing-rooms) already states, so holding
  a valid grant no longer implies the reset is possible. The director asks the
  operator to move one of the two.

## Managing rooms

Only an operator or admin manages rooms, through the dashboard channel
([channel events](../protocol/channels.md)). The role is checked at the
channel entry.

- **Create, rename.** They do not change who shares a room.
- **Move** one agent to a room. A move to the room the agent is already in
  changes nothing and announces nothing.
- **Delete** a room. All its members return to the lobby in one change, so a
  conversation among them stays open.

A move or a delete saves the membership and then closes every open
conversation that has a moved agent and whose participants are no longer all
in one room. Both happen inside one `ConversationStates` call. A closed
conversation becomes the usual tombstone
([lifecycle](conversations.md#conversation-lifecycle-and-post-close-handling-issue-167))
with reason `room_changed` (move) or `room_deleted` (delete), and each
participant receives the `conversation closed: <reason>` notice. Work items
are not cancelled or reassigned.

The two preview requests answer how many conversations a move or delete would
close if it ran now. The number is advisory: the real request decides again,
and its reply carries the count it closed.

## Notices

- **Conversation closed.** The existing server notice (`kind: "done"`,
  `turn_number: 0`, `meta.done: true`). The wrapper closes its track without
  waking the model.
- **Room changed.** Sent to an agent that is connected when it is moved, or
  when its room is deleted. It is a server status notice: `agent_id:
  "server"`, `kind: "inform"`, `turn_number: 0`, `meta.done: false`,
  `notice_type: "room_changed"`, `owner: {kind: "user", id: "system"}`, on a
  fresh `conversation_id` under which no conversation is recorded. The
  wrapper injects it as a status notice that asks for no reply, creates no
  conversation track for it, and gives it no reply basis. The server refuses
  `notice_type: "room_changed"` from a wrapper.
- An agent moved while it is disconnected is not notified, then or when it
  reconnects. It reads its room from `whoami` and `list_agents`, and a send
  across rooms tells it `room_mismatch`.

## Reading rooms

- `list_agents` lists the agents of every room; each entry carries `room`
  ([directory](directory.md#exposed-fields)). `whoami` carries the caller's
  own `room`.
- A dashboard receives `rooms_snapshot` after joining and after every room
  change.

In every reading surface an absent `room`, or a membership missing from an
incomplete snapshot, means unknown. A client must not show it as the lobby.

## Storage and failure

Rooms and memberships are one record in the DETS store `rooms`
(`KAOIRO_ROOMS_PATH`, [server configuration](../configuration/server.md)).
The same-room rule reads memory only.

| Event | Behavior |
|---|---|
| A save fails (insert or sync) | That request fails with `rooms_unavailable`. Memory keeps the last saved state, sends go on under it, no conversation is closed and no notice is sent. |
| The next create, rename, move, delete or agent delete after a failure | The store closes and reopens its file once and saves the new state from memory. It never reads the file back while running. |
| The store cannot be opened or read at start | A warning is logged and every agent is in the lobby. Agents that were in different rooms can message each other until the operator moves them again. The file is left as it was. The first save that succeeds afterwards replaces what the file held. |
| The file is not a DETS file at start | It is removed and created again, with a warning. |
| A stored room or membership is malformed, or names a room that does not exist | It is dropped with a warning; that agent is in the lobby. Valid records are kept. |
| The store does not answer a save within 2,000 ms, the tracker does not answer within 5,000 ms, or a notice fails | The reply is `room_change_unconfirmed`. The change may or may not have been applied. |

A failed save is not a durable rollback: an insert that reached the file
before the sync failed is what the next server start reads.

### After `room_change_unconfirmed`

Rejoin the channel to receive a fresh `rooms_snapshot`, and read
`list_conversations` again. If a timed-out save completes later, no room
change broadcast is sent and the dashboard remains stale until it rejoins.
When the save inside the server timed out and completed later, the membership
has changed but the conversations it split are still open. The same-room rule already refuses
every further message on them. Close such a conversation with the operator's
`close_conversation`. Repeating the move or the delete is not a repair: a
move to the room the agent is now in changes nothing, and a deleted room no
longer exists.

## Relation to per-pair permissions

Per-pair permissions
([issue #189](https://github.com/sakuraiyuta/kaoiro/issues/189)) are a
separate constraint. A send needs both: a pair permission never allows a send
across rooms, and sharing a room grants no pair permission.
