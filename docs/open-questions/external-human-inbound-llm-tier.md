---
title: 外部人間からの inbound を LLM に通すか(Tier B の最終採用)
description: 外部人間の返信を zero-tool 受付 LLM(Tier B)で要約・限定返信するか、決定論の Tier A に留めるか。injection 耐性の red-team spike で確定。
status: open
urgency: medium
blocks: [protocol-external-human, phase-9-external-human-messaging]
opened: 2026-07-04
decided: null
---

## 背景

外部人間メッセージング([protocol-external-human](../specs/protocol-external-human.md))
の inbound は untrusted 入力。operator は「これってこういうことだよね?と
要約して返す」体験を望むが、外部テキストを LLM 文脈へ入れると prompt
injection のリスクが出る。「LLM を通す」≠「ツールを持つ agent を通す」を
分離し、zero-tool の受付 LLM なら blast radius を極小化できる、という整理に
至った(spike で検証する)。

## 選択肢

| 案 | 内容 | メリット | デメリット |
|----|------|----------|-----------|
| A | Tier B: zero-tool 受付 LLM(Haiku、text→text)で `ext.interpretation` 付与 + 限定返信 | 望む UX(要約・キャラの味)を満たす。blast radius 小 | injection 面を持つ。spike ゲートが要る |
| B | Tier A のみ(決定論固定テンプレ) | injection 面ゼロ・最安全 | 要約なし、UX が貧弱 |

## 影響

- phase-9 Stage 1 の着手可否を gate する。Stage 0(Tier A)は本論点と独立に
  ship できる。
- Tier B 採用時は plugin-model のフィルタ機構初適用 / issue #18 の初実体。

## 判断材料

- red-team spike の結果: injection で不変条件(原文 verbatim / 同一相手固定 /
  zero-tool)が破れないか。
- 破れる場合の追加緩和(返信も operator 承認を挟む等)の要否とコスト。

## 暫定方針

phase-0 は **Tier A** で ship。実装前 red-team spike を通過したら **Tier B**
(A)を有効化する。原文 verbatim / 同一相手固定 / zero-tool / working agent
非注入は Tier B の MUST。

## 解決時のアクション

- [ ] Decision recorded in `adr/NNNN-<slug>.md`(または ADR-0028 追補)
- [ ] `../specs/protocol-external-human.md` の Tier B 節を確定へ
- [ ] `../plans/phase-9-external-human-messaging.md` Stage 1 の gate を解除
