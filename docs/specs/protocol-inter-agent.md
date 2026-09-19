---
title: Inter-agent messaging protocol
description: Envelope schema, nine kinds, hard limits, routing, and observation paths for direct interaction between multiple AI agents through the kaoiro server.
status: provisional
last_updated: 2026-09-18
related: [protocol, subagent-tasks, plugin-model, security-threat-model]
---
<!-- markdownlint-disable MD033 -->

# Inter-agent messaging protocol

## Purpose

Moved to [Inter-agent messaging](../architecture/inter-agent-messaging.md#purpose).

## Dispatch-confirmation ledger (issue #237)

Moved to [Inter-agent delivery](../reference/inter-agent/delivery.md#dispatch-confirmation-ledger-issue-237).

### Negotiated gap recovery

Moved to [Inter-agent delivery](../reference/inter-agent/delivery.md#negotiated-gap-recovery).

## Review-quagmire detection (issue #273)

Moved to [Design rationale](../architecture/coordination-monitoring.md#review-quagmire-detection-issue-273).

### Rally

Moved to [Exact contract](../reference/inter-agent/coordination-monitoring.md#rally).

### Stall

Moved to [Exact contract](../reference/inter-agent/coordination-monitoring.md#stall) and [Design rationale](../architecture/coordination-monitoring.md#stall-interpretation).

### Wire

Moved to [Exact contract](../reference/inter-agent/coordination-monitoring.md#wire).

### Configuration

Moved to [Exact contract](../reference/inter-agent/coordination-monitoring.md#configuration) and [Design rationale](../architecture/coordination-monitoring.md#provisional-defaults).

### Deliberate omissions

Moved to [Design rationale](../architecture/coordination-monitoring.md#deliberate-omissions).

## Definition

### Overview

Moved to [Inter-agent messaging](../architecture/inter-agent-messaging.md#overview).

### envelope.type: "inter_agent_message"

Moved to [Inter-agent message contract](../reference/inter-agent/messages.md#envelopetype-inter_agent_message).

### Inner envelope(`payload` schema)

Moved to [Inter-agent message contract](../reference/inter-agent/messages.md#inner-envelopepayload-schema).

### kind enum (nine values)

Moved to [Inter-agent message contract](../reference/inter-agent/messages.md#kind-enum-nine-values).

### Conversation owner and tie-breaker

Moved to [Inter-agent conversation contract](../reference/inter-agent/conversations.md#conversation-owner-and-tie-breaker).

### Hard limits (config + mechanical enforcement)

Moved to [Inter-agent conversation contract](../reference/inter-agent/conversations.md#hard-limits-config--mechanical-enforcement).

### Memory-reclamation TTL (config, not a hard limit)

Moved to [Inter-agent conversation contract](../reference/inter-agent/conversations.md#memory-reclamation-ttl-config-not-a-hard-limit).

### Conversation lifecycle and post-close handling (issue #167)

Moved to [Inter-agent conversation contract](../reference/inter-agent/conversations.md#conversation-lifecycle-and-post-close-handling-issue-167).

#### CID reuse is not a contract (issue #167 review S2)

Moved to [Inter-agent conversation contract](../reference/inter-agent/conversations.md#cid-reuse-is-not-a-contract-issue-167-review-s2).

### Explicitly supplied unknown conversation_id (issue #252)

Moved to [Inter-agent conversation admission](../reference/inter-agent/conversation-admission.md#explicitly-supplied-unknown-conversation_id-issue-252).

### Observation path (dashboard display)

Moved to [Exact contract](../reference/inter-agent/coordination-monitoring.md#observation-path-dashboard-display).

### IA sidecar and display restoration ([ADR-0051](../adr/0051-history-restart-resilience.md))

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
  event ([protocol](protocol.md) event table). No routing or SDK injection
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
  `replay_ia` row in [protocol](protocol.md) for details.
- **Relation to resume reconstruction**: do **not** reproject IA injection
  framing text from the SDK transcript into the `kind=user` log. Structured
  display is provided by sidecar-derived `replay_ia`, preventing duplicates.

### Channel event additions

Moved to [Channel event additions](../reference/inter-agent/directory.md#channel-event-additions).

#### Peer-directory information boundary (#99 / #150)

Moved to [Peer-directory information boundary (#99 / #150)](../reference/inter-agent/directory.md#peer-directory-information-boundary-99--150).

##### Exposed fields

Moved to [Exposed fields](../reference/inter-agent/directory.md#exposed-fields).

##### Directory-only entry (issue #259)

Moved to [Directory-only entry (issue #259)](../reference/inter-agent/directory.md#directory-only-entry-issue-259).

##### `context` capability gate

Moved to [`context` capability gate](../reference/inter-agent/directory.md#context-capability-gate).

##### Projection from `ext`

Moved to [Projection from `ext`](../reference/inter-agent/directory.md#projection-from-ext).

##### Always include `conversation`

Moved to [Always include `conversation`](../reference/inter-agent/directory.md#always-include-conversation).

##### Omit session fields for uncorrelated connections

Moved to [Omit session fields for uncorrelated connections](../reference/inter-agent/directory.md#omit-session-fields-for-uncorrelated-connections).

##### Persistent exclusions

Moved to [Persistent exclusions](../reference/inter-agent/directory.md#persistent-exclusions).

##### Exposed user fields (issue #187 phase 2, ADR-0021 F6-8)

Moved to [Exposed user fields (issue #187 phase 2, ADR-0021 F6-8)](../reference/inter-agent/directory.md#exposed-user-fields-issue-187-phase-2-adr-0021-f6-8).

##### Meaning of a live role join

Moved to [Meaning of a live role join](../reference/inter-agent/directory.md#meaning-of-a-live-role-join).

##### User backward compatibility (issue #187 phase 2)

Moved to [User backward compatibility (issue #187 phase 2)](../reference/inter-agent/directory.md#user-backward-compatibility-issue-187-phase-2), [Event contracts](../reference/inter-agent/directory.md#event-contracts), [Send acceptance and rejection](../reference/inter-agent/send-and-wait.md#send-acceptance-and-rejection).

### Approval flow (permission_broker integration)

This flow applies to Claude Code only; see the engine-scope note near the end
of this section for Codex and Antigravity. When wrapper-A invokes
`send_to_agent`, it asks the operator for approval through the existing
`canUseTool` path ([ADR-0022](../adr/0022-pending-permission-authoritative-source.md)).

- Tool name: `send_to_agent`.
- `input` contains destination `to`, kind, a body excerpt, and
  `conversation_id` so the operator can decide.
- Phase 1 reuses the existing permission dialog; Phase 2 may provide a
  dedicated UI.
- On denial the tool call fails; wrapper-A returns a send-rejected error to the
  SDK and the agent can try another response.

#### Automatic approval (conversation-scoped whitelist, ADR-0044 F2 addendum, option B)

Subsequent `send_to_agent` calls for the same `(conversation_id, to)` are
automatically allowed without `canUseTool` (no operator dialog) **only when
this wrapper process just received an accepted ack from the server for that
pair**.

- The whitelist exists **only in wrapper-process memory** as
  `autoAllowedPeer` on the conversation lifecycle track (issue #167
  `ConversationTrack` extension). It is bound to both `conversation_id` and
  the approved `to` (issue #165 round-3 review, Fujino M2); binding only the
  conversation would allow an `unknown_agent` rejection to be replaced by a
  different recipient without approval. It is not persisted by the server.
  A wrapper restart (including relaunch), or track TTL/cap eviction, clears it
  and requires first-send approval again. A transport reconnect does not clear
  it: the same-process `InterAgentTool` survives, and reconnect does not revoke
  an operator-approved conversation.
- Each wrapper instance has an independent whitelist. When B first replies to
  a conversation started by A, B has no local entry and needs normal
  `canUseTool` approval.
- The first send of a new conversation (caller omitted `conversation_id`, and
  the wrapper allocates one after sending) always goes through `canUseTool`;
  no ID exists yet to match a whitelist entry.
- **Establish a whitelist entry only for the first send that is both operator-
  approved and server-accepted** (issue #165 round-4 review, Fujino design
  approval, condition A — [issue #201 comment 5384486838](https://github.com/sakuraiyuta/kaoiro/issues/201#issuecomment-5384486838)).
  `canUseTool` approval (dialog or an existing auto-allow) merely permits the
  attempt and does not write the whitelist. Register `(conversation_id, to)`
  when `#dispatch()` returns `{kind: "accepted"}`. **Rejected sends and
  `unknown` (delivery unknown because no ack arrived) never touch the
  whitelist**. Keeping unknown state gated is consistent with the repository's
  safe default of retaining approval requirements ([ADR-0051](../adr/0051-history-restart-resilience.md)
  D3-2): the cost is repeated dialogs, whereas promoting unknown delivery
  would create a permission-bypass risk. The former optimistic registration at
  the canUseTool boundary was discarded after three review rounds; see
  [#201 comment 5384486746](https://github.com/sakuraiyuta/kaoiro/issues/201#issuecomment-5384486746)
  and the design decision in [#201 comment 5384486838](https://github.com/sakuraiyuta/kaoiro/issues/201#issuecomment-5384486838).
- **Race with inbound during a non-`done` dispatch** (issue #165 round-3
  review, Fujino M3, gitea issue #201): if a valid inbound (including a
  server-synthesized hard-limit stop) arrives for the same conversation while
  `#dispatch()` is pending, the accepted-only rule prevents a rejected send
  from establishing a whitelist through the race. `mutationGen` protects
  `closed` / `turnNumber` state so reject cleanup cannot overwrite inbound
  writes such as `closed=true` (a counter increments only on actual value
  changes; issue #165 round-4 review, Fujino condition C). The comments in
  `wrapper/agent-common/src/inter_agent.ts` `invoke()` and `receiveInbound()`
  are authoritative.
- This section applies **only to Claude's canUseTool path**. Codex fixes
  approval to `never` and has no canUseTool-equivalent route ([ADR-0033](../adr/0033-permission-model-dual-axis.md)
  F3), so `send_to_agent` is already unconditionally allowed and this
  whitelist has no additional role.
- Antigravity's inter-agent tools (`send_to_agent` / `list_agents` /
  `whoami`) are registered through `ToolHost.listen` (`wrapper/antigravity/src/host.ts`),
  a separate MCP-serving path that never passes through `AntigravityGate`'s
  tool-class table (`wrapper/antigravity/src/gate.ts`) — they carry no
  approval axis at all, unconditionally allowed by construction, not merely
  fixed to `never` like Codex.
- Kind does not affect the decision (query/response and request/propose share
  the whitelist). Responsibility scope from ADR-0044 F2 is not an auto-allow
  axis; only first approval per conversation is the gate.

### Receiver-side behavior (wrapper-B)

Moved to [Send and wait](../reference/inter-agent/send-and-wait.md#receiver-side-behavior-wrapper-b).

#### Coalescing pending messages (issue #211 phase 3)

Moved to [Send and wait](../reference/inter-agent/send-and-wait.md#coalescing-pending-messages-issue-211-phase-3). The batching structure and purpose are in
[Dispatch and coalescing](../architecture/inter-agent-messaging.md#dispatch-and-coalescing);
the send-and-wait reference holds the trigger, ordering, limits, and failure contract.

#### Synchronous reply wait (`send_to_agent.wait_for_response`)

Moved to [Send and wait](../reference/inter-agent/send-and-wait.md#synchronous-reply-wait-send_to_agentwait_for_response).

### Unresponsive notices (`payload.error`)

Moved to [Unresponsive notices](../reference/inter-agent/errors.md#unresponsive-notices-payloaderror).

#### Error codes (initial set)

Moved to [Error codes](../reference/inter-agent/errors.md#error-codes-initial-set).

#### Sources (four paths)

Moved to [Sources](../reference/inter-agent/errors.md#sources-four-paths).

#### `stale_turn` notice structure (issue #212 defect 3)

Moved to [`stale_turn` notice structure](../reference/inter-agent/errors.md#stale_turn-notice-structure-issue-212-defect-3).

#### Server-synthesized (`reconnecting` / `reconnected` / `disconnected`) rules

Moved to [Server-synthesized rules](../reference/inter-agent/errors.md#server-synthesized-reconnecting--reconnected--disconnected-rules).

#### Receiver handling

Moved to [Receiver handling](../reference/inter-agent/errors.md#receiver-handling).
### Companion tools (wrapper SDK MCP)

Moved to [Companion tools (wrapper SDK MCP)](../reference/inter-agent/directory.md#companion-tools-wrapper-sdk-mcp).

#### Session operation tool — `request_compact` (phase-28 B2)

Moved to [Session operation tool — `request_compact`](../reference/inter-agent/session-tools.md#session-operation-tool--request_compact-phase-28-b2).

#### Threshold notice (phase-28 B1)

Moved to [Threshold notice](../reference/inter-agent/session-tools.md#threshold-notice-phase-28-b1).

#### `request_session_reset` (phase-28 C2)

Moved to [`request_session_reset`](../reference/inter-agent/session-tools.md#request_session_reset-phase-28-c2).

#### Destination-resolution guidance

Moved to [Destination-resolution guidance](../contributing/peer-routing.md#destination-resolution-guidance).

### Reserved `envelope.type` and version

Moved to [Inter-agent message contract](../reference/inter-agent/messages.md#reserved-envelopetype-and-version).

## Constraints

- MUST: The server must not interpret payload semantics (`kind` / `body` /
  `meta`); it may read only `to` for routing. Carve-out (issue #127): validate
  `payload.error` structurally (`code` non-empty string, `message` string) but
  do not interpret values. The server may synthesize `reconnecting` or
  `disconnected` envelopes on wrapper disconnect and an error-free `reconnected`
  inform after exact-token planned recovery; these are minimal structural hooks
  for observability, not semantic interpretation.
- MUST: An envelope with `payload.error` still uses one of the nine kinds;
  unresponsive notices use `inform`.
- MUST: Do not count server-synthesized error notices in turns or tokens.
- MUST: Deliver `inter_agent_message` envelopes **to operators only**
  ([ADR-0021](../adr/0021-role-information-disclosure-policy.md)); remove them
  entirely for viewers.
- MUST: In Phase 1 every `send_to_agent` call goes through per-call
  `permission_broker` approval (effect depends on permission mode; auto modes
  include approval). Do not add kaoiro autonomous approval skipping before
  Phase 3.
- MUST: Enforce config hard limits (`max_turns`, `max_tokens`,
  `max_concurrent_agents`) mechanically. Issue #211 removed old
  `max_wallclock` as a hard limit.
- MUST: A conversation completes only when both owner-side agents send
  `meta.done=true`; one side alone is not done.
- MUST (issue #167): Retain a conversation closed by both done flags, a hard
  limit, or `open_conversation_ttl_ms` (issue #211, GC only) as a tombstone
  until `tombstone_ttl_ms` expires. While closed, do not relay, store, or
  broadcast sends for that conversation; reject them with
  `{:error, :conversation_closed}`. Discard counters (turns/tokens/started_at/
  done_by) at closure and never reset them on retry.
- MUST (issue #167): Closed conversations are inactive in `peer_index` and in
  disconnect unresponsive notices.
- MUST: Reject self-routing where `payload.to == agent_id`.
- MUST: A `kind: "reject"` envelope carries a non-empty string
  `meta.reject_reason`.
- MUST: Accept only agent IDs in `send_to_agent.to` (charset constrained).
  Resolve persona names through the wrapper `list_agents` tool and ask the
  operator when ambiguous.
- MUST: The peer directory is an **allow-list**. Expose only fields explicitly
  listed by `directory_entry`; never pass `ext` through. Apply the allow-list at
  nested levels and construct a new map of canonical keys
  ([ADR-0021](../adr/0021-role-information-disclosure-policy.md) F6-2 and
  [“Projection from `ext`”](../reference/inter-agent/directory.md#projection-from-ext)).
- MUST (issue #187 phase 2): Apply the same allow-list discipline to `users`
  ([ADR-0021](../adr/0021-role-information-disclosure-policy.md) F6-8). Build literal maps with per-value validation; do not use a
  `Map.take/2`-style key-only filter that bypasses shape checks. Omit an entire
  user entry when its role cannot be resolved.
- MUST (issue #187 phase 2): Expose users by default—unset
  `KAOIRO_EXPOSE_USERS_TO_AGENTS` means open, explicit `false` opts out. A
  closed read-site fallback is only for the abnormal case where the config key
  itself is missing, not normal boot.
- MUST: Project `context` only when
  `ext.session_capabilities.supports_context_usage == true`; with absent or
  explicit false capability omit each field and emit neither `null` nor an
  inferred value ([ADR-0040](../adr/0040-context-usage-capability.md)).
- MUST: For `rate_limits` windows, accept absence only when the key is missing;
  if present with an invalid value (including `null`), drop that window. Drop
  windows left empty after projection.
- MUST: Server and wrapper apply **identical projection rules and limits**; a
  looser side must not reopen data closed by the other.
- MUST: Return `{"active": false, "peers": []}` even without a conversation;
  never disclose `conversation_id`.
- MUST: `session_started_at` and `last_activity_at` are **server-observed
  timestamps**, not wrapper measurements or envelope `ts`.
- MUST: A `list_agents` consumer compares `rate_limits.resets_at` (Unix seconds)
  with current time and, after expiry, does not trust that window's
  `utilization` or `status`. Snapshots come from the peer's last turn and do
  not update while idle. This is a best-effort model convention, not a
  deterministic server/wrapper enforcement; dashboard parity is tracked in
  [#154](https://github.com/sakuraiyuta/kaoiro/issues/154).
- MUST: An omitted field means **unknown**, never zero, healthy, or unlimited.
- SHOULD: Allocate `conversation_id` values from UUIDv4 for collision
  resistance and easy grouping.
- SHOULD: Truncate `body` at 16 KB on the wrapper like other protocol fields and
  set `meta.truncated=true`.

## Open Questions

- Conversation persistence (whether conversation_id survives a server restart
  and how it connects to Phase 4 / ADR-0014) — settle in Phase 2.
- Insertion point for the message filter (kaoiro issue #18) — begin review in
  Phase 2.
- Automatic escalation when starting an `owner.kind: "agent"` conversation —
  pending Phase 3 / kaoiro issue #87.

## See Also

- Related specs: [protocol](protocol.md) (common envelope foundation),
  [tasks](../reference/protocol/tasks.md) (similar reserved-type patterns),
  [extensions](../architecture/extensions.md) (future filter insertion point), and
  [threat-model](../architecture/security-threat-model.md) (basis for operator-only delivery).
- Related plans: [phase-8-inter-agent-messaging](../plans/phase-8-inter-agent-messaging.md)
  and [phase-27-list-agents-metadata](../plans/phase-27-list-agents-metadata.md)
  (six peer-directory liveness fields).
- ADRs: [0010 protocol-precisification](../adr/0010-protocol-precisification.md),
  [0015 protocol-version-stamping](../adr/0015-protocol-version-stamping.md),
  [0021 role-information-disclosure-policy](../adr/0021-role-information-disclosure-policy.md)
  (F6 = allow-list for agent disclosure, F6-8 = user disclosure allow-set),
  [0022 pending-permission-authoritative-source](../adr/0022-pending-permission-authoritative-source.md),
  [0040 context-usage-capability](../adr/0040-context-usage-capability.md)
  (the `context` capability gate),
  [0050 principal-model-and-graded-access-control](../adr/0050-principal-model-and-graded-access-control.md)
  (D5 = identity disclosure policy)
- kaoiro issues #17 (implementation origin), #18 (message filter), #87
  (umbrella investigation), #127 (unresponsive notices), #150
  (peer-directory liveness), #154 (rate-limit display defect), #167
  (conversation lifecycle, tombstone, stale-turn rejection), and #187 (user
  disclosure, phase 2).
