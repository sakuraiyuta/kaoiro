---
title: Phase 3.5 — Response Display (Making the Bundled Dashboard Usable)
description: Relay and display agent response text, making the bundled dashboard minimally useful on its own. Default tile list → detail view.
status: done
phase: 3.5
depends_on: [phase-3-server-multiagent]
last_updated: 2026-07-03
---

# Phase 3.5 — Response Display (Making the Bundled Dashboard Usable)

## Goal

Relay and display responses to instructions (agent response text) to eliminate the
state where “the instruction arrives but its answer cannot be seen”. The default is
a tile list, with a click opening a full-screen detail view (response log). The
direction and boundaries are defined by [ADR-0012](../adr/0012-response-display-and-dashboard-scope.md).

## Acceptance Criteria

- [x] Responses use a chat-like `log` stream (`assistant` sequentially + tool I/O
      collapsible/expandable)
- [x] Response logs are restored after reload/reconnect (server in-memory history A)
- [x] Only operators can view response logs (viewers stop at the grid)
- [x] Notice when another agent needs attention even in full-screen detail (blind-spot indicator)
- [x] Send an instruction to any one agent → read its response in the bundled dashboard (end-to-end)
      — implementation complete (all-layer tests green). Real-machine E2E accepted through
      daily dogfooding (2026-07-03, operator confirmation).

## Tasks

### Stage MVP (issue #13 resolved)

| # | Task | Status | Notes |
|---|------|--------|-------|
| R-1 | protocol: reserve → define `log`/`result` payloads and deliver to operators only | ✅ | [protocol](../specs/protocol.md). `log.kind` = assistant/tool_use/tool_result |
| R-2 | wrapper: relay assistant text, tool_use/tool_result, and result | ✅ | SDK message → `log` type mapping is in [agent-sdk-events](../specs/agent-sdk-events.md). `d5d120c` |
| R-3 | server: in-memory ring-buffer history in `AgentStates`, snapshot + history on join, operator-role filter for log/result | ✅ | No new DB dependency. Persistence is issue #24. `7410d68`/`f7af05f` |
| R-4 | dashboard: grid → click → full-screen detail (chat-like log, collapsible tools, instruction, approval, blind-spot indicator) | ✅ | Cards display face, name, state, and agent_id (instruction input removed 2026-06-16). Instruction and approval operations are in detail. `8319576` |

MVP implementation complete (wrapper 68 / server 70 / dashboard 13 tests green).
Each review-cycle stage was completed. Three surfaced security issues were implemented
in #26/#28 (`0e81680`).

# 27 remains a candidate for deferral. Real-machine E2E was accepted through dogfooding
(2026-07-03). Only Stage Polish (issue #21) remains.

### Stage Polish (issue #21 = game-like UI)

| # | Task | Status | Notes |
|---|------|--------|-------|
| R-5 | Tile → detail animation/morph transition | ⏳ | A simple transition is acceptable in the MVP |
| R-6 | Polish the Wizardry-style border UI | ⏳ | issue #21 |
| R-7 | Tune the blind-spot indicator color's most-urgent precedence | ⏳ | error > waiting_permission > other |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## Followups (in-phase but unfinished)

- Persisting history to disk (resilience across redeployments) is issue #24 (including specification).
- Three-column grid + latest-response timeline is issue #25.
- Claude Code-specific token/context visualization is issue #16 (through `ext`).

## Open Questions Blocking This Phase

None (resolved by [ADR-0012](../adr/0012-response-display-and-dashboard-scope.md)).

## See Also

- ADRs: [0012](../adr/0012-response-display-and-dashboard-scope.md),
  [0007](../adr/0007-client-separation-reference-dashboard.md),
  [0010](../adr/0010-protocol-precisification.md)
- Specs: [protocol](../specs/protocol.md),
  [non-goals](../specs/non-goals.md),
  [threat-model](../specs/threat-model.md)
- Previous: [phase-3-server-multiagent](phase-3-server-multiagent.md)
