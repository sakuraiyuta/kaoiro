---
title: viewer / operator Information disclosure of roles — allow-list approach and envel  separate matrix
status: accepted
date: 2026-06-22
opened: 2026-06-22
supersedes: []
superseded_by: null
related_specs: [protocol, threat-model, protocol-inter-agent]
related_adrs: [11, 12, 13, 22, 25, 27, 28, 30, 40, 41, 42, 43, 44, 50]
---

# ADR-0021 — viewer / operator

## Status

Accepted

## Context

[ADR-0011](0011-phase3-reliability-and-auth.md) / [ADR-0012](0012-response-display-and-dashboard-scope.md)
"Instructions, approvals, and responseHome are limited to operators", but the viewer role
**What to see**The overall policy remains unsecided right, with individual patches whenever required
deny-list:

- `log` / `result` Release to operator only ([ADR-0012](0012-response-display-and-dashboard-scope.md)).
- Remove `permission_request.input` from viewer (preh ic history of this ADR).
- `state_change.ext`(`cwd` / `model` / `context` / `rate_limits` /
`slash_commands`) removed from viewer (#46 implementation phase, commit 9b32c34 /
ef7b606. remove `ext` for all types in catch-all.

This seamless approach has three structural problems:

1. **New envel  type viewer delivery default unknown**— catch-all
so the new additional type will include a sub-field in **viewer
Delivered**. Unless the developer is actively determined to be "this is only operator"
Fail-open
2. **The "right look" of viewer is not documented**— the grid
It is implicit that you can draw or show the detail panel. I can't judge by readingRead.
3. **`permission_request` `input`**(`tool_name` /
`request_id` / `truncated`) is connected to the viewer and the operator is
You can guess what tools you want to use (partial leak).

issue #46 “viewer role permission”
''' is the real thing. This is a culture of the polycy.

## Decision

### F1: 2-roll fixing (operator / viewer) — withdrawn

> **Revised (2026 14, issue #188).**F1
> [ADR-0050](0050-principal-model-and-graded-access-control.md) D2 covered.
> role**admin / operator / viewer**F1 "3 Roll"
ADR-0050
>
> This is because only F1 is covered. F2 or later
> The allow-list approach and envel  separate matrix are active, even after 3 determining
> Just add:
>
> - **This ADR delivers "operator only" to admin.**
> admin is all visible at the top of the operator, by MUST of ADR-0050 D2
> Suitable for concealment. `AgentsChannel`
> `@operator_capable_roles` Determines one location
> - The viewer visibility (F3 or later) is not changed. ADR-0050 D2
> Not changed because it matches the intention of
>
[issue #189](https://github.com/sakuraiyuta/kaoiro/issues/189)
> When the operator starts to narrow down the receiving range, remove admin from that judgment
> required The above MUST is broken when narrowed down.

Original Description: Middle roll (admin etc.) is  NI. `operator` = All rights as administrator,
`viewer` = View only. 3. Rolling requires another ADR.

### F2: viewer delivery is allowed-list approach (default for operator only)

server**all envel Alls**explicitly
viewer Only the ones viewd are delivered to viewer. viewer
**Complete removal**(envel  is not pushed, it is removed from snapshot).

`sanitize_envelope_for/2` `agents_channel.ex`
`:viewer` clause is specified for each type
Determine). Developers who add a new envel  type are required to viewer
**Active judgment**(fail-closed).

### F3: envel: type × role matrix

`agents:lobby` Viewer visibility of events (including envel ) to be delivered on the topic
Defining:

| event / envelope.type | operator | viewer ||
|---|---|---|---|
| `envelope` `state_change` |✓ As it is| ✓ `ext`Remove|The origin of grid drawing.`ext`Home`cwd`Remove viewer (automatic cover for future ext items with c -all)`state`fields are required to viewer(`waiting_permission`grid display)|
| `envelope` `permission_request` |✓ As it is|✓ Syn `state_change(waiting_permission)`|viewer`input` / `tool_name` / `request_id`grid presence`state_change`Rewrite`payload={}` / `ext`wrapperbution by removal (from the previous wrapper)`state_change(waiting_permission)`Duplicate with idemic etc.)|
| `envelope` `log` | ✓ |- Complete removal|ADR-0012|
| `envelope` `result` | ✓ |- Complete removal|ADR-0012|
| `envelope` `task`(Reservation)| TBD |- Default deny|Re-determined (ADR-0019) at the time of specification confirmation, unless express declaration viewer non-delivery|
| `snapshot`(join)|sanitize all agents / all types|Same left`permission_request``state_change`)|grid starting point|
| `history`(join)| ✓ |- Push not| ADR-0012 |
| `history_cleared`(broadcast) | ✓ | ✗ |viewer doesn't see log itself. allow-list Intercept and operator push|
| `agent_deleted`(broadcast) | ✓ | ✓ |required(Only agent id)|

`permission_request` Syn  subst tion of envel : wrapper
`waiting_permission` emit `state_change(waiting_permission)` when transition
(`host.ts:#apply({kind: "permission_request"})`) viewer
`state_change` But snapshot is the latest envel
`permission_request` overwrites later with a single option
view subst tion is required for viewer to lose the agent.

### F4: The role gate of the input direction (client → server) is set

`instruction` / `permission_decision` / `interrupt` / `clear_history` /
`delete_agent` is already available ([protocol](../specs/protocol.md)).
Book ADR**Delivery direction only**Target

### F5: Roll Extension Instructions

To add a new envel  type:

1. In the specification PR, specify whether or not the displayer of the type.
2. The operator limit is default. viewer `sanitize_envelope_for/2`
explicitly add a clause to the `:viewer` clause and test the visibility of both rolls

3. If the Japanese term field is on the ext, it will continue to be protected by catch-all ext removal
(ext is not delivered to viewer even if it is view type).

### F6: agenter directory

F1 to F5 is intended for `agents:lobby` delivery for client (dashboard).
[issue #150](https://github.com/sakuraiyuta/kaoiro/issues/150)
the request that the agent reads and delegates the status of the agenter,
**Disabling `agent` as the third disclosure requirement**(2026 -28 Added,
[phase-27](../plans/phase-27-list-agents-metadata.md)).

**F6-1 — `agent` is not part of `operator`.**operator
`agents:lobby`
`wrapper:<id>` /
`WrapperChannel.handle_in("directory_request", …)`)
One allow-list does not protect the other. Both judge independently.

**F  — directoryer directory is also a allow-list approach.**`directory_entry/4`
Only the specified field will appear between the agent. envel  `ext`
Dispensing implementation is prohibited (F2 fail-closed). allow-list
**Apply to nested hierarchy**`ext`
Assemble new map projected only canonical key and unknown nested key
Not disclosed.

**F6-3 — current allow set**: `agent_id` /
`persona{id, name, sprite_set}` / `display_name` / `state` / `engine` /
`model` / `effort` / `context` / `session_started_at` / `turns` /
`last_activity_at` / `conversation` / `rate_limits` / `directory_only` /
`last_seen`.
`persona{...}` to back 6 field(`context` to `rate_limits`)
[#150](https://github.com/sakuraiyuta/kaoiro/issues/150)
(phase-27) `display_name`(issue #209 D19)
Independent mutable commonly known — `persona.name` canonical from pack
`display_name`
De  rename in operation. `directory_only` / `last_seen`
([#259](https://github.com/sakuraiyuta/kaoiro/issues/259))
`AgentDirectory`
identity + `last_seen`
`directory_only` entry `cwd`
without operator-grade field. F6-7
Issue #259 T7/W1-W3

**F6-4 — explicit deny (co ous ex )**: `cwd`,`permission`(`sandbox` /
`approval`),`permission_mode` / `fast_mode`,`session_id`,
`pending_permission`, `pending_question`,
`slash_commands`,`models` catalog,`resume_snapshot` /
`resume_drift`,`model_source` / `effort_source`,
`session_capabilities`, `cost`. No need for delegation decisions or operator-specific
To guess the work contents. `session_capabilities`
`supports_context_usage` `context`
only read in internal**, the value itself does not appear inerer
([ADR-0040](0040-context-usage-capability.md) D1 3-state judgment
dashboard).

**F6-5 — `conversation` discloses up to `agent_id`
`conversation_id` does not disclose. ** The scope of disclosure is determined
"active conversation + opponent agent id list" (#150 decision 4)
identifiers exceed their scope. It is a judgment that it does not come out because it is out of range,
[#17](https://github.com/sakuraiyuta/kaoiro/issues/17)
conversation id Don’t have concluded here about confidentiality. Trust
Reassessment of the boundary itself is included in the future item of F6-6.

**F6-6 — the basis and re-evaluation of validity (issue #187).**Japanese term
Originally, kaoiro is a closed system under a single operator, anderer is
Interdisciplinary visualization of operation status based on the same human-started agent
The risk of exposure is smaller than the convenience of reducing intervention
Concluded, the trust boundary between “ex  inbound” or agent is the operator
The condition of "revaluation at the time when the unit disappears.

[ADR-0050](0050-principal-model-and-graded-access-control.md)
Phase A (identity + admin role, issue #187 / #188)
Part — start to break down — the premise of “the same human-started agent”.
principal is type-separation to user / agent (D1), user side contains viewer
has multiple roles. Context of ADR-0050
Japanese termose that condition is fired, and issue #187Japanese term clause is
Contact Us Therefore, the book section does not write an exception, but actually
Re-evaluate.

**Reassessment conclusions.** [ADR-0050](0050-principal-model-and-graded-access-control.md)
*identity (id / kind /
**(F6-8) that explicitly accepts by display name / role.
D5 is the scope of “visible” to identity and state and activities (w
per-pair (D3)
Corres ence to being divided.

**role is not an agent's authorization basis, but the
description metadata. ** With the word D5, you know that “agent is role”
the server side to force the agent
not recognized. With this position, the scope of disclosure is narrowed down to identity
The authorization decision itself remains consistently on the server side while minimizing the exposure surface —
Even if the agent side misreads and mis s role, the actual permission exercise is
allow-list / per-pair permission

Please note that disclosure of state/activity is not subject to this section. per-pair permission
It is not the introduction of itself — the edge of the addition model, the graph editing tool, etc.
D3/D9 is the scope of Phase B (#189).
Do not step into the implementation. ADR-0050 Phase B
refilter the same per-pair permission table. F6-8 allow
Max.

**Next Reassessment**: external inbound
([#95](https://github.com/sakuraiyuta/kaoiro/issues/95))
ADR-0050 permission B (per-pair, #189)

**F6-7 — extension procedure.**F5
like viewer judgment**Determine whether or not to disclose agent**F6-3 / F6-4
After enumerating on the command line, the test covers the visibility of both sides.

**F6-8 — allow group of user disclosure (issue #187 step 2).**Agent
user disclosure is independent of F6-3 (agent entry allow set)
F6-1
If you manage the agent directory (payload separately for the same route) with the same set,
loosen the allow-list of the other.

current allow set: `id` / `kind` (always literal `"user"`) /
`display_name` / `role`(`"admin"` \| `"operator"` \| `"viewer"` —
issue #188 wire contract
[protocol-inter-agent](../specs/protocol-inter-agent.md)
`wrapper/core/src/transport.ts` `USER_ROLES` when type and execution
derive from one place. F6-6 Reassessment
The conclusion is only 4 field equivalent to identity. state/activity
not user, but disclose
It is also suitable for

unsolving roles (configs revoked from config-list are unknown)
(e.g.) The user is omitted by entry. `role` is wire required field
agent F6-3 agent entry, per-field's "unknown" is expressed.
To save the space.

Same as F6-7 when adding new field.
F6-3 / F6-8 Enumeration → Test to cover the visibility of both sides.

### F7: HTTP endpoint gate role (issue #232, 2026 28)

F1 to F6 is supported by `agents:lobby` (WS envel ) anderer directory.
**HTTP endpoint also follows the same fail-closed principle**: New endpoint
If you can return subtle information, you can set the operator/admin only by default and viewer
Disclosing is expressly determined separately (F2's "New output is the default operator only"
WS envel

Current target: `GET /api/personas/:id` (persona pack manifest.json)
All metadata + personality.md .). custom pack personality.md
system prompt to getJapanese termrietary operation instructions
operator/admin (director decision, 202628)28). Viewer
In the future, the byte limit of personality.md (as S-232-1)
(issue #232)
see).

`KaoiroServerWeb.RequireOperatorPlug`
Reuse `ClientSocket.role_for/1` and use session cookies
request live revalidate — same as F1's 3 roll revision
Determine admin). More
[auth-and-authz](../specs/auth-and-authz.md)"Operator limited HTTP
endpoint

How to add a new HTTP endpoint is the same as F5: viewer disclosure
By default, the viewer disclosure is
`RequireOperatorPlug` is specified as an option and in the test
Anonymous/viewer/operator/admin

## Consequences

### Positive

- viewer**fail-closed**Home New type Accident in addition
Prevent structure.
- `permission_request` envel  `tool_name` / `request_id` viewer
A leak (blocks the guess path of the tool used by operator).
- The specification of the viewer roll can be read in the list (threat-model.md / protocol.md
also reflected).
- F6 toerer directory
The judgment procedure for adding field is set as viewer (#150).

### Negative

- Syn  `state_change` for viewer (snapshot/broadcast)
converting costs minor to hot path.
- Increases the number of new functions to explicitly determine whether to appear in viewer when adding new types.
However, tolerance is the intention of allow-list.

### Neutral

- Existing operator delivery is unchanged (operator clause is bound to `envelope`).
- ext catch-all removal (F3 `state_change` clause is `Map.delete("ext")`
including).
- `agent_deleted` also receives viewer (specified to allow-list for grid matching)


## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
|Keep current catch-all connections|The viewer leak continues when new type is added. Structural problems that do not notice until an accident occurs|
| `permission_request`envel `input`(current)| `tool_name` / `request_id`Def -in-depth|
|Viewer`permission_request`Home**Completely**Remove from snapshot|Recent Posts`permission_request`The agent disappears from the grid of the viewer. `state_change`adopt to keep grid consistency in subst tion|
|3 Rolling (admin / operator / viewer)|.NI 2 rolls in the current function. ADR~~**With) rejected (2026 (2014, issue #188).**[ADR-0050](0050-principal-model-and-graded-access-control.md) D2 decided to 3 value. See  F1 revisions|

## Related

-COs: [protocol](../specs/protocol.md)
Unified), [threat-model](../specs/threat-model.md) (cited matrix).
-CO ADR: [0011](0011-phase3-reliability-and-auth.md)
mounting),[0012](0012-response-display-and-dashboard-scope.md)(log/re t
[0013](0013-user-token-cookie-persistence.md)
(token)
- F6 Origin: [issue #150](https://github.com/sakuraiyuta/kaoiro/issues/150),
[phase-27](../plans/phase-27-list-agents-metadata.md) Disclosure field
wire is [protocol-inter-agent](../specs/protocol-inter-agent.md)
"peer directory information boundary"
- Origin: [issue #46](https://github.com/sakuraiyuta/kaoiro/issues/46).
