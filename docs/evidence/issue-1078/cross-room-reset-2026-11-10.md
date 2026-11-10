---
title: Cross-room peer session reset, the behaviour before the refusal
status: recorded
last_updated: 2026-11-10
---

# Issue 1078 — the cross-room peer session reset, measured before the fix

The decision record on
[issue #537](https://github.com/sakuraiyuta/kaoiro/issues/537) required this
measurement before the refusal was implemented, because the behaviour was only
inferred from the code.

Base commit: `c0a2fdef3ba69a14b22b12462f6cd724f522efc6`. Measured with the
server's own `ChannelCase` on an isolated container runner, plus one scratch
test file that was not committed. Everything ran through the real path: the
operator's `move_agent` on the dashboard channel (`AgentsChannel`),
`WorkStore.apply` for the grant, and `peer_session_reset_request` on the
wrapper channel. The control case was asserted, so a run that observed nothing
could not be mistaken for a refusal. Result: 3 passed, exit 0.

## Observed

| Case | Rooms (director / target) | `Rooms.same_room/3` | Reply | `SessionResets.pending?/1` |
|---|---|---|---|---|
| Control: both in the lobby | `lobby` / `lobby` | `:ok` | `:ok` with a `request_id` | true |
| A: the target moved, then the work assigned | `lobby` / a new room | `{:error, :room_mismatch}` | `:ok` with a `request_id` | true |
| B: the work assigned, then the target moved | `lobby` / a new room | `{:error, :room_mismatch}` | `:ok` with a `request_id` | true |

In case B the work item was still `state: "active"` with
`authority_epoch: 1` after the move, and `move_agent` replied
`closed_count: 0` (no conversation was open).

## What this establishes

A move neither revokes the grant nor blocks the reset. A director reset an
assignee in another room, in either order of the move and the assignment, and
the target's session was replaced.

## Limits

- Case A needs the operator's own `work_control`, which rooms do not bind
  ([ADR-0050](../../adr/0050-principal-model-and-graded-access-control.md)).
  That this path is reachable is **read from the docs, not measured**; what
  was measured is that a grant created that way authorizes the reset. Case B
  is the order an operator produces by moving an assignee mid-work, and that
  one was measured end to end.
- The grant was created by calling `WorkStore.apply` directly with operator
  attribution, not by driving the dashboard channel.
- Only `mode: "new"` was measured; `clear` shares the same handler path up to
  the acceptance lock.
- The window between the room check and the lock acquisition was not measured.
  It is reasoned from the code in the
  [ADR-0072 amendment](../../adr/0072-rooms-single-membership-send-boundary.md).
