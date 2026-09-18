---
title: Inter-agent conversation admission
status: provisional
last_updated: 2026-09-18
description: Inter-agent conversation admission and its boundaries.
---

# Inter-agent conversation admission

Structure is defined by `Envelope`, `InterAgentMessagePayload`, and
`InterAgentMessageKind` in [@kaoiro/protocol](../../../protocol/src/index.ts);
this page specifies the corresponding semantics.

### Explicitly supplied unknown conversation_id (issue #252)

The only canonical path for starting a new conversation is to omit
`conversation_id` (see [CID reuse](conversations.md#cid-reuse-is-not-a-contract-issue-167-review-s2)). Before issue #252, however, the server did not
distinguish this case and **silently accepted an explicitly supplied unknown
`conversation_id` as a new conversation**. Three director transcription errors
on 2026-08-16–17 became apparently valid threads instead of errors. This path
now fails fast and visibly.

- **Transmit the distinction with `payload.new_conversation` (MUST)**:
  true only for an initiating wrapper send where the caller omitted
  `conversation_id` and this wrapper allocated a new one. Replies and notices
  (`peer_error` / `stale_turn`) and sends where the agent supplied an explicit
  ID use false. The server cannot distinguish omission from an erroneous
  explicit ID by the CID string alone (allocation and UUID uniqueness belong
  entirely to the wrapper), so this boolean is the sole input to the check.
- **Server decision** (`ConversationStates.record_message/8`): reject with
  `{:error, :unknown_conversation_id}` only when no entry for the
  `conversation_id` exists (neither open nor tombstoned) and
  `new_conversation? == false`. If an entry exists (open or closed), ignore
  this flag; `conversation_closed`, `participants_mismatch`, and `stale_turn`
  retain their existing precedence. An unknown CID with
  `new_conversation? == true` is the normal new-conversation path and never
  reaches this check.
- **Sender-wrapper tool result**: do not return the raw
  `unknown_conversation_id` reason. Return wording that asks for a retry with
  the correct ID or a new conversation by omission
  (`send_to_agent failed: conversation_id=<id> is unknown to the server — retry
  with the correct conversation_id, or omit it to start a new conversation
  (this can also mean the server restarted since this conversation began,
  which drops all of its state).`). The server has no persistence, so a
  restart removes every in-flight conversation and makes subsequent explicit
  sends unknown. Mentioning this possibility avoids wasting a turn while the
  sender assumes only a transcription error. No special local-track handling
  is needed: an explicitly supplied unknown CID naturally satisfies the
  `wasBlank` (“no meaningful history”) test and existing reject cleanup resets
  it.
- **Known exception (intentionally accepted residual)**: a send with
  `new_conversation? == false` that is a valid reply or continuation of an
  existing entry is unaffected because `existing != nil` bypasses this check;
  all messages after the first use this path. Only an explicitly supplied CID
  from a typo or copied old session that matches no entry is affected.
- **Treat missing `payload.new_conversation` as true rather than rejecting**
  (review, issue #252 delta, Chloe M1):
  `validate_live_inter_agent_payload/1` requires the key only when present and
  rejects non-boolean values. Wrappers predating issue #252 omit the field,
  while the Phoenix client keeps reconnect/heartbeat itself
  (`wrapper/core/src/transport.ts`), so old processes can continue sending
  after only the server is redeployed. Making the key mandatory would reject
  all such live sends with `missing key: payload.new_conversation`, contrary to
  [ADR-0015](../../adr/0015-protocol-version-stamping.md)'s best-effort policy of
  ACKing and processing version mismatches. `preflight_inter_agent/2` reads a
  missing key as true (`case payload do %{"new_conversation" => false} ->
  false; %{"new_conversation" => true} -> true; _ -> ... end`) and emits the
  same style of protocol-version warning as `agents_channel.ex` for each such
  message (`inter_agent_message: client declared new_conversation (absent);
  accepting as true (issue #262 legacy best-effort accept)`). During migration,
  an explicit unknown CID from an old wrapper therefore opens a new
  conversation silently instead of being rejected; this temporary regression
  disappears once wrappers are updated and is not a permanent bypass.
  - **Per-message warnings from old wrappers are intentional** (review, Chloe):
    existing ADR-0015 warnings such as `refresh_engine_catalog` occur only on
    connection or catalog updates, whereas this warning appears on **every
    inter-agent send** until the old wrapper is updated. The high frequency is
    not itself an anomaly; this paragraph is normative so operators do not
    misread the growing log share during a long migration.
  - **`ConversationStates.record_message` requires `new_conversation?`** (director ruling,
    issue #252 delta round 2): the initial implementation gave
    `new_conversation?` a `\\ true` default so channel callers could omit the
    branch, merely moving the “silently allow when forgotten” defect from the
    wire layer into the internal API. Making the argument mandatory forces
    every future caller to state the decision explicitly; the absent branch in
    `preflight_inter_agent/2` above is the only legal place to choose the
    permissive side. The separate eighth `server` argument does have a default
    (`__MODULE__`), so normal callers use `/7`; this does not default the
    mandatory seventh `new_conversation?` argument. The cost was mechanical
    argument updates for existing callers (mostly tests, about 90 sites).
  - **Removal criterion**: this absent-field branch is not permanent. Once
    operations confirms that every running wrapper is built after issue #252,
    make `validate_live_inter_agent_payload/1` require the key again and remove
    `warn_legacy_new_conversation_absent/0`. The trigger is the operator's
    confirmation that no old wrappers remain, not a fixed TTL such as
    `CLOSED_TRACK_TTL_MS`.

## Related inter-agent topics

- [Inter-agent messaging](../../architecture/inter-agent-messaging.md).
- [Inter-agent message contract](messages.md).
- [Inter-agent conversation contract](conversations.md).
- [Remaining protocol topics](../../specs/protocol-inter-agent.md), including approval and session-operation tools.
- [Delivery confirmation and recovery](delivery.md).
- [Send and wait](send-and-wait.md).
- [Coordination monitoring and display](coordination-monitoring.md).
- [Peer directory and companion tools](directory.md).
