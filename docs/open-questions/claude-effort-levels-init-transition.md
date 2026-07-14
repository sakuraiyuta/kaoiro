---
title: init 前後の Claude `effort_levels` UX ズレの影響評価
description: BOOTSTRAP default エントリに FULL_EFFORT を仮出しする現行踏襲判断が、init 後の実測 default モデルの effort_levels との不一致 (init 前 5 段階 → init 後は減る可能性) として UX 影響を出すかを実装後に観察する。
status: open
urgency: medium
blocks: []
opened: 2026-07-14
decided: null
---

## 背景

[ADR-0037](../adr/0037-claude-model-catalog-live-refresh.md) F5 は、縮小後の
`default` エントリの `effort_levels` に FULL_EFFORT
(`["low", "medium", "high", "xhigh", "max"]`) を仮出しする現行踏襲を採用した。
現行 fresh idle agent の effort switcher 供給源
(`AgentDetail.svelte:369` コメント) を壊さないための踏襲であり、init 後の
`ext.models` で正しい effort_levels に置換される契約と併存する。

この判断の副作用として、init 前に effort を xhigh に選択したユーザが init
完了後に「選んだはずの xhigh が switcher 候補から消える」ケースが発生しうる
(実測 default が Sonnet 系列で SONNET_EFFORT
`["low", "medium", "high", "max"]` を返す場合、xhigh は除外される)。

この UX ズレが実装後にどの程度 user friction を生むかは事前に判断できない
ため、実装後の観察対象として open-question 化する。

## 選択肢

| 案 | 内容 | メリット | デメリット |
|----|------|----------|-----------|
| A | 受容可能なズレとして継続 (現行踏襲) | 実装最小、既存 switcher 供給経路を壊さない | init 前後の選択肢差が friction を生む可能性 (実装後観察) |
| B | 実装後の UX 観察で問題大なら D1 を再判断 (effort_levels 空 or 3 段階固定へ) | 問題顕在化後に対処、実データに基づく判断 | 判断のタイミングが遅れる、user feedback 収集の仕組みが要 |

## 影響

- **blocks**: なし (blocking しない、実装後の観察タスク)
- init 前 launch dialog の effort 選択と init 後 AgentDetail の effort switcher で
  選択肢集合が一致しない可能性がある。ズレの発生頻度は SDK が返す実測 default
  モデルの `effort_levels` に依存

## 判断材料

- Phase 18 実装後、init 前 xhigh / max を選択したユーザが init 後に "選択肢
  から消えた" を経験する頻度 (issue / user feedback / dashboard log)
- Phase 18-2 (Q1 実測) の結果、SDK 実測 default モデルが実際どの
  `effort_levels` を返すか (現時点では Opus 系列で FULL_EFFORT が返る前提だが
  未確定)
- 案 B に移行する場合の代替値: effort_levels 空 (init 前 switcher 無効化)
  または low/medium/high 3 段階固定

## 暫定方針

案 A (受容) で ADR-0037 F5 を進める。Phase 18 実装後、issue や user feedback
から友情 friction が問題視されたら案 B へ移行を検討する。

## 解決時のアクション

- [ ] Phase 18 実装後、UX 観察期間 (2〜4 週間を目安) を設ける
- [ ] friction が観測された場合: [ADR-0037](../adr/0037-claude-model-catalog-live-refresh.md)
      F5 を revise、`effort_levels` 空化 or 3 段階固定への切替を新規 ADR または
      追補で判断
- [ ] friction が観測されなかった場合: 本 open-question を close (削除)
