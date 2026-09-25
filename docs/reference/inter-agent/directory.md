---
title: Peer directory
status: provisional
last_updated: 2026-09-26
---

# Peer directory

The structural types `DirectoryEntry`, `DirectoryResult`, `UserDirectoryEntry`,
`DirectoryContext`, and `DirectoryRateLimitWindow` are defined in
[@kaoiro/protocol](../../../protocol/src/index.ts). Shared tool definitions
are in [agent-common](../../../wrapper/agent-common/src/inter_agent.ts).

### Channel event additions

The `inter_agent_message` body continues to use the existing `envelope` event;
the companion feature adds **`directory_request`**.

#### Peer-directory information boundary (#99 / #150)

Phase 8 limited directory entries to `agent_id / persona / state` for name
resolution. Once the cross-engine state-envelope schema was fixed in phase 15,
#99 expanded that minimal read-only directory so agents could choose a
delegate by peer execution characteristics, exposing `engine / model / effort`.

Issue #150 (phase 27) expands it again into a directory that can judge whether
delegation is appropriate from peer liveness. Without operator involvement an
agent must be able to avoid heavy work for a peer near its context limit, avoid
peers at their usage limit, avoid interrupting a peer in conversation, and
report peers that have been inactive for a long time.

##### Exposed fields

| field | type | meaning | omitted when |
|---|---|---|---|
| `agent_id` | string | destination identifier | MUST (always present) |
| `persona` | `{id?: string, name?: string, sprite_set?: string}` | canonical identity when resolved; directory-only unresolved entries use `{id: persona_id}` (below); `name`, when available, is stable within a session (issue #209 D19) | MUST (object always present; individual fields may be absent) |
| `display_name` | string | mutable runtime name used for display (issue #209 D19/D26, ADR-0021 F6-3) | old wrapper did not report it |
| `state` | string | current state | MUST |
| `engine` / `model` / `effort` | string | execution characteristics (#99) | not a non-empty string |
| `context` | `{used_tokens, max_tokens, used_percentage}` | context usage | capability gate fails, unreported, malformed, or disconnected |
| `session_started_at` | ISO8601 (UTC) | **server-observed** current-session start | server did not observe or recover the start; also omitted for uncorrelated joins even when `SessionStarts` has a value |
| `turns` | non-negative integer | response round trips in the current session | server did not observe that session start, or the join is uncorrelated |
| `last_activity_at` | ISO8601 (UTC) | time the server last accepted an envelope | no envelope accepted yet |
| `conversation` | `{active, peers[]}` | whether an IA conversation is active and its peers | **never omitted** (below) |
| `rate_limits` | `{<window>: {status?, utilization?, resets_at?}}` | latest reported usage-limit snapshot, including an account read before the first turn | no usable source, all windows dropped in projection, or disconnected |
| `disconnect` | `{origin, reason}` | server-observed terminal disconnect attribution using the closed pairs from protocol.md | connected, planned restart, legacy server, or malformed pair |
| `directory_only` | boolean (`true` fixed, issue #259) | entry comes only from persistent `AgentDirectory`, with no live envelope in `AgentStates` ([ADR-0030](../../adr/0030-agent-directory-and-explicit-restore.md)) | omitted for live entries; unlike other fields, absent means live-directory origin rather than unknown |
| `last_seen` | ISO8601 (UTC), issue #259 | memory-only hint of the last envelope accepted by `AgentDirectory` | after server restart / never touched, or for live entries (which have `last_activity_at`) |

`session_started_at` and `last_activity_at` are **server timestamps**. They
are not wrapper measurements and are independent of envelope `ts` (the
wrapper host clock), avoiding cross-host clock skew in decisions.

- MUST (issue #167): Closed conversations are inactive in `peer_index` and in
  disconnect unresponsive notices.

##### Directory-only entry (issue #259)

The `agents` array in a `directory_request` response merges live entries built
from the in-memory `AgentStates` snapshot with `AgentDirectory` entries that
have no envelope in `AgentStates`. A single array keeps persona-name
resolution and the existing `send_to_agent` flow identical for live and
directory-only entries. Merge rules:

- **Deduplication**: when an `agent_id` exists in both, prefer the live
  `AgentStates` entry and do not create a `directory_only` entry.
- **Merged entry**: `agent_id`, fixed `state: "disconnected"`,
  `directory_only: true`, always-present `persona` (including typed unresolved,
  below), resolved `display_name` when available, always-present
  `conversation` (`{active, peers[]}` like live entries), and `last_seen` when
  available.
- **Omitted fields**: `engine`, `model`, `effort`, `context`, `rate_limits`,
  `session_started_at`, `turns`, and `last_activity_at` are always omitted
  because `AgentDirectory` has no values for them (the normal absent = unknown
  rule).
- **Typed-unresolved persona** (same rule as [#209](https://github.com/sakuraiyuta/kaoiro/issues/209)
  D21): when `persona_id` resolves in `PersonaAssets`, return canonical
  `{id, name, sprite_set}`; otherwise return only `{id: persona_id}`.
  **The `persona` key itself is always present**; omitting it would make the
  wrapper's narrow (which requires `persona`) drop the whole entry.
- **Count cap**: `AgentDirectory` grows until an operator explicitly deletes
  entries, so keep at most **N=32** directory-only entries ordered by descending
  `last_seen` (unknown last, ties by ascending `agent_id`). Warn once per
  agent/request about truncation, following the same aggregation as rate-limit
  window-drop logs.
- **Charset / display_name validation**: drop an entry whose `agent_id` fails
  `AgentId.valid?/1` (the first gate before DETS-loaded IDs reach an agent).
  If `display_name` validation fails, omit only that field and keep the entry,
  as for live entries.
- **Exclude the requester** once live and directory-only entries have been
  merged.

##### `context` capability gate

Do not decide from the presence of `ext.context`. Project it only when
`ext.session_capabilities.supports_context_usage == true` and
`used_tokens`, `max_tokens`, and `used_percentage` are all numeric. If the
capability is absent (old wrapper) or explicitly `false` (Codex), **omit the
field** and emit neither `null` nor an inferred value
([ADR-0040](../../adr/0040-context-usage-capability.md) D1's three-state decision,
aligned with the dashboard). Do not disclose the
capability field itself to peers.

##### Projection from `ext`

`ext` is an open schema that wrappers may extend freely, so **never pass it
through raw**. Build a new map containing only canonical keys, applying the
allow-list recursively
([ADR-0021](../../adr/0021-role-information-disclosure-policy.md) F6-2).

| target | allowed keys | validation |
|---|---|---|
| `context` | only `used_tokens` / `max_tokens` / `used_percentage` | all **finite with `\|x\| <= 2^53-1`**; omit `context` if any is missing or invalid |
| `rate_limits` window value | only `status` / `utilization` / `resets_at` (all optional) | `status` is a string ≤64 UTF-8 bytes; `utilization` is **finite with `\|x\| <= 2^53-1`**; `resets_at` is a non-negative safe integer |
| `rate_limits` window key | open string | ≤32 UTF-8 bytes, charset `[A-Za-z0-9_-]` |
| `rate_limits` window count | — | at most 8 |

 - **Only a missing key is absent**: if a key exists but its value is invalid
  (including `null`), drop that window. Dropping one value while returning the
  rest would make an incomplete window look complete.
- Drop an **empty window** when projection leaves no values.
- When more than eight windows remain, consider only windows that passed
  validation and empty-drop; always prefer canonical windows (`five_hour` then
  `seven_day`) and fill the rest in lexical order. Canonical windows that fail
  validation are not retained.
- Drop malformed data at the top-level field and retain valid siblings (a bad
  `context` does not remove `rate_limits`).
- Do not convert numbers. Projection only narrows keys; it does not transform
  values. Do not enforce a 0..1 range for `utilization` (defer until real data
  is checked for [#154](https://github.com/sakuraiyuta/kaoiro/issues/154)).
- Aggregate drop logs per agent/request rather than warning without bound per
  window (`list_agents` is auto-allowed and must not amplify logs).
- Apply the same rules and limits to wrapper-side narrowing; a looser side
  would let the client reopen data the server closed.

##### Always include `conversation`

Unlike other fields, the server can determine this engine-independent value
every time. Return `{"active": false, "peers": []}` even with no conversation.
An old server may omit the field entirely, so consumers can distinguish
**absent (unknown)** from `active: false` (no conversation). Never disclose
`conversation_id` (ADR-0021 F6-5).

##### Omit session fields for uncorrelated connections

On every spawn, restore, or reset the server issues a transition correlator and
matches the resulting wrapper connection at join (implementation details:
[phase-27](../../plans/phase-27-list-agents-metadata.md) D3). For an uncorrelated
connection—an old wrapper that returns no correlator, or a join belonging to a
different transition—**omit** `session_started_at` and `turns` for that
connection.

**This omission takes precedence over restoration from `SessionStarts`.** If
it were applied later, a legacy restore that reuses a session_id could expose
the pre-restore start time and turn count. Without correlation those values
cannot be asserted to describe the current session, so omission follows the
spec-wide “omitted = unknown” rule.

`last_activity_at` and `conversation` are not session-bound and are not
omitted here.

##### Persistent exclusions

This change does not expose all of `ext` to peers. Continue excluding `cwd`,
permission/sandbox, `session_id`, model catalog, pending state, resume
snapshot/drift, `model_source / effort_source`, `session_capabilities`, and
`cost` from the directory. ADR-0021 F6-4 is the canonical exclusion set.

##### Exposed user fields (issue #187 phase 2, ADR-0021 F6-8)

The `directory_request` reply always includes **`users`** alongside `agents`,
including an empty array. Its contents follow the operator setting
`KAOIRO_EXPOSE_USERS_TO_AGENTS`: **the config default is `true`** (unset means
expose, implementing the issue #187 “visible by default” constraint), and an
explicit `false` opts out. Only an abnormal case where the config key cannot
be read (for example `config/runtime.exs` did not run) uses a closed fallback.
This is a separate allow-list from the `agents` list (F6-2/F6-3); ADR-0021
F6-8 is authoritative.

| field | type | meaning | omitted when |
|---|---|---|---|
| `id` | string | user_id, using the same charset as agent_id (`[A-Za-z0-9._-]`, issue #61); ADR-0050 D1 defines one ID space | MUST (always present) |
| `kind` | string | always the literal `"user"` | MUST |
| `display_name` | string | display name (contract below) | MUST |
| `role` | string | `"admin"` \| `"operator"` \| `"viewer"` | MUST |

**If a user's role cannot be resolved** (revoked from the allow-list or made
unknown by a config change), omit the entire entry rather than only the field.
`role` is a required wire field like the other three fields and has no
per-field “unknown” representation; this differs from the agents' normal
absent = unknown rule.

**`display_name` contract (issue #187 phase 2, Fujino MF-1 review):** after
trimming, the wire value must be non-empty, at most **64 grapheme clusters**,
and contain no control characters (C0 `\x00`–`\x1f` or DEL `\x7f`), enforced
by the server (`WrapperChannel.valid_display_name/1`). “Grapheme cluster” is
exactly the unit counted by Elixir `String.length/1`; JavaScript UTF-16
`.length` or Unicode-code-point `[...s].length` overcounts combining marks and
ZWJ emoji (measured example `"👨‍👩‍👧‍👦é́"`: `String.length/1` = 2,
`.length` = 13, `[...s].length` = 9). Wrapper narrowing
(`userDirectoryEntryFrom`, `wrapper/core/src/transport.ts`) enforces the same
contract and drops only violating entries. Matching both sides of the double
projection (D7) keeps rolling upgrades, malformed payloads, and future server
regressions consistent.

- MUST (issue #187 phase 2): Apply the same allow-list discipline to `users`
  ([ADR-0021](../../adr/0021-role-information-disclosure-policy.md) F6-8). Build literal maps with per-value validation; do not use a
  `Map.take/2`-style key-only filter that bypasses shape checks. Omit an entire
  user entry when its role cannot be resolved.

##### Meaning of a live role join

For every response, resolve the user's source (`{:oauth, provider, uid}` or
`{:token, token_hash}`, server-internal only) against the authorization source
of truth (`OAuthAllowlist` allow-list text or the `client_tokens` setting).

“Live” guarantees only that a repeated `directory_request` on the same wrapper
socket sees the role at that moment. It is neither revocation of a previous
response nor push invalidation: `directory_request` is a pull API and the
server has no proactive change notification to wrappers. Until the next call,
an old role may remain visible or a new entry may be absent.

Within one response, read each authorization source once
(`OAuthAllowlist.snapshot/1` or the `client_tokens` token_hash→role map), so
users from one source type cannot mix old and new roles. The two sources are
read sequentially, however, so **cross-source atomicity is not guaranteed**:
`client_tokens` may change after OAuth users are resolved and before token users
are read.

##### User backward compatibility (issue #187 phase 2)

From phase 2 onward the server always returns `users` (an empty `[]` when
opted out). A missing key indicates only a pre-phase-2 server. A server with
`KAOIRO_EXPOSE_USERS_TO_AGENTS` disabled still returns the key with an empty
array; the wrapper narrows both cases to `users: []` because consumers
(`list_agents`) have no useful distinction.

### Event contracts

| event (direction) | shape | server behavior |
|---|---|---|
| `envelope` (W→S, type=inter_agent_message) | [Inner envelope](messages.md#inner-envelopepayload-schema) | Preserve causal order ([ADR-0051](../../adr/0051-history-restart-resilience.md) D3-1): (1) **validate / preflight** participants, hard limits, planned intents (`peer_reconnecting` / `peer_reconnecting_capacity`), an unexpectedly disconnected target (`disconnected`, issue #257), and conversation quota. `ConversationStates.record_message/8` checks and atomically updates turn/token counters in one call, so **counter updates happen here** (splitting them opens a TOCTOU gap; fixed at implementation, 2026-08-08). Complete every check that could determine rejection before proceeding; return a planned reject before ConversationStates, pane, or delivery ledger. (2) **Allocate ingress stamp** (globally unique ingress-order domain, wire form `[us, seq]`). (3) Upsert sender and receiver panes with the same stamp (`identity = ingress_stamp\|pane_agent_id`). (4) Push the stamped envelope to `wrapper:<to>` and broadcast to `agents:lobby` (operator-only). (5) Return `{ingress_stamp}` to the sender wrapper as the **acceptance ack**, which triggers sender-side sidecar recording. Routing after upsert is only the peer push; rejected IA must not remain in a pane. |
| synthesized `envelope` (S→W) | hard-limit exceeded | Push to both `wrapper:<id>` and `agents:lobby`. |
| synthesized `envelope` (S→W) | wrapper disconnect / matching recovery | For each other participant in conversations of the wrapper, push `kind=inform` with `error.code=reconnecting` for planned disconnect, `error.code=disconnected` plus optional `error.origin` / `error.reason` for a terminal disconnect, or error-free `kind=inform` (`reconnected`) after exact-token recovery (see [“Unresponsive notices”](errors.md#unresponsive-notices-payloaderror)). |
| `directory_request` (W→S) | `{}` (empty payload) | wrapper-A receives all peer entries **except itself** in `{:ok, %{agents: [...], users: [...]}}`. Agent fields and omission rules follow “Peer-directory information boundary”; users follow “Exposed user fields” (issue #187 phase 2). Used by [`list_agents`](#companion-tools-wrapper-sdk-mcp). |

### Companion tools (wrapper SDK MCP)

In addition to broker-mediated `send_to_agent`, the wrapper provides the
following tools in the **default allowedTools with auto-allow**. They are
read-only and side-effect free, so models use them for destination resolution
and self-identification without per-call approval.

| Tool (full name) | purpose | path |
|---|---|---|
| `mcp__kaoiro__list_agents` | Lists other agents on the connection, returning destination identifiers (id/persona name/state), execution characteristics (engine/model/effort), and liveness (context/session_started_at/turns/last_activity_at/conversation/rate_limits). | Calls server `directory_request`, narrows both `agents` and `users`, and returns them as separate arrays. Users are not `send_to_agent` destinations. |
| `mcp__kaoiro__whoami` | Returns the server's view of this agent: agent_id/persona/state/engine, effective model/effort and sources, permission/network_access, legacy permission_mode/fast_mode, session_id/cwd, `context`, `rate_limits`, and `inter_agent_delivery` when available. | Reads identity/effective settings/context/rate_limits from local `EffectiveStatusSnapshot` and host cache. If delivery status is wired, performs a server `delivery_status_request` round trip and includes `inter_agent_delivery` only on success. |

Build `whoami` local fields from the shared host `EffectiveStatusSnapshot` and
cache rather than a separate state envelope. Return model/effort/source and
network_access only when known; permission is engine-neutral `{sandbox,
approval}`, while permission_mode/fast_mode are included only when available as
Claude-compatible fields. Omit fields the SDK or rollout has not reported
instead of filling stale or inferred values. Unlike these local fields,
`inter_agent_delivery` observes a server ledger and is not guaranteed on every
call.

`context` (phase-28 A2, [#158](https://github.com/sakuraiyuta/kaoiro/issues/158))
returns `{used_tokens, max_tokens, used_percentage}`. Its `DirectoryContext`
shape and semantics are **identical** to what peers read through
`list_agents`, so self and peer views are comparable, though transport delay
can make their timestamps differ.

- **Cached last successful measurement**: `whoami` never refreshes. It returns
  the host's latest successful measurement, which may lag the current turn;
  no on-demand refresh is provided because a control request on every call
  would encourage constant polling.
- Engines with `supports_context_usage: false` (Codex) omit each key.
  **Absent = unknown**, not zero or “plenty of room”.
- Context compaction and conversation reset start a new epoch; omit each key
  until a measurement succeeds in that epoch and withdraw the old value.
  Absent therefore means either never measured or no longer valid.
- Tool descriptions say to inspect values when needed and do not encourage
  constant viewing (avoid context anxiety; #158 comment-5384365227, P3).

`inter_agent_delivery` (issue #237 addendum) exposes the server's
recipient-local delivery ledger
`{issued_seq, acked_seq, pending_since?, lost_count?, last_loss?}`. With
`skip-v1`, `acked_seq` includes explicit losses: equal watermarks mean no
unresolved deliveries, not proof that every message started an SDK turn. The
same fields and interpretation apply to each `list_agents` entry. It is not a
local snapshot. The wrapper sends `delivery_status_request` and adds
the field only when a reply arrives. Omit each key—and treat **absent as
unknown**—for an old or incapable server, a disconnect, or a failed query.
This ledger observes delivery unconfirmed before SDK turn start; it is not a
delivery guarantee, resend queue, or failure inference.

`rate_limits` (addendum [#244](https://github.com/sakuraiyuta/kaoiro/issues/244))
returns this agent's windows as `{<window>: {status?, utilization?, resets_at?}}`.
Its `DirectoryRateLimitWindow` shape and semantics are **identical** to the
value peers read through `list_agents`.

- **This addressed a self-observation gap, not a display gap.** Because
  `list_agents` excludes its caller, an agent told to stop work at a 7-day
  utilization threshold had no way to read its own number. `whoami` is now the
  single self-observation point.
- Read values from the **host's latest snapshot**, not a server copy. The
  wrapper produces them, so the host map is at least as fresh as the directory;
  any mismatch with a peer is temporary transport delay. Keep one implementation
  path and pin **equal values** in tests (matching shape alone cannot detect a
  split).
- Reading `rate_limits` itself does **not** cause a server round trip; `whoami`
  uses host cache. A call that also requests `inter_agent_delivery` sends the
  independent `delivery_status_request` described above, so there is no
  “whoami never round-trips” guarantee.
- A fresh Codex or Claude Code wrapper announces idle immediately, then sends
  another `state_change` when its optional account probe returns usable windows.
  Thus a zero-turn peer can have a snapshot. The value is not refreshed on an
  idle timer. Compare `resets_at` (Unix seconds) with current time and stop trusting
  `utilization`/`status` after expiry, as specified by the `list_agents` tool
  description.
- Omit each key until the engine has reported it once. **Absent = unknown**, not
  unlimited (including a source-free or unavailable startup probe).
- Antigravity reports an observed individual quota exhaustion in the canonical
  `seven_day` window: its terminal reset delay can span about 149 hours, which
  matches the weekly window, and using a canonical key keeps existing consumers
  interoperable. The current `result.error` shape is inferred from the CLI's
  internal log output; it has not been measured in a raw terminal stream event.
  Only the observed compact `h`/`m`/`s` reset format is accepted. If a raw event
  demonstrates another format, replace this grammar using that evidence.

## Related topics

- [Send acceptance, rejection, and waiting](send-and-wait.md).
- [Delivery ledger](delivery.md).
- [Peer-routing rules](../../contributing/peer-routing.md).
- [Approval flow](../security/inter-agent-tool-authorization.md#approval-flow-permission_broker-integration).
