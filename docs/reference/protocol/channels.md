---
title: Channels and directional messages
status: accepted
last_updated: 2026-10-04
description: Wrapper/server/client/runner channel events by direction, and the client's Phoenix Channels transport contract.
---

# Channels and directional messages

### Directional message types (v0 settled)

Channel event names and contents. Topics are `wrapper:<agent_id>` for wrappers and
`agents:lobby` for clients.

**For the client → server, server → wrapper, and server → runner rows completed in stage 1,
`version` is a common flat outer key and is not repeated in each payload column**
([ADR-0015](../../adr/0015-protocol-version-stamping.md)); this is the same treatment as not
repeating envelope outer keys in every `type` row. A row explicitly mentioning `version`
does so only for a producer/domain-specific note; omission does not mean the stamp is absent.
The complete coverage and the permanent `attach_chunk` exception are normative in the
"version inventory" below.

| Direction | Event | Contents |
|---|---|---|
| wrapper → server | `envelope` | Full envelope. Accepted `inter_agent_message` replies carry `ingress_stamp: [us, seq]`, the same server-owned `delivery_authority` as the relayed payload, optional `work` and `work_control_result`, and `delivery.advisory` (`recipient_state`, `granted`, optional `downgrade`, `mechanism`, `unresolved_count`, `guidance: "accepted; do not resend"`). `unresolved_count` excludes submitted or retired entries above an earlier unresolved sequence; it is not the gap between issued and acknowledged sequence numbers. `mechanism` is `queue`, `fold`, `cut`, `steer`, `hook`, or `unknown`; receivers treat an unrecognized value as `unknown`. A receipt hit rejects with `work_operation_deduplicated`, `send_not_attempted: true`, stored `work_control_result` and delivery knowledge (`recorded`, `not_recorded`, or `unknown`), with no ingress stamp. An unknown work outcome rejects with `work_outcome_unknown`, `send_not_attempted: true`, and `operation_id`, also with no ingress stamp. Other envelope types receive an empty reply. Causal ordering follows [directory event contracts](../../reference/inter-agent/directory.md#event-contracts); sidecar recording uses [ADR-0051](../../adr/0051-history-restart-resilience.md). Under `credit-v1`, `unresolved_count` also counts the recipient's queued items, and the reply carries the [server-owned queue](#server-owned-inter-agent-queue-credit-v1) fields. |
| wrapper → server | `delivery_ack` | `{ delivery_seq: positive integer }`, the SDK-dispatch confirmation watermark (issue #237); unnegotiated, duplicate, or future values are no-op, not resend requests. Under `credit-v1` it is a no-op for queue-origin sequences ([server-owned queue](#server-owned-inter-agent-queue-credit-v1)). |
| wrapper → server | `delivery_stage` | ADR-0063 negotiated v1: `{version: "0", incarnation, generation, delivery_seq, stage, mode?, handoff?, evidence?, reason?, yield_disposition?, at}`. `stage` is `queued`, `submitted`, `included`, `settled`, or `unknown`; the server records `accepted` and `lost`, and returns `expired` on query. Codex steer handoffs are `turn_steer_accepted`, `turn_steer_item_observed`, and `turn_steer_write_uncertain`; eligible unknown reports resolve a gap as uncertainty, not loss. `yield_disposition` is set once. The current owner and ledger identity are checked before recording. Under `credit-v1` it is stage history only for queue-origin sequences and never resolves them ([server-owned queue](#server-owned-inter-agent-queue-credit-v1)). |
| wrapper → server | `yield_claim` | `{version: "0", incarnation, generation, yield_token, conversation_id, turn_number, work_id, authority_epoch}`. The serialized server decision returns `{granted: true, repeated?}` or `{granted: false, reason}`; a stale owner receives `stale_channel`. |
| wrapper → server | `work_transfer_ack` | `{version: "0", work_id, transfer_id}`; only the old assignee of that pending obligation may acknowledge it. The reply is `{work_id, transfer_id, state: "acknowledged"}` and includes no work record. |
| wrapper → server | `work_op_result_request` | `{version: "0", operation_id}`; reads the caller's receipt, `unknown_operation`, or `operation_id_expired`. |
| wrapper → server | `work_status_request` | `{version: "0", work_id?}`; returns a permitted work view, or the caller's non-terminal works when the ID is absent. |
| wrapper → server | `work_check_request` | `{version: "0", work_id, action: "start" \| "land", expected_revision, subject_hash?}`; cooperative check and audit, without a resource lock. |
| wrapper → server | `wrapper_build_info` | `{ build_revision, build_dirty, build_version, build_channel }` reports the wrapper artifact immediately after each successful channel join. The server derives `agent_id` from the topic, validates the complete identity pair, keeps only the latest connected value, and broadcasts it to operator-capable clients. `build_version` is `"unknown"` or `YYYY.M.PATCH`: a four-digit year, month `1` through `12`, and one to six decimal patch digits. The flat protocol `version` is added by the wrapper control-event funnel. |
| wrapper → server | `delivery_status_request` | `{conversation_id?, turn_number?}`; without a message pair, reads the sender's ledger watermark. With a pair, reads the sender-authorized stage set or `expired`. Absence of a watermark is legacy/disarmed unknown. |
| wrapper → server | `delivery_resync` | Negotiated by the additional join capability `delivery_resync: "skip-v1"`, echoed in the join reply. `{generation, request_id, cutoff, missing_ranges}` retires a bounded page of missing sequences under the current channel owner and generation. The reply echoes `request_id` and `skipped_ranges` with post-skip `delivery`; errors are `invalid_delivery_resync` or `stale_delivery_owner`. Version remains `"0"`. See [gap recovery](../../reference/inter-agent/delivery.md#negotiated-gap-recovery). Under `credit-v1`, queue-origin ranges are returned or resolved as unknown and reported in `returned_ranges` and `uncertain_ranges`, not `skipped_ranges` ([server-owned queue](#server-owned-inter-agent-queue-credit-v1)). |
| wrapper → server | `history_reset` | `{ replay_id }` starts replay. Use the server ID when the join verdict requires replay, otherwise a legacy wrapper ID. Clear display projection, retain IA for `replay_ia`, and acknowledge an absent entry as no-op ([ADR-0051](../../adr/0051-history-restart-resilience.md), [ADR-0014](../../adr/0014-session-resume-and-restore.md)). |
| wrapper → server | `history_replay_complete` | `{ replay_id }` follows the final JSONL/sidecar row. The server broadcasts it and CAS-transitions matching in-flight hydration ([ADR-0051](../../adr/0051-history-restart-resilience.md)). |
| wrapper → server | `replay_ia` | `{ replay_id, items: [{ envelope, ingress_stamp }] }` restores one pane from the sidecar. Bind to the topic agent, upsert only that pane, reject stale/malformed stamps, and broadcast `history_replay_envelope`; operator-only ([ADR-0051](../../adr/0051-history-restart-resilience.md)). |
| wrapper → server | `directory_request` | `{}` requests the peer directory. The server allow-lists AgentStates, merges AgentDirectory-only disconnected entries, and removes the sending wrapper once. It replies with `{ agents: [...], users: [...] }` only when the complete production JSON reply fits the transport frame budget; otherwise its Phoenix error body is `{ reason: "directory_too_large" }`. It never returns a partial directory, so a wrapper cannot use incomplete data for peer name resolution. Projection rules are normative in [peer directory](../../reference/inter-agent/directory.md). |
| server → client | `snapshot` | `{ agents: { <agent_id>: envelope }, snapshot_incomplete?: true }` is pushed after join. The TransportLimits-bounded projection marks omission with `snapshot_incomplete`; compact entries may lose display-only fields while control state is unchanged. |
| server → client | `task_snapshot` | `{ tasks: { <agent_id>: { <task_id>: envelope } } }` is the active subagent/workflow set, separate from agents. Viewer joins always receive `tasks: {}` ([ADR-0048](../../adr/0048-task-aggregation-delivery.md)). |
| server → client | `delivery_snapshot` | `{ deliveries: { <agent_id>: { issued_seq, acked_seq, pending_since?, lost_count?, last_loss?, uncertain_count?, last_uncertain? } }, snapshot_incomplete?: true }` reports recipient-local confirmation gaps, not a resend queue; `uncertain_count` and `last_uncertain` persist for the ledger lifetime, while `lost_count` and `last_loss` reset on delivery-generation change (`InterAgentDeliveryStatus`). Connected or gapped entries are prioritized; viewers receive `{ deliveries: {} }` ([ADR-0048](../../adr/0048-task-aggregation-delivery.md)). Each entry gains `queue` under `credit-v1` ([server-owned queue](#server-owned-inter-agent-queue-credit-v1)). |
| server → client | `delivery_status` | `{ agent_id, delivery?: { issued_seq, acked_seq, pending_since?, lost_count?, last_loss?, uncertain_count?, last_uncertain? } }` reports a ledger update; capability loss omits `delivery`. Operator-only. `delivery` gains `queue` under `credit-v1` ([server-owned queue](#server-owned-inter-agent-queue-credit-v1)). |
| server → client | `wrapper_build_info` | Join snapshot is `{ builds: { "<agent_id>": { build_revision, build_dirty, build_version, build_channel } }, build_info_incomplete?: true }`; live update is the same flat identity plus `agent_id`, and disconnect is `{ agent_id, cleared: true }`. Only currently connected wrappers appear in the snapshot. `build_info_incomplete: true` means the join snapshot omits one or more complete entries to fit the transport frame budget; live update semantics are unchanged. Operator-only. |
| server → client | `envelope` | The complete envelope, broadcast on each state change. |
| server → client | `history` | `{ agents: { "<pane_agent_id>": [...] }, clear_watermarks: { ... }, history_projection: "per-pane-v1", projection_epoch, history_incomplete?: true }` is pushed after join. `history_incomplete: true` means one or more oldest history entries or clear-watermark entries were omitted to fit the transport frame budget. Each retained pane remains chronological and contains a newest suffix; it does not alter the server's history or clear-watermark state. Operator-only. |
| server → client | `directory` | `{ entries: { "<agent_id>": { ... } }, directory_incomplete?: true }` is pushed after join and after a directory change. `directory_incomplete: true` means complete directory entries were omitted to fit the transport frame budget; it does not change the directory state used by wrapper peer-name resolution. Operator-only. |
| server → client | `history_cleared` | `{ agent_id, session_id, clear_watermark }` follows operator `clear_history` and filters non-IA rows by session and IA rows by watermark. `/new` and `/clear` use session-reset lifecycle events instead. Missing start points warn and leave the watermark unchanged; operator-only. |
| server → client | `history_reset` | `{ agent_id, preserve_inter_agent: boolean, replay_id? }` is sent only for replay reconstruction. `preserve_inter_agent` is explicitly `false` during compatibility; `/new` and `/clear` do not use this event. Operator-only ([ADR-0051](../../adr/0051-history-restart-resilience.md)). |
| server → client | `history_replay_complete` | `{ agent_id, replay_id }` marks the resume JSONL replay boundary; matching rows are excluded from new-message animation. Operator-only. |
| server → client | `history_replay_envelope` | `{ pane_agent_id, envelope }` delivers one restored IA row to the named pane only; it must not fan out by `agent_id ∪ payload.to` ([ADR-0051](../../adr/0051-history-restart-resilience.md), [IA sidecar and display restoration](../storage/inter-agent-sidecar.md)). Operator-only. |
| server → client | `agent_deleted` | `{ agent_id }` follows successful deletion and removes the agent from grid and display logs; viewers receive it for grid consistency ([ADR-0021](../../adr/0021-role-information-disclosure-policy.md)). |
| client → server | `attach_open` | `{ agent_id, upload_id, filename, mime, size, chunks }` announces an attachment. Operator-only; upload IDs are client-assigned and relayed to the wrapper, with unknown agents rejected. See the file-upload wire section. |
| client → server | `attach_chunk` | Binary V2 frame `<u32 upload_id_len><upload_id utf8><u32 chunk_index><chunk_bytes>`, relayed opaquely to the wrapper. This is the permanent `version` carve-out because no JSON object exists. |
| client → server | `attach_close` | `{ agent_id, upload_id }` completes one upload (optional chunk-complete acknowledgement). Operator-only; wrapper validates MIME, size, count, and TTL. |
| client → server | `instruction` | `{ agent_id, text, attachment_ids? }` is relayed without interpretation. The wrapper renders completed uploads as SDK content blocks and rejects unknown agents or invalid attachments ([attachment wire contract](attachments.md), [ADR-0025](../../adr/0025-file-upload-wire-and-wrapper-rendering.md)). |
| client → server | `permission_decision` | `{ agent_id, request_id, allow, message? }`, operator-only relay matched to the pending permission. |
| client → server | `question_response` | `{ agent_id, request_id, answers, cancelled? }`, operator-only relay matched to AskUserQuestion; `cancelled` denies and answers use option labels ([ADR-0027](../../adr/0027-askuserquestion-envelope.md)). |
| client → server | `interrupt` | `{ agent_id }` requests an operator-only turn interrupt. Relay is fire-and-forget; SDK returns an error result and the wrapper drops pending upload bytes, emitting `attach_rejected{reason="interrupted"}` ([ADR-0025](../../adr/0025-file-upload-wire-and-wrapper-rendering.md)). |
| client → server | `set_model` | `{ agent_id, model }` selects an `ext.models[].value` alias and is relayed fire-and-forget; unknown agents are rejected (#54, [ADR-0020](../../adr/0020-dashboard-battery-included-client.md)). |
| client → server | `set_effort` | `{ agent_id, effort }` selects one of the model's `effort_levels` and is relayed fire-and-forget; unknown agents are rejected (#54, [ADR-0020](../../adr/0020-dashboard-battery-included-client.md), [ADR-0035](../../adr/0035-codex-model-catalog-and-mid-session-switch.md)). |
| client → server | `refresh_models` | `{ agent_id }` asks the wrapper to retry its supported-model catalog fetch ([ADR-0037](../../adr/0037-claude-model-catalog-live-refresh.md) F6). It is a no-op for an absent session and rejects while `session_reset` is pending. |
| client → server | `set_permission_mode` | `{ agent_id, mode }` relays a six-value SDK mode and persists it per agent for the next wrapper join. Unknown mode/agent returns `invalid value: mode` / `unknown_agent` (#58). |
| client → server | `set_permission` | `{ version, agent_id, sandbox?, network_access?, approval? }`; operator-only non-empty patch. `approval` is accepted only when the session advertises it mutable in `permission_switch_axes` (Antigravity, issue #359; opted-in Codex app-server, ADR-0064); each axis is clamped to its launch ceiling and, for approval, to `values` when advertised. Persists requested raw configuration and returns `{revision, status:"pending", requested}`; see [permission changes](permission-requests.md#permission-changes-at-an-execution-boundary). |
| client → server | `set_quagmire_settings` | `{ rally_turns }` sets the deployment-wide review-quagmire rally threshold; `null` is ∞ (rally detection off). Operator-only, persisted, and applied without a restart. Out of range, non-integer, or an absent key returns `invalid_rally_turns` — an absent key is not a request to disable ([#307](https://github.com/sakuraiyuta/kaoiro/issues/307), [coordination monitoring](../../reference/inter-agent/coordination-monitoring.md)). |
| client → server | `clear_history` | `{ agent_id }` purges prior-session display logs from the server ring buffer and broadcasts `history_cleared`; it never touches wrapper JSONL. Unknown agent/current session returns `unknown_agent` / `no_current_session` (#48). |
| client → server | `delete_agent` | `{ agent_id }` is accepted only for disconnected agents. Requiring the disconnected pre-check, revoking and fsyncing the token, broadcasting `revoked`, closing planned targets, purging all server stores, then broadcasting `agent_deleted` preserves fail-closed ordering ([ADR-0051](../../adr/0051-history-restart-resilience.md), [#14](https://github.com/sakuraiyuta/kaoiro/issues/14), [#72](https://github.com/sakuraiyuta/kaoiro/issues/72)). |
| client → server | `revoke_wrapper_token` | `{ agent_id }` immediately places the per-agent signed token on the denylist, fsyncs, and force-disconnects the wrapper. It is accepted for live or disconnected agents and survives restart ([ADR-0024](../../adr/0024-agent-instance-identity-and-spawn-auth.md), [#72](https://github.com/sakuraiyuta/kaoiro/issues/72)). |
| client → server | `rename_agent` | `{ version, agent_id, display_name }` renames the instance; `AgentDirectory.rename/2` is the sole write, returns a monotonic revision, dual-emits `persona_sync`/`display_name_sync`, and updates operator directory projections. A name is at most 64 grapheme clusters and 256 UTF-8 bytes, with no control characters. Invalid names/revisions fail closed (issue #209, [ADR-0021](../../adr/0021-role-information-disclosure-policy.md)). |
| client → server | `rename_user` | `{ version, user_id, display_name }` synchronously renames an existing user and returns `{ id, kind, display_name }`; unknown users and invalid names return `unknown_user` / `invalid_name`. |
| client → server | `list_users` | `{ version }` is an operator-only read query returning an explicit `{ id, kind, display_name, role }` projection from `Users.all_with_role/1`; no live push or runner relay.  ([../adr/0021-role-information-disclosure-policy.md](../../adr/0021-role-information-disclosure-policy.md)) |
| server → wrapper | `attach_open` | `{ upload_id, filename, mime, size, chunks }` creates a five-minute pending upload. |
| server → wrapper | `attach_chunk` | Binary relay parsed by the wrapper into the upload chunk buffer; the binary frame is the permanent `version` exception. |
| server → wrapper | `attach_close` | `{ upload_id }` closes an upload; wrapper enforces MIME, 128 MB file size, 20 in-flight count, and emits `attach_rejected` when invalid. |
| server → wrapper | `instruction` | `{ text, attachment_ids? }` enters the input queue; completed attachments render as image/document/text blocks (Office via markitdown), with whole-instruction rejection reported by `instruction_rejected` ([attachment wire contract](attachments.md), [ADR-0025](../../adr/0025-file-upload-wire-and-wrapper-rendering.md)). |
| server → wrapper | `permission_decision` | `{ request_id, allow, message? }` relays to the matching pending approval. |
| server → wrapper | `question_response` | `{ request_id, answers, cancelled? }` relays to the matching pending question; cancelled is deny and allowed answers are returned through SDK `updatedInput.answers` ([ADR-0027](../../adr/0027-askuserquestion-envelope.md)). |
| server → wrapper | `interrupt` | `{}` calls SDK `Query.interrupt()` and drops pending upload bytes, emitting interrupted attachment rejections when needed (#51, [ADR-0025](../../adr/0025-file-upload-wire-and-wrapper-rendering.md)). |
| server → wrapper | `set_model` | `{ model }` calls `Query.setModel(value)` for subsequent turns; absent sessions are a no-op (#54). |
| server → wrapper | `set_effort` | `{ effort }` calls `Query.applyFlagSettings({ effortLevel })` for subsequent turns; absent sessions are a no-op (#54). |
| server → wrapper | `refresh_models` | `{}` resets retry state and kicks `#refreshSupportedModels()`; it remains usable after a silent cap and is a no-op without a session ([ADR-0037](../../adr/0037-claude-model-catalog-live-refresh.md) F6). |
| server → wrapper | `set_permission_mode` | `{ mode }` relays or pushes after join. Before a session it updates internal state for the next query; `bypassPermissions` is accepted only when startup enabled `allowDangerouslySkipPermissions` (#58). |
| server → wrapper | `set_permission` | `{ version, revision, sandbox, network_access, approval? }`; complete raw configuration for the next execution, never the current exec. `approval` rides only for an engine carrying it as a mutable axis (Antigravity, issue #359). Unsupported adapters reject. |
| server → wrapper | `permission_sync` | `{ version, control, next }`; authoritative permission settings after every join, including explicit nulls when empty. Gates the first/successor exec; see [permission synchronization](permission-sync-audit.md#persistence-join-synchronization-and-resume). |
| server → wrapper | `persona_sync` | `{ version, name, revision }` is the legacy half of the dual emit with `display_name_sync`; both update only display_name and guard monotonic safe revisions (issue #209). |
| server → wrapper | `display_name_sync` | `{ version, display_name, revision }` is the new dual-emitted form with the same contract and revision guard; wrappers route both forms through `renameDisplayName`. |
| server → wrapper | `delivery_status` | `{ issued_seq, acked_seq, pending_since?, lost_count?, last_loss?, uncertain_count?, last_uncertain?, version }`, flat (the topic already scopes `agent_id`) — same ledger fields as the `server → client` row below, but distinct: this copy drives the wrapper's own gap-recovery bookkeeping (`wrapper/core/src/transport.ts` `#bindServerEvent("delivery_status", ...)`), broadcast alongside the client-bound copy from the same `broadcast_delivery_status/1` call. Gains `queue` under `credit-v1` ([server-owned queue](#server-owned-inter-agent-queue-credit-v1)). |
| client → server | `session_reset` | `{ agent_id, mode: "new" \| "clear" }` is operator-only. Validate role, agent, mode, capability, idle state, and pending lock atomically, then broadcast `session_reset_started` and push runner `reset_session`; reserved literal commands are rejected ([ADR-0036](../../adr/0036-session-lifecycle-commands.md)). |
| wrapper → server | `session_reset_request` | `{ mode: "new" \| "clear", reason?: string }` is the agent-self deferred reset request. Bind agent_id to the connection, reuse SessionResets checks, and return `{ request_id }` as lock confirmation only; use existing lifecycle rejection vocabulary ([ADR-0043](../../adr/0043-agent-initiated-session-reset.md)). |
| wrapper → server | `session_lifecycle` | `{ kind, trigger?, at, details? }` records one session-lifecycle transition (phase-33, [ADR-0055](../../adr/0055-compaction-resume-and-lifecycle-log.md)). `kind` — wrapper-produced: `compacting` \| `compact_boundary` \| `compact_failed` \| `resume_reserved` \| `resume_fired` \| `threshold_notice` \| `conversation_reset` plus `permission_applied` / `permission_failed` with typed [permission details](permission-sync-audit.md#permission-lifecycle-audit); server-only `permission_requested` uses the same timeline. Server-merged into the same per-agent timeline: `disconnected` \| `reconnecting` \| `reconnected` \| `session_reset_started` \| `session_reset_completed` (a reset-driven rejoin records only `session_reset_completed`, never also `reconnected`). A server-authored `disconnected` may carry `details {origin, reason}` using the closed disconnect pairs; wrapper ingress cannot author this shape. `trigger` applies only to `compact_boundary`: `request_compact` when the wrapper's own FIFO reservation queue attributes this boundary to a `request_compact` call; otherwise the SDK's own account (`sdk_auto` for its `"auto"`, `manual` for its `"manual"` — which also covers an operator-typed `/compact` directly, indistinguishable from the SDK's side); omitted when neither is determinable. `at` is the wrapper's own observation timestamp, not server receipt time. Server retains up to `SESSION_LIFECYCLE_MAX_EVENTS_PER_AGENT` events per agent (default 10,000, oldest discarded first) and does not notify peers. |
| wrapper → server | `disconnect_intent` | `{ version, reason }`, where `reason` is `stop` \| `quota_exhausted` \| `crash`. The server stamps `origin=agent_self`, accepts only the channel that currently owns the agent entry, and acknowledges before the wrapper closes. A quota turn error that leaves the wrapper alive does not send this event. |
| runner → server | `stop_agent` | `{ version, agent_id }` records a 30-second `runner/stop` intent only when the authenticated runner host owns the agent id. The runner sends it before signaling the child. |
| client → server | `list_conversations` | `{ version }` is an operator-only pull query. It replies `{ conversations: [{ conversation_id, agents, status, started_at, turns, tokens }, ...], conversations_incomplete?: true }`, newest first. `conversations_incomplete: true` means a newest-first prefix was returned because further complete entries would exceed the transport frame budget. |
| client → server | `list_session_events` | `{ version, agent_id }` is an operator-only pull query for one agent's `session_lifecycle` timeline, with the same `require_operator` gate as `list_conversations` / `list_users` (phase-33, [ADR-0055](../../adr/0055-compaction-resume-and-lifecycle-log.md)). `agent_id` is format-validated only (no existence check): `delete_agent` does not purge the `session_lifecycle` store, so a deleted agent's history stays queryable for post-hoc debugging — that retention is a deliberate decision, not an oversight, made together with this query (issue #200 closing note); an unknown/never-existed `agent_id` returns `{ "events": [] }`. Replies `{ events: [{ kind, trigger, at, details? }, …], events_incomplete?: true }`; permission events retain their typed details, newest first. `events_incomplete: true` means a newest-first prefix was returned because further complete entries would exceed the transport frame budget. |
| server → client | `session_reset_started` | `{ request_id, agent_id, mode, origin: "operator" \| "agent_self", previous_session_id?, reason? }` is operator-only; dashboard shows progress and disables Composer.  ([../adr/0021-role-information-disclosure-policy.md](../../adr/0021-role-information-disclosure-policy.md)) |
| server → client | `session_reset_completed` | `{ request_id, agent_id, mode, previous_session_id?, to_session_id: string \| null, clear_watermark?: string }` is emitted after fresh wrapper join confirms completion. `/clear` includes a SessionStarts-derived watermark used to filter panes. |
| server → client | `session_reset_failed` | `{ request_id, agent_id, mode, reason, ceiling_conflict? }` is operator-only with closed lifecycle vocabulary; dashboard displays a loud reason notice. `ceiling_conflict` (issue #397) is a `{ axis, current, ceiling }[]` present only for `reason: "permission_ceiling_conflict"` (Antigravity only), naming which axis to narrow. |
| server → wrapper | `session_reset_failed` | `{ request_id, reason }` is a private relay only to the old wrapper that reserved the matching reset; stale IDs and fresh wrappers are ignored. Never carries `ceiling_conflict` — the detail is operator-diagnostic only. |
| server → runner | `reset_session` | `{ version, agent_id, mode, request_id, previous_session_id?, resume_snapshot? }` terminates the old child, then fresh-launches or rolls back. It never double-starts after timeout and uses SessionPointers to apply the resume snapshot ([ADR-0036](../../adr/0036-session-lifecycle-commands.md), [ADR-0014](../../adr/0014-session-resume-and-restore.md)). |
| runner → server | `session_reset_result` | `{ version, host_id, agent_id, mode, request_id, ok, reason?, ceiling_conflict?, to_session_id?: string \| null }` reports fresh spawn/rollback after exact host binding. Success waits for wrapper join; failure broadcasts and releases the lock. `ceiling_conflict` mirrors the `session_reset_failed` field above (issue #397). |

A `session_reset_request` error reply has exactly four `reason` values: `agent_busy`,
`session_reset_pending`, `unsupported_session_reset`, and `runner_unavailable`.
`timeout` never appears in this payload because the wrapper transport owns that result when a
request receives no reply.

### ADR-0063 capability and event contract

The wrapper join request may declare
`inter_agent_delivery_modes: {version: "v1", early, yield, stage_reports}`
and independently `work_control: "v1"` and
`notice_attribution: "v1"` (sequence-scoped failure notices), and
`operator_input_modes: {version: "v1", early}` (`early` is `fold`, `steer`,
`hook` or `none`). The operator-input declaration is echoed as
`operator_input_modes: "v1"` when well formed, has no prerequisite, and never
changes inter-agent early admission. Delivery modes are echoed as
`inter_agent_delivery_modes: "v1"` only with `inter_agent_delivery_ack: "dispatch-v1"`,
`delivery_resync: "skip-v1"`, `inter_agent_reply_basis: "v1"`, and stage
reports enabled when an early or yield mechanism is declared. Work control
has no delivery-mode prerequisite and is echoed as `work_control: "v1"`.
The server echoes `notice_attribution: "v1"` independently when the wrapper
declares it; Codex IA steering requires this echo in addition to delivery
modes and the server-granted early intent. Older receivers retain conservative
CID-only failure notices.
An absent echo means the corresponding control is unavailable.
An acknowledged delivery join also echoes
`inter_agent_delivery_incarnation`, the server's current ledger incarnation.
The wrapper copies that value into `delivery_stage` and `yield_claim`; a stale
incarnation is refused with `stale_channel`. Every reconnect receives the
current value, including a reconnect in the same generation.

| Direction | Event | Contents |
|---|---|---|
| client → server | `instruction` | Gains optional `delivery_intent`: `normal`, `early`, or `yield`. An explicit value is relayed unchanged. When omitted, the recipient's `operator_input_modes` declaration decides alone if present (`early` unless it declared `none`); otherwise `early` when the recipient declared an inter-agent early mechanism, else `normal`. |
| client → server | `work_control` | Operator-only `{version: "0", work_control}`. The server applies the same reducer used for inter-agent operations and sends notices to affected agents. |
| client → server | `work_yield_status` | Operator-only `{version: "0", work_id, yield_token?}`. Reads claimed tokens for the work and each token's `cut`, `downgraded`, `unknown`, or `expired` disposition. |
| server → wrapper | `work_notice` | `{version: "0", work, op, reason, transfer_id?}`. `work` is a full record for a current director or assignee; a former assignee with a pending obligation receives `{work_id, access: "transfer_pending", pending_transfers}` containing only its own obligations. A later transfer ID is withheld from other former assignees. Best-effort ordinary input, without a conversation, turn, or reply basis. |
| server → client | `work_changed` | Operator-only `{version: "0", work}` after an applied operation. |
| server → client | `work_scope_overlap` | Operator-only `{version: "0", work_id, other_work_id, scopes}` when active grants overlap by declared scope. |

The matching shared MCP tools are `send_to_agent` with optional
`delivery_intent`, `work_id`, `expected_authority_epoch`, and
`work_control`; `work_transfer_ack({work_id, transfer_id})`;
`work_op_result({operation_id})`; `work_status({work_id?})`;
`work_check({work_id, action, expected_revision, subject_hash?})`; and
`delivery_status({conversation_id, turn_number})`. These names specify
the v0 wire surface; their availability follows the negotiated wrapper
implementation.

### Server-owned inter-agent queue (`credit-v1`)

The server holds every undelivered inter-agent input for a recipient. The
wrapper pulls it with credit, holds at most one offered and unsubmitted
ordinary batch, and reports a typed outcome for every item it was offered.
Queue identity (`queue_id`) is distinct from the delivery sequence: a
sequence is allocated only when an item is offered, and a returned item
keeps its `queue_id` and receives a new sequence on its next offer. Every
request and push below carries `version: "0"`; replies do not, as for other
channel replies.

This section fixes the field names and meanings. The runtime validators
for these shapes come with the server queue (C2). Because they make
`@kaoiro/protocol` a runtime import, that change also declares it as a
production dependency of the runner and the wrapper packages (director
decision, 2026-10-04).

**Join.** The wrapper join request must carry:

| Field | Value |
|---|---|
| `inter_agent_queue` | `"credit-v1"` |
| `inter_agent_queue_policy` | `{batch_max_items, backlog_max_items, backlog_max_bytes}`, all integers, defaults already resolved by the launcher. Rules: `batch_max_items` ≥ 1; 1 ≤ `backlog_max_items` ≤ 1000; 16384 ≤ `backlog_max_bytes` ≤ the server ceiling (`backlog_max_bytes_ceiling`, default 8388608) |
| `inter_agent_inline_recovery` | optional `"v1"`, only together with `inter_agent_reply_basis: "v1"`: the wrapper accepts `queue_recovery` on `stale_reply_basis` |
| prerequisites | `inter_agent_delivery_ack: "dispatch-v1"`, `delivery_resync: "skip-v1"`, `delivery_generation` |

The join reply echoes `inter_agent_queue: "credit-v1"`, the bound
`inter_agent_queue_policy`, `inter_agent_queue_epoch` (opaque string, new on
every start of the server queue owner), `inter_agent_inline_recovery: "v1"`
when declared, and `inter_agent_queue_resume_required` (boolean, true when
this generation still owns a lease or a waiter registration). A wrapper that
receives no `inter_agent_queue` echo must not proceed.

The policy is bound to `delivery_generation` and persisted with the
recipient's ledger. A rejoin under the same generation must declare the same
tuple. Join errors, returned before the agent is bound or published:

| `reason` | Extra fields | When |
|---|---|---|
| `queue_capability_required` | `missing` (list of absent or unsupported fields) | `inter_agent_queue` or a prerequisite is absent or has another value |
| `invalid_queue_policy` | `field`, `detail` (`missing`, `not_integer`, `below_minimum`, `above_ceiling`, `generation_mismatch`), `limit` when a bound applies | The tuple is missing, partial or malformed, outside its bounds, or differs from the tuple bound to this generation |

The wrapper exits with status 78 on either error; the runner does not
restart that exit.

**Batch limits.** `credit` carries no limits. Every offer uses the bound
`batch_max_items` (B), and the wrapper trims an offer to at most 16384 UTF-8
bytes of formatted native input. A first item larger than that is offered
alone. The trimmed suffix is returned with reason `format_budget` before any
native submission and stays charged on the server.

**Wrapper → server `delivery_queue_control`.** One event with a
discriminated `op`. Every request carries `operation_id`, `queue_epoch`,
`incarnation` and `generation`.

| `op` | Request fields | Success reply fields |
|---|---|---|
| `credit` | `kind`: `root` or `early`; `native_turn_token`; `mechanism`: `fold` or `steer` (early only) | `credit_revision` |
| `withdraw` | `credit_revision` | `withdrawn` (boolean; false when it was already consumed or superseded) |
| `begin_native` | `lease_id`, `queue_ids` (subset of the lease), `native_turn_token` | `permitted_queue_ids` |
| `return` | `lease_id`, `items: [{queue_id, reason, sub_reason?}]` | `returned_ranges` (`[[first, last]]` delivery sequences) |
| `dispose` | `lease_id`, `items: [{queue_id, outcome, witness?, reason?}]` | `disposed` (queue ids), `resolved_ranges`, `returned_ranges` |
| `waiter_close` | `registration_id` | `closed` (boolean), `claimed` (boolean: a reply already matched and stays as W) |
| `resume` | `lease_ids`, `registration_ids` | `leases: [{lease_id, items: [{queue_id, phase}]}]` with `phase` one of `queued`, `offered`, `native_pending`, `terminal`; `registrations: [{registration_id, active}]` |
| `freeze` | `reason`: `shutdown` or `session_reset` | `frozen: true` |

Every success reply also echoes `op` and `operation_id` and carries `queue`
(the counts below).

*Credit.* A wrapper has at most one outstanding credit; a new `credit`
supersedes the previous one. The ordinary lease slot is held while any item
of an ordinary lease (root, early or recovery) is still `offered`: the
server makes no new ordinary offer under any credit until that lease's
items are permitted by `begin_native`, returned or disposed, and a
superseding credit waits for that. Permitted items become `native_pending`
and free the slot. A `credit` with `kind: "root"` is refused with
`previous_root_pending`, and recorded as an invariant violation, while any
root item of an earlier native turn is still `native_pending`; the wrapper
disposes such items first (as `unknown` when no witness arrived).

*Idempotency.* An operation is keyed by `(recipient, queue_epoch,
generation, operation_id)`. The server keeps its record (payload digest,
reply, and the phase each touched item entered) across reconnects in the
same generation until every touched item has left that phase, or the epoch
or generation changes. Operations that touch no item keep their record as
follows: a `credit` until it is consumed by an offer, withdrawn or
superseded, so a retry returns the same `credit_revision`; `withdraw`,
`waiter_close`, `freeze` and `resume` for the epoch and generation, at most
the 64 most recent per recipient. A retry with the same `operation_id`:

- with a different payload is refused with `operation_payload_mismatch`;
- while every touched item is still in the recorded phase, receives the
  original reply;
- after any touched item moved on, is refused with `operation_superseded`
  and the current `items: [{queue_id, phase}]`; it never repeats the
  original success, so a stale `begin_native` cannot re-permit a returned
  item;
- after the record is gone, is refused with `unknown_operation`; an expired
  id and a never-seen id are not distinguished, and the wrapper reconciles
  through `resume`.

*Return and dispose.* `return` reasons: `early_ineligible` with
`sub_reason` one of `same_peer_in_turn`, `conversation_pending`,
`host_busy`, `pending_settings`, `steer_cap`, `fold_unavailable`,
`oversize`; and `format_budget`, `host_rejected_before_start`,
`credit_withdrawn`, `recovery_abandoned`, `waiter_abandoned`, `shutdown`,
`epoch_changed`. `return` is valid only when the host call for the item
was never invoked, for example a host that refused before the call. A
returned item keeps its `queue_id`, class, byte charge and queue position;
its old sequence is resolved as returned, never as lost, uncertain or
acknowledged.

| `dispose` `outcome` | Meaning | Required field | Capacity |
|---|---|---|---|
| `observed` | The native boundary took the input | `witness` (below) | released |
| `intentional_non_injection` | The wrapper classified the item and did not submit it | `reason`: `terminal_skip` or `stale_skip` | released |
| `definitely_unstarted` | The host call was invoked and returned a definite not-started result | `reason` | kept: the item returns to its queue position as for `return`, and its old sequence is reported in `returned_ranges` |
| `unknown` | Submission may have happened | `reason` | released; the sequence is resolved as uncertain |

Witnesses: `prompt_hook` and `fold_hook` (Claude), `tool_result` (every
engine's tool-result return), `turn_start_accepted` (Codex app-server),
`exec_input_written` (Codex exec), `turn_steer_item_observed` (Codex
steer), `turn_input_written` (Antigravity: a confirmed turn-input write
followed by `onTurnStart`), and `waiter_consumed` (Antigravity only, a
waiter reply consumed where the bridge exposes no tool-result return).

An early item that was returned, or disposed `definitely_unstarted`, is not
offered again under early credit for the same native turn. A duplicate
identical outcome is a no-op; a conflicting outcome for the same item is
refused.

*Sequences.* Under `credit-v1` the server resolves queue-origin sequences
only through `return`, `dispose` and the `delivery_resync` rule here.
`delivery_ack` for such a sequence is a no-op, and `delivery_stage` for it
is recorded as stage history only: it never resolves the sequence or
changes the item. A `delivery_resync` range that covers a queue-origin
sequence returns the item when it has no `begin_native` permit and resolves
it as `unknown` otherwise. It never records a loss for it, and the reply
reports those ranges in `returned_ranges` and `uncertain_ranges`, not in
`skipped_ranges`.

*Resume and freeze.* While `inter_agent_queue_resume_required` is true,
`credit`, `begin_native` and `delivery_resync` are refused with
`queue_resume_required`. The order after a same-generation rejoin is
`resume`, then `delivery_resync` for the remaining non-queue gap, then
`credit`. `freeze` withdraws the outstanding credit, and no
`delivery_batch` follows its reply. After `freeze`, `credit` and
`begin_native` are refused with `queue_frozen`; `return`, `dispose`,
`waiter_close` and `resume` stay valid.

Control errors (`reason`): `stale_queue_epoch`, `stale_channel` (stale
`incarnation` or `generation`), `stale_delivery_owner`,
`queue_resume_required`, `queue_frozen`, `previous_root_pending`,
`unknown_lease`, `unknown_queue_item`, `operation_payload_mismatch`,
`operation_superseded` (with `items`), `unknown_operation`,
`conflicting_disposition`, `invalid_queue_control` (with `field`), and
`queue_unavailable` (the queue owner cannot commit; nothing changed).

**Server → wrapper `delivery_batch`.** Pushed on the channel, never through
PubSub broadcast:

| Field | Meaning |
|---|---|
| `queue_epoch`, `incarnation`, `generation` | Must match the wrapper's current values; otherwise the wrapper ignores the push |
| `lease_id` | Lease the items belong to |
| `kind` | `root`, `early` or `waiter` |
| `credit_revision` | The credit the offer consumes (`root`, `early`) |
| `registration_id` | The matched waiter registration (`waiter`) |
| `items` | `[{queue_id, attempt_id, delivery_seq, class, byte_charge, envelope}]`; `class` is `ordinary`, `waiter` or `control`; `envelope` is the full `inter_agent_message` envelope |

A `root` offer carries at most B items: one peer's FIFO prefix, plus any
returned waiter items from any peer, which count toward B. `early` and
`waiter` offers carry one item.

**Sending (`envelope` with `type: "inter_agent_message"`).**

- The push may carry an outer `waiter_registration: {token, call_token,
  expires_in_ms}` for a `send_to_agent` that waits for its reply. `token` is
  a wrapper-generated random string; `expires_in_ms` is at most 300000. The
  peer, conversation and sent turn come from the envelope itself. The server
  strips the field before relaying, projecting or recording the envelope.
- An accepted reply adds `queue_id` and, when a registration was installed,
  `waiter_registration_id`. Its `delivery.advisory.unresolved_count` counts
  the recipient's queued items plus its issued-but-unresolved sequences.
- Refusals add three `reason` values: `receiver_overloaded` with `from` (the
  recipient) and `message`, before any conversation, sequence or pane change;
  `delivery_unavailable` with `delivered: false` when the accepted message
  could not be committed to the queue; and the existing
  `stale_reply_basis`, which gains `queue_recovery: {lease_id, items}` (the
  `delivery_batch` item shape) when the sender declared
  `inter_agent_inline_recovery` and matching queued input was claimed for
  it. The server claims at most 10 items and at most 16384 bytes of body
  charge. The wrapper returns with `format_budget` any claimed item that
  does not fit its rendered tool result.

**Queue counts.** Control replies, the server → wrapper `delivery_status`
push and `InterAgentDeliveryStatus` (whoami, `list_agents`, the dashboard
delivery snapshot) carry `queue: {queued, offered, native_pending, waiter,
control, charged_bytes, policy}`, within the existing wire-projection
budget:

| Field | Counts |
|---|---|
| `queued`, `offered`, `native_pending` | Non-waiter items in that phase; the three are disjoint |
| `waiter` | Waiter items in any phase, disjoint from the three above |
| `control` | Control-class items in any phase; a subset of the first three, not added to them |
| `charged_bytes` | Body-byte charge of every counted item, including waiter and control items |
| `policy` | The bound tuple |

The admission count Q is `queued + offered + native_pending + waiter`, and
the byte charge E is `charged_bytes`. The wrapper's `unread_count` takes
`queued` plus its own offered items not yet submitted. Bodies, tokens and
registration secrets never appear in these counts.

### Client transport

Client ↔ server connections use **Phoenix Channels exclusively**
([ADR-0009](../../adr/0009-client-transport.md)); no raw WebSocket endpoint or SSE is added.

- The wire format is fixed to the Channels V2 serializer and requires query `vsn=2.0.0`.
  Frame shape (`[join_ref, ref, topic, event, payload]`) follows the official guide
  [Writing a Channels Client](https://hexdocs.pm/phoenix/writing_a_channels_client.html)
  as specified.
- kaoiro defines only topics, event names, and payloads (the type/payload and directional
  message tables above).

## Related protocol topics

See [Protocol documentation](../../README.md#protocol-documentation) for the
full topic index.

- [Envelope contract](envelope.md).
- [Event types and payloads](events.md).
- [Versioning policy](versioning.md).
