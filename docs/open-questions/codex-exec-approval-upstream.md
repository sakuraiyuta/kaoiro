---
title: Tracking upstream support for the Codex exec approval flow
description: The wrapper explicitly configures non-interactive Codex exec approvals. Track upstream approval-request support and redesign kaoiro's Codex approval UX when it becomes available.
status: open
urgency: low
blocks: []
opened: 2026-07-10
decided: null
---

## Background

The wrapper configures `approvals_reviewer="user"` on the Codex SDK client and
`approvalPolicy="never"` on every new or resumed thread. Both become CLI
`--config` overrides, which take precedence over host `config.toml` defaults
([configuration precedence](https://learn.chatgpt.com/docs/config-file/config-basic#configuration-precedence)).
An unconfigured `codex exec` must not be assumed to force `never`: host
`approvals_reviewer="auto_review"` can change its effective approval policy to
`on-request` ([upstream report](https://github.com/openai/codex/issues/36570)).

The SDK/exec path has no approval-request callback wired into kaoiro. Codex-agent
permissions therefore expose sandbox and network controls with approval fixed
to `never` ([ADR-0033](../adr/0033-permission-model-dual-axis.md)). The wrapper
checks rollout observations against that contract and blocks further execution
on a mismatch. Such a permission gate can produce `waiting_permission`; it is
not an interactive tool-approval channel.

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
