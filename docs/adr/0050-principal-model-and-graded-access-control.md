---
title: Principal model — separate user/agent types, three role levels, and additive per-pair permissions
status: accepted
date: 2026-08-11
opened: 2026-08-05
supersedes: []
superseded_by: null
related_specs: [auth-and-authz, protocol, protocol-inter-agent, threat-model]
related_adrs: [7, 13, 21, 24, 28, 30, 33, 42]
---

# ADR-0050 — Principal model and graded access control

## Status

Accepted (2026-08-11; マスター promoted it from `proposed` by decision. Phase A
(identity) was completed in [issue #187](https://github.com/sakuraiyuta/kaoiro/issues/187)).
Implementation issues are [#187](https://github.com/sakuraiyuta/kaoiro/issues/187)
(identity, implementation complete) /
[#188](https://github.com/sakuraiyuta/kaoiro/issues/188)
(admin role) /
[#189](https://github.com/sakuraiyuta/kaoiro/issues/189)
(per-pair permissions) /
[#190](https://github.com/sakuraiyuta/kaoiro/issues/190)
(persistence foundation) /
[#191](https://github.com/sakuraiyuta/kaoiro/issues/191)
(graph editing tool).

The questions to settle before starting Phase B and later (#188-#191) — whether
to revise or supersede ADR-0021 (#188), the default for agent→agent edges (#189;
naively applying the additive model would stop inter-agent messaging entirely),
and whether to add a DETS store or introduce SQLite (#190) — will be decided
individually when each issue begins.

## Context

kaoiro authorization is fixed at two roles (operator / viewer), and operators have
effectively unlimited authority ([ADR-0021](0021-role-information-disclosure-policy.md)
F1). The Known gaps in `docs/specs/auth-and-authz.md` explicitly identify three
holes in this structure:

- **Operator-role granularity**: operators have all authority, including spawn /
  interrupt / approve / clear. Assumes a single tenant.
- **Multi-tenant isolation**: every operator can operate every agent. There is no
  agent ownership boundary.
- **Audit log**: there is no durable record of “who sent what to which agent and
  when.”

All three were deferred as out of scope by [ADR-0042](0042-oauth-allowlist-login.md).
They worked while there was one user, but all become harmful in medium-sized or
larger operations. In addition, a user has no identity internal to kaoiro (only an
OAuth identity (provider + uid) or a shared token), so “who” remains neither in
logs nor envelopes, and an AI agent cannot identify the source of an instruction.

ADR-0021 F6-6 further grounds the peer directory's validity in the premise that
“kaoiro is currently a closed system under a single operator, and peers are
limited to agents started by the same human,” and explicitly says to
“**re-evaluate this section when the trust boundary between agents is no longer
per operator**.” This ADR's decision is exactly what triggers that condition.

This ADR decides these four elements (identity / role hierarchy / per-pair
permissions / persistence) as one integrated design.

## Decision

### D1 — Separate user and agent types; the only shared abstraction is `Principal`

Make `User` and `Agent` separate types, with a shared `Principal` (`id` / `kind` /
`display_name`) abstraction used only as nodes in the permission graph. The axis of
separation is **the source of authority**, not “human or AI.”

Rationale:

1. **Their identity SoTs differ.** `agent_id` is assigned by kaoiro
   ([ADR-0024](0024-agent-instance-identity-and-spawn-auth.md) D3,
   `<scope>.<rand>`). A user's identity comes from an external IdP (OAuth
   provider + uid), whose SoT is outside kaoiro. A unified type structurally creates
   broken operations such as “spawn a user” and “put an agent on the allowlist.”
2. **Accountability is asymmetric.** An agent's actions ultimately become
   attributable to some user, while a user's actions terminate without attribution
   to anyone. Without expressing this in types, the responsibility chain
   user → agent → agent is flattened and auditing cannot work.
3. **There is a precedent.** D3 of [ADR-0028](0028-external-human-messaging.md)
   separated external-human messaging into a dedicated type / tool rather than
   generalizing inter-agent messaging. The reason is that “putting trust models in
   one path makes a missed branch immediately a vulnerability.” If future agent
   destinations become agent / internal user / external human, authority differs
   for each of the three paths and the same trap must be avoided.

Derived rules:

- `kind` is a required wire field. If an agent cannot distinguish a human peer from
  an AI peer, it cannot determine whether an incoming message has authority.
- The ID space is unified. Preserve the existing charset `[A-Za-z0-9._-]`
  ([#61](https://github.com/sakuraiyuta/kaoiro/issues/61)).
- **Do not derive `kind` from the ID.** Store it as an attribute. Giving meaning to
  an ID prefix would make spoofing directly affect authorization decisions.

**Implementation status**: The user side was implemented in Phase 2 of issue #187
as `%{id, kind, display_name,
role}`. At the time of issue #187, the agent side
substituted `persona.name` for `display_name` (a temporary carve-out of ADR-0030
D2), so the `Principal` abstraction was not realized on the agent side.
[Issue #209](https://github.com/sakuraiyuta/kaoiro/issues/209) implemented an
agent-side `display_name` independent of `persona` (from the pack, immutable during
the session), allowing `Principal` (`id` / `kind` / `display_name`) to take its
proper form on both user and agent sides.

### D2 — Three roles: admin / operator / viewer

Override F1 of [ADR-0021](0021-role-information-disclosure-policy.md) (fixed at two
roles; three-role conversion was YAGNI).

| role | definition |
|---|---|
| admin | Editor of the permission graph and fully visible. **Not subject to concealment**. Always has full authority and is outside per-pair permissions |
| operator | A principal that can operate agents. Which agents it can operate is determined by per-pair permissions |
| viewer | Guest. By default, only confirmation of presence on the grid |

The original intent of viewer was “show a guest who visits the office that the
employees are working,” not disclose conversation logs. The current viewer
visibility in ADR-0021 F3 matches this intent and is therefore **unchanged**.

**MUST — admin cannot be concealed.** Do not draw an edge that hides an admin on
the permission graph. If possible, auditing collapses. As a consequence, it is
impossible in principle to hide anything from a human with admin permission.

**MUST — retain a bootstrap path.** kaoiro is fail-closed (ADR-0042), and if there
is no admin, permission editing becomes permanently impossible (lockout). Declaring
the initial admin by editing env / files directly is the only entry point. In D3's
additive model, this path also serves as the initial edge-ingestion path.

### D3 — Four levels of per-pair permission, using an additive model

Define four permission levels — **can submit prompts / can view conversation logs /
list-only / completely hidden** — for each user→agent / user→user / agent→agent
pair.

**Additive model** — a principal has no permissions other than those explicitly
granted. With zero edges, it sees and can do nothing (except admin). Do not use a
subtractive model (the role grants defaults and edges narrow them) for three reasons:

1. kaoiro already makes ADR-0021 F2's allow-list, ADR-0029 F3, and the OAuth
   allowlist fail-closed, with “nothing reaches the destination without an explicit
   declaration” as a design principle. Creating a fail-open island only here would
   break consistency.
2. Moving from subtractive to additive in a system with real operational data would
   be a destructive change that removes existing users' permissions. With one user
   today, migration cost is nearly zero.
3. Given OSS publication and business expansion, tightening after shipping with
   loose defaults would break existing users' environments.

**Composition rule**: the global role is the ceiling, and per-pair permissions can
   narrow only within that ceiling. Do not grant a viewer “can submit prompts” via
   per-pair permission. This has the same structure as the dual-axis model of
   [ADR-0033](0033-permission-model-dual-axis.md).

### D4 — Automatically grant the spawner a full edge at spawn (ownership concept)

Naively applying the additive model creates a newly spawned agent invisible to and
uncontrollable by everyone, so operation cannot function. Automatically grant the
spawner a full edge at spawn.

This does not violate D3's principle that “nothing other than what was explicitly
granted is held” — **the act of spawning itself is an explicit permission claim**.
It has the same structure as a Unix user who starts a process becoming its owner,
and a file receiving rw permissions for its creator when created.

This decision enters the “multi-tenant isolation (agent ownership boundary)” that
ADR-0042 deferred as out of scope.

### D5 — Two visibility layers: identity is generally disclosed; state and activity are per-pair

kaoiro is a virtual office where multiple AI agents participate, so entities in the
office are generally visible with their roles. However, the scope of “generally
visible” is limited to **identity (id / name / kind / role)**; state and activity
(what it is doing, and whom it is communicating with) are subject to per-pair
permissions.

“Who is currently present” and “whom to approach” are separate questions, and it is
fine for the former to be known. ADR-0028 D4 already concluded for an external
human's contact list that disclosure does not weaken defense (“list disclosure does
not weaken defense — enforce guarantees it, office metaphor”). Knowing a role does
not change an agent's authority. Enforcement belongs on the server, not in an
agent's perception.

**Retain fail-closed behavior at implementation level.** “Generally visible” is
implemented as a **configuration default value**, not as the implementation's
default behavior. Making the implementation default open would break ADR-0021 F2's
allow-list structure and revive leaks when a new field is added.

### D6 — Conversation-log visibility is per agent; do not guarantee transitive concealment

Grant conversation-log viewing permission per agent. A user who can view an agent's
logs sees **the messages of every user who conversed with that agent**.

The rationale is the operational requirement that “a supervisor of the agent should
naturally be able to inspect all of that agent's work.” Do not filter by speaker
(redacting messages from hidden users): it breaks context, and the existence of the
redaction itself leaks information.

**As a consequence, “completely hidden” user→user is not transitive.** Even if user
C is completely hidden from user B, when B and C converse with the same agent A,
C's messages are visible to B through A's log. State this property explicitly in
the specification.

The requirements “hide from a particular user” and “a supervisor sees everything”
appear contradictory, but **resolve them hierarchically**. Concealment applies
between operators of equal standing; admins and higher-level operators cannot be
hidden from (D2). This has the same structure as the fact that in a real office,
only someone equal or senior to A can say “keep it from A.”

### D7 — Dashboard and agent paths read the same permission table (MUST)

As in ADR-0021 F6-1, the path seen by operators (`agents:lobby` /
`AgentsChannel.sanitize_envelope_for/2`) and the path seen by agents
(`wrapper:<id>` / directory responses from `WrapperChannel`) are separate
implementations; one allow-list does not protect the other.

Per-pair permissions must have **both paths read the same permission table**.
Independent decisions create the divergence “hidden on the graph but visible from
the agent side,” making the permission configuration itself untrustworthy.

### D8 — Implementation phases: A → B-1 → B-2 → C

| Phase | content | issue |
|---|---|---|
| A | Identity + admin role. Authorization SoT remains text | #187 / #188 |
| B-1 | Store + **simultaneous introduction of per-pair permission behavior** | #189 / #190 |
| B-2 | Manually add edges through the bootstrap path and verify behavior | #189 |
| C | Graph editing tool | #191 |

The key is to **introduce behavior simultaneously with the store in B-1**. If the
editing tool is built first and behavior deferred, it is impossible to verify what
the tool edits, and divergence between D7 paths stays hidden until the tool is
complete. Above all, a configuration UI without enforcement creates the worst state
for a security feature: “I thought I configured it, but it has no effect.”

Admin retains full authority even under the additive model (D2), so B-1 does not
make operation impossible. By B-2, there is already operational value in “exclude a
particular operator from a particular agent.”

**Phase B migrates the OAuthAllowlistWatcher mechanism.**
[#160](https://github.com/sakuraiyuta/kaoiro/issues/160) completed on 2026-08-05
(commits `2d64000` / `8ef15fc`) and watches the allowlist text file as authorization
SoT through file_system events + periodic reconcile. Moving to a structured store
changes this premise, so replacing the watcher from “file watch” to “store change
notification” is included in Phase B.

### D9 — Build the graph editing tool as an independent client

Implement the permission-editing UI as an independent client, not as a screen in
the bundled dashboard. The bundled dashboard is only a reference implementation
([ADR-0007](0007-client-separation-reference-dashboard.md)), and the design already
allows an operator to provide a dedicated client and stop serving the default
dashboard.

As a byproduct, **the permission-editing protocol surface must be defined on the
wire**. This lets operators implement their own admin tools and establishes the
same “reference implementation + replaceable” structure for permission editing as
for the dashboard.

Reflect graph changes live (agents dynamically increase/decrease through spawn /
stop, and D4 automatically adds edges at spawn).

### D10 — Audit the permission changes themselves

Persist “who drew which edge to whom and when” as an audit trail. Even strict
permissions under the additive model are meaningless if the permission changes
themselves cannot be tracked. This overlaps the audit-log Known gap in
auth-and-authz.md ([#146](https://github.com/sakuraiyuta/kaoiro/issues/146));
whether to integrate or divide the work is decided in #190.

## Future work (not decided by this ADR)

- **Relay messages between users**. An extension to support a prompt where an agent
  asks to relay a message to another user. The choice in D5 to disclose the full
  user list to agents anticipates this extensibility. For now it remains a prospect
  and is not in implementation scope.
- **Grid display of users and mutual chat**. A UI where agents and users appear
  side by side. Even if implemented, retain D1's type separation — appearing next
  to each other in the UI and having the same type are different things, and the
  more identity is shared, the more important explicit kind becomes.

## Consequences

### Positive

- Authorization is consistently fail-closed across the whole system. “Nothing
  reaches the destination without an explicit declaration” applies from envelope
  delivery (ADR-0021 F2) through the permission graph.
- Auditing works: users have identities, and permission changes leave evidence.
- Medium-sized operations become possible by dividing which agents each operator
  can touch.
- This lays groundwork for OSS publication and business expansion. Security models
  are hard to strengthen later, so choosing the strict side at the start is right.
- Making permission editing a wire protocol lets operators build custom admin tools
  (D9).

### Negative

- **This overturns ADR-0021 F1.** That ADR must be revised or superseded (which is
  decided in #188), and F3 / F4 / F6 also require broad rewrites.
- Implementation cost is large, especially migrating to per-pair checks
  (classifying about 22 operator-only inbound paths through `require_operator/1`),
  changing the `sanitize_envelope_for/2` fan-out hot path, and developing an
  independent client.
- The additive model fits poorly with dynamic agent creation; operation fails
  without D4's ownership concept. The default for agent→agent edges is unresolved
  (#189).
- The implemented OAuthAllowlistWatcher (#160) assumes that the text file is
  authorization SoT; that changes in Phase B and requires migrating the watcher.

### Neutral

- Existing operator / viewer behavior is unchanged during Phase A. Only admin is
  added above them; the substance of demotion is Phase B.
- Do not change viewer visibility (ADR-0021 F3), since it matches the original intent.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| **Subtractive model** (role grants default permissions and edges narrow them) | Migration is smooth, but it does not satisfy the safer principle of removing everything not explicitly granted. It conflicts with fail-closed behavior elsewhere in kaoiro. With one user today, migration to additive costs nearly nothing |
| **Unified user / agent type** | Their identity SoTs differ (external IdP vs internal assignment) and accountability is asymmetric. Unification flattens the audit responsibility chain. ADR-0028 D3 also provides a precedent for choosing path separation for the same judgment |
| **Speaker-level log filtering** | Breaks conversation context, and the existence of redaction itself leaks information, making concealment incomplete. It is half-measure |
| **Conversation-level permissions** (see only conversations one participated in) | Strictest, but directly conflicts with the virtual-office idea that “the place is visible,” and has the highest implementation cost. It also fails D6's requirement that supervisors see everything |
| **Permission editor inside the dashboard** | Cheaper to implement, but because the dashboard is replaceable as a reference implementation, enclosing permission editing there loses the editing means when the dashboard is replaced |
| **Build the editing tool first and implement behavior later** | The tool's correctness cannot be verified, and D7 path divergence remains hidden. A configuration UI without enforcement is most dangerous. Admin retains full authority even under the additive model, so implementing behavior first does not make operation impossible |
| **A mechanism that can also hide from admin** | Auditing would collapse if realized. Accept this in principle as the consequence of holding root authority |

## Related

- Specs: `auth-and-authz` (map of boundaries; the three Known gaps are this ADR's
  starting point), `protocol` (destination for the permission-editing surface),
  `protocol-inter-agent` (peer-directory information boundary), and `threat-model`.
- Related ADRs: [0007](0007-client-separation-reference-dashboard.md) (client
  separation → D9), [0013](0013-user-token-cookie-persistence.md) (cookie /
  ticket), [0021](0021-role-information-disclosure-policy.md) (**overturn F1 /
  trigger the F6-6 re-evaluation condition**),
  [0024](0024-agent-instance-identity-and-spawn-auth.md) (agent_id assignment),
  [0028](0028-external-human-messaging.md) (one-way authority and path-separation
  precedent → D1 / D5),
  [0030](0030-agent-directory-and-explicit-restore.md) (AgentDirectory and the
  persistence decision → #190 open questions),
  [0033](0033-permission-model-dual-axis.md) (dual-axis → D3 composition rule),
  [0042](0042-oauth-allowlist-login.md) (**withdraw the out-of-scope statement**).
- Related issues: #187 / #188 / #189 / #190 / #191 (implementation),
  [#146](https://github.com/sakuraiyuta/kaoiro/issues/146) (audit log), and
  [#160](https://github.com/sakuraiyuta/kaoiro/issues/160) (authorization-SoT
  watcher, implemented and a Phase B migration target).
