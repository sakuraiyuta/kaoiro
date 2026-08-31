---
title: principal model — user/agent type separation, 3 role hierarchy, per-pair addition model
status: accepted
date: 2026-08-11
opened: 2026-08-05
supersedes: []
superseded_by: null
related_specs: [auth-and-authz, protocol, protocol-inter-agent, threat-model]
related_adrs: [7, 13, 21, 24, 28, 30, 33, 42]
---

# ADR-0050 — principal model and step-by-step access control

## Status

Accepted (2026 (2011) Phase A
[issue #187](https://github.com/sakuraiyuta/kaoiro/issues/187)
).
[#187](https://github.com/sakuraiyuta/kaoiro/issues/187)
(identity) /
[#188](https://github.com/sakuraiyuta/kaoiro/issues/188)
(admin role) /
[#189](https://github.com/sakuraiyuta/kaoiro/issues/189)
(per-pair)
[#190](https://github.com/sakuraiyuta/kaoiro/issues/190)
(Persistent base) /
[#191](https://github.com/sakuraiyuta/kaoiro/issues/191)
(Graph editing tool).

ADR-0021
or supersede (#188), agent→agent edge default (#189, add
inter-agent Model stops when the model is applied rusticly),
Add SQLite to DETS or #190
Make a decision.

## Context

kaoiro authorization is fixed to 2 roles (operator / viewer) and operator is real
([ADR-0021](0021-role-information-disclosure-policy.md) F1)
`docs/specs/auth-and-authz.md`'s Known gaps make this structure a hole
3 explicitly:

- **operator role**: operator spawn / interrupt / approve / clear
All rights including: Single tenant premise
- **Multi-tenant isolation**: All operators can operate all agents.
Register agent owner boundaries
- **Audit Log**: Fixed athe relevant entry record of "whoever sent to the agent"

[ADR-0042](0042-oauth-allowlist-login.md)
It was sent in the future. It was established between single users, but it is more than medium size
In operation, it becomes real harm. kaoiro internal identity
(OAuth identity (provider + uid) or shared  only)
"Who" remains in the log and envelope , and the AI agent is the source
Not recognized.

In addition, ADR-0021 F6-6 is based on the validity of theerer directory.
This is a closed system under the single operator, and theerer is the same agent.
Set "only," the trust boundary between **agent is no longer in the operator unit
At the time, we specify the condition that we will re-evaluate this section. The decision of this ADR
ignite the condition.

This ADR has four (identity / role hierarchy / per-pair / persistence)
Design as an integrated design.

## Decision

### D1 — user and agent separate types. Common abstracts`Principal`

`User` and `Agent` are different types, and only common nodes in the permission graph
`Principal` (`id` / `kind` / `display_name`) Axial separating
not human or AI****.

Reference:

1. **Iden  SoT is different**Note `agent_id` is kaoiro
   ([ADR-0024](0024-agent-instance-identity-and-spawn-auth.md) D3,
`<scope>.<rand>`. The identity of user isternal fromternal IdP (OAuth provider + uid)
SoT is outside of kaoiro. "Spawn user"
Broken operation surfaces such as “Applying agent to permission list” can be constructed
2. **Athe relevant entrymetric**Note The action of the agent is ultimately attributed to any user,
The behavior of the user is the end that is not attributable to anyone. If not expressed by type
user → agent → agent’s responsibility chain is flattened and audit is not established
3. **Example**Note [ADR-0028](0028-external-human-messaging.md) D3
external human tool to the dedicated type / tool instead of generalizing inter-agent
separated. If the Route "trust model is in one route, the condition is leaked immediately
Vulnerability Agent / internal user / external
3 Pass the same   because each route is different

Note rules:

- `kind` is a required field on wire. Agent forerer
If it is not judged, it is not possible to determine whether there is a reception message
- id space is single. charset `[A-Za-z0-9._-]`
([#61](https://github.com/sakuraiyuta/kaoiro/issues/61))
- **`kind` does not derive from id**Note store attribute. id
If prefix has a meaning, the falsehood is effective for the permission judgment as it is

**Status**: user side is issue #187 step 2`%{id, kind, display_name,
role}`implemented. agent at issue #187`persona.name`Note
`display_name`, `Principal`
was not realized on the agent side.
[issue #209](https://github.com/sakuraiyuta/kaoiro/issues/209)
independent from `persona` (pack-derived, session-invariant)
`display_name` field is implemented and `Principal` (`id` / `kind` /
`display_name`) to be established in both user and agent


### D2 — role is admin / operator / viewer

[ADR-0021](0021-role-information-disclosure-policy.md) F1 (2-roll fixed,
3 Rolling covers  NI).

| role ||
|---|---|
| admin |Author and full visibility of permission graphs.**Apply to cover concealment**Note Per-pair permission|
| operator |Make sure the agent can be operated. which agent can be operated by per- permissionpair|
| viewer |Guest Default is only available on grid|

The original intention of viewer is to say, "the guest who came to the office is working by the employee."
It is about "to show" and not the disclosure of the conversation log. ADR-0021 F3
Visibility is consistent with this intention**Not changed**.

**MUST — admin cannot be hidden.**Disable admin on permission graph
No edges. The audit fails if it is lost. admin
It is not possible to hide something to a person with permission.

**MUST — leave the boots  route.**kaoiro fail-closed design
(ADR-0042), and in state where admin is not one, permission editing can not be permanently
(lockout) Initial admin declaration by editing env / file is the only entrance.
In the addition model of D3, this path can also be used to initialize the edge.

### D3 — per-pair permission 4 steps

permission**Prompt / Conversation log viewable / List display only / Full non-display**
the user→agent/user→user/agent

**Model**—— Do not have any other permissions provided explicitly. if edge is 0
(admining admin) Nothing can be seen. subtraction model (role default permission)
Feeding and squeezing edges): 3:

1. kaoiro already has ADR-0021 F2 allow-list, ADR-0029 F3, OAuth permission list
fail-closed and the design principle of "not reach without explicit declaration".
The consistency of the principle breaks when making the island of fail-open only here
2. Subtraction → Migration of addition is the permission of the existing user in state with actual operation data
It becomes a destructive change that disappears. Nearly zero migration costs when one user is present
3. After shipping with a loose default, more than exposure to public and business development
If you close it, the environment of the existing user is broken

**Syn  Rules**: global role squeezes only the ceiling and per-pair.
Per-pair is not given to viewer.
[ADR-0033](0033-permission-model-dual-axis.md) dual-axis structure.

### D4 — auto-grant full edge to spawner when spawn (owner concept)

Applying the add-on model is simple, the newly spawned agent is not visible from anyone
Nobody can operate in state. spawn at spawner
Automatically add edge full.

This does not break the Principles of D3's "not having anything explicitly given"
**spawn itself express permission claim**That's why.  in Unix
rw is attached to the creator if the booted user becomes the owner and make the file
same structure.

This decision is "multi-tenant iso  by ADR-0042"
(Agent owner boundaries)

### D5 — 2 levels of visibility. identity disclosure, state and activity per-pair

kaoiro is a virtual office for multi-AI agents.
As a rule, the entity that is participating is a form that is visible in role. However,
The scope of “visible” is**id / name / kind / role**Note
per-pair permission
permission

"Who are you currently?" and "Who do you work?" are another problem, and the former is known
Comment ADR-0028 D4 ex  human contact that the disclosure does not weaken the defense
I already concluded a list ("list disclosure is not weakening the defense -- enforce"
collateral, office meta s). The agent does not change even if it knows the role.
The server is not recognized by the agent.

**The implementation level fail-closed is maintained.**"See the Principles" is implemented
not default behavior**Default value of configuration**default
ADR-0021 F2 allow-list structure is broken when open
A leaking incident is revived.

### D6 — The visibility of the conversation log is the agent unit. No concealment guaranteed

The permission of the conversation log is given by the agent unit. The agent can log
user**All user's words that have spoken with the agent**See

"If the agent is the boss of the agent, it is possible to check all the operations of the agent.
"Of course" operation request. Filters per message (deferring non-display user)
The existence of the defamation itself does not get away because it breaks the context.

**As a result, "complete non-display" of user→user is not always established.**
Even if user C is completely non-display for user B, B and C are the same agent A
If you have a conversation, you can see a C statement via the A log. This nature is
permission

"I want to hide a specific user" and "the boss see all"
At first g ,**Resolve in hierarchy**Note It is an equal stand that hiding is established
operators are not hiding from admin and higher operators (D2).
In real-world office, "A is an intimate" is a human who is more than equal to A
The same structure as the only one.

### D7 — dashboard route and agent routes draw the same permission table (MUST)

ADR-0021 F6-1
`AgentsChannel.sanitize_envelope_for/2`)
`wrapper:<id>` / `WrapperChannel` directory
One allow-list does not protect others.

per-pair permission**Both routes draw the same permission table**Structure Close
When it is judged, "It is visible from the agent side even though it is non-display on the graph"
The permission setting itself is not credible due to divergence.

### D8 — Implement phase order: A → B-1 → B-2 → C

| Phase ||permission|
|---|---|---|
| A |identification + admin role. Authorized SoT remains text| #187 / #188 |
| B-1 |per-pair**Simultaneously inject behavior** | #189 / #190 |
| B-2 |Handwritten edge in the boots  pathway to verify behavior| #189 |
| C |Graph editing tool| #191 |

**Put the behavior at the same time in B-1**Edit tools first
When you make and make the behavior later, you can see what the editing tool is editing.
The D7 routing dev  is not valid until the tool is complete. More
The setting UI without enforce is "not working with it"
Security state as a security function.

Even with the addition model, admin keeps all rights (D2), so if it is unoperable at the time of B-1
When B-2 is used, it is called " ing a specific agent"
Real-time value is already obtained.

**Phase B migrates the watcher mechanism of OAuthAllowlistW er.**
[#160](https://github.com/sakuraiyuta/kaoiro/issues/160)
Completed on 2026 05 (commit `2d64000` / `8ef15fc`), in the permission list
file system event + periodic
reconcile As this premise changes when moving to a structured store,
Re watch watcher from "file watch" to "store change notification"
Phase B

### D9 — Graph editing tools make as independent clients

permission Edit UI is not included in dashboard.
.. Included dashboard is a reference implementation
([ADR-0007](0007-client-separation-reference-dashboard.md))
Operations where operators prepare dedicated clients to stop sending default dashboards
To be in the design field.

As a by-product, the required to define **permission editing protocol surface to wire is
** As a result, operators can implement their own admin tools,
The same "reference implementation + changeable" composition as dashboard is for permission editing
Close

Graphs reflect live (agents dynamically increase or decrease with spawn / stop, and D4
to stop edge automatically when spawn.

### D10 — Audit permission changes itself

“Whoever draws what edges” as audit trail.
If the permission change itself can not be tracked, even if the permission is strictly in the model
auth-and-authz.md
([#146](https://github.com/sakuraiyuta/kaoiro/issues/146))
#190 determines whether to integrate or share it.

## Future work

- **the relevant entryation between users**Note The agent prompts for another user
Supported extensions. D5 to disclose all user lists to agent
I'm looking for this scalability. Sorry, this entry is only available in English.
Not included in the implementation scope
- **user grid list display and interactive chat**Note Agent and user on UI
Shape that looks  . D1 mould separation can be realized with —— UI up UI
The same type is another one, and the more the same type is expressed as kind
permission

## Consequences

### Positive

- The entire authorization is consistent with fail-closed. If there is no explicit declaration,
Follow the same principles from the envelope  delivery (ADR-0021 F2) to the permission chart
- Audit is established. The user has identity, and the trail remains in the permission change
- Medium-scale operation is possible. Separate agent that touches each operator
-   Stone for public and business development. Security models are hard to reinforce,
The correct answer to the severe side of the initial
- With permission editing to wire protocol, operators can use their own admin tool
Created (D9)

### Negative

- **Cover ADR-0021 F1.**ADR revision or supersede is required (either
#188 F3 / F4 / F6
- High mounting cost. `require_operator/1`
operator-only inbound about 22 types), `sanitize_envelope_for/2`
fan-out hot path
- The addition model is not compatible with the dynamic generation of the agent and does not compensate for the owner concept of D4
Operation is not established. agent→agent edge is unresolved (#189)
- "Text file" assumed by implemented OAuthAllowlistW er (#160)
"Authorized SoT" is changed with Phase B, and watcher mechanism is migrated

### Neutral

- The behavior of the existing operator / viewer at Phase A does not change.
Simply add the admin to the top, and the precipitation is Phase B
- The viewer visibility (ADR-0021 F3) is the original intention.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| **Model**(role gives default permission and edges)|The migration is smooth, but it does not meet the safety principle of “extracting other than expressly given”. kaoiro unmatched with fail-closed on other parts. Nearly zero migration costs for one user now|
| **user / agent integration type** |Identification of SoT is different (ex  IdP vs internal number). When integrating, the responsibility chain of the audit is flattened. ADR-0028 D3 selected route separation by the same type|
| **Log filters for each speech** |The context of the conversation is broken. The existence of bleeding characters is incomplete because it leaks information. Mid-Term|
| **Permission of Conversation Unit**(You can see only the conversation you have joined)|It is the most strict, but it collides from the idea of the virtual office, and the implementation cost is the maximum. D6's "supervisor can see all" requests can not be met|
| **Permission editing screen in dashboard** |The implementation cost is cheap, but Dashboard is a reference implementation and can be replaced, and if the permission edit is closed there, you lose the editing method when you change it|
| **Create and implement editing tools** |The correctness of the editing tool can not be verified, and the routing gap between D7 is not dewed. The setting UI without enforce is the most dangerous. Even if the model is added, the admin keeps all rights, so even if it is not possible to operate|
| **How to hide to admin** |The audit fails when realized. Give up in principle as a return to having root|

## Related

-Maps: `auth-and-authz` (Boundary map, Known gaps, 3 items in book ADR
starting point), `protocol` (Additional destination for permission editing),
`protocol-inter-agent`, `threat-model`
-> ADR: [0007](0007-client-separation-reference-dashboard.md)
(Clients separation → D9),
  [0013](0013-user-token-cookie-persistence.md) (cookie / ticket),
  [0021](0021-role-information-disclosure-policy.md)
  (**Cover F1 / F6-6 Reassessment ignition**),
[0024](0024-agent-instance-identity-and-spawn-auth.md) (agent id),
[0028](0028-external-human-messaging.md)
Example → D1/D,,
  [0030](0030-agent-directory-and-explicit-restore.md) (AgentDirectory,
Determination of persistence → #190 unresolved matters),
[0033](0033-permission-model-dual-axis.md)
  [0042](0042-oauth-allowlist-login.md) (**With  Out of scope**)
-) issue: #187 / #188 / #189 / #190 / #191 (implemented),
  [#146](https://github.com/sakuraiyuta/kaoiro/issues/146)
(Audit Log),
  [#160](https://github.com/sakuraiyuta/kaoiro/issues/160)
(Approved SoT watcher, implemented and migrated with Phase B)
