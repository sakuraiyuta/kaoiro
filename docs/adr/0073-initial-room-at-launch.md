---
title: The room a new agent starts in
status: accepted
date: 2026-11-10
opened: 2026-11-10
supersedes: []
superseded_by: null
related_specs: [rooms]
related_adrs: [24, 30, 72]
---

# ADR-0073 — The room a new agent starts in

## Status

Accepted (2026-11-10). Records the decisions of Phase 1-1 of rooms
([issue #537](https://github.com/sakuraiyuta/kaoiro/issues/537) decision
record section 6, implemented in
[issue #1081](https://github.com/sakuraiyuta/kaoiro/issues/1081)). Design
review: four rounds, must 7 cumulative, 0 at round 4.

Items 3 to 5 of that record's order (per-agent room permissions and the first
unit of agent room operations, representatives and root, the approval flow for
"ask") will be added here as numbered decisions when each unit's design is
approved. [ADR-0072](0072-rooms-single-membership-send-boundary.md) keeps all
of its decisions; nothing here replaces one.

## Context

ADR-0072 Phase 0 stores one room per agent and limits sending to that room,
and it places room selection at launch outside its own scope. An agent with no
stored membership is in the lobby, so every newly launched agent started there
and an operator moved it afterwards — one manual step per launch, and a window
in which the new agent could message the wrong team.

Measured on the pre-change server (2026-11-10,
[evidence](../evidence/issue-1081/launch-room-2026-11-10.md)): the launch
request carried no room, an unknown `room_id` in it was silently dropped, and
at the moment the runner received the launch nothing was stored — a wrapper
joining right then was answered `room: {id: "lobby", name: null}` by its own
`whoami`.

## Decision

D1. **Only a new agent picks its room.** The operator picks it in the launch
dialog, and `spawn` carries `room_id`. The dialog offers the picker in both of
its modes, including resume: that mode allocates a **new** agent id, so it has
no stored room to keep (operator decision Q43 = A, 2026-11-10). The decision
record's "resuming an agent keeps its stored room" is the detail view's
restore of the *same* agent id; `restore` and `resume_session` carry no room
and leave the stored membership untouched.

D2. **The membership is saved before the launch is broadcast.** The runner is
what starts a wrapper, and it learns of the launch from the `spawn`
broadcast, so a save placed before that broadcast is always committed by the
time the wrapper first registers. This is the same ordering, for the same
reason, that made `AgentDirectory.record/4` a synchronous call before the
broadcast ([issue #209](https://github.com/sakuraiyuta/kaoiro/issues/209)
D22).

D3. **The identity is recorded before the membership.** A membership whose
`agent_id` has no identity appears in no list and cannot be removed:
`delete_agent` purges both, and it needs the identity. Recording the identity
first therefore keeps the residue of a refused launch clearable by an action
that already exists. The cost is an identity left behind by a refused launch,
which already happens when the delivery-policy seed fails or the runner cannot
start the wrapper.

D4. **A failed save refuses the launch; a failed notice does not.** A room the
operator chose but the server could not store is worse than a launch the
operator can retry, so the transition is resolved as failed and the runner is
never told. The snapshot notice is different: the membership is already saved,
the agent is in the right room, and a stale dashboard copy has a documented
repair (rejoin for a fresh snapshot), so a failed notice is logged and the
launch continues.

D5. **The lobby reaches no store.** With `room_id` absent, or naming the
lobby, the handler calls neither `Rooms` nor `ConversationStates` — not even
the snapshot read. The lobby *is* the absence of a membership, and a stalled
store must not refuse launches on an installation that uses no rooms
(ADR-0072 decision 1).

D6. **Placement reuses the move path.** `ConversationStates.apply_room_change/1`
saves the membership, as ADR-0072 decision 4 requires of every membership
change; a fresh agent id has no conversations, so nothing is closed. The
handler then calls the same `announce_room_change/1` the move handler uses,
which for a fresh agent emits only the `rooms_snapshot` broadcast — no
`room_changed` notice, because the agent is not connected yet. Without that
broadcast a client would keep showing the new agent in the lobby, since it
updates its copy from `rooms_snapshot` alone.

D7. **The room is checked twice and answered as an id.** The room's existence
is read from the snapshot before any side effect, so a typo leaves nothing
behind, and the save decides again under a room deleted in between — the shape
ADR-0072 decision 3 uses for a send. A `room_id` that is present but not a
usable string is refused rather than quietly placed in the lobby. The reply
carries `room_id` as a bare string (`"lobby"` when none was named), not the
`{id, name}` wire room: a name would mean reading the store on a lobby launch,
which D5 forbids. A server that ignores the field answers no `room_id`, which
is how a client detects that its choice was dropped.

## Alternatives considered

- **A `{:place, agent_id, room_id}` command of its own.** Names the operation
  more precisely than "move" while adding a mechanism the existing one already
  covers. Rejected.
- **Saving before the identity.** Leaves no identity behind on a refusal, but
  a membership that outlives an unconfirmed save is then invisible and
  unclearable. Rejected (D3).
- **Refusing the launch on a failed snapshot notice.** Trades a saved
  membership for a display problem that rejoining already repairs. Rejected
  (D4).
- **Routing a lobby launch through the store anyway**, for one code path.
  Makes every launch depend on the rooms store, including where no room is in
  use. Rejected (D5).
- **A remembered last-used room** in the launch dialog. Not asked for by the
  decision record; the lobby is the default.

## Consequences

- An operator launching into a room no longer has a window where the new agent
  can message another team.
- While a launch is in flight the identity can exist before its membership, so
  a dashboard and `list_agents` may briefly show a starting agent in the
  lobby. The wrapper's own first registration is never in that window (D2).
- A refused launch can leave an identity, and an unconfirmed save can leave a
  membership that appears after the refusal. Both are cleared by
  `delete_agent`.
- The decision in D4 to continue after a failed notice is **not covered by a
  test**: for a fresh agent the only step that runs is the broadcast, which a
  test cannot fail without a new seam. An implementation that refused the
  launch there would pass the suite.
- A client older than this change, or one that does not send `room_id`, keeps
  Phase 0 behaviour: its launches land in the lobby.
