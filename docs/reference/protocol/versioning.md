---
title: Protocol versioning policy
status: accepted
last_updated: 2026-09-19
description: The flat outer-version stamping policy and the staged completion inventory for every wrapper/server/client/runner route.
---

# Protocol versioning policy

### Versioning policy

- Receivers **ignore unknown keys** for forward compatibility.
- ADR-0015 requires a flat outer `version` on **every wrapper/server/client message**. The
  implementation is staged; stage 1 covers client → server, server → wrapper, and server →
  runner. The inventory below is normative for all routes, including stage 2.
- A receiver treats only an exact version match as normal and logs a **warning** on mismatch,
  while continuing best-effort processing ([ADR-0015](../../adr/0015-protocol-version-stamping.md)).
- Additive keys and reserved types keep the same `version`; only breaking semantic changes or
  removals bump it.
- `ext` is a filter namespace and is not interpreted by the core.
- Transport version is negotiated independently by Channels `vsn`
  ([ADR-0009](../../adr/0009-client-transport.md)).

### Version inventory (issue #208)

This records staged fulfillment of ADR-0015's requirement for all three parties. Stage 1
(client → server, server → wrapper, server → runner) was completed in issue #208; baseline
is `develop` `8b1d287` (2026-08-21). The same misreading—"this message is not relayed to the
runner, so it needs no version"—became a must-fix twice in [#88](https://github.com/sakuraiyuta/kaoiro/issues/88)
and stage 3 of [#187](https://github.com/sakuraiyuta/kaoiro/issues/187). Except for the
explicit `attach_chunk` carve-out in ADR-0015, no implicit route exception exists; the table
below is authoritative and a neighboring message without a stamp is not precedent.

The **stamping authority** is route-specific. A producer stamps when assembling its payload;
for client payloads passed through by the server, the server **normalizes** (`relay/5` /
`relay_to_runner/4` overwrites `version` with `"0"`). This is not authentication of the
client claim but normalization that guarantees the receiver independent of sender build; the
original claim is warned before normalization.

#### Client → server (stage 1, completed in #208)

| Status | Message |
|---|---|
| Stamped | `instruction` / `permission_decision` / `question_response` / `interrupt` / `set_model` / `set_effort` / `refresh_models` / `refresh_engine_catalog` / `set_permission_mode` / `set_permission` / `set_quagmire_settings` / `rename_agent` / `clear_history` / `delete_agent` / `stop` / `restore` / `resume_session` / `session_reset` / `spawn` / `launch_defaults` / `enumerate_sessions` / `attach_open` / `attach_close` |
| Permanent carve-out | `attach_chunk` (below) |
| Producer not implemented | `restart` (no dashboard push call; implementation will use `pushVersioned` and stamp automatically) |

Dashboard stamps through the single `pushVersioned` send point (`dashboard/src/lib/protocol.ts`)
rather than call-site discipline, eliminating the structural opportunity for the above error.
`rename_user`/`list_users` producers (`connection.renameUser`/`connection.listUsers`) use the
same funnel. The unimplemented `revoke_wrapper_token` has only server-side receive checks.

#### Server → wrapper (stage 1, completed in #208)

| Status | Message |
|---|---|
| Server normalizes (`relay/5`) | `instruction` / `permission_decision` / `question_response` / `interrupt` / `set_model` / `set_effort` / `refresh_models` / `set_permission_mode` |
| Stamped during assembly | `attach_open` / `attach_close` / `revoked` / `session_reset_failed` / `delivery_status` / `persona_prompt` / join `set_permission_mode` / `set_permission` / `permission_sync` / `persona_sync` / `display_name_sync` |
| From envelope | `envelope` (IA relay; frame key carries `version`, including synthesized `SynthEnvelope`) |
| Permanent carve-out | `attach_chunk` (below) |

#### Server → runner (stage 1, completed in issues #171/#172)

`spawn` / `reset_session` / `switch_session` are stamped during server assembly.
`stop` / `restart` / `enumerate_sessions` / `refresh_engine_catalog` are normalized by
`relay_to_runner/4`.

#### Runner → server (complete; outside #208 scope)

`register` / `heartbeat` / `sessions` / `spawn_result` / `catalog_result` /
`session_reset_result` are all assembled by the runner with `version: "0"`.

#### Wrapper → server (stage 2, completed in issue #260; wrapper identity in issue #288 Stage 3)

`envelope` is stamped by its frame key. `delivery_ack` / `delivery_status_request` / `delivery_resync` /
`history_reset` / `replay_ia` / `history_replay_complete` / `directory_request` /
`session_reset_request` / `wrapper_build_info` / `session_lifecycle` / `disconnect_intent`
are declared in `WRAPPER_CONTROL_EVENT_POLICY`;
the wrapper's sole send point `#pushVersioned` adds flat `version`. The server's
`@wrapper_event_policy` and single `handle_in/3` funnel warn on omission/mismatch and accept
best-effort. `wrapper_build_info` is sent after every join/rejoin from the wrapper's own
generated artifact; it is not inferred from runner identity.

#### Server → client (stage 2, completed in issue #260; wrapper identity in issue #288 Stage 3)

`envelope` is stamped by its frame key. The remaining 21 events
(`history_replay_envelope` / `snapshot` / `task_snapshot` / `delivery_snapshot` / `history` /
`hosts` / `directory` / `history_cleared` / `history_reset` / `history_replay_complete` /
`agent_deleted` / `delivery_status` / `quagmire_notice` / `quagmire_settings` /
`session_reset_started` / `session_reset_completed` /
`session_reset_failed` / `spawn_result` / `runner_sessions` / `catalog_result` /
`wrapper_build_info`) receive flat
`version` from server `push_versioned/3`. Internal PubSub and runner claims are not wire SoT.
Dashboard's `CLIENT_EVENT_VERSION_POLICY` and `bindServerEvent` funnel warn and accept best-effort.

#### Permanent carve-out — `attach_chunk`

`attach_chunk` is a V2 binary frame (fixed header plus raw bytes, [attachment wire contract](attachments.md));
there is no JSON object on which to place a `version` key. Adding one would change the wire
(and bump the protocol version), outside #208. It is therefore a **permanent exception**;
the same rationale is recorded at the sender (`dashboard/src/lib/protocol.ts` `attachChunk`),
server receiver (`agents_channel.ex` `handle_in("attach_chunk", {:binary, data}, ...)`, the
only path calling `require_operator_role/1` directly), and wrapper receiver (`transport.ts`
`SERVER_EVENT_VERSION_POLICY` `binaryFrame`).

#### Receiver validation

ADR-0015's warn-then-accept rule (no warning on match; warn and continue on omission or
mismatch) is implemented on every receive path (server / wrapper / runner / dashboard).
It is guaranteed in two layers: a **mechanism enforcing validation** and
**tests detecting bypasses**, rather than handler-by-handler discipline.

The mechanism alone is insufficient: it can encourage validation but cannot prevent a new
route from bypassing it. Each layer therefore has a test that turns red when bypassed
(Fujino #208 review MF-3/MF-4).

| Receiver | Mechanism | Bypass detection |
|---|---|---|
| Server | `require_operator/4` invokes `warn_on_version_mismatch/3` after the role check (viewers cannot forge versions to create logs). | Enumerate `handle_in` event names from the module AST, push an invalid version to each, and assert warnings; new clauses are included automatically. |
| Wrapper | `#bindServerEvent` is the sole `channel.on` call and its event type must be a `SERVER_EVENT_VERSION_POLICY` key. | Assert the registered event set equals policy and each event is registered exactly once; Phoenix invokes every callback, so a raw duplicate `channel.on` is visible by count. |
| Runner | `bindControlEvents` loops over the event table to bind. | A source-regex test (`runner/test/transport.test.ts`) asserts `channel.on(` appears exactly once in `transport.ts` and that the one call is `bindControlEvents(channel, ...)` — a raw duplicate bind would fail it. |
| Client | `CLIENT_EVENT_VERSION_POLICY` and `bindServerEvent` validate 21 server → client events on receipt. | Integration tests cover every policy omission/match/mismatch and continued acceptance, and check `c.on(` appears only in the bind function. |

#### Non-map payload handling

Clients speaking Phoenix directly may place any JSON term in payload. Since handlers expect
maps, `AgentsChannel` returns **non-map payloads fail-closed as `missing_agent_id`** at the
start of `handle_in/3`. Binary `attach_chunk` frames are excluded because their correct
payload is `{:binary, data}`.

The shape gate runs before role resolution, so viewers receive a shape verdict rather than
`forbidden`. This preserves the intended priority and the one role resolution per message
(issue #148). A malformed-payload verdict concerns the sender's own input and discloses no
server state.

## Related protocol topics

- [Envelope contract](envelope.md).
- [Event types and payloads](events.md).
- [Channels and directional messages](channels.md).
- [Message topology](../../architecture/message-topology.md).
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
