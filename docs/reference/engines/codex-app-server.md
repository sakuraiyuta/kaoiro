---
title: "Codex app-server transport"
status: implemented
last_updated: 2026-09-30
---

# Codex app-server transport

Current implementation contracts, extracted from the package README. The
[backend architecture](../../architecture/codex-backends.md) links the neighboring contracts;
[ADR-0058](../../adr/0058-codex-app-server-turn-steer.md) retains the decisions and staged authorization.
Measured coverage and limits are in the [evidence record](../../evidence/codex-app-server/stage1-compatibility.md).

`AppServerRpc` resolves the native executable from the installed, pinned Codex
package. One continuous JSONL reader routes responses and notifications,
retaining split UTF-8 and a final unterminated frame. Child exit does not end
routing before stdout drains. Events arriving before a start response are
retained until its turn id is known; unrelated thread/turn notifications do
not enter that turn's stream. A completed stream drains its buffered terminal
before ending, even if the process subsequently exits.

EOF and request timeout fail pending operations and close the child. A submitted
request that loses its response has an unknown outcome; the transport does not
retry or replace the process automatically. Graceful shutdown (`shutdownTimeoutMs`)
defaults to five seconds before killing only the owned child; `CodexHost` overrides
this to 2000ms (issue #391) so the child's own SIGKILL escalation stays below the
runner's reset grace — see
[adapter-contract.md](adapter-contract.md#sigterm-handling-and-process-termination-timing).
RPC waits default to 25 seconds.
Stopping iteration detaches the consumer, not the running turn: admission stays
closed until its terminal event. The internal Host backend wires token-fenced
interrupt and immediate shutdown; the CLI composition is exercised below.

Approval policy is pinned to `never`, reviewer to `user`, analytics disabled,
and `experimentalApi` false. Unexpected server requests receive an explicit
JSON-RPC rejection and an optional diagnostic without their payload. The
`stderrTail` accessor retains up to 16,384 characters for diagnostics; callers
must redact it before logging.

## Operator steering (ADR-0058 Stage 2)

An opted-in Codex persona on the app-server backend may deliver an operator
instruction into the running turn with `turn/steer` instead of queueing it
(opt-in: [wrapper configuration](../configuration/wrapper.md#codex-operator-steer-controls);
capability: [`operator_input_modes`](../protocol/channels.md#adr-0063-capability-and-event-contract)).
Only operator text whose delivered intent is `early` is eligible. Inter-agent
input, work notices, session-reset notices and inputs with attachments always
queue; IA steering is ADR-0063 phase 3.

`AppServerTransport.steer` takes the active-turn snapshot, calls the host's
`admit(turnId)` and writes `turn/steer {threadId, expectedTurnId, input,
clientUserMessageId}` in one synchronous section. `admit` is the only place
the admission guards decide: the current join's echo, an
older operator entry or placeholder in the queue, pending model, effort or
permission settings (including an unresolved permission sync after a join),
an abandoned turn, a session reset in progress or a queued reset notice, and
a cap of 8 steers per turn. A closed or stopped host never reaches `admit`:
closing the runtime is synchronous with every stop, and the runtime or
transport then refuses the steer as `closed`. A declined input queues with a `system` log line
naming the reason. While the start response of a turn is pending the input
waits for it once and returns to `admit`.

Each steer is one record with two independent sides: the response (accepted,
turn ID mismatch, precondition rejection, other error, or lost connection) and
the terminal (`turn/completed`, or a stream that ended without one). Each side
keeps only its first final event, and the record settles exactly once when
both are final. An input item carrying the steer's `clientId` counts only if it
arrives before the terminal. Outcomes: accepted and observed is `included`;
accepted but not observed is `unknown`; a precondition rejection is `requeued`
to the next `turn/start`; any other error is `refused` (also reported as
`instruction_rejected`); a turn ID mismatch or a contradiction is `unknown`.
Nothing is re-sent after an `unknown` outcome.

A precondition rejection creates an operator-order placeholder in the queue
in the rejection's own synchronous section; settlement only resolves it into
the requeued input or removes it. A later operator input therefore queues
behind the rejected one instead of being steered ahead of it.

Precondition rejections are classified from `error.data.codexErrorInfo.activeTurnNotSteerable`
and from the two measured `-32600` messages for an expected-turn mismatch and
no active turn; see the [Stage 2 probes](../../evidence/codex-app-server/stage2-steer-probes-2026-09-30.md).

The transport records its bound thread and up to 256 turn IDs it started;
past that, the oldest ID is forgotten, so a late item of a turn started more
than 256 turns earlier in the same session would read as foreign. A
turn on that thread which this host did not start is foreign, whether it
appears with no active turn, before a start response names the host's turn,
or while another turn is active. Only `turn/started` and `item/*`
notifications are evidence of a running turn: after `thread/resume`, the
app-server sends thread-level notifications such as `thread/tokenUsage/updated`
carrying past turn IDs, and those are never treated as foreign. Every persona
records a `codex_foreign_turn` diagnostic line; an opted-in persona also stops
steering and refuses the next `turn/start`.

That refusal stops the host through the same path as a lost app-server
connection: the current turn finishes, the host enters `error`, and every
queued entry is discarded without being sent. A queued inter-agent batch,
including one that was about to start, settles once through the turn-end and
finalization callbacks with the stop as its error, so the sending peer learns
it was not delivered. Queued operator input is dropped. Recovery is an
operator session reset or wrapper restart.
