---
title: Codex exec contract evidence
status: accepted
last_updated: 2026-09-18
---
<!-- markdownlint-disable MD033 -->

# Codex exec contract evidence

This page preserves the dated record from the pre-migration specification.
The stated versions, dates, observations, and limits have not been re-measured
by the documentation move.

## Live verification notes (2026-07-11, ChatGPT-plan authentication)

Three points found by starting real Codex agents (kuroe / ao) from the dashboard
and incorporated in implementation:

- **Model catalog is account default only (former; updated in phase-16)**:
  Under ChatGPT-plan authentication, every explicit `model` selection was
  rejected with 400/404 (the bundled catalog was for API keys), accepted models
  were account-dependent and could not be enumerated from the SDK. kaoiro made
  the Codex model catalog empty and omitted `model` to use the account default
  ([ADR-0032](../../adr/0032-codex-adapter.md) F4bc). → **phase-16 update
  (2026-07-13, [ADR-0035](../../adr/0035-codex-model-catalog-and-mid-session-switch.md))**:
  Restore the catalog through an operator declaring `codex.chatgpt_plan` in
  `runner.config.json`; present Sol / Terra / Luna in LaunchDialog for Plus and
  above, and accept mid-session switching (for the mid-session-switch envelope
  contract, see `ext.pending_model` / `ext.effective` / `ext.switch_error` in
  [protocol](../../specs/protocol.md); for Codex catalog details, see
  [codex-model-catalog](../../reference/engines/codex-model-catalog.md)).
- **MCP tools need auto-approval**: Under `codex exec` approval_policy=never,
  an MCP tool call defaults to “user cancelled MCP tool call.” Set
  `mcp_servers.kaoiro.default_tools_approval_mode: "approve"` to auto-approve
  kaoiro tools only ([ADR-0032](../../adr/0032-codex-adapter.md) F5).
- **Envelope ordering for waiting_question**: Because the Codex adapter
  synchronously emits `state_change(waiting_question)` through
  `setPendingQuestion`, `QuestionBroker` sends the `question_request`
  notification **before** `onPendingChange`. Otherwise `question_request`
  without ext overwrites dashboard render state: no question dialog appears and
  the engine badge also disappears. Claude is unaffected because
  `setPendingQuestion` only stamps, while state_change is emitted separately.
- **Effectiveness of persona injection**: kuroe (calls the user “Master,”
  secretary manner) and ao (first-person “watashi,” plain style, concise) were
  clearly differentiated, confirming that `developer_instructions` injection
  works faithfully per persona (former Q1 closed). No interference with built-in
  `personality` configuration was observed, so `none` was unnecessary.


## Migration links

- [Exec event contract](../../reference/engines/codex-exec-events.md)
