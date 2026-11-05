---
title: Director-requested session reset of an assigned peer
description: A director holding an active work grant may request the session reset of its assignee through a dedicated wrapper-to-server request; authority comes from the server-owned work record alone, the target passes the operator reset's gates, and the result returns to the requester's own topic.
status: accepted
last_updated: 2026-11-05
date: 2026-10-17
opened: 2026-10-17
supersedes: [43]
superseded_by: null
related_specs: [protocol-inter-agent]
related_adrs: [36, 43, 55, 63]
---

# ADR-0068 — Director-requested session reset of an assigned peer

## Status

Accepted (2026-10-17). Operator decisions recorded in
[issue #677](https://github.com/sakuraiyuta/kaoiro/issues/677): the
authority model change is approved, the approval level equals the agent-self
reset (permission-mode dependent), an open conversation between requester and
target is allowed, and production rollout is decided separately after
implementation review. Design review: two rounds, must 2 cumulative, 0 at
round 2.

Partially supersedes [ADR-0043](0043-agent-initiated-session-reset.md) D2
(see D7); the frontmatter lists 43 for that reason, while ADR-0043 itself
stays `accepted` because its other decisions are untouched. [ADR-0036](0036-session-lifecycle-commands.md) F2 / F6 / F7 and
[ADR-0063](0063-layered-delivery-authority-and-continuations.md) D3 / D9 are
unchanged.

## Context

Since ADR-0063 the director of a piece of work is a server-owned record
(`director`, `assignee`, `state`, `authority_epoch`), not a name in a
conversation. A director that hands a peer unrelated follow-on work wants the
peer to start from a fresh session, because re-reading a long session whose
cache has expired costs far more than a fresh start. Today the director can
only ask the peer by message to call its own `request_session_reset`
(ADR-0043). That costs a round trip, depends on the peer acting, and the
director learns the outcome only if a conversation with the peer is still
open: the planned-disconnect notices (`reconnecting` / `reachable`) go to
open-conversation peers only, and the `session_reset_*` broadcasts are
operator-only.

ADR-0043 D2 declined a dedicated path originating from another agent because,
in 2026-07, "director" had no server-side meaning. That premise no longer
holds.

## Decision

D1. **Authority is the work grant alone.** Requester R may reset target T
only when the request names a `work_id` and `expected_authority_epoch`, the
work is `active`, `work.director` is R's principal, `work.assignee` is T,
`R != T`, and the epoch matches. The server (`WorkStore.authorize_peer_reset`)
decides from its own record; nothing the wrapper or model asserts is used.
Every authority failure answers the single word `reset_not_authorized`, as
`decide_yield` does, so a reply cannot be used to probe other agents' grants.
Conversation membership, persona names and the `owner` placeholder grant
nothing (ADR-0063 D3). Operator-directed work is reset through the existing
operator path.

D2. **The target passes the operator reset's gates plus one.** After D1 the
request runs the same checks as `AgentsChannel.session_reset`: envelope
present (`unknown_agent`), capability advertised
(`unsupported_session_reset`), ready state / cooldown / pending lock
(`agent_busy`, `session_reset_pending`) acquired through the per-agent
`AgentAcceptance` choke point with the new `:peer_session_reset` command.
The one new gate, `agent_in_conversation`, refuses while T has an open
conversation with any agent other than R. A busy target is refused, never
interrupted or queued (ADR-0036 F6); a director that needs the target to
stop first uses the cooperative yield of ADR-0063.

D3. **Wire.** `peer_session_reset_request` (wrapper → server, versioned)
carries `{agent_id, mode, work_id, expected_authority_epoch, reason?}` and
replies `{request_id}` or one of eight closed reasons
(`KaoiroServer.PeerSessionResetReplyReasons`, cross-checked against the
wrapper by a script like the self-reset one). `peer_session_reset_result`
(server → the **requester's** wrapper topic, checked) carries the terminal
outcome on completion, failure and timeout, independent of any conversation,
best effort like `work_notice`. The lock records origin `:director` with
`requested_by` and `work_id`; `session_reset_started` carries
`origin: "director"`, `requested_by`, `work_id`.

D4. **Tool.** `request_peer_session_reset {agent_id, mode, work_id,
expected_authority_epoch, reason?, wait? = true}` sends the request at once
(the requester is not the process being replaced, so there is no turn
boundary to wait for) and, with `wait`, returns the result within 70 seconds
(the server's 60-second reset timeout plus margin). Approval is the same
class as `request_session_reset`: Claude through canUseTool and its
permission mode, Codex through the policy-aware wrapper gate, Antigravity
through its per-call broker (operator decision, 2026-10-17).

D5. **Audit.** The lifecycle row `session_reset_started` records a closed
attribution `{origin, requested_by?, work_id?}` for all three origins through
a server-only record function (`SessionLifecycleEvents.record_session_reset_started/4`,
validated by `SessionResetAttribution`, re-validated on boot). Wrapper
ingress rejects a wrapper-produced `session_reset_started`. The dashboard
origin vocabulary gains `director`.

D6. **Engines.** The runner path is unchanged (fresh relaunch for every
engine). Claude Code, Codex and Antigravity register the requester tool and
can be targets. Grok is neither today: its wrapper advertises
`supports_session_reset: false`, so it is refused as a target with
`unsupported_session_reset`, and it does not negotiate `work_control` on
join (measured on the built `runGrokCli` options and on the wire, 2026-10-18,
wrapper review r1), so the tool is not registered for it. Both halves are
tracked by [issue #658](https://github.com/sakuraiyuta/kaoiro/issues/658).

D7. **ADR-0043 D2, by sentence.** (1) "no dedicated protocol / tool through
which agent A requests a reset for agent B" is superseded for the lifetime of
an active work grant. (2) "no permanent director role" stands: authority
exists per work and ends with it. (3) "the instructed agent calls its own
tool and the operator approves each request" is superseded by D4 — the
director calls this tool under the same approval class as its own reset.

## Implementation result (2026-10-18)

- Landing unit: server authorization and gates, the wire pair, the tool on
  the three engines, the lifecycle attribution, and the dashboard's
  **in-flight** display of the requesting director and `work_id` next to
  "starting a new session". `session_reset_completed` / `_failed` clear
  that display as before.
- [Issue #682](https://github.com/sakuraiyuta/kaoiro/issues/682) adds the
  operator-only session history dialog, reachable from agent detail or an ID
  lookup in Settings, including deleted agents with retained history. The
  query resolves work titles at read time and keeps the work ID as fallback.
  Empty history, partial replies, unreadable rows and fetch failure remain
  distinct. Reset-started/completed notifications trigger best-effort re-fetch;
  recording may follow notification, so the latest row can require manual
  refresh. Other lifecycle kinds use manual refresh. D5's stored attribution
  and the existing transcript session boundaries are unchanged.

## Alternatives considered

- A `work_control` op carried by `send_to_agent`: ties a reset to message
  delivery and a conversation, and would be the first op that does not
  advance the work revision. Rejected.
- Server-driven delegation to the peer's own `request_session_reset`:
  bypasses the peer's approval path (ADR-0043 D4) and still waits on a busy
  peer. Rejected.
- Authority from conversation membership or `owner`: explicitly excluded by
  ADR-0063 D3. Rejected.
- Interrupt-then-reset for busy targets: frozen by ADR-0036 F6 / ADR-0063
  D9. Rejected.
- Reporting the result through the conversation's synthetic notices: lost
  whenever the conversation is closed, which is the common case. Rejected.

## Consequences

- A director under an accepted grant can discard the assignee's context
  without the assignee's consent. Mitigations: the grant is explicit and
  revocable by the operator, the epoch invalidates stale directors, the tool
  description obliges the director to have the target externalize state and
  to carry context into the next request, and the target's status line
  survives.
- An `auto`-mode director resets without a dialog, as it already resets
  itself. Operators who want a dialog keep the director on a default-class
  permission mode.
- The requester misses the result if it disconnects before the terminal
  event (best effort); `list_agents` `session_started_at` and the target's
  lifecycle timeline remain the durable record.
- The conversation gate and the lock live in different processes; a
  conversation opened in between only means its peer receives the ordinary
  planned-disconnect notice.
- The wrapper's `session_lifecycle` ingress still accepts the other
  server-only kinds through its generic clause; this ADR closes only
  `session_reset_started` and leaves the rest to a follow-up issue.


## Amendment (2026-11-05, basic work operations)

[Issue #965](https://github.com/sakuraiyuta/kaoiro/issues/965) removes transfer
without changing reset authorization. Callers still pass the authority epoch
observed in their work result. Existing values above 1 are preserved; new work
starts at 1 and no supported operation advances it. An active grant, matching
director/assignee and matching epoch remain necessary, and terminal work cannot
authorize a reset. Cancellation followed by a new assignment replaces transfer;
it does not itself stop the previous assignee's running tools.
