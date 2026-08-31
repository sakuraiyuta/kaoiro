---
title: Phase 8 — Inter-Agent Messaging
description: Enable direct interaction between multiple AI agents. Stage A specification alignment → Stage B Phase 1 MVP (explicit user instruction) → Stage C Phase 2 permission-gate improvements. Stage D Phase 3 (autonomous decisions) follows completion of #87.
status: done
phase: 8
depends_on: [phase-3-server-multiagent, phase-4-host-runner]
last_updated: 2026-08-09
---

# Phase 8 — Inter-Agent Messaging

Enable multiple AI agents to exchange messages directly through the kaoiro
server. This is the implementation for kaoiro issue #17, paired with kaoiro
issue #18 (message filtering), while kaoiro issue #87 (research into the design
of cooperative communication among multiple AI agents) serves as the umbrella
issue that also organizes prerequisites.

Mechanical specifications such as the envelope schema are split out into the
[protocol-inter-agent spec](../specs/protocol-inter-agent.md) (to be created in
follow-up work); this plan covers only the staged implementation plan.

## Goal

Starting from an explicit user instruction such as “Discuss X with @agent-a and
@agent-b and reach a conclusion,” agents A and B exchange messages through the
kaoiro server, implementing three kinds of interaction—consultation, discussion,
and request—using structured envelopes. Duplicate the observation path so that
the entire interaction can be followed in the dashboard.

## Non-goals (outside this Phase, Stage D and later after #87)

- A path for agents to **autonomously** query other agents (Phase 3)
- Unattended operation using automatic approval + quota/cooldown
- Natural-language “next speaker selection” (equivalent to AutoGen dynamic group chat)
- Message filtering, censorship, and transformation (handled separately in kaoiro
  issue #18 and considered from Phase 2 onward)

## Stage A — pre-spike (specification alignment check)

Before implementation begins, understand the current state of the existing
envelope conventions, sending-tool path, and dashboard log display, and confirm
that new envelope types can be added without inconsistency.

| Item | Purpose | Output |
|--|--|--|
| IN1 | Read the naming conventions for existing envelopes (runner control #66, subagent-tasks, etc.) and understand what `from`/`to` refer to, the case of kind strings, and whether a common base type exists | Alignment guide when starting the spec draft |
| IN2 | Location where the sending tool is implemented (wrapper MCP/in-process tool injection path) | Determine where to place the `send_to_agent` tool |
| IN3 | Dashboard log display path and existing log envelope shape | Finalize the rendering policy for `inter_agent_message` on the observation path |

Completion criterion: reflect the research results for the three items above in
the new spec draft `docs/specs/protocol-inter-agent.md` and finalize the envelope
schema in a machine-readable form.

## Stage B — Phase 1: A→B by explicit user instruction (MVP)

The minimum implementation in which inter-agent messages flow only when the user
explicitly instructs “@agent-a → @agent-b.” Demonstrate the skeleton of wire +
tool + routing + observation + approval + safety valve.

**Insert user review → commit → push when Phase 1 is complete.**
Decide whether to proceed to Stage C in a subsequent session.

### IN (included)

- `send_to_agent(agent_id, message, kind, meta)` tool (wrapper)
- envelope schema with 9 kinds (`request` / `response` / `query` /
  `inform` / `propose` / `accept` / `reject` / `escalate-to-user` /
  `done`); fields: `from` / `to` / `conversation_id` / `turn_number` /
  `kind` / `payload` / `meta {done, propose_next, confidence?,
  reject_reason?}` / `owner {kind, id}`
- server: envelope routing (deliver to B's session) + observation broadcast
  (duplicate to the dashboard log stream)
- dashboard: display `kind: "inter_agent_message"` in both A and B's log fields
- wrapper: connect tool calls to per-call approval through the existing
  `permission_broker`. Display the destination `agent_id` and a payload excerpt
  in the dialog
- Hard-limit config per conversation: `max_turns` / `max_tokens` / `max_wallclock` /
  `max_concurrent_agents`. Finalize defaults in the spec. When a limit is
  exceeded, the server forcibly terminates the conversation and records an
  “unagreed termination” status in the dashboard (issue #211 removed
  `max_wallclock` from the hard limits—the current limit set and the memory-
  reclamation TTL are defined by the “Hard limits” section of the
  [protocol-inter-agent spec](../specs/protocol-inter-agent.md))

### OUT (explicitly excluded, Stage C onward or future)

- Per-call approval dialog UX improvements (start with a plain dialog)
- Automatic approval / quota / cooldown
- Autonomous decisions (allow the path in which the LLM chooses
  `send_to_agent` itself, but always preserve an opportunity for user
  intervention through per-call approval by permission_broker)
- Message filtering (kaoiro issue #18)
- Conversation restart and history resume (within the scope of Phase 4 / ADR-0014)
- Routing between remote hosts (start with agents within the same server)

### Completion criteria

- The user instructs from the dashboard “Consult @agent-b about X with
  @agent-a” → A calls `send_to_agent` → after per-call approval, the envelope
  reaches B's session → B responds → it returns to A through the same path, and
  the interaction history is observable in both dashboard logs
- Hard limits (max_turns, etc.) take effect mechanically and automatically stop
  on quota overrun
- The implementation matches the spec's envelope schema (typecheck / lint pass)

### Layered slices (order)

| Order | Layer | Contents |
|--|--|--|
| 1 | spec | Finalize `docs/specs/protocol-inter-agent.md` (envelope / kind / meta / owner / hard-limit defaults) |
| 2 | server | Envelope routing + observation broadcast + hard-limit monitoring timer |
| 3 | wrapper | Define the `send_to_agent` tool, connect it to permission_broker, and inject received envelopes into SDK input |
| 4 | dashboard | Display `inter_agent_message` in logs and the destination in the permission dialog |
| 5 | config | Add configuration items for `max_turns` / `max_tokens` / `max_wallclock` / `max_concurrent_agents` (`max_wallclock` was removed by issue #211; see the spec) |
| 6 | E2E | Run one round of consultation → discussion → agreement → done in a two-agent environment |

## Stage C — Phase 2: permission gate improvements + refactor

Polish Phase 1's per-call approval dialog for inter-agent messaging and organize
the duplication and naming issues that stand out in Stage B. The goal of kaoiro
issue #17 extends through completion of Stage C.

### IN (included)

- Dedicated UI for the permission dialog (structured display of sender / receiver /
  kind / full payload / meta)
- Opt-in “allow everything from this point in this conversation” (a whitelist per
  conversation_id, valid within the session)
- Refactor: consolidate the envelope validation and quota-monitoring logic
  duplicated in Stage B at the sites of duplication
- Decide whether to begin kaoiro issue #18 (message filtering)

### OUT (Stage D onward)

- Persistent whitelist (surviving process restarts)
- Fully automatic approval (quota as the only mechanical guard)
- Selecting the other party through autonomous decisions

### Completion criteria

- Ensure enough information in the permission dialog that approval does not have
  to be given without reading the message contents
- Repeated approvals in the same conversation proceed from “click every time” to
  “initial consent”
- Stage B's E2E still passes after the refactor

## Future — Stage D / Phase 3 (after #87)

Await the conclusion of kaoiro issue #87 (research into the design of cooperative
communication among multiple AI agents). Points of consideration:

- Boundary of unattended operation using automatic approval + quota/cooldown
- Autonomous decisions (human broker / automatic routing)
- Operating rules for consensus / consent / majority vote / tie-breaker
- Automatic escalation rules for the conversation owner concept
- Implementation of kaoiro issue #18 (message filtering)

Beginning Phase 3 is outside this plan's scope. Once the policy for #87 is
settled, create it as a separate plan (or an addendum to this plan).

## Progress log

- 2026-08-02: Closed by the master's decision (status: done). Basis:
  - Stages A/B are implemented and operating (`send_to_agent` /
    [protocol-inter-agent spec](../specs/protocol-inter-agent.md); the originating
    issue #17 is closed)
  - The unfinished parts of Stage C (approval relaxation such as the conversation
    whitelist) were carried forward early into F2 of
    [ADR-0044](../adr/0044-coordination-injection-hitl.md) (option B finalized and
    implemented in issue #165 on 2026-08-09)
  - Stage D (autonomous decisions onward) is explicitly outside this plan's scope
    and is tracked by issue #87 (cooperative-design research, open), issue #18
    (message filtering, open), and ADR-0044

## References

- [protocol-inter-agent spec](../specs/protocol-inter-agent.md) (mechanical
  envelope definition to be created in follow-up work)
- [protocol spec](../specs/protocol.md) — Existing common envelope foundation
- [ADR-0010 protocol-precisification](../adr/0010-protocol-precisification.md)
- [ADR-0019 subagent/workflow entity and task envelope](../adr/0019-subagent-workflow-entity-and-task-envelope.md) — Reference for existing envelope naming conventions
- kaoiro issue #17 — Main inter-agent messaging work (origin of this plan)
- kaoiro issue #18 — Message filtering (input for decisions from Stage C onward)
- kaoiro issue #87 — Research into cooperative communication design among multiple
  AI agents (organizing prerequisites for Stage D onward)
