---
title: Claude `value: "default"` alias の SDK 解決 semantic 実測確認
description: SDK 0.3.208 相当で `model: "default"` を Query に渡した際の `model_source` / 実効モデル解決先を実測し、`default` が account 推奨モデルに写像されるという ADR-0037 の前提を確定する。
status: open
urgency: high
blocks: [phase-18-claude-model-catalog-live]
opened: 2026-07-14
decided: 2026-07-14
---

## 背景

[ADR-0037](../adr/0037-claude-model-catalog-live-refresh.md) の中間解は、
BOOTSTRAP を `default` 1 エントリのみの最小 floor に縮小することを核とする。
この判断は「`default` alias は SDK 側 semantic として "account 推奨モデル" を
指す名前解決であり永久に腐らない」という前提に強く依存する。

一方でこの前提は、現時点で kaoiro 側の運用実績 (BOOTSTRAP に `default`
エントリが存在してきた事実) からの類推であり、`@anthropic-ai/claude-agent-sdk`
の公式ドキュメントで文書化された保証を確認できていない。SDK 0.3.208 相当
(phase-18-1 upgrade 後) で `model: "default"` を Query に渡した際に、実際に
account 推奨モデル (現時点では `claude-opus-4-8` 相当) に解決されるかを実測で
検証する必要がある。

前提が崩れる場合、中間解自体が再検討対象となり、ADR-0037 を revise または
supersede する必要がある。

## 選択肢

| 案 | 内容 | メリット | デメリット |
|----|------|----------|-----------|
| A | SDK 実測で `default` が account 推奨モデル (Opus 4.8 相当) に解決されることを確認 | ADR-0037 の前提成立、中間解を予定通り実装 | 実測の代表性 (account / plan / team 依存) を今後も監視する必要 |
| B | SDK 実測で `default` が想定と異なる挙動 (別モデル解決 / エラー / 400 等) を示す | 前提の誤りを早期発見できる | ADR-0037 を revise or supersede、実装計画を再構築 |

## 影響

- **blocks**: [phase-18-claude-model-catalog-live](../plans/phase-18-claude-model-catalog-live.md)
  の Phase 18-3 (BOOTSTRAP 縮小 PR) 着手前に確定必須
- **blocks**: [ADR-0037](../adr/0037-claude-model-catalog-live-refresh.md) 本文の前提節。
  案 B に落ちた場合、ADR を revise or supersede

## 判断材料

- SDK 0.3.208 相当を kaoiro dev 環境で起動し、`AgentHost` init 後の
  `#refreshSupportedModels()` の返り値と、`model: "default"` を渡したときの
  実際の `model_source` / 実効モデル文字列を取得
- 可能なら `@anthropic-ai/claude-agent-sdk` の release notes / API doc で `default`
  alias の semantic 記述を並行確認
- account 差 (`ANTHROPIC_API_KEY` vs Claude subscription 経由) で解決先が変わる
  可能性があれば併記

## 暫定方針

案 A を仮説として ADR-0037 の記述と phase-18 の plan を策定した。Phase 18-2
(実測タスク) で確定 or 却下する。案 B が確定した時点で、Phase 18-3 着手前に
マスターへ報告し ADR revise / supersede の判断を仰ぐ。

## 実測結果 (2026-07-14、Phase 18-2)

SDK `@anthropic-ai/claude-agent-sdk 0.3.208` を kaoiro dev 環境で起動し、
`query({ prompt, options: { model: "default", canUseTool: deny-all } })` の
init 直後に `query.supportedModels()` を呼び出して返り値を dump した (一時
probe script、実行後破棄)。

### 判定: **案 A 確定**

`value: "default"` の row が実測配列に存在し、`resolvedModel` field で
`"claude-opus-4-8[1m]"` (現時点の account 推奨モデル) に解決されることを
確認。ADR-0037 F1 (BOOTSTRAP を `default` 1 エントリのみに縮小) の前提が
成立、Phase 18-3 の gate は unblock。

### 実測 dump 抜粋

```json
{
  "value": "default",
  "resolvedModel": "claude-opus-4-8[1m]",
  "displayName": "Default (recommended)",
  "description": "Opus 4.8 with 1M context · Best for everyday, complex tasks",
  "supportsEffort": true,
  "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"],
  "supportsAdaptiveThinking": true,
  "supportsFastMode": true,
  "supportsAutoMode": true
}
```

### 併せて観測された事実 (Phase 18-3 以降で扱う)

1. **BOOTSTRAP snapshot の drift 実証**: 実測配列は `default` / `opus[1m]`
   / `claude-fable-5[1m]` / `sonnet` (resolvedModel: `claude-sonnet-5`) /
   `haiku` の 5 エントリのみ。BOOTSTRAP に含まれていた `sonnet[1m]` と
   `claude-opus-4-7` は SDK 側で既に消滅。Sonnet 5 は SDK 側追従済み。
2. **`ModelInfo` 拡張フィールドの追加**: `resolvedModel`, `supportsEffort`,
   `supportsAdaptiveThinking`, `supportsFastMode`, `supportsAutoMode` が
   SDK 側で新規追加。現行 `#refreshSupportedModels()` の mapping
   (`host.ts:1237-1244`) は既存 4 field のみを転写しており、拡張 field は
   projection されない。UI 表示への反映は Phase 18-9 / 18-10 で判断。
3. **default の `effort_levels`**: 実測でも 5 段階 (`low` / `medium` /
   `high` / `xhigh` / `max`) を返しており、ADR-0037 F5 (FULL_EFFORT を
   仮出し) と整合。

## 解決時のアクション

- [x] Phase 18-2 の実測結果を本ファイルの「実測結果」節として追記
- [ ] 案 A 確定 (本節): [ADR-0037](../adr/0037-claude-model-catalog-live-refresh.md)
      の Context 節に実測根拠を追記、本 open-question は Phase 18-3 commit
      と同時に削除
- [ ] 本 open-question を close (削除)
