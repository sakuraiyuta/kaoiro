---
title: The launch path's room, measured before it carried one
status: recorded
last_updated: 2026-11-10
---

# Issue 1081 — the launch path before it carried a room

[ADR-0073](../../adr/0073-initial-room-at-launch.md) D2 orders the membership
save before the launch broadcast. This record is the measurement that decided
that ordering, taken before any of the change existed.

Base commit: `6bac827fa332aa258c91fc0fbcb802ea966b06eb`. Measured with the
server's own `ChannelCase` on an isolated container runner, through one
scratch test file that was **not** committed. Every case drove the real route:
the operator's `spawn` on the dashboard channel (`AgentsChannel`), the
`runner:<host_id>` broadcast, and — where it mattered — a wrapper joining
`wrapper:<agent_id>` and asking its own `directory_request` with
`scope: "self"` (the `whoami` tool). Result: 5 passed, exit 0.

## Observed

| # | Case | Observed |
|---|---|---|
| 1 | `spawn` with `room_id` naming an existing room | The key never reaches the runner's payload and is not refused. The new agent has no membership, so it reads as the lobby |
| 2 | A wrapper joins at the moment the `spawn` broadcast arrives and calls `whoami` | Answered `room: {"id": "lobby", "name": null}`. Nothing is stored at that point |
| 3 | `ConversationStates.apply_room_change({:move, <fresh agent_id>, room})` | One agent moved, **zero** conversations closed, nothing to notify |
| 4 | The same call naming the lobby | A no-op: no membership is written, because the lobby is the absence of one |
| 5 | The same call naming a room that does not exist | `{:error, :unknown_room}`, before any save |

## Inferred

- A save placed **after** the broadcast could lose to the join of case 2. Case
  2 shows the window is reachable at all; it does not show that any particular
  implementation loses it. What measures the ordering is the committed test
  that holds the save with `ConversationStates` suspended and asserts the
  runner receives no `spawn` while it is held — with the same subscription
  receiving it after the resume, so the refutation is not a dead assertion.
- Case 4 was taken with a healthy store. It does not show that a lobby launch
  survives a *stalled* store: a no-op still traverses both processes. That is
  why ADR-0073 D5 short-circuits before the store is called at all, and why
  the committed test suspends both stores.

## What the measurement did not cover

- The dashboard. The cases above push `room_id` straight at the channel, so
  none of them exercises the launch dialog's own wiring; the committed dialog
  tests do that.
- A room deleted between the pre-check and the save. The save decides again in
  that case (ADR-0073 D7), which is the behaviour ADR-0072 decision 3 already
  describes for a send.
