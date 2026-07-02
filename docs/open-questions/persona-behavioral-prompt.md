---
title: タスク姿勢(慎重度・報告頻度・ツール使用の癖)の注入
description: 人格プロンプト注入のスコープを口調系から拡張し、タスク姿勢(慎重さ・進捗報告頻度・ツール使用の癖等)まで含めるかどうか。
status: open
urgency: low
blocks: []
opened: 2026-07-02
decided: null
---

## 背景

[persona-personality-injection](../specs/persona-personality-injection.md)
の初回スコープは「口調・一人称・語尾・返答スタイル」に限定し、タスク姿勢
(慎重度・進捗報告頻度・ツール使用の癖等)は将来課題として明示的に切り出
した([ADR-0026](../adr/0026-persona-personality-injection.md))。

背景: dogfooding フェーズでの初期実装を軽く保ちたかったこと、タスク姿勢は
実作業の成果に直結するため「口調が違うだけ」より慎重な検証が要ること。

このスコープ拡張を将来どう扱うかを予約する。

## 選択肢

| 案 | 内容 | メリット | デメリット |
|----|------|----------|-----------|
| A | 現行スコープに含めず、必要になった時点で新 spec を起こす | 現行実装への影響ゼロ。慎重な検証を必要な段階でだけ行える | 拡張を望むタイミングで再議論から始める必要 |
| B | 既存の `personality_prompt` にタスク姿勢も自然文で混ぜて書ける仕様に拡張 | フィールド追加が要らない。柔軟 | 口調とタスク姿勢が混ざり、レビュー・差し替えがしにくい。判別可能性・検証が難しくなる |
| C | `personality_prompt` と `behavior_prompt` を分けた 2 フィールド化 | 責務分離が明確。ペルソナごとの姿勢差を独立にレビュー可能 | データモデル拡張。current phase では過剰設計の可能性 |

## 影響

- 現行仕様は変更なし。dogfooding で「タスク姿勢もペルソナごとに変えたい」
  需要が出た時点で本 open-question を decide する。
- decide 時期に応じて、既存の personality_prompt_file と互換を保つ移行
  方針も併せて設計する必要がある。

## 判断材料

- dogfooding で「口調は違うが姿勢は同じ」ことが不自然と感じられる場面が
  出るか。
- タスク姿勢を人格に組み込んだ場合の副作用(assistant の実作業品質への
  影響)を計測する仕組みがあるか。

## 暫定方針

**A**(将来課題として保留)。tag は「dogfooding 観察待ち」。

## 解決時のアクション

- [ ] Decision recorded in `adr/NNNN-persona-behavioral-prompt.md`
- [ ] 拡張する場合は `../specs/persona-personality-injection.md` の
      「スコープ」節を更新
- [ ] This file moved to ADR or deleted
