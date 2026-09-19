---
title: Common event protocol
description: Common event envelopes v0, state machines, and persona identity shared by wrapper, server, and client.
status: accepted
related: [architecture, plugin-model, claude-events, personas, security-threat-model, subagent-tasks, protocol-inter-agent]
---
<!-- markdownlint-disable MD033 -->

# Common event protocol (v0)

## Purpose

Moved to [Message topology](../architecture/message-topology.md#purpose).

## Definition

### Terms and hierarchy

Moved to [Envelope contract](../reference/protocol/envelope.md#terms-and-hierarchy).

### Design intent

Moved to [Message topology](../architecture/message-topology.md#design-intent).

### Envelope v0

Moved to [Envelope contract](../reference/protocol/envelope.md#envelope-v0).

#### Two-axis `ext.permission` (2026-07-10, [ADR-0033](../adr/0033-permission-model-dual-axis.md))

Moved to [Permission control](../architecture/security-boundaries.md#permission-control-two-axis-model) (design intent) and
[Permission state](../reference/protocol/permission-state.md#two-axis-extpermission-2026-07-10-adr-0033) (field contract).

#### `ext.engine` (2026-07-10, [ADR-0032](../adr/0032-codex-adapter.md) F4a)

Moved to [Envelope contract](../reference/protocol/envelope.md#extengine-2026-07-10-adr-0032-f4a).

#### `ext.model_source` / `ext.effort_source` (2026-07-11, [ADR-0032](../adr/0032-codex-adapter.md) F4bc addendum, phase 15)

Moved to [Model and effort state](../reference/protocol/model-effort.md#extmodel_source--exteffort_source-2026-07-11-adr-0032-f4bc-addendum-phase-15).

#### `ext.session_capabilities` (2026-07-11, [ADR-0034](../adr/0034-session-capabilities-advertisement.md) F1/F2)

Moved to [Session capabilities](../reference/protocol/capabilities.md#extsession_capabilities-2026-07-11-adr-0034-f1f2).

#### `ext.resume_snapshot` / `ext.effective` / `ext.resume_drift` (2026-07-11, [ADR-0032](../adr/0032-codex-adapter.md) F4bc + [ADR-0033](../adr/0033-permission-model-dual-axis.md) F4 addendum, phase 15)

Moved to [Model and effort state](../reference/protocol/model-effort.md#extresume_snapshot--exteffective--extresume_drift-2026-07-11-adr-0032-f4bc--adr-0033-f4-addendum-phase-15).

#### `ext.pending_model` / `ext.pending_effort` / `ext.switch_error` / `ext.effort_reset` (2026-07-13, [ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md) F1–F3, phase 16)

Moved to [Model and effort state](../reference/protocol/model-effort.md#extpending_model--extpending_effort--extswitch_error--exteffort_reset-2026-07-13-adr-0035-f1f3-phase-16).

### Permission changes at an execution boundary

Moved to [Permission requests](../reference/protocol/permission-requests.md#permission-changes-at-an-execution-boundary).

#### Request, relay, and acknowledgement

Moved to [Permission requests](../reference/protocol/permission-requests.md#request-relay-and-acknowledgement).

#### Requested, submitted, and effective state

Moved to [Permission state](../reference/protocol/permission-state.md#requested-submitted-and-effective-state).

#### Persistence, join synchronization, and resume

Moved to [Permission synchronization and audit](../reference/protocol/permission-sync-audit.md#persistence-join-synchronization-and-resume).

#### Permission lifecycle audit

Moved to [Permission synchronization and audit](../reference/protocol/permission-sync-audit.md#permission-lifecycle-audit).

### Types and payload (v0 settled)

Moved to [Event types and payloads](../reference/protocol/events.md#types-and-payload-v0-settled).

#### Wrapper-owned stderr error diagnostics

Moved to [Event types and payloads](../reference/protocol/events.md#wrapper-owned-stderr-error-diagnostics).

### `task_type: "tasklist"` addendum (issue #178, ADR-0049 F4)

In addition to the general `task` rules, an agent's own todo is always the single entity
`{ agent_id, task_id: "tasklist", task_type: "tasklist" }`. The reserved word is bidirectional:
when `task_type` is `tasklist`, `task_id` must be `tasklist`, and vice versa.
The server rejects either mismatch. This prevents child task IDs from being used for this
entity and prevents child tasks from using the reserved ID.

The payload is `{ kind: "updated", status: "running", items, omitted? }`.
`items` is a whole-list snapshot of `{ text: string, status: "pending" | "in_progress" | "completed" }`,
with the latest snapshot replacing the whole list (LWW). Do not send `kind: "completed"`
when all items are complete. `items: []` is a valid replacement meaning that the current
todo is empty; retain the entity until its parent wrapper leaves. The dashboard must not
show a float for an empty list (avoiding a meaningless `0/0`), but must not delete the
entity from state.

The wrapper sends at most 50 items in source order, normalizing each `text` to at most
256 UTF-8 bytes and the `items` JSON to at most 16,384 bytes. If later source items exist,
it must include `omitted: { count, completed }`, so the operator can see that the detail is
partial and how many items are complete overall. The server defensively validates the same
limits and rejects violations; normal over-limit input is made displayable by wrapper normalization.

`tasklist` is outside the three-second/token/tool-name throttle used for child-task
`kind=updated`. Todo changes have no later token/tool signal to flush, so that throttle
could permanently lose updates. The wrapper de-duplicates only consecutive snapshots with
identical content and sends changed snapshots immediately. Claude Code's default source
since SDK 0.3.228 is the `TaskCreate`/`TaskUpdate`/`TaskList` tool triggers ([ADR-0049](../adr/0049-tasklist-on-task-envelope.md)
addendum); `TodoWrite`, which maps `content` and the three-valued status directly, remains
only the `CLAUDE_CODE_ENABLE_TASKS=0` compatibility fallback. `activeForm` is Claude-local UI text; the wire item
settled by ADR-0049 contains only text and status, so it is not sent. Showing it later
requires a protocol extension rather than an implicit field addition. Codex
`todo_list.completed: boolean` maps `false -> pending` and `true -> completed`.
Both cover only the parent thread's list. On socket reconnect, wrapper transport resends
active `task` entities with a fresh seq, so they can be restored even after the old channel
terminates and purges the server task table, without tasklist content de-duplication blocking it.
The resend cache is capped at `5,000` entities / JSON `6,000,000` bytes. This prevents
crashed/killed child tasks that never send `completed` from remaining forever; on overflow,
the least recently updated child entities leave the cache and the wrapper warns on stderr.
The parent `tasklist` snapshot is retained while any other eviction target exists. This is
a local-memory bound for reconnects, not a substitute for server-side TaskStates ingress/byte
bounds across multiple wrappers.

### Directional message types (v0 settled)

Moved to [Channels and directional messages](../reference/protocol/channels.md#directional-message-types-v0-settled).

### Planned wrapper cycle (issue #256)

Moved to [Session lifecycle](../reference/protocol/session-lifecycle.md#planned-wrapper-cycle-issue-256).

#### Projection hydration and restart resilience ([ADR-0051](../adr/0051-history-restart-resilience.md))

Moved to [Session lifecycle](../reference/protocol/session-lifecycle.md#projection-hydration-and-restart-resilience-adr-0051).

### Session visibility semantics (#106 / ADR-0036 F3 restoration, 2026-07-24)

Moved to [Session lifecycle](../reference/protocol/session-lifecycle.md#session-visibility-semantics-106--adr-0036-f3-restoration-2026-07-24).

### File-upload wire

Moved to [Attachment wire contract](../reference/protocol/attachments.md#file-upload-wire).

### Session resume and restoration

Moved to [Session ownership and continuity](../architecture/system-overview.md#session-ownership-and-continuity) (design intent) and
[Session lifecycle](../reference/protocol/session-lifecycle.md#session-resume-and-restoration) (field contract).

### Runner control messages (v0 settled, [#66](https://github.com/sakuraiyuta/kaoiro/issues/66))

The runner resident on each host ([ADR-0023](../adr/0023-host-runner-architecture.md))
connects to the server on the dedicated `runner:<host_id>` topic, separate from the direct
`wrapper:<agent_id>` data path. It registers the host, reports liveness, and controls the
wrapper lifecycle (spawn / stop / restart / session enumeration), including resume. Messages
use the existing **Channels event** mechanism; no envelope `type` is added.

| Direction | Event | Payload |
|---|---|---|
| runner → server | `register` | `{ host_id, cwd_allowlist, allowed_personas? \| blocked_personas? \| personas?, capabilities?, engines?, build_revision?, build_dirty?, build_version?, build_channel? }`. Sent once at connection to declare the cwd allowlist and persona trust mode. Exactly one of `allowed_personas`, `blocked_personas`, or none (accept-all) may be set; multiple values are invalid ([ADR-0031](../adr/0031-runner-persona-trust-mode.md)). Legacy `personas` is deprecated and interpreted as an ID allowlist; `name`/`sprite_set` are ignored because server SoT owns them ([ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md)). `engines` carries per-engine launch catalogs for the LaunchDialog cascade ([ADR-0032](../adr/0032-codex-adapter.md) F4bc). Capabilities are `"claude-code" \| "codex" \| "antigravity"`; old `"claude"` is normalized for one release then rejected ([ADR-0032](../adr/0032-codex-adapter.md) F4a, [ADR-0057](../adr/0057-antigravity-adapter.md) F1). Each `capabilities` item and `engines[].id` is at most 64 UTF-8 bytes; each `engines[].models[].value` and `engines[].models[].display_name` is at most 256 UTF-8 bytes. `build_revision`/`build_dirty` identify the git artifact and `build_version`/`build_channel` identify its CalVer project version and channel (issue #288, [ADR-0056](../adr/0056-project-calver-build-version.md)); each pair may be omitted for pre-feature compatibility, but a pair must be complete and values must be in-domain. `build_version` is `"unknown"` or `YYYY.M.PATCH`: a four-digit year, month `1` through `12`, and one to six decimal patch digits. When the version/channel pair is present with `channel: "release"`, the revision/dirty pair is also required, and it must be a known 40-hex revision with `dirty: false`; the version must be a known CalVer value. Any incomplete, out-of-domain, or contradictory release identity is rejected as `invalid_build_info`. |
| runner → server | `heartbeat` | `{ host_id }`. Liveness notification. |
| runner → server | `sessions` | `{ host_id, cwd, sessions: [{ session_id, summary?, mtime? }], engine? }`. Response to `enumerate_sessions`; minimal JSONL metadata, **operator-only** (T2, [ADR-0014](../adr/0014-session-resume-and-restore.md)). Echoes the requested engine so dashboards discard stale results ([ADR-0032](../adr/0032-codex-adapter.md) F8). |
| runner → server | `spawn_result` | `{ host_id, agent_id, ok, reason?, request_id? }`. Failure reasons are `already_running` / `cwd_not_found` / `session_not_found` (T3 validation under cwd failed, [#101](https://github.com/sakuraiyuta/kaoiro/issues/101)) / `permission_ceiling_conflict` (an Antigravity spawn declared an `antigravity.max_*` ceiling narrower than its own launch value, [ADR-0057](../adr/0057-antigravity-adapter.md) F4c Stage B0, [#359](https://github.com/sakuraiyuta/kaoiro/issues/359), rejected fail-closed) / `error`. Echo `request_id` from `spawn`/`switch_session`; the server applies it only when matching the stored transition (phase-27 / [#150](https://github.com/sakuraiyuta/kaoiro/issues/150)). Old runners omit it and the server silently drops correlation. |
| server → runner | `spawn` | `{ agent_id, persona, display_name?, cwd, server_url?, token?, initial_prompt?, resume_session_id?, resume_snapshot?, apply_resume_snapshot?, engine?, model?, effort?, permission_mode?, sandbox?, network_access?, approval?, request_id? }`. **Operator-only**. `display_name` is the server-resolved initial display name (the operator's spawn custom name, else `persona.name`'s value at that moment; [ADR-0050](../adr/0050-principal-model-and-graded-access-control.md) D1, [#219](https://github.com/sakuraiyuta/kaoiro/issues/219) D19/D20). The runner supplies `server_url` from its config when omitted; `initial_prompt` is the wrapper's first turn. `model`/`effort` are LaunchDialog values ([ADR-0032](../adr/0032-codex-adapter.md) F4bc). Claude `permission_mode` is persisted at spawn so explicit spawn wins; Codex/Antigravity `sandbox`/`network_access` are fixed launch permissions, and Antigravity's `approval` is likewise launch-fixed ([ADR-0033](../adr/0033-permission-model-dual-axis.md), [ADR-0033](../adr/0033-permission-model-dual-axis.md) F3, [ADR-0057](../adr/0057-antigravity-adapter.md) F4c). `request_id` is the server session-transition correlation echoed as wrapper `transition_id`; `resume_session_id` selects resume. `agent_id` and `token` are server-issued, not client input ([ADR-0024](../adr/0024-agent-instance-identity-and-spawn-auth.md) D3/D4). `engine?: "claude-code" \| "codex" \| "antigravity"` selects the wrapper package and is checked against registered capabilities ([ADR-0032](../adr/0032-codex-adapter.md) F1, [ADR-0057](../adr/0057-antigravity-adapter.md) F1). `apply_resume_snapshot?: true` requests fresh-restore without a resume ID (phase-25, [ADR-0030](../adr/0030-agent-directory-and-explicit-restore.md) D8 / [ADR-0014](../adr/0014-session-resume-and-restore.md) F1). |
| server → runner | `stop` | `{ agent_id }`. **Operator-only**. Validate the client host binding before intent mutation; cancel any planned intent and deliver terminal `disconnected` to tracked peers before relay (issue #256). |
| server → runner | `restart` | `{ agent_id, request_id? }`. **Operator-only**. Validate host binding first. New servers assign a non-empty request ID for planned live-agent restarts; new runners map it to wrapper `transition_id` after relaunch, while omission preserves old behavior (issue #256). |
| server → runner | `enumerate_sessions` | `{ agent_id?, cwd, engine? }`. **Operator-only**. Requests resume candidates under `cwd`, scoped to one engine (default `claude-code`, [ADR-0032](../adr/0032-codex-adapter.md) F8). The server strips `host_id`, fills `cwd` from SessionPointers when omitted, and forwards a runner shape where `cwd` always exists; `agent_id` remains only for detail-view requests. Client must provide at least `cwd` or `agent_id`; both are accepted, with explicit `cwd` taking precedence. |
| server → runner | `switch_session` | `{ agent_id, resume_session_id, request_id?, resume_snapshot? }`. **Operator-only**. Replaces the resume target of a live agent without changing agent_id/cwd. Runner transfers the F4 lock and restarts the wrapper, rechecking T3 and F4; failures use `spawn_result` ([ADR-0014](../adr/0014-session-resume-and-restore.md)). `request_id` distinguishes the new connection; `resume_snapshot` carries the server's current SessionPointers snapshot (phase-15 D8). |
| server → runner | `refresh_engine_catalog` | `{ engine, request_id, force? }`. **Operator-only** request to re-probe the LaunchDialog engine catalog ([ADR-0039](../adr/0039-engine-catalog-live-probe.md) Option E). It is keyed by `(host, engine)`, not agent; `force` bypasses TTL. Only Claude currently probes live; Codex advertises statically ([ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md) F1). |
| runner → server | `catalog_result` | `{ host_id, engine, request_id, ok, reason?, models_count? }`. Completion report for `refresh_engine_catalog`, forwarded to operators. Failure reasons are `auth_failed` / `spawn_failed` / `cli_error` / `invalid_output` / `timeout` / `unsupported_engine`; `models_count` is only a toast signal and the catalog arrives in the runner's normal `hosts` broadcast ([ADR-0039](../adr/0039-engine-catalog-live-probe.md)). |

**Authentication**: The runner connects with per-host tokens (a server-configured
`host_id:token` list, extending ADR-0011's per-entity token principle). host_id is fixed in
configuration and is not server-assigned; this is separate from per-agent wrapper tokens
([ADR-0011](../adr/0011-phase3-reliability-and-auth.md)).

**Version**: Runner messages also carry flat outer `version` (currently `"0"`)
([ADR-0015](../adr/0015-protocol-version-stamping.md)); adding message types keeps the same
version for forward compatibility.

There are two `version` stamping authorities. Messages whose payload is **assembled** by
server or runner (`register` / `heartbeat` / `sessions` / `spawn` / `spawn_result` /
`switch_session` / `reset_session` / `session_reset_result` / `catalog_result`) are stamped
at assembly. In pass-through routes where the server strips only `host_id` from client
payload (`enumerate_sessions` / `refresh_engine_catalog` / `stop` / `restart`),
`relay_to_runner/4` warns about the client value and normalizes `version` to `"0"`.
Dashboard pushes also all carry `version` through the single `pushVersioned` funnel (issue
#208 onward). Runners warn on mismatch, including omission, and accept best-effort (ADR-0015).

`restart` still lacks a dashboard push producer, but implementation will use the funnel above
and therefore stamp `version` automatically. See "version inventory" below for coverage.

**Safety** (spawn is effectively remote code execution): accepting spawn / resume /
resume_session / stop / restart is **operator-only**. Runner T3 verifies that the resume
session exists under the agent-bound cwd; `switch_session` rechecks the target in the same
immutable cwd. The cwd is restricted to the runner `cwd_allowlist` (#22, T1).

**Duplicate-start prevention** uses two layers: existing server-owner fencing plus a
runner-local lock ([ADR-0014](../adr/0014-session-resume-and-restore.md) F4). The runner
rejects a spawn race with `spawn_result.reason = already_running`. A wrapper join for an
`agent_id` that already has a live owner is also explicitly rejected, making accidental
double starts visible instead of silently applying last-write-wins ([ADR-0024](../adr/0024-agent-instance-identity-and-spawn-auth.md) D5).

### WrapperConfig fields relayed by the runner (issues #181 and #292)

`WrapperConfig` (protocol/src/index.ts) is the runner's per-spawn config
handoff to the wrapper process it launches — a process-boundary data
structure, not a `runner:<host_id>` channel message like the table above.
Most of its 30 fields mirror the `spawn` payload verbatim
(`resolveWrapperConfig`, runner/src/supervisor.ts); this section documents
only the fields that instead come from `runner.config.json`'s per-engine
blocks, since nothing else in this spec names `WrapperConfig`.

- `codex_backend?: "exec" | "app-server"` — runner-local `codex.backend`,
  resolved to `"exec"` when omitted and relayed only for Codex launches. The
  wrapper validates the closed enum. It is not accepted from `spawn` or a
  resume snapshot and is not a wire capability. Reload affects subsequent
  wrapper lifetimes, including resumes; existing wrappers retain their backend.

- `codex_extra_models` / `antigravity_extra_models` (`EngineModelInfo[]`)
  — the operator's `codex.extra_models` / `antigravity.extra_models`
  declaration (runner.config.json), already merged by the runner's
  `buildRegister` into the launch catalog it advertises. Relayed so the
  wrapper applies the SAME merge to its own catalog resolution — `ext.models`,
  effort-switch availability (Codex only), and `setModel` validation must
  all recognise a declared model too, not only the register's launch-time
  list. Absent / empty on either field means no declarations for that
  engine. See [Codex model settings](../operations/codex-model-settings.md#d-kaoiros-own-extra_models-declaration-issue-292) (D) and
  runner/README.md's "Codex 設定" / "Antigravity configuration" sections
  for the declaration syntax and merge semantics.

- `antigravity_cli_path` / `antigravity_probe_timeout_ms` — runner-local
  values derived from `antigravity.cli_path` / `antigravity.probe_timeout_ms`.
  They are not accepted from a server `spawn` payload and introduce no
  server/dashboard error vocabulary. The wrapper snapshots them at launch;
  path resolution or probe failure is reported only by an existing bounded,
  redacted local diagnostic.

### Client → server launch control (#22, [ADR-0024](../adr/0024-agent-instance-identity-and-spawn-auth.md))

Launch-UI requests from the dashboard operator are relayed by the server to
`runner:<host_id>` (see the runner control table). **Persona is a type; agent_id is an
instance**. Multiple spawns with the same character are represented by one persona and
different agent IDs (D1).

`version` follows the directional-message rules above: in stage-1 client → server rows it is
a common outer key, and appears in a payload column only for producer-specific notes. The
version inventory below is normative for all routes.

| Direction | Event | Payload |
|---|---|---|
| client → server | `spawn` | `{ host_id, persona, cwd, name?, initial_prompt?, resume_session_id?, engine?, model?, effort?, permission_mode?, sandbox?, network_access?, approval? }`. **Operator-only**. LaunchDialog values are passed through to runner; `persona` is an ID resolved against the host declaration. The server allocates `agent_id` and issues the per-agent token (plan A, D3/D4; [ADR-0024](../adr/0024-agent-instance-identity-and-spawn-auth.md)); runner supplies `server_url` from config. Optional `name` overrides the per-instance display name (agent_id/persona.id unchanged, at most 64 grapheme clusters and 256 UTF-8 bytes, with no control characters). `resume_session_id` selects resume and seeds cwd in SessionPointers. `engine` must be advertised by the host ([ADR-0032](../adr/0032-codex-adapter.md) F1, [ADR-0032](../adr/0032-codex-adapter.md) F1, [phase-14-codex-adapter](../plans/phase-14-codex-adapter.md)). |
| client → server | `launch_defaults` | `{ version }`. **Operator-only** request for LaunchDialog's per-persona previous effort ([issue #88](https://github.com/sakuraiyuta/kaoiro/issues/88)); it is computed synchronously by the server and never relayed to runner. ADR-0015 still requires the version stamp, with mismatch/absence warned and accepted best-effort. Reply status is Phoenix `ok`, body `{ defaults: { "<persona_id>": "<effort>" } }`. The server joins AgentDirectory and SessionPointers at read time; for each persona choose the highest `effort_revision`, the sole candidate, or one common value, and omit conflicting preferences. Invalid entries are dropped fail-closed; LaunchDialog falls back silently to `default_effort`. |
| client → server | `stop` / `restart` | `{ version, host_id, agent_id }`. **Operator-only**. Verify exact host binding and reject mismatches as `agent_not_owned`; stop comes from the dashboard end button and derives host_id from agent_id. A future restart producer will use `pushVersioned` and receive the stamp automatically (issue #208). |
| client → server | `restore` | `{ agent_id }`. **Operator-only**. Re-spawn a disconnected agent with the same ID and resume pointer (ADR-0014). Missing pointer/cwd returns `no_session`; a live agent returns `not_disconnected`. |
| client → server | `resume_session` | `{ agent_id, session_id }`. **Operator-only**. Select a resume target while retaining agent_id/cwd (ADR-0014 resume-swap). Live agents use runner `switch_session` (kill → relaunch); disconnected agents use `spawn`. Session IDs match `[A-Za-z0-9-]{1,128}`; missing/invalid values return `missing_session_id` / `invalid_session_id`, and missing cwd returns `no_session`. |
| client → server | `enumerate_sessions` | `{ version, host_id, cwd }` or `{ version, host_id, agent_id }`. **Operator-only** request for resume candidates. The server fills cwd from SessionPointers when omitted; neither field returns `invalid_cwd`, and a pointer without cwd returns `no_session`. |
| client → server | `refresh_engine_catalog` | `{ version, host_id, engine, request_id, force? }`. **Operator-only** LaunchDialog refresh. The server checks role, host_id, and payload size, then relays the remaining fields opaquely to `runner:<host_id>`; runner validates engine/request_id/force ([ADR-0039](../adr/0039-engine-catalog-live-probe.md)). |
| server → client | `hosts` | `{ hosts: { "<host_id>": { personas, cwd_allowlist, capabilities?, engines?, build_revision?, build_dirty?, build_version?, build_channel?, registered_at } }, hosts_incomplete?: true }`. A **map keyed by host_id**, pushed on host changes and immediately after join. `personas` is the host trust policy applied to the server persona pool, not raw runner IDs ([ADR-0031](../adr/0031-runner-persona-trust-mode.md)). `hosts_incomplete: true` means complete host entries were omitted to fit the transport frame budget. Build identity fields pass through runner `register` (issues #218/#288, [ADR-0053](../adr/0053-build-identity.md), [ADR-0056](../adr/0056-project-calver-build-version.md)); `build_version` uses the same `"unknown"` or `YYYY.M.PATCH` grammar (four-digit year, month `1` through `12`, one to six decimal patch digits). The dashboard shows the runner's CalVer/channel in the host selector and retains mismatch warnings without blocking. **Operator-only** ([ADR-0021](../adr/0021-role-information-disclosure-policy.md)). |
| server → client | `runner_sessions` | Forwarded runner `sessions` response to `enumerate_sessions`. **Operator-only**. |
| server → client | `spawn_result` | Forwarded `{ host_id, agent_id, ok, reason?, request_id? }`. **Operator-only**. |
| server → client | `catalog_result` | Forwarded runner result. **Operator-only**; the successful catalog itself arrives in the runner's subsequent `hosts` broadcast. |

**Spawn authentication path**: Spawn is unified through the runner (resident or one-shot
`kaoiro-runner spawn …`). Trust starts with the per-host runner token
([ADR-0023](../adr/0023-host-runner-architecture.md)) plus the per-agent token issued and
injected by the server at spawn; pre-registering per-agent tokens is unnecessary
([ADR-0024](../adr/0024-agent-instance-identity-and-spawn-auth.md) D2/D4). Token issuance
and lifetime are defined by ADR-0024. Full runner-less direct `node wrapper` support is [#71](https://github.com/sakuraiyuta/kaoiro/issues/71).

### Versioning policy

Moved to [Versioning policy](../reference/protocol/versioning.md#versioning-policy).

### Version inventory (issue #208)

Moved to [Versioning policy](../reference/protocol/versioning.md#version-inventory-issue-208).

#### Client → server (stage 1, completed in #208)

Moved to [Versioning policy](../reference/protocol/versioning.md#client--server-stage-1-completed-in-208).

#### Server → wrapper (stage 1, completed in #208)

Moved to [Versioning policy](../reference/protocol/versioning.md#server--wrapper-stage-1-completed-in-208).

#### Server → runner (stage 1, completed in issues #171/#172)

Moved to [Versioning policy](../reference/protocol/versioning.md#server--runner-stage-1-completed-in-issues-171172).

#### Runner → server (complete; outside #208 scope)

Moved to [Versioning policy](../reference/protocol/versioning.md#runner--server-complete-outside-208-scope).

#### Wrapper → server (stage 2, completed in issue #260; wrapper identity in issue #288 Stage 3)

Moved to [Versioning policy](../reference/protocol/versioning.md#wrapper--server-stage-2-completed-in-issue-260-wrapper-identity-in-issue-288-stage-3).

#### Server → client (stage 2, completed in issue #260; wrapper identity in issue #288 Stage 3)

Moved to [Versioning policy](../reference/protocol/versioning.md#server--client-stage-2-completed-in-issue-260-wrapper-identity-in-issue-288-stage-3).

#### Permanent carve-out — `attach_chunk`

Moved to [Versioning policy](../reference/protocol/versioning.md#permanent-carve-out--attach_chunk).

#### Receiver validation

Moved to [Versioning policy](../reference/protocol/versioning.md#receiver-validation).

#### Non-map payload handling

Moved to [Versioning policy](../reference/protocol/versioning.md#non-map-payload-handling).

### Identity and persona (must)

Moved to [Session lifecycle](../reference/protocol/session-lifecycle.md#identity-and-persona-must).

### State-machine state set v0 (draft)

Moved to [State machine](../reference/protocol/state-machine.md#state-machine-state-set-v0-draft).

### Persona asset distribution

HTTP API resolving `persona.sprite_set` to images. [ADR-0008](../adr/0008-persona-asset-distribution.md)
initially covered sprites only; [ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md)
expanded it on 2026-07-05 to persona-pack zip distribution, a server aggregate SoT, and
auto-watch. It is independent of Channels and not gated by `:serve_dashboard` (public API).
Asset layout and format are defined by [personas](personas.md); the pack schema is
[persona-pack-format](../reference/personas/pack-format.md).

- `GET /api/personas` — manifest JSON:

```json
{
  "version": "<16hex>",
  "personas": {
    "<sprite_set>": {
      "name": "<display name>",
      "pack_version": "<semver>",
      "description": "<optional 1-line>",
      "states": {
        "<state>": {
          "url": "/personas/<sprite_set>/<state>.png?v=<12hex>",
          "hash": "sha256:<64hex>"
        }
      }
    }
  }
}
```

- `version` is the aggregate version derived from asset contents; clients refetch sprite URLs
  only when it changes (incremental sync).
- `name` / `pack_version` / `description` come from the persona pack `manifest.json`
  ([persona-pack-format](../reference/personas/pack-format.md)). `personality.md` is not exposed by this API;
  it is pushed only during the WS wrapper handshake (see "Personality prompt delivery").
- Hashed `url` forms are immutable with `cache-control: public, max-age=31536000, immutable`;
  URLs without `?v=` are `no-cache`.
- Only files listed in the manifest are served; unknown paths return 404.
- A missing sprite falls back to the `idle` image. `disconnected` has no image (MUST NOT in
  personas.md) and is shown as grayscale idle. Missing manifests or unlisted sprite sets fall
  back to sprite-less rendering (CSS face in the reference implementation).
- **Auto-watch**: the server watches the intake directory with Elixir `FileSystem`, detects zip
  additions/updates/deletions, and rebuilds the manifest ([ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md) F6); no manual restart is needed.

### Personality prompt delivery (ADR-0029)

Under [ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md), the personality
prompt is pushed from the server aggregate SoT (`personality.md` in the persona pack) to the
wrapper during the WS handshake.

- **Reject unknown persona.id at wrapper join**: when accepting `wrapper:<agent_id>`, the server
  checks the persona ID from the agent-token mapping against the manifest. IDs absent from the
  manifest are refused (enforcing no stray personas,
  [ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md)
  F3).
- **after_join push**: server pushes the following message to the wrapper:

  | Direction | Type | Payload | Notes |
  |---|---|---|---|
  | server → wrapper | `persona_prompt` | `{ prompt }` | Sent once after wrapper join. `prompt` is persona-pack `personality.md` plus the server-joined common footer ([ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md) F5). The wrapper injects it unchanged with SDK `systemPrompt.append` ([persona-personality-injection](persona-personality-injection.md)); no hot-swap push occurs during the session (F9). |

- **Fail-closed when server is unreachable**: the wrapper cannot complete spawn until it
  receives `persona_prompt`, including dev/local operation where a minimal server runs in
  [ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md)
  F10).

### Client transport

Moved to [Channels and directional messages](../reference/protocol/channels.md#client-transport).

### Connection authentication (v0 settled, [ADR-0011](../adr/0011-phase3-reliability-and-auth.md))

Moved to [Authentication and authorization](../reference/security/authentication-authorization.md#connection-authentication-v0-settled-adr-0011).

## Constraints

- MUST: `agent_id` is stable. MUST: state derivation is wrapper-side.
- MUST: `agent_id` uses `[A-Za-z0-9._-]`, 1–256 characters.
- MUST: client connections use only Phoenix Channels (`vsn=2.0.0`).
- MUST: receivers ignore unknown envelope keys (forward compatibility).
- MUST: `instruction` / `permission_decision` / `interrupt` are operator-only.
- MUST: permission waits are **unlimited** by default, matching the SDK (Promise remains
  pending). Finite timeout is wrapper opt-in and then fails closed with deny ([ADR-0022](../adr/0022-pending-permission-authoritative-source.md), issue #60).
- MUST: while `waiting_permission`, pending state persists in `state_change.ext.pending_permission`,
  the authoritative source; `permission_request` is only the initial notification
  ([ADR-0022](../adr/0022-pending-permission-authoritative-source.md)).
- MUST: `log` / `result` envelopes are delivered only to operator role ([ADR-0012](../adr/0012-response-display-and-dashboard-scope.md)).
- MUST: `agents:lobby` uses an **allow-list**. Viewers receive only `state_change` (with `ext`
  removed) and `agent_deleted`; all other events/types are removed ([ADR-0021](../adr/0021-role-information-disclosure-policy.md)).
  `permission_request` is replaced for viewers by synthetic `state_change(waiting_permission)` to keep the grid consistent.
- MUST: file-upload operations (`attach_open` / `attach_chunk` / `attach_close` /
  `attach_rejected` / `instruction_rejected` / `instruction.attachment_ids`) are **operator-only**
  for both delivery and acceptance ([ADR-0021](../adr/0021-role-information-disclosure-policy.md) /
  [ADR-0025](../adr/0025-file-upload-wire-and-wrapper-rendering.md)).
- MUST: the server neither interprets nor persists upload bytes; it transparently relays them
  without disk access ([ADR-0020](../adr/0020-dashboard-battery-included-client.md) F3).
- MUST: attachment rendering (image/document/text block choice and Office conversion) is
  **wrapper-internal**. Protocol, client, and server do not use Anthropic API terms
  ([attachment rendering by engine](../reference/engines/attachment-rendering.md), [ADR-0025](../adr/0025-file-upload-wire-and-wrapper-rendering.md) F1).

## Open Questions

None; protocol reliability was settled by [ADR-0011](../adr/0011-phase3-reliability-and-auth.md).

## See Also

- Related specs: [architecture](../architecture/system-overview.md),
  [extensions](../architecture/extensions.md), [personas](personas.md),
  [subagent-tasks](subagent-tasks.md),
  [attachments](../architecture/attachments.md)
- ADRs: [0001](../adr/0001-agent-sdk-integration.md),
  [0003](../adr/0003-persona-identity-persistence.md),
  [0008](../adr/0008-persona-asset-distribution.md),
  [0009](../adr/0009-client-transport.md),
  [0010](../adr/0010-protocol-precisification.md),
  [0011](../adr/0011-phase3-reliability-and-auth.md),
  [0012](../adr/0012-response-display-and-dashboard-scope.md),
  [0014](../adr/0014-session-resume-and-restore.md),
  [0015](../adr/0015-protocol-version-stamping.md),
  [0016](../adr/0016-error-body-relay.md),
  [0019](../adr/0019-subagent-workflow-entity-and-task-envelope.md),
  [0021](../adr/0021-role-information-disclosure-policy.md),
  [0022](../adr/0022-pending-permission-authoritative-source.md),
  [0023](../adr/0023-host-runner-architecture.md),
  [0025](../adr/0025-file-upload-wire-and-wrapper-rendering.md)
