---
title: Phase 18 — Claude モデル catalog live 実測一元化と bootstrap default floor
description: BOOTSTRAP を default 1 エントリに縮小、Claude live 経路を SDK 実測に一元化、retry 契約を実装する。
status: in-progress
phase: 18
depends_on: []
last_updated: 2026-07-14
---

# Phase 18 — Claude モデル catalog live 実測一元化と bootstrap default floor

## Goal

[ADR-0037](../adr/0037-claude-model-catalog-live-refresh.md) を実装し、Anthropic
の新モデル追加 (Sonnet 5 等) に BOOTSTRAP snapshot 手動更新なしで追従できる形へ
Claude 側 catalog を再構成する。BOOTSTRAP は `default` 1 エントリのみの最小 floor
に縮小し、`ext.models` 経路は SDK 実測を単一の source of truth とする。

実装は 3 段階に分け、SDK upgrade → wrapper 改修 → client UI 対応の順で PR を
分割する。Phase 18-2 の実測で ADR-0037 の前提 (default alias が account 推奨
モデルに解決される) は追認済み (2026-07-14、詳細は
[ADR-0037](../adr/0037-claude-model-catalog-live-refresh.md) の Context 節)。

## Acceptance Criteria

- [x] `wrapper` package の `@anthropic-ai/claude-agent-sdk` が最新 (0.3.208 相当以上)
      にアップグレードされ、既存 test suite が pass する
- [x] `supportedModels()` の実測結果 (SDK upgrade 後) を記録し、
      `model: "default"` を渡した際の `model_source` と実効モデル解決先が
      [ADR-0037](../adr/0037-claude-model-catalog-live-refresh.md) の
      Context 節に反映される
- [x] Q1 の実測結果が「`default` は account 推奨モデルに解決される」を確認できる
      (or ADR-0037 の再検討が必要な場合はマスターへ報告)
- [x] `wrapper/claude-code/src/catalog.ts` の `BOOTSTRAP` が `default` 1 エントリの
      みに縮小され、`display_name: "Default (recommended)"` + neutral description で
      具体モデル名を引かない記述となる (`effort_levels` は FULL_EFFORT を維持)
- [ ] `#refreshSupportedModels()` に自動 bounded retry (上限 3 回) が実装される
- [ ] retry 上限到達時に 1 度限り toast 通知を発火する mechanism が実装される
- [ ] operator が明示的に trigger できる手動 retry control message が実装される
- [ ] persist alias validation が起動時に実行され、SDK 実測に含まれない alias は
      `default` に fallback + 通知 event 発行される
- [ ] `AgentDetail.svelte` のモデル switcher 内に「モデル一覧を再取得」ボタンが
      設置される
- [ ] toast 表示と persist alias fallback 通知の UI 実装が完了する
- [ ] `LaunchDialog.svelte` で縮小 catalog (default のみ) の launch が正常動作する
      (既存の `?? []` fallback で覆えているはず)
- [ ] wrapper 単体テスト / integration test / e2e で retry シナリオ、persist alias
      fallback シナリオ、init 後 Sonnet 5 選択 (SDK が返している前提) が pass する
- [ ] `docs/specs/plugin-model.md` の該当節 (ADR-0037 参照節) が実装確定後の内容に
      維持更新される

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 18-1 | `wrapper/package.json` の `@anthropic-ai/claude-agent-sdk` を最新 (`^0.3.208` 相当) にアップグレード | ✅ | 2026-07-14 完了 (commit 93f0e68)。resolved 0.3.187 → 0.3.208、blast radius は SDK + 8 platform binary のみ。breaking は `CanUseTool` return が `Promise<PermissionResult \| null>` へ変更、test 7 呼出しを `(await ...)!` で非 null narrow (14 line)、src (catalog.ts / host.ts) は F7 準拠で無改変 |
| 18-2 | `model: "default"` の SDK 解決 semantic を実測検証し Q1 に追記 | ✅ | 2026-07-14 完了 (commit 93f0e68 に併走)。案 A 確定 (`default` → `resolvedModel: "claude-opus-4-8[1m]"`)。bonus: BOOTSTRAP drift 実証 (`sonnet[1m]` / `claude-opus-4-7` は SDK 側消滅、Sonnet 5 追従済み)、`ModelInfo` 拡張 5 field (`resolvedModel` / `supportsEffort` / `supportsAdaptiveThinking` / `supportsFastMode` / `supportsAutoMode`) 検出。18-3 commit で open-question を削除し実測根拠を [ADR-0037](../adr/0037-claude-model-catalog-live-refresh.md) Context 節へ移設 |
| 18-3 | `wrapper/claude-code/src/catalog.ts` の BOOTSTRAP を default 1 エントリに縮小 | ✅ | 2026-07-14 完了。neutral description は `"Account-recommended model · resolved after session start"`、`effort_levels` は FULL_EFFORT 維持。`SONNET_EFFORT` は orphan として削除。連動更新: `wrapper/claude-code/test/host.test.ts` (`initialStatusExt` → `["default"]`) / `runner/test/config.test.ts` (register models → `["default"]`) / open-question 削除 + [ADR-0037](../adr/0037-claude-model-catalog-live-refresh.md) Context 節に実測根拠追記 / `docs/specs/plugin-model.md` の該当節も追随 |
| 18-4 | `#refreshSupportedModels()` に自動 bounded retry (上限 3 回) を実装 | ⏳ | 現行の `#modelsRequested` フラグを retry counter に置換、上限到達判定を追加 |
| 18-5 | 手動 retry を trigger する control message hook を追加 | ⏳ | protocol の control envelope で `refresh_models` (または相当) を追加、`host.ts` 側で receive → `#refreshSupportedModels()` を再起動 (retry counter reset) |
| 18-6 | retry 上限到達時の 1 度限り toast 通知 mechanism を実装 | ⏳ | server → client への 1 shot notification 経路。既存 `state_change.ext` の empty models + `models_error: true` flag 相当で表現可能かを検討 |
| 18-7 | persist alias validation + `default` fallback + 通知 event を実装 | ⏳ | 起動時 (session resume 経路 or spawn 時) に保存 `model` を SDK 実測と照合、不一致なら `default` に置換 + 通知。**併せて `wrapper/claude-code/src/host.ts:701-708` の pre-init validation を軟着陸させる**: 18-3 縮小後は floor 外モデルへの `setModel` が `unknown bootstrap model` throw を起こすため、F8 (persist alias fallback) 実装時に「floor 外 alias は `default` へ fallback + 通知」経路へ置換する (18-3 監督申し送り) |
| 18-8 | wrapper 単体テストの追加 / 更新 | ⏳ | BOOTSTRAP snapshot テスト更新、retry counter / 上限 / reset のテスト、persist alias fallback のテスト |
| 18-9 | `AgentDetail.svelte` のモデル switcher 内に「モデル一覧を再取得」ボタンを設置 | ⏳ | 具体的な UI 配置 (dropdown 内 inline / status バナー / 両方) は本 task の PR で確定 (ADR-0037 の Q3 相当) |
| 18-10 | toast 表示実装 (retry 失敗 / persist alias fallback) | ⏳ | 通知の粒度 (toast 1 度 / session log / 明示ダイアログ) は本 task の PR で確定 (ADR-0037 の Q4 相当) |
| 18-11 | `LaunchDialog.svelte` で縮小 catalog の動作確認 | ⏳ | 既存の `?? []` fallback で問題なく動作するはず。実測で確認 |
| 18-12 | integration test / e2e の追加 | ⏳ | retry シナリオ / persist alias fallback / init 後 Sonnet 5 選択 (SDK 側追従前提) |
| 18-13 | `docs/specs/plugin-model.md` の該当節を実装確定後の内容へ維持更新 | ⏳ | ADR-0037 の implementation 完了後、spec の記述を実態に合わせて refresh |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## Followups (in-phase but unfinished)

- `runner/test/config-watcher.test.ts` の debounce 系 2 テストは 18-1 baseline
  で既存 flake / macOS 決定論的赤として確認済み。Phase 18 とは無関係な既存
  問題として Gitea
  [issue #116](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/116)
  に外部化済み (2026-07-14)。修正案: 固定 `settle` 待ちをやめ、`onReload`
  を promise 化して条件成立を上限付き polling wait に置き換える
- Phase 18-2 の Q1 実測で SDK 側 `ModelInfo` に拡張 5 field (`resolvedModel`
  / `supportsEffort` / `supportsAdaptiveThinking` / `supportsFastMode` /
  `supportsAutoMode`) が新規追加されているのを検出済み。現行
  `#refreshSupportedModels()` (`wrapper/claude-code/src/host.ts:1237-1244`)
  は既存 4 field (`value` / `displayName` / `description` /
  `supportedEffortLevels`) のみを転写しており拡張 field は projection
  対象外。UI (switcher / toast / display) での projection 是非は Phase 18-9
  (switcher UI) / Phase 18-10 (通知実装) で判断する

## Open Questions Blocking This Phase

なし (Q1 (`claude-default-alias-sdk-semantic`) は 2026-07-14 に 18-2 実測で
**案 A 確定** し、18-3 commit で open-question を削除して実測根拠を
[ADR-0037](../adr/0037-claude-model-catalog-live-refresh.md) Context 節に
反映済み)。

## See Also

- Specs covered: [plugin-model](../specs/plugin-model.md), [protocol](../specs/protocol.md)
- 関連 ADRs: [ADR-0037](../adr/0037-claude-model-catalog-live-refresh.md) (本 phase 決定), [ADR-0032](../adr/0032-codex-adapter.md) F4bc (`EngineCapability.supportedModels()` 契約), [ADR-0034](../adr/0034-session-capabilities-advertisement.md) (session capability advertisement), [ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md) (codex 側は据え置き)
- Previous phase: [phase-17-session-lifecycle-commands](phase-17-session-lifecycle-commands.md)
