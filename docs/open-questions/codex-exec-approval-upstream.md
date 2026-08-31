---
title: Tracking upstream support for the Codex exec approval flow
description: codex exec forces approval_policy to never and cannot return approval requests to the caller. Track stabilization of the upstream feature flag exec_permission_approvals (under development) and redesign kaoiro's Codex approval UX when it becomes available.
status: open
urgency: low
blocks: []
opened: 2026-07-10
decided: null
---

## 背景

Live SDK verification for [ADR-0033](../adr/0033-permission-model-dual-axis.md)
(2026-07-10) confirmed that `codex exec`
(the execution path of `@openai/codex-sdk`) forces `approval_policy=never` through
a harness override and has no approval-request event in the JSON event stream.
Therefore Codex-agent permissions use a fixed two-axis choice at spawn, and the
design does not produce `waiting_permission` for Codex.

The upstream has a feature flag `exec_permission_approvals` (under development
as of 0.144.1), so an approval flow may eventually be provided even in exec mode.
The experimental `codex app-server` (JSON-RPC over stdio) already has an
approval-request protocol.

## 選択肢

| Option | Content | Advantages | Disadvantages |
|----|------|----------|-----------|
| A | When `exec_permission_approvals` stabilizes, wire approval through SDK/exec and make `waiting_permission` work in Codex too | A published path and approval UX equal to Claude | Timing unknown |
| B | Switch to `codex app-server` and support it early | Possible immediately | Depends on an experimental protocol; high implementation cost (rejected in ADR-0033) |
| C | Permanently retain the fixed two-axis choice at startup | Zero implementation | Engine asymmetry in approval UX becomes permanent |

## 影響

None (the current design is complete with fixed two-axis permissions). Track the
opportunity to improve Codex permission UX when upstream support arrives.

## 判断材料

- State of the upstream `openai/codex` `exec_permission_approvals` feature flag
  (check with `codex features list`)
- Whether an approval callback API has been added to `@openai/codex-sdk` (release
  notes)
- Stabilization status of `codex app-server`

## 暫定方針

Wait for option A. On each Codex SDK version update, check `codex features list`
and the SDK changelog; when an approval path is published, promote this open
question to an ADR and redesign.

## Actions upon resolution

- [ ] Create an ADR revising [ADR-0033](../adr/0033-permission-model-dual-axis.md)
      F3 (approval fixed to never)
- [ ] Wire an approval callback in wrapper/codex and make
      `waiting_permission` / `pending_permission` work in Codex too
- [ ] Add an approval selector to the dashboard's Codex permission UI (sandbox
      only)
- [ ] Close (delete) this open question
