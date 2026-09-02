---
title: Phase 14 — Codex Adapter Implementation
description: Implement an @openai/codex-sdk-compatible EngineAdapter in wrapper/codex. Includes the dual-axis permission envelope extension, engine selector UI, engine resolution in the runner launcher, and moving inter-agent tools into the common Tool description layer.
status: done
phase: 14
depends_on: [phase-13-wrapper-multipackage-restructure]
last_updated: 2026-07-11
---

# Phase 14 — Codex Adapter Implementation

## Goal

Implementation phase for F2–F9 of [ADR-0032](../adr/0032-codex-adapter.md).
Complete the `wrapper/codex` adapter wrapping `@openai/codex-sdk` 0.144.1 and
implement engine resolution in the runner launcher, the dashboard engine
selector, the dual-axis permission envelope extension, moving inter-agent tools
into the common Tool description layer, a custom AskUserQuestion tool, engine
separation for resume, and engine-specific model/effort UI end to end. The goal
is a working Codex adapter across representative personas (fuji / kuroe / ao /
momo) and major features.

## Acceptance Criteria

(Revised 2026-07-10: Former Q2/Q3/Q5/Q6 were resolved through real SDK
verification + spec elicitation. The decisions are reflected in
[ADR-0032](../adr/0032-codex-adapter.md) / [ADR-0033](../adr/0033-permission-model-dual-axis.md) /
[codex-sdk-events](../specs/codex-sdk-events.md), and these criteria assume them.)

- [x] `wrapper/codex` implements the `EngineAdapter` interface and can be driven end to end through `thread.runStreamed()` / `codex.resumeThread(id)` (a process model that spawns `codex exec` every turn).
- [x] Agent-level `ext.permission = {sandbox, approval}` from F1 of [ADR-0033](../adr/0033-permission-model-dual-axis.md) is carried in the envelope. The Claude six-mode → dual-axis mapping table (F2) is implemented in `wrapper/claude-code`, and `ext.permission_mode` is colocated for one release as a backward-compatibility window.
- [x] Dashboard permission displays (AgentCard / AgentDetail) are dual-axis badges derived from `ext.permission`, and the controls are engine-native (Claude = mode selector, Codex = sandbox selector + network toggle, with a dual-axis equivalent label; ADR-0033 F4).
- [x] Inter-agent tools (`mcp__kaoiro__send_to_agent` / `list_agents` / `whoami`) are moved into the common Tool description layer and can be called from both Claude (in-process MCP) and Codex (bundled MCP bridge, ADR-0032 F5).
- [x] The Codex equivalent of AskUserQuestion (`ask_user_question`, through the MCP bridge) works, questions reach the operator, and `waiting_question` is established. Claude native behavior is unaffected.
- [x] An `engine` field is added to `SpawnRequest` / `SpawnMessage`, and the runner launcher resolves `engine → wrapper パッケージ (@kaoiro/claude-code | @kaoiro/codex)`.
- [x] The LaunchDialog engine selector is enabled (shown only when the host has two or more `capabilities`). The three-step engine selection → model list → optional effort selection works (Codex has an empty model catalog = use the account default model; verified on real hardware 2026-07-11; F4bc of [ADR-0032](../adr/0032-codex-adapter.md)).
- [x] Values in the capabilities field are renamed to `claude-code` / `codex`. The old `claude` value is silently normalized + given a deprecation warning for one release (ADR-0032 F4a).
- [x] Engine-specific session enumeration works: the Claude adapter enumerates existing JSONL files, while the Codex adapter matches `session_meta.cwd` in `~/.codex/sessions/**/rollout-*.jsonl` (ADR-0032 F8).
- [x] Personas work on the Codex adapter and reproduce the Claude version's tone and manner equivalently (former Q1 resolved, verified on real hardware 2026-07-11). As contrasting examples, two personas were confirmed live: kuroe (calls the user “master,” secretary tone) / ao (first person “I,” plain style, concise). Injection uses `developer_instructions` through the common path for all personas, so fuji / momo use the same mechanism. No interference from the built-in `personality` config.
- [x] Reflect the cwd at the time the Codex adapter starts in `ext.cwd` (tracking remains best-effort; [Q4](../open-questions/codex-cwd-extraction.md) continues at low priority).
- [x] All server / dashboard regression tests pass. All wrapper tests pass.

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 14-1 | Add the `@openai/codex-sdk` dependency to `wrapper/codex` and implement the adapter itself with the `EngineAdapter` interface | ✅ | Convert runStreamed events → common AdapterEvent. Process model that spawns exec every turn ([codex-sdk-events](../specs/codex-sdk-events.md)) |
| 14-2 | Verify the ThreadEvent → common AdapterEvent mapping on a real turn and promote `codex-sdk-events.md` to accepted | ✅ | Spec updated based on actual types on 2026-07-10; real-turn confirmation after authentication remains |
| 14-3 | Add `ext.permission = {sandbox, approval}` from ADR-0033 F1 to `@kaoiro/protocol` | ✅ | Colocate `permission_mode` for one release window (D-A) |
| 14-4 | Implement the Claude six-mode → dual-axis mapping table in `wrapper/claude-code` (ADR-0033 F2 table) | ✅ | Implement it in the mapping-table placeholder created in phase-13 |
| 14-5 | Project the Codex adapter's fixed sandbox + `approval: "never"` at spawn time into `ext.permission` | ✅ | ADR-0033 F3. waiting_permission does not occur in Codex |
| 14-6 | Complete the common Tool description layer (JSON Schema + handler pair) and move the inter-agent tools | ✅ | Move current `wrapper/src/inter_agent.ts` to `wrapper/agent-common`; both Claude / Codex use the same handler |
| 14-6b | Implement the stdio MCP bridge bundled with `@kaoiro/codex` (connect to the wrapper over a unix socket; register through the `mcp_servers.kaoiro` config override) | ✅ | Revised ADR-0032 F5. Assumes codex spawns the bridge every turn |
| 14-7 | Provide Codex's `ask_user_question` through the MCP bridge and normalize it to a question_request envelope | ✅ | Claude native behavior unaffected; confirm waiting_question works |
| 14-8 | Add an `engine` field to `SpawnRequest` / `SpawnMessage` and update `@kaoiro/protocol` types | ✅ | Verify by matching server-side `capabilities` |
| 14-9 | Change the runner launcher (`runner/src/spawn.ts`) to resolve `engine → wrapper パッケージ` | ✅ | The `KAOIRO_WRAPPER_DEV=1` path also branches by engine |
| 14-10 | Add an engine selector to the dashboard LaunchDialog (only when there are two or more capabilities) | ✅ | Continue preserving the current UX when there is only one |
| 14-11 | Reconfigure the dashboard LaunchDialog as three-step engine → model → optional effort selection | ✅ | The engine adapter returns the model / effort lists. Codex uses a curated static catalog (ADR-0032 F4bc) |
| 14-12 | Update the dashboard permission UI: dual-axis badges from `ext.permission`, engine-native selector + dual-axis equivalent label for controls (ADR-0033 F4) | ✅ | Do not adopt a preset layer (decision 2026-07-10) |
| 14-13 | Rename capabilities field values (`claude` → `claude-code`) and implement one-release normalization + warning for the old value | ✅ | ADR-0032 F4a. Strict rejection in the next release |
| 14-14 | Implement Codex-side session enumeration and resume (match `session_meta.cwd` in `~/.codex/sessions/**/rollout-*.jsonl`) | ✅ | Method finalized in ADR-0032 F8 |
| 14-15 | Q1 verification: tone and manner reproduction test with persona × Codex adapter | ✅ | Real-hardware verification 2026-07-11. Live confirmation of two representative personas (kuroe / ao); injection uses the common path for all personas. Former open question closed |
| 14-16 | Reflect cwd at startup on the Codex side (tracking remains best-effort; Q4 continues) | ✅ | Minimal implementation that places startup cwd in `ext.cwd` (the wrapper stamps it because thread.started has no cwd) |
| 14-17 | Add follow-ups to plugin-model.md / architecture.md / personas.md (reflect spec changes tied to docs/plans, such as documenting F3) | ✅ | protocol.md / codex-sdk-events.md updated 2026-07-10; bundle the rest immediately before phase completion |
| 14-18 | Confirm all wrapper / server / dashboard / runner tests pass | ✅ | Regression health maintained in two stages: phase-13 and this phase |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## Followups (in-phase but unfinished)

- [Q4 codex-cwd-extraction](../open-questions/codex-cwd-extraction.md) — Treat phase-14 as complete with startup-only reflection because cwd change tracking is best-effort; continue dynamic tracking at low urgency.
- [codex-exec-approval-upstream](../open-questions/codex-exec-approval-upstream.md) — Codex interactive approval awaits upstream stabilization of `exec_permission_approvals`. Complete this phase with fixed dual axes at startup.

## Open Questions Blocking This Phase

None (all closed). Former Q1 (personality injection effectiveness) was closed by real-hardware verification on 2026-07-11; former Q2 (envelope schema) / Q3 (UI vocabulary) / Q5 (model catalog) / Q6 (compatibility window) were resolved and closed through real SDK verification + spec elicitation on 2026-07-10 (decisions added to [ADR-0032](../adr/0032-codex-adapter.md) / [ADR-0033](../adr/0033-permission-model-dual-axis.md)). The only low-priority ongoing tracking is Q4 / codex-exec-approval-upstream in Followups above.

## See Also

- Specs covered: [plugin-model](../specs/plugin-model.md), [protocol](../specs/protocol.md), [personas](../specs/personas.md), [architecture](../specs/architecture.md), [codex-sdk-events](../specs/codex-sdk-events.md) (new)
- Related ADRs: [ADR-0032](../adr/0032-codex-adapter.md) (main ADR for this phase), [ADR-0033](../adr/0033-permission-model-dual-axis.md) (dual-axis permissions), [ADR-0027](../adr/0027-askuserquestion-envelope.md) (question envelope), [ADR-0014](../adr/0014-session-resume-and-restore.md) (resume separation), [ADR-0031](../adr/0031-runner-persona-trust-mode.md) (compatibility-window pattern)
- Previous phase: [phase-13-wrapper-multipackage-restructure](phase-13-wrapper-multipackage-restructure.md)
