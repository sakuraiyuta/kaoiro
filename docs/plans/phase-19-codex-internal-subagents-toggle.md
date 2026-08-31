---
title: Phase 19 — Codex Internal Sub-Agent Toggle and Peer-Routing Contract
description: Make Codex internal sub-agents disableable through runner codex.internal_subagents, and suppress confusion between named peers and internal sub-agents with soft guards synchronized across the footer, tool description, and spec.
status: done
phase: 19
depends_on: [14]
last_updated: 2026-07-15
---

# Phase 19 — Codex Internal Sub-Agent Toggle and Peer-Routing Contract

## Goal

Implement [ADR-0038](../adr/0038-codex-internal-subagents-toggle.md). Make Codex
internal sub-agent spawning disableable through the runner option
`codex.internal_subagents` (enabled by default), and synchronize the routing
contract that resolves a named collaboration target as an existing kaoiro peer
across the footer, tool description, and spec as soft guards.

Responsibility split: the kaoiro repo handles runner config relay, host
`features.multi_agent`, the routing contract, and provenance. The Codex harness
hard guard (PreToolUse block) is not possible in Codex 0.144.1 and is out of
scope (ADR-0038 F4). Tracked management of Codex personal settings
(`dotfiles/codex`) belongs to the settings repo.

## Acceptance Criteria

- [x] `runner/src/config.ts` has `internal_subagents?: boolean` in `CodexConfig`.
      Validate strict booleans; unspecified is undefined (effective default = true).
- [x] `protocol/src/index.ts` has `codex_internal_subagents?` in `WrapperConfig`.
      Parse it on the wrapper side in `wrapper/core/src/persona.ts`.
- [x] `runner/src/cli.ts` / `runner/src/supervisor.ts` relay the value through the
      same path as chatgpt_plan on spawn / reload.
- [x] `wrapper/codex/src/host.ts` always injects the effective value
      (configured ?? true) into `features.multi_agent` in the per-run config
      (true=enabled / false=disabled / unspecified=explicit default true).
      The runner option takes precedence over user-global config.
- [x] Live reload applies only to new spawns and does not kill existing children
      (test).
- [x] Synchronize the routing contract into the common footer
      (`persona_assets.ex`), inter-agent tool description (`inter_agent.ts`), and
      spec (`protocol-inter-agent.md`).
- [x] The provenance backstop is satisfied by the existing `inter_agent_message`
      envelope + observation path + existing tests (ADR-0038 F5). No new
      mechanism.
- [x] Unit/integration tests: config parse (unspecified/true/false/invalid type),
      supervisor reload, persona parse, host feature injection (false / true and
      unspecified), footer contract, and tool-description contract.
- [x] Settings repo: tracked `dotfiles/codex` source + `install.codex.sh` +
      `install.dotfiles.sh` exclusion + README/.gitignore/ADR-0013 (settings side).
- [x] Related typecheck / test / format pass (commit after Fuji review).
      The full server suite has one known failure, #111 (InterAgentHistory's
      DETS fixed path is not isolated), and this change is non-regressive (the
      server change is only the persona_assets footer).

**Note from 2026-08-08:** This #111 is a verification record from the point at
which phase 19 was completed. `InterAgentHistory` DETS was removed in phase
30-7 based on [ADR-0051](../adr/0051-history-restart-resilience.md), and does
not describe the current durability design.

## Tasks

| # | Target | Status |
|---|------|------|
| 19-1 | runner config + WrapperConfig relay (config/protocol/cli/supervisor/persona) | ✅ |
| 19-2 | wrapper/codex host `features.multi_agent` injection | ✅ |
| 19-3 | routing contract (footer / inter_agent description / spec) | ✅ |
| 19-4 | provenance backstop verification (prove it in tests/docs, minimal change) | ✅ |
| 19-5 | docs (ADR-0038 / this plan / runner README / example config) | ✅ |
| 19-6 | unit/integration tests | ✅ |
| 19-7 | settings: dotfiles/codex + install.codex.sh + settings ADR-0013 | ✅ |
| 19-8 | verify both repos + Fuji review | ✅ |

## Notes

- Implementation was performed by Chloe through kaoiro peer delegation; Fuji
  handled review and Git decisions (2026-07-15). Commit / push / branch /
  installer execution followed review.
- Do not touch unrelated existing changes in the settings repo
  (`neovim/init.lua` / `scripts/nvr.sh`). Touch only Codex-settings-related
  files.
- Verification record: runner 141 pass / wrapper core 55, agent-common 82,
  codex 80, claude-code 175 pass / both typechecks clean /
  install.codex.sh shellcheck clean / git diff --check clean. Server:
  persona_assets 12/12 (including the footer contract test), full mix test
  405/406—the sole failure is wrapper_channel_test:523
  `InterAgentHistory.list_for` (DETS fixed path
  `System.tmp_dir()/…dets` is not isolated = known #111), a non-regression
  unrelated to this change. Both review cycles, round 1 medium / round 2 small,
  had zero findings.

**Note from 2026-08-08:** The above is a test result from that time; see D3 of
[ADR-0051](../adr/0051-history-restart-resilience.md) for the policy to remove
`InterAgentHistory`.
