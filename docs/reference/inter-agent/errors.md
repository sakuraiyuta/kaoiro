---
title: Inter-agent error notices
description: Error notices, their sources, stale-turn resynchronization, and server-synthesized reachability rules.
status: provisional
last_updated: 2026-09-18
related: [protocol, inter-agent-messaging]
---

# Inter-agent error notices

## Unresponsive notices (`payload.error`)

When a peer cannot answer because of a usage limit, context overflow, or lost
connection, return that fact to the **originating agent itself**
([issue #127](https://github.com/sakuraiyuta/kaoiro/issues/127)). The origin
must be able to decide whether retrying is futile, whether to wait, or whether
to escalate to an operator, and must distinguish this from a silent timeout
(`reply_pending`). No new envelope type or kind enum member is added; presence
of `payload.error` is the discriminator.

```json
{
  "to": "lab-pc-1.claude-a",
  "conversation_id": "cnv-7f3a1c",
  "turn_number": 0,
  "kind": "inform",
  "body": "peer lab-pc-1.claude-b is unreachable: rate limit reached",
  "error": {
    "code": "rate_limit",
    "message": "peer lab-pc-1.claude-b is unreachable: rate limit reached"
  },
  "meta": { "done": false, "propose_next": "" },
  "owner": { "kind": "user", "id": "system" }
}
```

 - `kind` reuses `"inform"` (the nine-member enum is unchanged). Older
  receivers that do not know `error` display it as a normal inform.
- Repeat the same human-readable reason in `body` for old-client display
  compatibility.
- `meta.done` is always false in Phase 1; the originating agent decides whether
  to end the conversation.
- Never put secrets such as tokens in `error.message`; the emitting wrapper
  masks and truncates it.

### Error codes (initial set)

`code` is an open string rather than an enum so engine-specific values can be
added later. Treat an unknown code as `api_error`.

| code | meaning | recommended action for origin |
|---|---|---|
| `delivery_lost` | server explicitly retired an undelivered message or unrecoverable synthetic notice | Confirm current peer/conversation state before retrying; duplicate loss IDs do not require another action. |
| `rate_limit` | usage or quota exceeded | Immediate retry is futile; wait or escalate. |
| `context_overflow` | context length exceeded | Retry with the same content is futile; summarize/split or escalate. |
| `api_error` | engine/API error or classification fallback | One retry is allowed; escalate if it repeats. |
| `timeout` | peer processing timed out (Antigravity: a tool step past the absolute `KAOIRO_ANTIGRAVITY_TOOL_TIMEOUT_MS` deadline ended the turn with `error_detail: tool_timeout`, [antigravity tools and permissions](../engines/antigravity-tools-permissions.md#tool-children-prompts-disabled-absolute-tool-deadline-issue-350)) | Wait, then retry. |
| `permission_gate_blocked` | peer reached the permission dispatch deadline before an execution started | Ask the operator to reapply the same sandbox/network values (allocating a new revision), then resend. Never retry automatically. |
| `interrupted` | peer turn was interrupted | It may be operator-driven; check state before retrying. |
| `reconnecting` | server announced a wrapper restart | Do not escalate; wait for `reconnected`, then retry the same `conversation_id`. |
| `disconnected` | peer wrapper disconnected; optional `origin` / `reason` identifies the terminal cause | Retry is futile until it returns; escalate. |
| `stale_turn` | receiver discarded a message whose turn_number was at or below its known maximum (AC9) | Send using a new conversation_id. |

### Sources (four paths)

| source | trigger | path |
|---|---|---|
| peer wrapper | SDK turn ended with `is_error` while an inter-agent injection in that turn remained unanswered | Send directly through ServerLink to the conversation origin (no broker approval because it bypasses the model); route as a normal `inter_agent_message`. |
| server | wrapper channel terminated | Synthesize `code=reconnecting` for a planned cycle or `code=disconnected` otherwise. A terminal notice repeats the validated `origin` / `reason`, then pushes to every other participant in each conversation of that wrapper. |
| server (preflight) | `envelope` send addressed to a `to` that is known but unexpectedly disconnected, with no active planned intent | Reject the `envelope` push itself with `reason=disconnected` and optional `disconnect {origin, reason}` before `ConversationStates.record_message` (issue #257) — without this, the disconnect that would ever trigger the notice above already fired (or never will while `to` stays down), so no notice follows and the send would silently drop. The sending wrapper maps the synchronous reject to the same structured `peer_error.code=disconnected` as the async notice. |
| receiver wrapper | AC9 discarded a stale/duplicate turn (issue #212 defect 3) | Send directly through ServerLink to the discarded envelope's sender, except when that envelope is itself an error notice or the conversation is already closed (next section). |

### `stale_turn` notice structure (issue #212 defect 3)

Unlike other codes, `stale_turn` is both a **notice and a side effect that
resynchronizes the receiver's turn number to the sender**. Its
`turn_number` is freshly allocated from the receiving wrapper's
`track.turnNumber`. The sender's `receiveInbound()` treats the envelope as a
normal (non-stale) inbound and advances its own track to that value. Its next
send can therefore use the same `conversation_id` with the skew removed. Keep
this resynchronization role in mind if the mechanism is reconsidered.

Send the notice when AC9 rejects a stale turn, but not unconditionally:

- **If the target envelope already has `payload.error`** (it is itself a
  notice), replying with another notice could bounce forever between two
  skewed counters. Advancing the number cannot prevent this because stale
  comparison uses the receiver's own track. Excluding notices bounds the
  exchange to one message.
- **If the target conversation is already `closed`**. A late message for a
  closed conversation differs from a stale turn in a live conversation; the
  sender has already (or will on its next send) receive `conversation_closed`
  and the AC10 local rejection. Retrying adds no value and there is no target to
  resynchronize. Still log the discard so this exception does not create a new
  silent path.

Engine differences are absorbed in the shared classifier (engine-agnostic,
[ADR-0032](../../adr/0032-codex-adapter.md) F5); unclassifiable events fall back
to `api_error`. Engine reason/detail strings are used **only for internal
keyword classification**. Always use a fixed code-specific template for
`error.message` and `body`, never exposing raw exception text to a peer LLM;
the template also guarantees the required secret masking.

### Server-synthesized (`reconnecting` / `reconnected` / `disconnected`) rules

- A synthesized envelope uses `agent_id: "server"`, `turn_number: 0`, and
  `owner: {kind: "user", id: "system"}`, matching hard-limit envelopes; set
  `payload.to` per recipient.
- Candidate destinations are **all other participants** in every conversation
  of the wrapper. Planned cycles apply the target-pair cap below (Phase 1 has
  `max_concurrent_agents = 2`, so this is effectively one recipient per
  conversation).
- Push to both `wrapper:<recipient>` and `agents:lobby`, the same observation
  path as synthesized escalation.
- Do **not** add synthesized notices to turn or token counters: they are
  server metadata, not dialogue turns.
- Keep the conversation entry. A returning wrapper can continue with the same
  `conversation_id`; existing wall-clock GC reclaims abandoned entries.
- Planned cycles are limited to `session_reset` (operator or agent-self), a
  live agent `resume_session` (`switch_session`), and operator `restart`.
  Before sending to the runner, reserve one intent per agent and carry the
  server-issued `request_id` through runner to wrapper `transition_id`.
  Direct kills, SIGKILL, autonomous runner/service restarts, and operator
  `stop` do not start a planned cycle. If `stop` races an active intent,
  cancel the intent instead of returning `agent_busy`, and close already-notified
  targets with terminal `disconnected`.
- On a planned disconnect, take a read-only snapshot of peers in open
  conversations and send `reconnecting`. The notification source of truth is
  the deduplicated union of that snapshot and `{conversation_id, sender}` pairs
  bounced with `peer_reconnecting` during the planned window. Cap the union at
  50 `{conversation_id, peer}` pairs, preferring tracked bounces and filling
  remaining slots from the snapshot; warn with count and targets for omitted
  pairs. Do not consume the ordinary-unreachable mark: a peer that already got a
  terminal notice may still need `reconnected`, and can receive `disconnected`
  again after recovery without exchanging IA.
- In either `announced` or `disconnected` phase, close the intent and send a
  normal `kind=inform` with no `payload.error` (protocol outcome `reconnected`)
  only when a later join presents the same non-empty `transition_id`. Fixed
  wording says the peer is reachable and may be retried with the same
  conversation_id without asserting physical reconnection. Mismatched, empty,
  or missing tokens do not close the intent.
- On planned-intent timeout or terminal failure, if authoritative `AgentStates`
  is still `disconnected`, send terminal `disconnected` to the target union
  regardless of ordinary `notified_unreachable` marks. If an old or rollback
  wrapper is live, send `reconnected` to the same union rather than leaving
  bounced senders waiting, then close the window. For reset,
  `spawn_failed` means rollback startup succeeded, so retain the intent until a
  matching join or timeout; `rollback_failed` closes it as terminal failure
  (issue #248).
- Do not synthesize for a stale terminate after reconnection; emit only when the
  server actually adopts `disconnected` state.
- An ordinary unexpected `disconnected` is sent once per conversation and is
  suppressed until that agent speaks again. A terminal planned-cycle
  `disconnected` that closes the target union bypasses this mark. Entries remain
  and counters do not change on disconnect; without suppression a crash-looping
  wrapper would consume peer turns repeatedly.
- Cap ordinary notifications by conversation count and planned cycles by target
  pairs (both default to 50). Each notice produces two broadcasts
  (`wrapper:<peer>` and `agents:lobby`), so the cap prevents fan-out
  amplification. Log overflow rather than silently dropping it.
  `PlannedDisconnects.max_unreachable_notices/0` is the shared source for
  ordinary claims and planned snapshots. Retain a bounced target that already
  received `peer_reconnecting` so its close notice is guaranteed. Planned
  terminal handling marks and delivers only this bounded union and claims no
  additional ordinary target.

New IA to a destination with an active planned intent is rejected during server
preflight as `peer_reconnecting`. The reject updates no `ConversationStates`,
pane, or recipient delivery ledger. The active check and union insertion are
atomic in one `PlannedDisconnects.track_bounce` call. If closure wins first and
returns `:noop`, continue normal preflight and do not return
`peer_reconnecting` for a message that was not recorded. After 50 slots, an
unregistered pair is rejected as `peer_reconnecting_capacity` and is not added
to state. Its sender receives no `reconnecting` and has no contract to wait for
a later close notice; old wrappers treat the unknown reason as their generic
`isError=true` reject (only the new wrapper's fixed retry guidance is missing).
The wrapper normalizes the tool result to
`{peer_error: {code: "reconnecting", message, from}}` and neither retries nor
escalates until `reconnected`. Momentary delivery gaps outside the planned
window are issue #257.

Every state-machine exit (matching join, failure, timeout, operator stop,
disconnected-agent purge, or setup failure before runner relay) passes the same
target union to either `reconnected` or terminal `disconnected`. The existing
ordinary-claim rule—do not notify the same conversation again until it speaks—
remains; delivery gaps outside the planned window are out of scope.

### Receiver handling

- When a `wait_for_response: true` waiter receives an envelope with `error`,
  return it as the reply in the same tool result. The sender distinguishes it
  from `reply_pending` by the presence of `error.code`.
- For asynchronous next-turn injection, include `error.code` in the injected
  text (SHOULD), preferably as `error=<code>` on the existing metadata line.
  The originating agent must be able to choose an action from the code.
