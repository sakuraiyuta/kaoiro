---
title: Codex model カタログ復活の将来対応
description: ADR-0032 F4bc で空カタログに転じた Codex adapter の supportedModels() を、認証別 catalog 供給元 / plan tier 申告 / 上流 SDK の実 model 名逆通知 のいずれかで復活させる将来対応候補を追跡する。現状 e89fa98 の「アカウント既定 (選択不可)」表示で止血済み。
status: open
urgency: low
blocks: []
opened: 2026-07-11
decided: null
---

## 背景

[ADR-0032](../adr/0032-codex-adapter.md) F4bc は 2026-07-11 実機検証で
Codex adapter の `supportedModels()` を空カタログとし model 選択を
アカウント既定に委任する判断を採った (旧 Q5 codex-model-effort-catalog
close)。理由は [codex-model-catalog](../specs/codex-model-catalog.md) に
記録: ChatGPT-account 認証で明示 model が 400/404 になり、entitled
model 集合を SDK/CLI から列挙できないため。

副次症状として **Codex agent の稼働 model が UI から一切見えない** 状態
が生じていた ([e89fa98](https://gitea.example.invalid/sakurai.yuta/kaoiro/commit/e89fa98)
で AgentDetail に「アカウント既定 (選択不可)」ラベルを追加して短期止血
完了)。本 open-question は「見えない」ではなく「選べない/追跡できない」の
本質側の将来対応候補を追跡する。

## 選択肢

| 案 | 内容 | メリット | デメリット |
|----|------|----------|-----------|
| A | **auth mode 分岐**: `codex doctor --json` の `stored auth mode` を runner 起動時に検出し、`apikey` モードでは bundled 静的カタログ (Sol/Terra/Luna/5.5/5.4/5.4-mini) を復活。`chatgpt` モードは現状維持 (アカウント既定委任) | 実装コスト小。API-key ユーザは model 選択が復活。ChatGPT-plan ユーザは追加リスク無し | Master 現行環境 (chatgpt-auth) では利益なし。plan tier 差 (Free/Go の Terra 固定 vs Plus+ の Sol/Terra/Luna) は依然埋まらない |
| B | **plan tier operator 申告**: `runner.config.json` に `codex.plan` フィールドを追加 (`free`/`go`/`plus`/`pro`/`business`/`enterprise`)。plan 別に entitled catalog を出す | plan 差を表現可能。UI から実選択できる | 誤申告で 400/404 を踏むリスク。OpenAI 側運用変更 (entitled 集合 drift) の保守が発生。plan 変更時に手動更新必要 |
| C | **上流 SDK の実 model 名逆通知待ち**: `@openai/codex-sdk` の `thread.started` / `turn.completed` に `model` フィールドが載れば post-spawn で実 model 名を back-fill 可能。upstream feature request として issue 起票 | 正確な稼働 model 名を UI 表示できる (Claude 側と対称化) | 実装コストは kaoiro 側ゼロだが、upstream に完全依存で時期不明 |
| D | **恒久的に現状維持**: e89fa98 の「アカウント既定 (選択不可)」で受容 | 実装ゼロ | Codex 側の可視性 / 選択自由度は Claude と非対称のまま |

## 影響

- 現行設計 (F4bc + e89fa98) で機能停止は無く、緊急性なし。
- 案 A は API-key ユーザ (将来 kaoiro を lab-pc-N 等の別ホストで動かす際に
  想定される認証モード) にとって直接の便益。
- 案 B は誤申告リスクと引き換えに ChatGPT-plan 側の選択自由度を得る。
- 案 C は Claude 側と対等な「稼働 model 実表示」を得る唯一の道。

## 判断材料

- kaoiro を api-key 認証ホストで運用する予定の有無 (案 A の実益判定)
- OpenAI 側 entitled 集合の drift 頻度 (案 B の保守負担見積り、過去
  `gpt-5.5` が一時 404 → 復帰の実績あり、[#26892](https://github.com/openai/codex/issues/26892))
- `@openai/codex-sdk` release notes での event 型定義の変化 (案 C の待ち先)
- Claude 側 `ext.model` 表示が operator に与える価値の実運用体感 (対称化
  優先度の判断)

## 暫定方針

**案 D** で継続。当面 Master の運用環境は ChatGPT-plan (Plus 前提と推定)
かつ `~/.codex/config.toml` で default 明示可 (`model = "..."` 1 行) の
ため、e89fa98 の「アカウント既定 (選択不可)」表示で十分。案 A/B/C は
以下の trigger で再検討:

- **案 A の trigger**: kaoiro を api-key 認証ホストで運用開始する時。
- **案 B の trigger**: operator から「Codex model を UI で切り替えたい」の
  リクエストが上がった時。
- **案 C の trigger**: `@openai/codex-sdk` の release notes で
  `thread.started` に `model` 追加が観測された時。

## 解決時のアクション

- [ ] 採用案に応じて [ADR-0032](../adr/0032-codex-adapter.md) F4bc を改訂
      する ADR を起こす
- [ ] 案 A/B の場合: wrapper/codex/src/catalog.ts の `CODEX_MODELS` を
      案別ロジックで復活し、runner の `buildRegister()` から出力
- [ ] 案 C の場合: wrapper/codex/src/host.ts の `#applyThreadEvent` 相当
      で `model` を back-fill、`ext.model` に stamp
- [ ] AgentDetail.svelte の「アカウント既定 (選択不可)」ラベル特例 (Codex
      分岐、[e89fa98](https://gitea.example.invalid/sakurai.yuta/kaoiro/commit/e89fa98))
      を撤去
- [ ] 本 open-question を close (削除)
