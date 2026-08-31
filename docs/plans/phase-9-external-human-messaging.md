---
title: Phase 9 — External Human Messaging (Discord)
description: Enable AI agents to send and receive two-way messages with external humans through Discord. Stage 0 = Tier A safety slice; Stage 1 = Tier B (zero-tool intake LLM, spike gate).
status: planned
phase: 9
depends_on: [phase-8-inter-agent-messaging, phase-4-host-runner]
last_updated: 2026-07-04
---

# Phase 9 — External Human Messaging (Discord)

Enable AI agents (office staff) to send messages to external humans through
Discord and receive replies. This is a superset of inter-agent
([phase-8](phase-8-inter-agent-messaging.md)). Mechanical specifications such as
the envelope schema are in the
[protocol-external-human spec](../specs/protocol-external-human.md); the decision
background is in [ADR-0028](../adr/0028-external-human-messaging.md).

This plan is project roadmap phase-9. The feature-local slices are folded into
the plan below as Stage 0 / Stage 1 (the same form in which phase-8 contained
Stages A–D).

## Goal

An agent sends Discord messages to operator contacts (such as collaborators)
through an explicit tool call + operator approval, and the operator can follow
replies in the dashboard. Statements by external humans do not drive agent
actions (one-way authority).

## Non-goals (outside this Phase)

- email / Slack channels (retain them as planned future issues + docs)
- Accepting instructions from external humans (permission model,
  [external-human-recv-permission-model](../open-questions/external-human-recv-permission-model.md))
- A path for agents to use external input in their work
  ([external-human-agent-consumes-input](../open-questions/external-human-agent-consumes-input.md))
- GUI for contact management (v1 uses a config file,
  [external-human-contact-management-ux](../open-questions/external-human-contact-management-ux.md))

## Stage 0 — Tier A safety slice (minimal, no LLM)

Demonstrate the skeleton of two-way transport with zero injection surface.
Inbound is deterministic.

### Acceptance Criteria

- [ ] discord-wrapper entity maintains the bot connection and keeps the token within the process
- [ ] Read the contact whitelist from the config file (logical id, display name, destination DM|channel, raw target)
- [ ] Agent calls `send_to_human` → operator approves per call with destination + full body → enforce whitelist → send to Discord, explicitly identifying it as AI/kaoiro-originated
- [ ] Inbound is Tier A (fixed-template reply + verbatim relay of the original text to the operator), with no LLM
- [ ] `external_message` (both directions) is delivered only to the operator (viewers completely excluded)
- [ ] Mechanically enforce 3 turns per conversation in the server (ConversationStates)
- [ ] The implementation matches the spec's envelope schema (typecheck / lint pass)

### Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 9-1 | Finalize the spec + add the `external_message` type to protocol.md | ⏳ | |
| 9-2 | discord-wrapper entity (bot connection, token containment, runner supervision) | ⏳ | Assumes discord.js |
| 9-3 | Load + resolve + enforce the contact whitelist config | ⏳ | Raw IDs stay inside the wrapper |
| 9-4 | `send_to_human` / `list_contacts` / `whoami` tools (wrapper MCP) | ⏳ | Same shape as send_to_agent |
| 9-5 | Outbound routing (server) + full approval by permission_broker | ⏳ | |
| 9-6 | Inbound Tier A (fixed-template reply + relay original to operator) | ⏳ | No LLM |
| 9-7 | Extend the 3-turn quota to ConversationStates | ⏳ | |
| 9-8 | Display external_message logs in the dashboard (operator only) | ⏳ | |
| 9-9 | E2E: one round of agent → external human → reply → operator observation | ⏳ | |

## Stage 1 — Tier B (zero-tool intake LLM, spike gate)

**A red-team spike is a mandatory gate before starting.**

### Acceptance Criteria

- [ ] Red-team spike: confirm that injection cannot break Tier B invariants (verbatim original / fixed same party / zero-tool)
- [ ] Zero-tool Haiku filter adds `ext.interpretation` to inbound (original body unchanged)
- [ ] Responder generates a limited reply (fixed to the same party that sent the message)
- [ ] Fail-soft fallback to Tier A when Haiku fails
- [ ] No injection into the working agent's live session
- [ ] Make the filter an agent-agnostic module (open for extraction to another wrapper in the future)

### Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 9-10 | Red-team spike (injection-resistance verification) | ⏳ | Gate for adopting Tier B |
| 9-11 | Zero-tool Haiku filter (add ext.interpretation) | ⏳ | First application of plugin-model filtering / issue #18 |
| 9-12 | Responder (limited reply fixed to the same party) | ⏳ | |
| 9-13 | Fail-soft (Haiku failure → Tier A) | ⏳ | |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## Followups (in-phase but unfinished)

None.

## Open Questions Blocking This Phase

- [external-human-inbound-llm-tier](../open-questions/external-human-inbound-llm-tier.md)
  — gate for final adoption of Stage 1 (Tier B)

## See Also

- Covered specs:
  [protocol-external-human](../specs/protocol-external-human.md),
  [protocol](../specs/protocol.md), [plugin-model](../specs/plugin-model.md)
- ADR: [0028](../adr/0028-external-human-messaging.md)
- Previous phase: [phase-8-inter-agent-messaging](phase-8-inter-agent-messaging.md)
- kaoiro issue #95 (implementation), #93 (Tier B red-team spike), #94 (future
  email/Slack), #18 (message filtering)
