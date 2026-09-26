---
title: Issue 407 reconnect generation and permanent adapter controls
date: 2026-09-26
status: pending-review
last_updated: 2026-09-26
---

# Reconnect generation and adapter controls

The round-seven review found that a send captures negotiation mode before the
CID lock. A preceding acknowledgement can hold that lock across rejoin, leaving
a queued send formatted for an old mode. Phoenix buffers channel pushes while
unjoined; rejecting at the server is too late to prevent crossing generations.

Retain immutable input/ticket capture at invocation, but read negotiated mode
inside the CID lock after waiting for rejoin. Capture ServerLink's join generation
with that mode and pass it to the synchronous dispatch boundary. ServerLink
refuses protected inter-agent pushes unless the generation still matches, the
mode is settled, and the socket/channel are joined. No protected inter-agent
push enters Phoenix's disconnected buffer. Socket loss, channel error/close, and
join invalidate old generations. Already-written pushes retain their ordinary
ack/unknown semantics and are never automatically retried. Local refusal is
explicitly not attempted; valid consumed authorization can be reissued for an
intentional retry, using the existing definite-nonacceptance handoff contract.
Internal notices use the same generation guard. Generic state/task buffering is
unchanged, and AG v1 remains disabled.

Moving only the mode read would fix the CID example but leave disconnected
buffering unprotected. Checking only transport mode would miss a same-mode
rejoin; an explicit generation is needed. No server/protocol wire change is
required. Tests cover both mode transitions with real ServerLink/Phoenix and a
held first acknowledgement, channel-only rejoin, and delayed old-generation
sends. Deterministic regression tests traverse the real app-server session
resolver/ToolHost and the real Claude SDK MCP registration/callback; external
transport is controlled. Existing real native loopback probes remain complementary
evidence. Remove each new guard/wiring once and require red, restore and require
green. Run wrapper build/typecheck/full tests and server full/format gates; the
reported pre-existing server seed failure is outside scope. Update the reply-basis
reference and append content-bound evidence without rewriting prior observations.

## Channel/socket lifecycle contract

Phoenix 1.8.8 is installed in this worktree. Its `priv/static/phoenix.js` and
ES module `phoenix.mjs` were read directly. In the ES module, Channel setup
(192–252), `leave` (384–399), `rejoin` (438–445), Socket `disconnect`
(1202–1214), and `onConnClose`/`onConnError`/`triggerChanError` (1476–1512)
define the transitions below. The CommonJS/browser bundle has corresponding
Channel `onClose` at 255–259; unlike `onError`, it removes the channel and does
not schedule rejoin. Server token revocation is intercepted by
`WrapperChannel.handle_out("revoked", ...)` and stops the channel; it is observed
by the client as `phx_close`, not as an application `kick`/`leave` message.

Negotiation has three internal states: ready, recoverable pending, and terminal
closed. The published compatibility mode remains v1/legacy/pending; closed never
falls back to legacy. `waitForReplyBasisMode` returns `closed` for terminal state,
`pending` for a failed/bounded/aborted wait, or the negotiated mode for success.
Each wait has a fixed ten-second deadline, never extended by repeated failures.
Join error/timeout resolves current waits with pending even if a later join
succeeds before their continuations run. A terminal close is sticky: late join
callbacks cannot resurrect it. No automatic send retry is introduced.

| Event | Mode and generation | Negotiation waiter and CID queue result | Phoenix automatic rejoin |
| --- | --- | --- | --- |
| Initial join success, v1 or legacy | Ready; generation advances | Waiters receive negotiated mode; queued sends use current generation/input snapshot | Initial join only |
| `phx_error` | Recoverable pending; generation advances | Wait until successful rejoin, failure, abort, or fixed deadline; then send or definite local no-send | Schedules channel rejoin when socket connected; socket-open also rejoins errored channels |
| `phx_close` | Terminal closed, published pending; generation advances | Existing and future waits return closed; CID queue drains to `reply_basis_closed`, `send_not_attempted: true` | No: removes channel and resets its rejoin timer |
| Abnormal socket close, e.g. 1006 | Recoverable pending; generation advances (including associated channel error) | Same bounded recovery wait as `phx_error` | Socket reconnect scheduled unless clean; errored channel rejoins on open |
| Normal socket close, code 1000 | Terminal closed, published pending; generation advances | Existing/future waits return closed; local no-send | No socket reconnect under Phoenix's normal-close rule |
| Socket error | Recoverable pending; generation advances | Bounded wait; success sends, otherwise local no-send | Error callback itself does not reconnect socket; channel error schedules rejoin only when connected; a later abnormal close may reconnect |
| Join reply error | Recoverable pending; generation advances | Current negotiation waiters receive pending immediately; queued/future calls may wait for a later attempt, bounded; no send on failed wait | Schedules channel rejoin if connected |
| Join timeout | Recoverable pending; generation advances | Same failed-wait rule as join error | Sends `phx_leave`, resets join push, schedules rejoin if connected |
| Phoenix `Channel.leave()` | Terminal through `phx_close`; generation advances | Closed/local no-send, including CID queue | No; resets timer, then leave ack/timeout triggers close |
| Server channel stop/kick/revoke | Same `phx_close` terminal transition | Closed/local no-send; no extra inferred rejoin | No for channel stop; a separate abnormal socket close follows its own row |
| Unrecognized server event named `leave` or `kick` | No change | Ready calls send normally; does not bypass actual close handling | No special Phoenix handling; not a kaoiro lifecycle wire contract |
| `ServerLink.close()` | Terminal immediately, published pending; generation advances | Resolves all negotiation waits closed before leave/disconnect; future calls reject locally | No; explicit disconnect resets reconnect timer |
| Caller AbortSignal | Global mode/generation unchanged | That wait resolves pending; invocation origin check produces local stale/no-send. Others remain eligible | No change |
| No terminal event and no successful join for ten seconds | Global mode/generation unchanged | That wait resolves pending and releases its CID slot; local no-send, never unknown | Does not create or cancel retries |

A queued CID call cannot overtake its predecessor. Its predecessor releases the
lock after either bounded negotiation (at most ten seconds per wait) or the
Phoenix push's bounded acknowledgement (default ten seconds). Thus a finite
queue drains even when recovery never succeeds; `wait_for_response` is outside
this lock. Abort of a call waiting for the CID lock is checked when it reaches
the head, bounded by the finite preceding queue; it does not allow overtaking.
Already-written pushes can complete accepted/rejected or unknown timeout; a
lifecycle failure is not evidence that their side effects did not happen.

Terminal failures issue no retry ticket. Recoverable negotiation failure before
push is definite nonacceptance; an already consumed valid ticket is renewed only
at result handoff, following the existing intentional-retry contract. A result
from a failed wait cannot borrow a later successful join to send automatically.

Every row has a permanent real ServerLink/Phoenix loopback control, with direct
negotiation waits and same-CID invokes. Real socket/channel instances may use
shorter Phoenix timers for deterministic failure controls; a default construction
control and the fixed ten-second deadline control exercise production timing.
Socket error injection uses the real WebSocket EventTarget, not a replacement
Phoenix implementation. Server kick tests reproduce its verified `phx_close`
wire outcome, not a second Elixir integration suite. Mutations at least remove
terminal close and join-error waiter release, then require red/restored green.
