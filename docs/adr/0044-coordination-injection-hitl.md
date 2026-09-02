---
title: Automatic injection of a common coordination-guideline footer and autonomy within assigned responsibilities under an ad hoc director
status: accepted
date: 2026-07-29
opened: 2026-07-28
supersedes: []
superseded_by: null
related_specs: [protocol-inter-agent, persona-personality-injection, threat-model]
related_adrs: [21, 22, 29, 43, 45]
---

# ADR-0044 — Automatic injection of a common coordination-guideline footer and autonomy within assigned responsibilities under an ad hoc director

## Status

Accepted (drafted 2026-07-28; F2 revised by マスター's reapproval on 2026-07-29).
Implementation will be handled as a derivative issue from kaoiro issue #87 (the
umbrella for the investigation). A phase will be numbered when implementation
begins.

The F2 in the draft assumed a **permanent** director role and conflicted with P5
of [#158 comment-5384365227](https://github.com/sakuraiyuta/kaoiro/issues/158#issuecomment-5384365227),
decided about two hours later: “Do not define a permanent director role; operator
instruction each time + per-operation permission_broker approval.” Through
マスター's reapproval on 2026-07-29, F2 was revised so that the operator assigns a
director each time, responsibilities are assigned to each agent under that
director, and each agent acts autonomously within those responsibilities. This
aligns with P5 and [ADR-0043](0043-agent-initiated-session-reset.md) D2 in not
defining a permanent role. F1 (footer injection) / F3 (passive activation) are
unchanged from the draft.

## Context

When multiple agents are operated in parallel on kaoiro, we want the agents to
observe one another's situation and autonomously divide work and collaborate,
without requiring the operator to specify the coordination method every time
(kaoiro issue #87).

The observation foundation was completed in phase-27: `list_agents` returns peer
execution characteristics (engine / model / effort) and operating status
(context / session_started_at / turns / last_activity_at / conversation /
rate_limits). There is no mechanism for injecting behavioral guidance, however,
and `send_to_agent` requires operator approval every time through the
`canUseTool` path of [ADR-0022](0022-pending-permission-authoritative-source.md)
([protocol-inter-agent](../specs/protocol-inter-agent.md) defers auto-allow to
“Phase 2 and later”). Operational rules also treat “agreements on work
allocation” as an escalation target (2026-07-21 decision), so autonomous work
allocation cannot currently be established.

## Decision

### F1 — Extend the server-SoT common footer as the injection path

Append the behavioral guidance “observe other agents' status with `list_agents`,
make your own decision, and coordinate with `send_to_agent` as needed for work
division and collaboration” to the server-centralized SoT common footer of
[ADR-0029](0029-persona-server-sot-and-pack-distribution.md), and automatically
inject it by system-prompt append into **all agents** started on kaoiro. This is
an extension of the existing engine-independent mechanism; distribution in the
form of a Claude Code skill (SKILL.md) is not used. The wording and length of the
guidance are fixed as Option A (short behavioral principles only) (マスター decision
on 2026-08-08; details in the addendum below).

### F2 — The HITL boundary is “autonomy within responsibilities under an ad hoc director”

**Do not define a permanent director role.** The operator appoints a director for
each unit of work
([ADR-0043](0043-agent-initiated-session-reset.md) D2 and #158 P5 use the same
form). The appointed director assigns roles (responsibility boundaries) to
subordinate agents, and each agent may coordinate through `send_to_agent` without
operator approval within those responsibilities (agreeing on, adjusting, and
reporting work division after the fact). For a decision outside the
responsibility, confirm with the director or escalate to the operator.

The HITL starting point is **the director appointment and setting of the
responsibility boundaries**, not each individual `send_to_agent` within those
responsibilities. Accordingly, revise the current operating rule that “agreements
on work allocation are an escalation target” (2026-07-21 decision) only within the
responsibility boundaries. The `send_to_agent` auto-allow on which this depends is
brought forward from “Phase 2 and later” in protocol-inter-agent and fixed as
Option B (conversation-level whitelist) (マスター decision on 2026-08-08; details
in the addendum below).

**Destructive operations are outside autonomy within responsibilities.** For
session reset (`/new` / `/clear`), retain the target agent's own tool call plus
per-operation permission-broker approval as in ADR-0043 D2/D4. Do not create a
path for a director to directly start a reset for a subordinate.

### F3 — Activation is passive (work-triggered)

Activate coordination judgment **passively** by checking peer status when one
receives a task or becomes stuck. Continuous active monitoring in which an idle
agent regularly watches peers and offers help (resident polling) is out of scope.

### Addendum (2026-08-09, issue #165 — resolving the remaining open questions)

The two remaining open questions assumed by F1/F2 were decided by マスター on
2026-08-08.

- **send-to-agent-auto-allow**: Adopt Option B (conversation-level whitelist).
  Only a send that first passes operator approval (`canUseTool`) and is accepted
  by the server establishes the `(conversation_id, to)` combination; subsequent
  `send_to_agent` calls are auto-allowed. Merely passing canUseTool approval does
  not establish the combination while the server has not yet accepted it, or has
  rejected it / returned unknown (`to` is also bound because of an external
  review finding; see [#201](https://github.com/sakuraiyuta/kaoiro/issues/201) —
  binding only conversation_id would let a changed destination bypass the dialog
  after rejection). With the runaway guard still weak in part (#167 has partial
  coverage), the judgment is that narrowly scoped auto-allow is safer. Treat
  [protocol-inter-agent](../specs/protocol-inter-agent.md)'s “auto-approval”
  section as authoritative for detailed implementation behavior, including
  resistance to receive races while dispatch is waiting.
- **coordination-footer-scope**: Adopt Option A (short behavioral principles
  only). Do not include procedural details such as kind selection or reporting
  format in the footer. Expand after operational measurement if deficiencies are
  found. The mechanism for guaranteeing length was decided separately in
  [ADR-0045](0045-footer-file-externalization.md) F5.

Both open questions were closed (deleted) after reflecting the decisions. The
implementation is handled in this issue ([#165](https://github.com/sakuraiyuta/kaoiro/issues/165))
([protocol-inter-agent](../specs/protocol-inter-agent.md)'s “approval flow”
section and the server-side `priv/footers/system-footer.md`).

## Consequences

### Positive

- Work division among agents can occur without operator instruction, increasing
  throughput in parallel operation.
- Injection extends ADR-0029's existing SoT mechanism and retains centralized
  management on the server. Because activation is passive, there is no token cost
  for a resident mechanism.

### Negative

- Reducing operator approval for `send_to_agent` increases the risk of runaway
  inter-agent conversations and duplicate work (tracked under #87's “designing
  how to end” and “observability” concerns, and
  [work-division-conflict-guard](../open-questions/work-division-conflict-guard.md)).
  **Addendum (2026-08-09, issue #167)**: One part of “how to end” — a bug where a
  completed conversation was reopened and its done / escalate ping-pong failed to
  stop — was mechanically closed by #167 using a server-side tombstone (rejecting
  reopening with `conversation_closed`) and wrapper-side lifecycle
  (`localDone` / `remoteDone` / `closed`, rejecting stale/duplicate turns)
  ([protocol-inter-agent](../specs/protocol-inter-agent.md)'s section on the
  conversation lifecycle and handling after termination). Remaining issues, such
  as detecting loops where semantically identical proposals are repeated in
  changed forms, remain under #87.
- If the common footer grows, it continuously consumes context for every agent;
  this must be balanced against ADR-0029's SHOULD guideline for character count.

### Neutral

- The dashboard observation path (operator-only delivery of inter-agent messages,
  [ADR-0021](0021-role-information-disclosure-policy.md)) is unchanged. What is
  autonomous is approval of sending, not the disclosure scope.
- Work without a director appointment still requires operator approval for
  `send_to_agent` as before. Autonomy applies only to the scope that has gone
  through appointment and responsibility assignment; the default state remains
  current behavior.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| Distribute a Claude Code skill (SKILL.md) | It would be an engine-dependent mechanism |
| Combine footer + skill | Complicates SoT management |
| Full autonomy + after-the-fact reporting (without a director) | Risk of runaway behavior and duplicate work |
| Define a permanent director role and retain the appointment | The role would become fixed and the operator's control point would be lost. Rejected by #158 P5 / ADR-0043 D2 |
| Keep operator approval for finalizing work division (current behavior) | Limits the improvement in autonomy |
| Active monitoring (resident polling) | Token cost and noise |
