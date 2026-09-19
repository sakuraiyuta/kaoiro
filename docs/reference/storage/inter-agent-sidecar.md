---
title: IA sidecar and display restoration
status: provisional
last_updated: 2026-09-19
description: The wrapper-host IA sidecar's on-disk format, compaction, and the replay_ia restore path.
related: [protocol-inter-agent]
---

# IA sidecar and display restoration

### IA sidecar and display restoration ([ADR-0051](../../adr/0051-history-restart-resilience.md))

The canonical store for structured IA is the **IA sidecar on the wrapper
host**, not the server (`InterAgentHistory` DETS is retired).

- **Recording**: when a wrapper sends or receives IA, append the complete wire
  envelope and the server-assigned `ingress_stamp` in structured form to a
  sidecar file beside the engine transcript. Each JSONL line is
  `{"ingress_stamp": [us, seq], "envelope": {...}}`.
  - Path (fixed at implementation, 2026-08-08): `<transcript dir>/<session-id>.ia.jsonl`.
    claude-code uses `~/.claude/projects/<encoded-cwd>/`; codex uses the
    directory containing the rollout file.
  - Receiver: record when delivery from the server is received, **before** SDK
    injection. Server-synthesized envelopes (direct error notices) are also
    recorded. A phantom sidecar row left by failed injection is accepted.
  - Sender: record when the **acceptance ack reply `{ingress_stamp}`** for the
    `envelope` push arrives. Do not use the MCP tool result as the ack
    (`wait_for_response=true` waits for the peer reply). Do not record rejects,
    timeouts, or lost acks (loss is accepted; warn on stderr).
  - **Ack and tool-result relationship** (Fujino 30-10 must-fix M5,
    2026-08-08. The ack path and reject-as-tool-error requested by issue #167
    Stage 3 were already satisfied by this ADR-0051 implementation; #167 only
    added `conversation_closed` to the reject-reason list): the recording
    trigger remains the ack, and the `send_to_agent` **tool result is decided
    by the same ack**. Accepted sends keep returning `sent ...`; explicit
    server rejects (`unknown_agent`, `self_routing`, `participants_mismatch`,
    `conversation_closed` (issue #167), `unknown_conversation_id` (issue #252),
    etc.) return an **error result carrying the reason**. Only
    `unknown_conversation_id` includes the special wording that asks for a
    correct-ID retry or a new conversation by omission (below). A timeout or
    lost ack is “delivery unknown”: do not call it an error because retrying
    might duplicate delivery, and state this in the result body. Rejects and
    unknown delivery release `wait_for_response` immediately instead of waiting
    for a peer that cannot answer. If a peer reply has already arrived when the
    ack is lost, treat delivery as successful and return normal `sent + reply`
    (the reply itself proves delivery; Fujino 30-10 round-2 R3,
    2026-08-08).
  - **Relation to unresponsive notices (#127)** (Fujino 30-10 round-2 R2,
    2026-08-08): the “replied” decision for an injected inbound is also based
    on acceptance. Clear the pending injection for accepted or unknown
    delivery, but **not for a reject**—the send did not happen, so an error
    notice must be emitted at turn end. Unknown delivery clears it because a
    notice would otherwise contradict a message that may have been delivered.
  - Skip corrupt or truncated rows and warn on stderr; fsync is not required.
    Keep paths inside the transcript directory, sanitize session_id, and never
    follow symlinks.
  - **Read order** (Fujino 30-10 must-fix M3, 2026-08-08): the newest 200 rows
    on restore are the last 200 by ascending `ingress_stamp`, **not the last
    200 file lines**. Append order can differ from ingress order: on quota
    overshoot a server notice (high stamp) arrives first, while the triggering
    message (low stamp) is appended after its ack. Cutting by file order would
    keep the old notice and drop the new message. Collapse duplicate rows with
    the same stamp into one row (from bind-time appends).
  - **Compaction** (issue #192, 2026-09-18): the sidecar is a lossy replay
    cache, not an append-only audit log. After 4 MiB has been appended since
    the last successful canonicalization, rewrite it to the exact newest 200
    records by `ingress_stamp`. The canonical file starts with a recognized
    non-message marker containing format version, the minimum historical
    `retained_cap`, and the canonical data byte baseline. `retained_cap` never
    increases: a future larger replay cap must report that discarded history
    is incomplete rather than implying it can be recovered. No archive is
    created, so rows outside the retained set are irreversibly deleted.
  - On path activation, immediately compact an unmarked legacy file whose
    existing growth exceeds 4 MiB. `read()` is the backstop for smaller legacy
    files with more than 200 unique valid rows, duplicates, malformed rows, or
    an untrusted marker. A marker with an unknown version, a malformed marker,
    multiple markers, or a marker outside the first line is not trusted as a
    growth bound; perform a full scan and canonicalize from the valid message
    rows.
  - Canonicalization writes a mode-0600 sibling temporary file exclusively,
    closes it, rechecks the source inode, size, and modification time, then
    atomically renames it over the source. Temp write, source-change, or rename
    failure leaves the append-only source authoritative, warns, and returns the
    already computed replay result. Retry after another 4 MiB of growth or a
    later bind/read. This retains the existing no-fsync durability contract and
    relies on the runner's single-writer invariant; a continuously changing
    unsupported second writer can prevent compaction but cannot authorize a
    lossy replacement when its change is detected. The final source stat and
    rename are not atomic together: an unsupported writer that appends in that
    interval can still lose its append. The runner's single-writer invariant is
    what excludes that residual TOCTOU window in supported operation.
- **Session lifecycle**: before a session_id is assigned, append to a pending
  journal namespaced by `{agent_id, reset_generation}`; once the session_id is
  known, bind it to that session's sidecar (rename, or append when the target
  already exists). Pending journals cannot live in the transcript directory:
  codex rollout paths are date-nested and cannot be resolved before the
  session_id exists. Use
  `${KAOIRO_IA_PENDING_DIR:-~/.kaoiro/ia-pending}/<agent_id>__<generation>.ia.jsonl`,
  where `generation` is the launch `transition_id` (or a per-process random
  value when the runner does not provide one; fixed at implementation,
  2026-08-08). If a session_id is allocated again mid-session, bind the
  current sidecar to its new path as well; replay covers only the current
  session, so skipping this would lose that conversation's IA. Orphan journals
  from a crash before bind are excluded from replay and garbage-collected on
  next startup (fail-closed). `/new` and `/clear` stop appending to the old
  generation immediately and switch to the new one; only reset rollback returns
  to the old generation. Agent deletion leaves host-local artifacts
  (transcript/sidecar) in place.
 - **Restore**: a wrapper instructed to replay by the hydration verdict reads
  its sidecar and reprojects its pane's display rows through the `replay_ia`
  event ([protocol](../../specs/protocol.md) event table). No routing or SDK injection
  occurs. Hide cleared rows by comparing their stored `ingress_stamp` with
  durable `ClearWatermarks`; discard rows without a stamp (fail-closed).
  Accepted restored rows are broadcast to `agents:lobby` as
  **`history_replay_envelope { pane_agent_id, envelope }`** for display fan-out
  to connected tabs. Do not use the ordinary `envelope`: it has no pane and
  the client would fan it out to `agent_id ∪ payload.to`, leaving a restored
  row in panes that should not display it after reload (Fujino 30-10 must-fix
  M2, 2026-08-08). `pane_agent_id` comes from the replaying wrapper's channel
  assignment; wrapper payloads cannot choose a pane.
  A single `replay_ia` push is split at a JSON byte length of **1,000,000
  bytes** on the wrapper side. With an 8MB socket `max_frame_size`, 200
  64KiB envelopes would be about 12MB and each frame would be rejected before
  `complete`, leaving the pane permanently unhydrated. Send all pushes for one
  `replay_id` before `history_replay_complete`. A row that cannot fit even a
  single split is **dropped rather than sent**; sending it would repeat the
  frame-reject / missing-complete / rejoin loop, the same fail-closed decision
  as a corrupt sidecar row (Fujino 30-10 round-2 should, 2026-08-08). See the
  `replay_ia` row in [protocol](../../specs/protocol.md) for details.
- **Relation to resume reconstruction**: do **not** reproject IA injection
  framing text from the SDK transcript into the `kind=user` log. Structured
  display is provided by sidecar-derived `replay_ia`, preventing duplicates.

## Related inter-agent topics

- [Inter-agent messaging (design)](../../architecture/inter-agent-messaging.md).
- [Inter-agent message contract](../inter-agent/messages.md).
- [Inter-agent conversation contract](../inter-agent/conversations.md).
- [Inter-agent conversation admission](../inter-agent/conversation-admission.md).
- [Delivery confirmation and recovery](../inter-agent/delivery.md).
- [Send and wait](../inter-agent/send-and-wait.md).
- [Coordination monitoring and display](../inter-agent/coordination-monitoring.md).
- [Peer directory and companion tools](../inter-agent/directory.md).
- [Session lifecycle](../protocol/session-lifecycle.md).
