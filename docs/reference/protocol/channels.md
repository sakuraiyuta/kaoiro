---
title: Channels and directional messages
status: accepted
last_updated: 2026-09-19
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
| wrapper → server | `envelope` | Full envelope. Only `inter_agent_message` receives an `{ ingress_stamp: [us, seq] }` acceptance ack; other types receive an empty reply. Causal ordering follows [directory event contracts](../../reference/inter-agent/directory.md#event-contracts); sidecar recording uses [ADR-0051](../../adr/0051-history-restart-resilience.md). |
| wrapper → server | `delivery_ack` | `{ delivery_seq: positive integer }`, the SDK-dispatch confirmation watermark (issue #237); unnegotiated, duplicate, or future values are no-op, not resend requests. |
| wrapper → server | `wrapper_build_info` | `{ build_revision, build_dirty, build_version, build_channel }` reports the wrapper artifact immediately after each successful channel join. The server derives `agent_id` from the topic, validates the complete identity pair, keeps only the latest connected value, and broadcasts it to operator-capable clients. `build_version` is `"unknown"` or `YYYY.M.PATCH`: a four-digit year, month `1` through `12`, and one to six decimal patch digits. The flat protocol `version` is added by the wrapper control-event funnel. |
| wrapper → server | `delivery_status_request` | `{}`; reads the sender's `{ delivery?: {issued_seq, acked_seq, pending_since?} }`. Absence is legacy/disarmed unknown. |
| wrapper → server | `delivery_resync` | Negotiated by the additional join capability `delivery_resync: "skip-v1"`, echoed in the join reply. `{generation, request_id, cutoff, missing_ranges}` retires a bounded page of missing sequences under the current channel owner and generation. The reply echoes `request_id` and `skipped_ranges` with post-skip `delivery`; errors are `invalid_delivery_resync` or `stale_delivery_owner`. Version remains `"0"`. See [gap recovery](../../reference/inter-agent/delivery.md#negotiated-gap-recovery). |
| wrapper → server | `history_reset` | `{ replay_id }` starts replay. Use the server ID when the join verdict requires replay, otherwise a legacy wrapper ID. Clear display projection, retain IA for `replay_ia`, and acknowledge an absent entry as no-op ([ADR-0051](../../adr/0051-history-restart-resilience.md), [ADR-0014](../../adr/0014-session-resume-and-restore.md)). |
| wrapper → server | `history_replay_complete` | `{ replay_id }` follows the final JSONL/sidecar row. The server broadcasts it and CAS-transitions matching in-flight hydration ([ADR-0051](../../adr/0051-history-restart-resilience.md)). |
| wrapper → server | `replay_ia` | `{ replay_id, items: [{ envelope, ingress_stamp }] }` restores one pane from the sidecar. Bind to the topic agent, upsert only that pane, reject stale/malformed stamps, and broadcast `history_replay_envelope`; operator-only ([ADR-0051](../../adr/0051-history-restart-resilience.md)). |
| wrapper → server | `directory_request` | `{}` requests the peer directory. The server allow-lists AgentStates, merges AgentDirectory-only disconnected entries, and removes the sending wrapper once. It replies with `{ agents: [...], users: [...] }` only when the complete production JSON reply fits the transport frame budget; otherwise its Phoenix error body is `{ reason: "directory_too_large" }`. It never returns a partial directory, so a wrapper cannot use incomplete data for peer name resolution. Projection rules are normative in [peer directory](../../reference/inter-agent/directory.md). |
| server → client | `snapshot` | `{ agents: { <agent_id>: envelope }, snapshot_incomplete?: true }` is pushed after join. The TransportLimits-bounded projection marks omission with `snapshot_incomplete`; compact entries may lose display-only fields while control state is unchanged. |
| server → client | `task_snapshot` | `{ tasks: { <agent_id>: { <task_id>: envelope } } }` is the active subagent/workflow set, separate from agents. Viewer joins always receive `tasks: {}` ([ADR-0048](../../adr/0048-task-aggregation-delivery.md)). |
| server → client | `delivery_snapshot` | `{ deliveries: { <agent_id>: { issued_seq, acked_seq, pending_since?, lost_count?, last_loss? } }, snapshot_incomplete?: true }` reports recipient-local confirmation gaps, not a resend queue; `lost_count?`/`last_loss?: {at, first_seq, last_seq, count, reason}` are explicit-retirement outcomes, not dispatches (`InterAgentDeliveryStatus`). Connected or gapped entries are prioritized; viewers receive `{ deliveries: {} }` ([ADR-0048](../../adr/0048-task-aggregation-delivery.md)). |
| server → client | `delivery_status` | `{ agent_id, delivery?: { issued_seq, acked_seq, pending_since?, lost_count?, last_loss? } }` reports a ledger update; capability loss omits `delivery`. Operator-only. |
| server → client | `wrapper_build_info` | Join snapshot is `{ builds: { "<agent_id>": { build_revision, build_dirty, build_version, build_channel } }, build_info_incomplete?: true }`; live update is the same flat identity plus `agent_id`, and disconnect is `{ agent_id, cleared: true }`. Only currently connected wrappers appear in the snapshot. `build_info_incomplete: true` means the join snapshot omits one or more complete entries to fit the transport frame budget; live update semantics are unchanged. Operator-only. |
| server → client | `envelope` | The complete envelope, broadcast on each state change. |
| server → client | `history` | `{ agents: { "<pane_agent_id>": [...] }, clear_watermarks: { ... }, history_projection: "per-pane-v1", projection_epoch, history_incomplete?: true }` is pushed after join. `history_incomplete: true` means one or more oldest history entries or clear-watermark entries were omitted to fit the transport frame budget. Each retained pane remains chronological and contains a newest suffix; it does not alter the server's history or clear-watermark state. Operator-only. |
| server → client | `directory` | `{ entries: { "<agent_id>": { ... } }, directory_incomplete?: true }` is pushed after join and after a directory change. `directory_incomplete: true` means complete directory entries were omitted to fit the transport frame budget; it does not change the directory state used by wrapper peer-name resolution. Operator-only. |
| server → client | `history_cleared` | `{ agent_id, session_id, clear_watermark }` follows operator `clear_history` and filters non-IA rows by session and IA rows by watermark. `/new` and `/clear` use session-reset lifecycle events instead. Missing start points warn and leave the watermark unchanged; operator-only. |
| server → client | `history_reset` | `{ agent_id, preserve_inter_agent: boolean, replay_id? }` is sent only for replay reconstruction. `preserve_inter_agent` is explicitly `false` during compatibility; `/new` and `/clear` do not use this event. Operator-only ([ADR-0051](../../adr/0051-history-restart-resilience.md)). |
| server → client | `history_replay_complete` | `{ agent_id, replay_id }` marks the resume JSONL replay boundary; matching rows are excluded from new-message animation. Operator-only. |
| server → client | `history_replay_envelope` | `{ pane_agent_id, envelope }` delivers one restored IA row to the named pane only; it must not fan out by `agent_id ∪ payload.to` ([ADR-0051](../../adr/0051-history-restart-resilience.md), [protocol-inter-agent](../../specs/protocol-inter-agent.md)). Operator-only. |
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
| client → server | `set_permission` | `{ version, agent_id, sandbox?, network_access?, approval? }`; operator-only non-empty patch. `approval` is accepted only when the session advertises it mutable in `permission_switch_axes` (Antigravity, issue #359); each axis is clamped to its launch ceiling. Persists requested raw configuration and returns `{revision, status:"pending", requested}`; see [permission changes](permission-requests.md#permission-changes-at-an-execution-boundary). |
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
| server → wrapper | `delivery_status` | `{ issued_seq, acked_seq, pending_since?, version }`, flat (the topic already scopes `agent_id`) — same ledger fields as the `server → client` row below, but distinct: this copy drives the wrapper's own gap-recovery bookkeeping (`wrapper/core/src/transport.ts` `#bindServerEvent("delivery_status", ...)`), broadcast alongside the client-bound copy from the same `broadcast_delivery_status/1` call. |
| client → server | `session_reset` | `{ agent_id, mode: "new" \| "clear" }` is operator-only. Validate role, agent, mode, capability, idle state, and pending lock atomically, then broadcast `session_reset_started` and push runner `reset_session`; reserved literal commands are rejected ([ADR-0036](../../adr/0036-session-lifecycle-commands.md)). |
| wrapper → server | `session_reset_request` | `{ mode: "new" \| "clear", reason?: string }` is the agent-self deferred reset request. Bind agent_id to the connection, reuse SessionResets checks, and return `{ request_id }` as lock confirmation only; use existing lifecycle rejection vocabulary ([ADR-0043](../../adr/0043-agent-initiated-session-reset.md)). |
| wrapper → server | `session_lifecycle` | `{ kind, trigger?, at, details? }` records one session-lifecycle transition (phase-33, [ADR-0055](../../adr/0055-compaction-resume-and-lifecycle-log.md)). `kind` — wrapper-produced: `compacting` \| `compact_boundary` \| `compact_failed` \| `resume_reserved` \| `resume_fired` \| `threshold_notice` \| `conversation_reset` plus `permission_applied` / `permission_failed` with typed [permission details](permission-sync-audit.md#permission-lifecycle-audit); server-only `permission_requested` uses the same timeline. Server-merged into the same per-agent timeline: `disconnected` \| `reconnecting` \| `reconnected` \| `session_reset_started` \| `session_reset_completed` (a reset-driven rejoin records only `session_reset_completed`, never also `reconnected`). A server-authored `disconnected` may carry `details {origin, reason}` using the closed disconnect pairs; wrapper ingress cannot author this shape. `trigger` applies only to `compact_boundary`: `request_compact` when the wrapper's own FIFO reservation queue attributes this boundary to a `request_compact` call; otherwise the SDK's own account (`sdk_auto` for its `"auto"`, `manual` for its `"manual"` — which also covers an operator-typed `/compact` directly, indistinguishable from the SDK's side); omitted when neither is determinable. `at` is the wrapper's own observation timestamp, not server receipt time. Server retains up to `SESSION_LIFECYCLE_MAX_EVENTS_PER_AGENT` events per agent (default 10,000, oldest discarded first) and does not notify peers. |
| wrapper → server | `disconnect_intent` | `{ version, reason }`, where `reason` is `stop` \| `quota_exhausted` \| `crash`. The server stamps `origin=agent_self`, accepts only the channel that currently owns the agent entry, and acknowledges before the wrapper closes. A quota turn error that leaves the wrapper alive does not send this event. |
| runner → server | `stop_agent` | `{ version, agent_id }` records a 30-second `runner/stop` intent only when the authenticated runner host owns the agent id. The runner sends it before signaling the child. |
| client → server | `list_conversations` | `{ version }` is an operator-only pull query. It replies `{ conversations: [{ conversation_id, agents, status, started_at, turns, tokens }, ...], conversations_incomplete?: true }`, newest first. `conversations_incomplete: true` means a newest-first prefix was returned because further complete entries would exceed the transport frame budget. |
| client → server | `list_session_events` | `{ version, agent_id }` is an operator-only pull query for one agent's `session_lifecycle` timeline, with the same `require_operator` gate as `list_conversations` / `list_users` (phase-33, [ADR-0055](../../adr/0055-compaction-resume-and-lifecycle-log.md)). `agent_id` is format-validated only (no existence check): `delete_agent` does not purge the `session_lifecycle` store, so a deleted agent's history stays queryable for post-hoc debugging — that retention is a deliberate decision, not an oversight, made together with this query (issue #200 closing note); an unknown/never-existed `agent_id` returns `{ "events": [] }`. Replies `{ events: [{ kind, trigger, at, details? }, …], events_incomplete?: true }`; permission events retain their typed details, newest first. `events_incomplete: true` means a newest-first prefix was returned because further complete entries would exceed the transport frame budget. |
| server → client | `session_reset_started` | `{ request_id, agent_id, mode, origin: "operator" \| "agent_self", previous_session_id?, reason? }` is operator-only; dashboard shows progress and disables Composer.  ([../adr/0021-role-information-disclosure-policy.md](../../adr/0021-role-information-disclosure-policy.md)) |
| server → client | `session_reset_completed` | `{ request_id, agent_id, mode, previous_session_id?, to_session_id: string \| null, clear_watermark?: string }` is emitted after fresh wrapper join confirms completion. `/clear` includes a SessionStarts-derived watermark used to filter panes. |
| server → client | `session_reset_failed` | `{ request_id, agent_id, mode, reason }` is operator-only with closed lifecycle vocabulary; dashboard displays a loud reason notice. |
| server → wrapper | `session_reset_failed` | `{ request_id, reason }` is a private relay only to the old wrapper that reserved the matching reset; stale IDs and fresh wrappers are ignored. |
| server → runner | `reset_session` | `{ version, agent_id, mode, request_id, previous_session_id?, resume_snapshot? }` terminates the old child, then fresh-launches or rolls back. It never double-starts after timeout and uses SessionPointers to apply the resume snapshot ([ADR-0036](../../adr/0036-session-lifecycle-commands.md), [ADR-0014](../../adr/0014-session-resume-and-restore.md)). |
| runner → server | `session_reset_result` | `{ version, host_id, agent_id, mode, request_id, ok, reason?, to_session_id?: string \| null }` reports fresh spawn/rollback after exact host binding. Success waits for wrapper join; failure broadcasts and releases the lock. |

A `session_reset_request` error reply has exactly four `reason` values: `agent_busy`,
`session_reset_pending`, `unsupported_session_reset`, and `runner_unavailable`.
`timeout` never appears in this payload because the wrapper transport owns that result when a
request receives no reply.

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

- [Envelope contract](envelope.md).
- [Event types and payloads](events.md).
- [Message topology](../../architecture/message-topology.md).
- [Versioning policy](versioning.md).
- [Permission requests](permission-requests.md).
- [Permission state](permission-state.md).
- [Permission synchronization and audit](permission-sync-audit.md).
- [Model and effort state](model-effort.md).
- [Session capabilities](capabilities.md).
- [Session lifecycle](session-lifecycle.md).
- [State machine](state-machine.md).
- [Attachment wire contract](attachments.md).
- [Attachment rendering by engine](../engines/attachment-rendering.md).
- [Runner control and launch](runner-control.md).
- [Task and tasklist envelopes](tasks.md).
