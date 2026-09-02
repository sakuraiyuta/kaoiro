---
title: Information disclosure policy for viewer / operator roles — allow-list approach and per-envelope matrix
status: accepted
date: 2026-06-22
opened: 2026-06-22
supersedes: []
superseded_by: null
related_specs: [protocol, threat-model, protocol-inter-agent]
related_adrs: [11, 12, 13, 22, 25, 27, 28, 30, 40, 41, 42, 43, 44, 50]
---

# ADR-0021 — Information Disclosure Policy for viewer / operator Roles

## Status

Accepted

## Context

[ADR-0011](0011-phase3-reliability-and-auth.md) / [ADR-0012](0012-response-display-and-dashboard-scope.md) decided that “instructions, approvals, and response logs are operator-only,” but the overall policy for **what the viewer role can see** remained undefined. A deny-list was extended with individual patches whenever a need arose:

- Deliver `log` / `result` only to operators ([ADR-0012](0012-response-display-and-dashboard-scope.md)).
- Remove `permission_request.input` from viewers (the prehistory of this ADR).
- Remove `state_change.ext` (`cwd` / `model` / `context` / `rate_limits` / `slash_commands`) from viewers (implementation phase for #46, commits 9b32c34 / ef7b606; delete `ext` for every type with a catch-all).

This incremental approach has three structural problems:

1. **The default viewer delivery of a new envelope type is unknown**—because the catch-all passes it through, a newly added type is **delivered to viewers** even when it contains sensitive fields. Leakage occurs unless the developer actively decides “this is operator-only” (fail-open).
2. **The viewer’s “correct view” is not documented**—how far the grid can be rendered and what the detail panel shows are implicit. They cannot be determined by reading the specs.
3. **Everything except `input` in the `permission_request` envelope** (`tool_name` / `request_id` / `truncated`) passes through to viewers, allowing them to infer what tool the operator is trying to use (partial leak).

Issue #46 was fundamentally about **carefully working out the permission and information-disclosure scope of the viewer role through spec-elicitation**. This ADR makes that policy explicit.

## Decision

### F1: Fixed two roles (operator / viewer)—withdrawn

> **Revision (2026-08-14, issue #188).** F1 was overturned by D2 of [ADR-0050](0050-principal-model-and-graded-access-control.md). The roles are **three values: admin / operator / viewer**. F1 itself specified that “making three roles requires a separate ADR,” and ADR-0050 is that separate ADR.
>
> This ADR is not superseded because only F1 was overturned. The allow-list approach and per-envelope matrix from F2 onward remain active; after moving to three values, they work by adding only this one point:
>
> - **Every delivery described by this ADR as “operator-only” also reaches admin.** Admin is above operator and fully visible; ADR-0050 D2’s MUST means it is not subject to concealment. The implementation makes this determination in one place, `AgentsChannel`’s `@operator_capable_roles`.
> - Viewer visibility (F3 onward) does not change. ADR-0050 D2 explicitly says it is unchanged because it matches the viewer’s original intent.
>
When per-pair permissions ([issue #189](https://github.com/sakuraiyuta/kaoiro/issues/189)) begin narrowing the operator’s receiving scope, admin must be separated from that determination. Narrowing them together would break the MUST above.

Original statement: intermediate roles (admin, etc.) are YAGNI. `operator` = administrator with full authority, `viewer` = read-only. Three roles require a separate ADR.

### F2: Viewer delivery uses an allow-list (operator-only by default)

Of **all envelopes / events** from server to client, only those explicitly declared for viewer delivery reach viewers. Everything else is **completely removed** from viewers (the envelope is not pushed and is also excluded from snapshots).

Rewrite `sanitize_envelope_for/2` in `agents_channel.ex` into an allow-list structure (do not pass through with a catch-all; make the `:viewer` clause decide explicitly for each type). A developer adding a new envelope type is forced to **actively decide** whether viewers should receive it (fail-closed).

### F3: Envelope type × role matrix

Define viewer visibility for events (including envelopes) delivered on the `agents:lobby` topic:

| event / envelope.type | operator | viewer | Notes |
|---|---|---|---|
| `envelope` `state_change` | ✓ unchanged | ✓ remove `ext` | Starting point for grid rendering. Remove `ext` from viewers because it contains sensitive information such as `cwd` (the catch-all automatically covers future additions to ext). The `state` field is needed by viewers (for grid display such as `waiting_permission`) |
| `envelope` `permission_request` | ✓ unchanged | ✓ replace with synthetic `state_change(waiting_permission)` | Viewers receive none of `input` / `tool_name` / `request_id`. To preserve grid presence, rewrite the type to `state_change` and deliver it with `payload={}` / `ext` removed (idempotently duplicates the immediately preceding wrapper-emitted `state_change(waiting_permission)`) |
| `envelope` `log` | ✓ | ✗ remove completely | ADR-0012; main route for secrets to enter |
| `envelope` `result` | ✓ | ✗ remove completely | ADR-0012; same as above |
| `envelope` `task` (reserved) | TBD | ✗ deny by default | Reconsider when the specification is fixed (ADR-0019); without an explicit declaration, do not deliver to viewers |
| `snapshot` (on join) | Apply sanitisation to all agents / all types | Same (replace `permission_request` with synthetic `state_change`) | Grid starting point |
| `history` (on join) | ✓ | ✗ do not push | ADR-0012 |
| `history_cleared` (broadcast) | ✓ | ✗ | Meaningless because viewers cannot see the log itself. Intercept and push only to operators in line with the allow-list policy |
| `agent_deleted` (broadcast) | ✓ | ✓ | Needed for grid consistency; contains no sensitive information beyond agent_id |

Regarding synthetic replacement of the `permission_request` envelope: on transition to `waiting_permission`, the wrapper also emits `state_change(waiting_permission)` (`host.ts:#apply({kind: "permission_request"})`). Viewers therefore already know the state through `state_change`. However, a snapshot returns the **single latest envelope**, and `permission_request` can overwrite it later; synthetic replacement is needed so that a viewer does not lose the agent from the snapshot.

### F4: Keep the role gate for input direction (client → server) unchanged

`instruction` / `permission_decision` / `interrupt` / `clear_history` / `delete_agent` are already operator-only ([protocol](../specs/protocol.md)). This ADR covers **only the delivery direction**.

### F5: Procedure for extending roles

When adding a new envelope type:

1. State whether the type should be delivered to viewers in the specification PR.
2. Operator-only is the default. To deliver it to viewers, explicitly add a clause to the `:viewer` clause of `sanitize_envelope_for/2`, and cover the visibility of both roles in tests.
3. If sensitive fields are placed in ext, the catch-all removal of ext continues to protect them (even for an allowed type, viewers do not receive ext).

### F6: Disclosure between agents (peer directory)

F1–F5 cover `agents:lobby` delivery for clients (the dashboard). Because [issue #150](https://github.com/sakuraiyuta/kaoiro/issues/150) created a requirement for an agent to read peers’ operating status and decide whether to delegate, **define `agent` as a third disclosure principal** (addendum 2026-07-28, [phase-27](../plans/phase-27-list-agents-metadata.md)).

**F6-1 — `agent` is not a subset of `operator`.** The path visible to operators (`agents:lobby` / `AgentsChannel.sanitize_envelope_for/2`) and the path visible to agents (`wrapper:<id>` / `WrapperChannel.handle_in("directory_request", …)`) are separate implementations; one allow-list does not protect the other. Decide them independently.

**F6-2 — The peer directory also uses an allow-list.** Only fields explicitly enumerated by `directory_entry/4` are exposed between agents. Do not implement a path that passes through the envelope’s `ext` wholesale (the same fail-closed rule as F2). Apply the allow-list **through nested levels** as well—when carrying a structure from `ext`, construct a new map containing only canonical keys and do not expose unknown nested keys.

**F6-3 — Current allow set**: `agent_id` / `persona{id, name, sprite_set}` / `display_name` / `state` / `engine` / `model` / `effort` / `context` / `session_started_at` / `turns` / `last_activity_at` / `conversation` / `rate_limits` / `directory_only` / `last_seen`.
The six fields after `persona{...}` (`context`–`rate_limits`) were added in [#150](https://github.com/sakuraiyuta/kaoiro/issues/150) (phase-27). `display_name` (issue #209 D19) is a mutable common name independent of `persona.name`: `persona.name` remains immutable as the canonical name from the pack and is unaffected by renaming; only `display_name` reflects a rename while running. `directory_only` / `last_seen` ([#259](https://github.com/sakuraiyuta/kaoiro/issues/259)) are attached only to entries from `AgentDirectory` that have no live envelope in `AgentStates`; add no disclosure beyond identity + `last_seen` (the F6-4 deny set remains unchanged—`directory_only` entries also lack operator-grade fields such as `cwd`). Test coverage follows F6-7’s extension procedure (both server/wrapper sides, issue #259 T7/W1–W3).

**F6-4 — Explicit deny (continuing exclusions)**: `cwd`, `permission` (`sandbox` / `approval`), `permission_mode` / `fast_mode`, `session_id`, `pending_permission` (especially `input`), `pending_question`, `slash_commands`, `models` catalog, `resume_snapshot` / `resume_drift`, `model_source` / `effort_source`, `session_capabilities`, `cost`. These are either unnecessary for delegation decisions or allow the operator’s specific work to be inferred. Read `session_capabilities` only **inside the server** as the gate input for the `context` projection via `supports_context_usage`; do not expose the value itself to peers ([ADR-0040](0040-context-usage-capability.md) D1, to align the three-state determination with the dashboard).

**F6-5 — Disclose `conversation` through the other `agent_id`, but do not disclose `conversation_id`.** The decided disclosure scope is “whether an active conversation exists + the list of other agent_ids” (#150 decision 4), and the identifier exceeds that scope. This is a decision not to disclose it because it is outside the scope; it is not a conclusion here about the confidentiality of conversation_id in [#17](https://github.com/sakuraiyuta/kaoiro/issues/17). Re-evaluating the trust boundary itself remains a future item in F6-6.

**F6-6 — Basis for validity and re-evaluation (carried out in issue #187 phase 2).** This section originally concluded, on the basis that “kaoiro is currently a closed system under a single operator and peers are limited to agents started by the same person,” that the exposure risk of mutually visualising operating status was small and outweighed by the benefit of reducing operator intervention. It set the condition “re-evaluate when external inbound is introduced or when the trust boundary between agents is no longer per operator.”

Phase A of [ADR-0050](0050-principal-model-and-graded-access-control.md) (identity + admin role, issues #187 / #188) begins to break part of this basis—the premise that agents are “started by the same person.” Principals are type-separated into user / agent (D1), and the user side has multiple roles including viewer. The Context of ADR-0050 itself states that “the decisions of this ADR precisely trigger that condition,” and the constraint section of issue #187 carries this forward. Therefore, do not add an exception to this section; actually re-evaluate it.

**Re-evaluation conclusion.** Based on D5 of [ADR-0050](0050-principal-model-and-graded-access-control.md), explicitly accept disclosure from users to agents **limited to identity (id / kind / display_name / role)** (F6-8). D5 limits the “visible in principle” range to identity, separating state and activity (what it is doing, who it is communicating with) as subjects of per-pair permissions (D3).

**role is explanatory metadata for server enforcement, not the basis of an agent’s authorisation.** In D5’s words: “an agent knowing a role does not change authority. Enforcement is on the server side, not in the agent’s recognition.” This position minimises exposure by narrowing disclosure to identity while consistently keeping authorisation decisions on the server—an agent misreading or abusing role is not a direct vulnerability because the server separately enforces the actual exercise of permissions through the allow-list / per-pair permissions.

Leave disclosure of state / activity out of this section. This does not introduce per-pair permissions themselves—design changes for the additive model’s edge determination, graph-editing tools, and so on in D3/D9 are in the scope of phase B (#189), and this ADR does not enter implementation. When phase B of ADR-0050 is introduced, user-side disclosure will also be refiltered with the same per-pair permission table. Until then, the F6-8 allow set is the upper bound.

**Next re-evaluation condition**: introduction of external inbound ([#95](https://github.com/sakuraiyuta/kaoiro/issues/95)) or implementation of ADR-0050 phase B (per-pair permissions, #189).

**F6-7 — Extension procedure.** When adding a new field to the peer directory, as with the viewer decision in F5, **explicitly decide whether it should be disclosed to agents**, list it in either F6-3 / F6-4, and then cover the visibility of both principals in tests.

**F6-8 — User disclosure allow set (issue #187 phase 2).** User disclosure to agents is a separate allow-list from F6-3’s allow set for agent entries. The reason is the same as F6-1: user directory (through `wrapper:<id>`) and agent directory (a separate payload on the same path) are managed as different things; relaxing one side’s rule must not relax the other allow-list.

Current allow set: `id` / `kind` (always literal `"user"`) / `display_name` / `role` (`"admin"` \| `"operator"` \| `"viewer"`—three values since issue #188; the wire contract’s source of truth is this ADR and [protocol-inter-agent](../specs/protocol-inter-agent.md), while `wrapper/core/src/transport.ts`’s `USER_ROLES` exists only to derive the type and runtime narrow from one place on the implementation side). It is limited to the four identity-equivalent fields described in the F6-6 re-evaluation conclusion. There is no concept corresponding to state / activity (what a user is currently doing, whom they are communicating with) for users, so it is not disclosed.

Omit a user entry entirely if its role cannot be resolved (revoked from the allow-list, unknown to the config, etc.). `role` is a required wire field; unlike the agent entry in F6-3, there is no room to represent “unknown” per field.

The procedure for adding a new field is the same as F6-7 (decide whether it should be disclosed to agents → list it in either F6-3 / F6-8 → cover visibility of both principals in tests).

### F7: Role gate for HTTP endpoints (issue #232, addendum 2026-08-28)

F1–F6 cover `agents:lobby` (WebSocket envelope delivery) and the peer directory. **HTTP endpoints follow the same fail-closed principle**: when a new endpoint can return sensitive information, operator/admin-only is the default, and viewer disclosure requires a separate explicit decision (generalise F2’s idea that “new output surfaces default to operator-only” beyond WebSocket envelopes to other output surfaces).

Current target: `GET /api/personas/:id` (all metadata in the persona pack’s manifest.json + the full personality.md). A custom pack’s personality.md is a system prompt and may contain proprietary operational instructions, so it is operator/admin-only (director decision, 2026-08-28). If viewer disclosure is considered in the future, decide the byte limit for personality.md (deferred as S-232-1) at the same time (see the issue #232 closing comment).

The implementation is `KaoiroServerWeb.RequireOperatorPlug` (reuse `ClientSocket.role_for/1` from the WebSocket side as-is, live-revalidate the session cookie credential on every request—the same determination as the F1 three-role revision, so admin also passes). Details are in the “Operator-only HTTP endpoints” section of [auth-and-authz](../specs/auth-and-authz.md).

The procedure for adding a new HTTP endpoint is the same as F5: explicitly decide whether viewers should see it, operator-only is the default, explicitly choose not to pass through `RequireOperatorPlug` if viewers should see it, and cover anonymous/viewer/operator/admin visibility in tests.

## Consequences

### Positive

- Viewer leakage becomes **fail-closed**. Omissions when adding a new type are structurally prevented.
- Viewer leakage of `tool_name` / `request_id` from the `permission_request` envelope stops (closing the path to infer the operator’s tool).
- The viewer-role specification can be read in a single table (also reflected in threat-model.md / protocol.md).
- F6 places inter-agent disclosure under the same allow-list discipline, and the procedure for deciding when to add a field to the peer directory is aligned with the viewer procedure (#150).

### Negative

- Synthetic `state_change` conversion for viewers adds one step (a minor conversion cost in the snapshot/broadcast hot path).
- Adding a new type now requires the extra step of explicitly deciding “should it be sent to viewers?” This is acceptable because it is the purpose of the allow-list.

### Neutral

- Existing operator delivery is unchanged (the operator clause passes `envelope` through).
- Catch-all removal of ext remains (the F3 `state_change` clause includes `Map.delete("ext")`).
- Viewers also receive `agent_deleted` (explicitly listed in the allow-list for grid consistency).

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| Keep the current catch-all pass-through (adding deny-list entries) | Viewer leakage continues whenever a new type is added. The structural problem of not noticing until an incident remains |
| Pass the `permission_request` envelope through to viewers while removing only `input` (current state) | The operator’s work can be inferred from `tool_name` / `request_id`, which is insufficient as defence in depth |
| **Completely** remove `permission_request` from viewers (also remove it from snapshots) | When the latest item is `permission_request`, the agent disappears from the viewer’s grid. Adopt synthetic replacement with `state_change` to preserve grid consistency |
| Three roles (admin / operator / viewer) | ~~YAGNI. Two roles are sufficient for the current functions; use a separate ADR when needed~~ **Withdraw the rejection (2026-08-14, issue #188).** The time “when needed” arrived, and D2 of [ADR-0050](0050-principal-model-and-graded-access-control.md) decided on three values. See the F1 revision above |

## Related

- specs: [protocol](../specs/protocol.md) (unify destination notation with this ADR), [threat-model](../specs/threat-model.md) (quote the matrix).
- Related ADRs: [0011](0011-phase3-reliability-and-auth.md) (foundation for role/token authentication), [0012](0012-response-display-and-dashboard-scope.md) (starting point for operator-only log/result), and [0013](0013-user-token-cookie-persistence.md) (token storage).
- Origin of F6: [issue #150](https://github.com/sakuraiyuta/kaoiro/issues/150); implementation is [phase-27](../plans/phase-27-list-agents-metadata.md). The wire contract for disclosure fields is the “Information boundary of the peer directory” section of [protocol-inter-agent](../specs/protocol-inter-agent.md).
- Origin: [issue #46](https://github.com/sakuraiyuta/kaoiro/issues/46).
