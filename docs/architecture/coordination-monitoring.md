---
title: Coordination monitoring
status: provisional
last_updated: 2026-09-18
description: Coordination monitoring, including notification boundaries and limitations.
---

# Coordination monitoring

## Review-quagmire detection (issue #273)

Two failure modes of multi-agent review are invisible until an operator goes
looking: a review loop that keeps exchanging messages without reaching a
deliverable, and a message that was accepted but never dispatched. The server
detects both and pushes an operator-only notice; it never closes a
conversation and never messages an agent.

### Stall interpretation

**It is a suspicion, not a verdict.** The same shape appears while the
recipient is simply mid-turn: a wrapper acknowledges only when an SDK turn
actually starts, and a long tool run or a review workflow routinely exceeds
half an hour. `stall_ms` therefore sits ABOVE the Claude wrapper's 30-minute
turn-watchdog inactivity default, so the detector does not double-announce
what that watchdog's own interrupt already handles, and the operator-facing
wording says "suspected" rather than asserting the agent is stuck.

The alternative reading — "every agent sits in `waiting_input` with no
traffic" — is deliberately NOT implemented. A quiet system is usually just
quiet, so it would fire every night; an operator would mute it, and the real
[stall signal](../reference/inter-agent/coordination-monitoring.md#stall) would be muted with it.

### Provisional defaults

**The defaults are provisional.** `rally_turns: 16` rests on a thin sample: a
healthy delegation runs well under 10 turns, and the incident that motivated
the issue reached round 18. Revisit it against the `rally_turns` the
`list_conversations` projection reports after a month of real traffic.
`stall_ms: 3_600_000` is set above the Claude wrapper's 30-minute
turn-watchdog inactivity default for the reason given under [Stall interpretation](#stall-interpretation).

### Deliberate omissions

- Detection is process-local and starts empty, so a server restart
  re-announces every condition still standing. Accepted rather than
  persisting operator-visible notice state.
- No `escalate-to-user` envelope and no `inform` message to the director. A
  false positive that stops a working loop costs far more than a missed
  notice. Follow-up: a director-addressed notice can be reconsidered once the
  false-positive rate is known from real data.
- No automatic closing. `close_by_operator` remains the only path from a
  notice to a terminated conversation, and an operator takes it deliberately.

## Related topics

- [Exact detection, wire, configuration, and display contracts](../reference/inter-agent/coordination-monitoring.md).
- [Delivery confirmation](../reference/inter-agent/delivery.md).
- [Authentication and authorization](../reference/security/authentication-authorization.md).
