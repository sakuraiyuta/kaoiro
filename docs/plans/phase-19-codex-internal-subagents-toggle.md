---
title: Phase 19 — Codex internal sub-agent toggle と peer-routing contract
description: runner の codex.internal_subagents で Codex 内部サブエージェントを無効化可能にし、固有名 peer と内部サブエージェントの取り違えを footer/tool description/spec の soft guard で抑止する。
status: done
phase: 19
depends_on: [14]
last_updated: 2026-07-15
---

# Phase 19 — Codex internal sub-agent toggle と peer-routing contract

## Goal

[ADR-0038](../adr/0038-codex-internal-subagents-toggle.md) を実装する。Codex の
内部サブエージェント spawn を runner option `codex.internal_subagents` で
無効化可能にし(既定は有効のまま)、固有名で共同作業を指示された相手を
既存 kaoiro peer として解決させる routing contract を soft guard として
footer / tool description / spec に同期する。

責務分離: kaoiro repo は runner config 中継・host `features.multi_agent`・
routing contract・provenance を扱う。Codex harness 側の hard guard
(PreToolUse block)は Codex 0.144.1 では不能のため対象外(ADR-0038 F4)。
Codex 個人設定の tracked 管理(`dotfiles/codex`)は settings repo 側。

## Acceptance Criteria

- [x] `runner/src/config.ts` の `CodexConfig` に `internal_subagents?: boolean`。
      厳密 boolean 検証、未指定は undefined(effective default = true)。
- [x] `protocol/src/index.ts` の `WrapperConfig` に `codex_internal_subagents?`。
      `wrapper/core/src/persona.ts` で wrapper 側 parse。
- [x] `runner/src/cli.ts` / `runner/src/supervisor.ts` が chatgpt_plan と同経路で
      spawn / reload 時に値を中継。
- [x] `wrapper/codex/src/host.ts` が effective(= configured ?? true)を常に
      per-run config の `features.multi_agent` へ注入(true=有効 / false=無効 /
      未指定=default true 明示)。runner option を user-global config より上位に。
- [x] live reload は新規 spawn にのみ反映、既存 child は kill しない(test)。
- [x] common footer(`persona_assets.ex`)/ inter-agent tool description
      (`inter_agent.ts`)/ spec(`protocol-inter-agent.md`)へ routing contract
      を同期。
- [x] provenance backstop は既存 `inter_agent_message` envelope + observation
      path + 既存 test で充足(ADR-0038 F5)。新規機構なし。
- [x] unit/integration test: config parse(未指定/true/false/型不正)、supervisor
      reload、persona parse、host features 注入(false / true・未指定)、footer
      contract、tool description contract。
- [x] settings repo: `dotfiles/codex` tracked source + `install.codex.sh` +
      `install.dotfiles.sh` 除外 + README/.gitignore/ADR-0013(settings 側)。
- [x] 変更関連の typecheck / test / format が pass(commit は藤レビュー後)。
      full server suite は既知 #115(InterAgentHistory の DETS 固定 path 非分離)
      の 1 件のみ fail で、本変更とは非回帰(server 変更は persona_assets の
      footer のみ)。

**2026-08-08 注記:** この #115 は phase-19 完了時点の検証記録である。
`InterAgentHistory` DETS は [ADR-0051](../adr/0051-history-restart-resilience.md)
に基づく phase 30-7 で撤廃予定であり、現在の durability 設計を示すものではない。

## Tasks

| # | 対象 | 状態 |
|---|------|------|
| 19-1 | runner config + WrapperConfig 中継(config/protocol/cli/supervisor/persona) | ✅ |
| 19-2 | wrapper/codex host `features.multi_agent` 注入 | ✅ |
| 19-3 | routing contract(footer / inter_agent description / spec) | ✅ |
| 19-4 | provenance backstop 検証(test/docs で証明、最小変更) | ✅ |
| 19-5 | docs(ADR-0038 / 本 plan / runner README / example config) | ✅ |
| 19-6 | unit/integration tests | ✅ |
| 19-7 | settings: dotfiles/codex + install.codex.sh + settings ADR-0013 | ✅ |
| 19-8 | 両 repo verify + 藤レビュー | ✅ |

## Notes

- 実装は kaoiro peer 間 delegation でクロエが実施、藤がレビュー・Git 判断を担う
  (2026-07-15)。commit / push / branch / installer 実行はレビュー後。
- settings repo の無関係な既存差分(`neovim/init.lua` / `scripts/nvr.sh`)には
  非接触。Codex 設定関連ファイルのみ触れる。
- 検証記録: runner 141 pass / wrapper core55・agent-common82・codex80・
  claude-code175 pass / 両 typecheck clean / install.codex.sh shellcheck clean /
  git diff --check clean。server は persona_assets 12/12(footer contract test
  含む)、full mix test 405/406 — 唯一の fail は wrapper_channel_test:523 の
  `InterAgentHistory.list_for`(DETS 固定 path `System.tmp_dir()/…dets` 非分離 =
  既知 #115)で、本変更と無関係の非回帰。review cycle は round1 medium /
  round2 small とも findings 0。

**2026-08-08 注記:** 上記は当時の試験結果であり、`InterAgentHistory` の
撤廃方針は [ADR-0051](../adr/0051-history-restart-resilience.md) D3 を参照する。
