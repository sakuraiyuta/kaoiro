---
title: Coordination monitoring contract
status: provisional
last_updated: 2026-09-18
description: Coordination monitoring contract, including notification boundaries and limitations.
---

# Coordination monitoring contract

### Rally

A rally is counted per **agent group across conversations**, not per
`conversation_id`. `max_turns` closes a conversation and the protocol then
forces the peers onto a fresh id, so a loop that recurses far enough
necessarily spans several entries and a per-conversation count measures the
wrong unit. `ConversationStates.pair_rally/2` sums each OPEN entry's live
`turns` and every tombstone closed within `rally_window_ms`, keyed by the
sorted participant list.

`rally_window_ms` must not exceed `inter_agent.tombstone_ttl_ms`: tombstones
are the only record of a closed conversation, so a longer window silently
under-reports rather than reaching further back. The server refuses to boot
on a violation.

### Stall

A stall is an unacknowledged dispatch gap: `acked_seq < issued_seq` with
`pending_since` older than `stall_ms`, read from the dispatch-confirmation
[delivery ledger](delivery.md). A live `result` received by the server after `pending_since`
changes the notice reason to `delivery_confirmation_gap`: the recipient has
completed work during the unresolved period, so missing dispatch confirmation
must not be presented as proof that it stopped processing. This observation
uses server receipt time, resets on session changes, and excludes replayed
logs, idle states and wrapper timestamps. It does not prove every delivery
was processed. Changing the reason updates an existing notice.

**Known limit:** the ledger is a watermark, and a wrapper process replacing
its predecessor abandons the gap (`acked_seq := issued_seq`), so a stall is
detected only while one wrapper generation persists. A stall spanning a
wrapper restart is not reported.

### Wire

- `quagmire_notice` is an operator-only push on `agents:lobby`, gated in
  `handle_out` like `delivery_status`. It is **edge-triggered**: one notice
  per condition per subject when it first crosses, and again only after the
  subject has fallen back below or its stall reason changes. It is deliberately not a join snapshot
  frame — a joining operator reads the current picture from
  `list_conversations` and `delivery_snapshot`. A sweep whose store is
  unavailable skips that detector alone and keeps what the other already
  announced, so one outage does not re-announce an unrelated condition on
  every tick.
  - rally: `{kind: "rally", participants, turns, conversations, threshold, window_ms}`
  - stall: `{kind: "stall", agent_id, undelivered, pending_since, threshold_ms, reason?}`
- A dashboard removes a stall notice only when a delivery status or snapshot
  explicitly shows that recipient's `issued_seq == acked_seq`. A missing/null
  ledger, incomplete snapshot omission or another recipient's status is not
  resolution evidence. Resolved status permits `pending_since: null`.
  Rally notices are unaffected.
- `list_conversations` rows additionally carry `rally_turns`,
  `rally_conversations`, and `quagmire`. The verdict is computed server-side
  rather than shipping the threshold for a client to compare, so one place
  owns what "quagmire" means.
- `set_quagmire_settings {rally_turns}` (client → server, operator-only)
  changes the rally threshold at runtime; `null` is ∞. Out of range
  (1..999), non-integer, or an ABSENT key returns `invalid_rally_turns` —
  JSON `null` and a missing field both arrive as nil, and only one of them
  means off, so an absent key is refused rather than read as a request to
  disable.
- `quagmire_settings {rally_turns, source}` is the matching operator-only
  push: on join, and again whenever the threshold changes, so several
  dashboards agree on what is in force. `source` is `stored` / `env` /
  `default`. Unlike `quagmire_notice` this IS a join frame — a threshold is
  state rather than an edge.

### Configuration

`config :kaoiro_server, :quagmire` — deliberately separate from
`:inter_agent`, which configures conversation hard limits and memory-reclamation
TTLs. Quagmire thresholds produce notices rather than rejecting or closing
conversations.
`rally_turns` / `rally_window_ms` / `stall_ms` / `sweep_interval_ms`;
`KAOIRO_QUAGMIRE_RALLY_TURNS` and `KAOIRO_QUAGMIRE_STALL_MS` override the two
an operator would retune without a rebuild, and an invalid value raises at
boot rather than reverting to a default nobody chose.

**`rally_turns` is also runtime-mutable.** `QuagmireSettings` holds the
operator's pick in its own DETS store
(`KAOIRO_QUAGMIRE_SETTINGS_PATH`, part of the canonical persistence set in
[deployment](../../specs/deployment.md)), and precedence is stored > env > `config.exs`.
The detector reads it on every sweep and both the notice and the
`list_conversations` verdict follow it, so one threshold governs all three.
An unreachable store falls back to the boot value for that sweep rather than
disabling rally detection.

Changing it does NOT reset the edge memory, and deliberately so:
`notified_rally` is rebuilt from the current over-threshold set on every
sweep, so raising the threshold drops the subjects that fell below it and
lowering it announces the newly-crossed ones once. Clearing the memory
instead would re-announce subjects the operator has already seen. The server
cannot retract a notice it already sent, so the client drops banners whose
turn count the new threshold no longer covers.

The remaining three stay boot-time. `rally_window_ms` in particular is
validated against `tombstone_ttl_ms` at boot, and none of the three is a
per-session judgement.

### Observation path (dashboard display)

The server also broadcasts each `inter_agent_message` envelope to
`agents:lobby`, but, like `log` and `result`, delivery is **operator-only**
([ADR-0021](../../adr/0021-role-information-disclosure-policy.md)).

On receipt, the dashboard displays the message in the log panes of both
`agent_id` (sender) and `payload.to` (recipient). The client defines the exact
format, but it must at least provide:

- sender log: `→ to <to>: <body>(kind, conversation_id excerpt)`
- recipient log: `← from <agent_id>: <body>(kind, conversation_id excerpt)`
- a visual grouping by conversation_id so one dialogue can be followed.

Because this is a separate envelope type from `log`, existing log filters and
read-state handling remain independent.

The server retains display state as a **per-pane projection** (volatile sender
and receiver panes). Live display, F5 restoration, and replay after restart
all use the same upsert contract ([ADR-0051](../../adr/0051-history-restart-resilience.md)
D3-1). The cap is the newest 200 envelopes in the final projection after
transcript rows and IA are merged chronologically per pane; IA no longer gets
an exemption from the cap.

## Related topics

- [Design rationale and provisional defaults](../../architecture/coordination-monitoring.md).
- [Delivery confirmation](delivery.md).
- [Authentication and authorization](../security/authentication-authorization.md).
