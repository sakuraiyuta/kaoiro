---
title: "Codex app-server transport"
status: implemented
last_updated: 2026-10-08
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

The reviewer is pinned to `user`, analytics disabled, and `experimentalApi`
false. Thread start and resume, and every `turn/start` of a persona without
the approval opt-in, carry approval policy `never`; see
[Approval requests](#approval-requests-adr-0064). A server request that is
not routed receives JSON-RPC error `-32601` and an optional diagnostic without
its payload. The `stderrTail` accessor retains up to 16,384 characters for
diagnostics; callers must redact it before logging.

The wrapper sends `shell_environment_policy.set.CODEX_HOME` with a private
tool home on both `thread/start` and `thread/resume`. The app-server process
retains the state home for auth and sessions. Whether the final pinned native
binary applies the per-thread policy to a resumed thread remains a release
gate; a successful RPC alone does not establish the tool environment.

## Operator steering (ADR-0058 Stage 2)

An opted-in Codex persona on the app-server backend may deliver an operator
instruction into the running turn with `turn/steer` instead of queueing it
(opt-in: [wrapper configuration](../configuration/wrapper.md#codex-operator-steer-controls);
capability: [`operator_input_modes`](../protocol/channels.md#adr-0063-capability-and-event-contract)).
Only operator text whose delivered intent is `early` is eligible. Work notices,
session-reset notices and inputs with attachments queue. Inter-agent early
input has a separate [lease and admission path](#inter-agent-early-steering-adr-0063-phase-3).

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

## Inter-agent early steering (ADR-0063 phase 3)

An app-server wrapper advertises `early: "steer", yield: "none"` at join. It
steers only a server-granted early peer input after both delivery-mode and
`notice_attribution: "v1"` echoes. The exec backend always queues peer input.
This path has a distinct per-sequence lease, reply ticket, write-state guard,
and three-write IA quota within the common eight-steer turn cap. An older
same-peer root or unresolved steer blocks a successor; a rejected steer keeps
its queue position through a placeholder owned by the IA coordinator. Each
rejected fallback becomes one ordinary-format root, regardless of the
coalescing cap, before later same-peer input. Terminal reclassification removes
the slot; failed replacement retires the unstarted delivery and emits a
diagnostic. Operator placeholders have separate ownership. An operator steer cannot bypass
the common pending-settings, approval, reset, foreign-turn, and watchdog
guards.

### When an early input is queued

A server-granted early peer input that is not steered writes one wrapper stderr
line, `[kaoiro] inter-agent early input queued: <reason> seq=<n> from=<sender>`.
An input granted as normal writes none, and a failing sink never changes the
delivery. The reason is one of:

| Reason | Meaning |
|---|---|
| `steer_not_negotiated` | The exec backend, or the join lacks the `early: "steer"` echo or `notice_attribution: "v1"`. |
| `invalid_delivery_identity` | The delivery has no conversation id or no valid delivery sequence. |
| `behind_earlier_input_same_sender` | An earlier input from the same sender is queued for, or running in, this recipient; the batch the running turn carries counts. |
| `behind_open_root_same_conversation` | A root for the same conversation is open or pending. |
| `too_large` | The formatted message exceeds 16,384 bytes. |
| `no_active_turn` | The recipient is idle; the input starts a turn. |
| `conversation_terminal` | The conversation has closed. |
| `delivery_identity_unavailable` | The wrapper has no delivery incarnation and generation yet. |
| `reply_authorization_unavailable` | The wrapper could not prepare a reply ticket. |
| `idle`, `turn_starting`, `behind_earlier_input`, `pending_settings`, `turn_ending`, `reset_pending`, `steer_cap`, `inter_agent_steer_cap`, `inter_agent_steer_unavailable`, `stale_delivery_generation` | The host's admission refused the steer; `behind_earlier_input` includes any other queued entry except a reset notice. |

A steer request's valid response and a completed `userMessage` with matching
`clientId` and exact text are independent facts. Both must arrive before turn
terminal to activate its reply ticket. `submitted` can be reported from either
fact. A possibly written request without corroboration reports `unknown` and
is never automatically replayed; an unwritten request queues. A late response
may settle delivery evidence after terminal, but cannot activate a ticket.
The wrapper retains only activated bodies for bounded stale-basis recovery.
Sequence-scoped failure notices identify which peer turns were affected.
See [delivery status](../inter-agent/delivery.md#codex-app-server-early-handoff).

On pin 0.156.1 the write and response order is based on the app-server RPC
and projected item stream. The changed interruption primitives in later
pins require a new native comparison before any pin migration; the phase-3
design records the [0.159.2 comparison](../../evidence/codex-app-server/pin-0.159.2-evaluation-2026-10-01.md#authenticated-comparison-and-stage-3-denial).

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

## Approval requests (ADR-0064)

An opted-in Codex persona on the app-server backend exposes approval as a
mutable axis ([ADR-0064](../../adr/0064-codex-app-server-approval-requests.md);
opt-in: [wrapper configuration](../configuration/wrapper.md#codex-approval-axis-controls)).
Each `turn/start` carries the approval the runtime captured for that
execution (`untrusted`, `on-request` or `never`); the policy written is kept
on the turn's reservation and is the only policy the gate reads, so a
selection changed mid-turn cannot open it. The exec backend and a
non-opted-in persona write `never`.

### Routing and admission

`AppServerRpc` hands every server request with a fresh typed id (`n:1` and
`s:1` differ) to the transport synchronously in wire order. A reused id, or
the request past 65,536 ids on one connection, fails the connection with
kind `protocol` and no answer, because any answer would carry an ambiguous
id. Nothing is evicted below the bound.

Each request becomes one record. Admission is this list, checked top to
bottom at receipt and again when the reservation's start is set:

| Rule | Condition | Result |
|---|---|---|
| 1 | method is not `item/commandExecution/requestApproval` or `item/fileChange/requestApproval`, or params are invalid | rejected (`-32601` if writable) |
| 2 | the connection has failed | dropped |
| 3 | `threadId` is not the bound thread | rejected |
| 4 | no turn reservation at receipt | rejected |
| 5 | the reservation was aborted by the host | dropped |
| 6 | the reservation's own turn completed | dropped |
| 7 | the `turn/start` response has not arrived | held |
| 8 | the start failed, or named another turn | rejected |
| 9 | gate closed: no opt-in, or the turn's policy is `never` | rejected |
| 10 | otherwise | pending: shown to the operator |

The reservation's facts only accumulate: `aborted` is set by the host before
it aborts the turn (operator interrupt, watchdog interrupt or fail-stop,
close); `terminal` is set when the reservation's named turn completes, on the
wire or while the buffered window is replayed; `start` is set once. A
`turn/completed` for another turn or on another thread sets nothing.

### Record states and events

Events: `R` receipt, `Kn` / `Ku` the start named a turn / ended without one,
`S` `serverRequest/resolved` for the id, `T` the reservation's terminal, `F`
connection failure (a duplicate id is `F`), `A` host abort, `D` operator
decision, `X` deadline. The first event that leaves a live state wins.

| State \ Event | R | Kn / Ku | S | T | F | A | D | X |
|---|---|---|---|---|---|---|---|---|
| absent | admission | fact only | ignored | fact only | fact only | fact only | cannot happen | cannot happen |
| held | cannot happen | admission | dropped | cannot happen: a named start re-admits held records first | dropped | dropped | cannot happen | cannot happen |
| pending | cannot happen | cannot happen: the start is set once | dropped | dropped | dropped | dropped | replied (`accept` / `decline`) | replied (`decline`) |
| replied, dropped, rejected | cannot happen | ignored | ignored | ignored | ignored | ignored | ignored | ignored |

A write happens only on `D`, `X` or a rejection. A pending record that is
dropped aborts its broker request, which clears the dialog. The measured
0.156.1 order after an interrupt is the terminal, then `serverRequest/resolved`
([Stage 3 evidence](../../evidence/codex-app-server/stage3-approval-probes-2026-09-30.md)),
so the record ends on `T` and `S` is ignored.

### The reservation window

`#endReservation` is the only exit of the window between reserving a turn
and learning its id. It runs once, synchronously, before the error of a
failed start is rethrown and before another start can reserve (the
`AppServerPermissionSuperseded` retry included):

- It judges every deferred turn evidence item (`turn/started`, `item/*`
  notifications and `item/*` server requests) with the issue #366 predicate.
  An unnamed ending names no own turn, so evidence for any unknown turn is
  foreign.
- For a named start it sets `terminal` if the buffer holds that turn's
  `turn/completed`, sets `start`, re-admits held records, and only then is the
  buffer replayed. The active turn stays until its terminal is delivered.
- An unnamed start (JSON-RPC error, or a failure before `turn/start` is
  written) rejects held records; a connection failure drops them. Both
  release the active turn.

Notifications buffered before the `turn/start` response are bounded at
4,096; the next one fails the connection (`protocol`) instead of evicting,
because the buffer is the source of the terminal fact.

### Operator path

The shared `PermissionBroker` shows a pending record in the single
`pending_permission` slot ([ADR-0022](../../adr/0022-pending-permission-authoritative-source.md))
with `tool_name` `codex:command_execution` or `codex:file_change`. The input
is `{command, cwd, kind, reason?, command_actions?, network?, approval_id?}`
or `{item_id, reason?, grant_root?, changes? | changes_unavailable}`, plus
`inactivity_limit_ms`. `changes` comes from the latest `fileChange` item
snapshot keyed by `(threadId, turnId, itemId)` of the request itself: an item
id is not assumed unique across turns, so a late item of another turn, before
or after the start response, never supplies or overwrites it. Only the named
turn's items are stored, at most 256 per turn: items received in the
reservation window are taken from the bounded window buffer when the start
response names the turn, and later items at wire receipt. Items of other turns
therefore never take that budget. Without a matching snapshot the input says
`changes_unavailable`.
The 16 KB rule applies.

The broker's settle runs the record's callback before the slot changes and
reports the cause: an operator allow writes `accept`, a deny `decline`, a
deadline `decline`; an abort or close writes nothing. `decline` carries no
message. Command approvals on 0.156.1 carry an `availableDecisions` list
that is not in the generated schema and omits `decline`; `decline` was
measured to be honoured, and that capture is pinned in a test with the Codex
pin. There is no deadline unless `permission_timeout_ms` is configured. The
turn watchdog stays active, so an unanswered request ends with its turn at the
configured inactivity limit; the dialog states that limit.

Not offered: `acceptForSession`, policy amendments, `cancel`,
`item/permissions/requestApproval` (always `-32601`), and elicitations. The
bridge tools raise no server request under `on-request` or `untrusted`
(probes P4a/P4b), so they keep their own operator gate.
