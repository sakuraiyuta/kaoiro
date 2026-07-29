---
title: 自律協調の事後報告の宛先・形式
description: director 媒介で成立した作業分担・成果を、誰へどの形式で事後報告するか (director 経由でマスターへ、の現行運用との整合) を決める。
status: open
urgency: medium
blocks: []
opened: 2026-07-28
decided: null
---

## 背景

[ADR-0044](../adr/0044-coordination-injection-hitl.md) F2 は「都度
指名された director のもとで、責務範囲内の作業分担は operator 承認
不要 (事後報告)」と決めたが、事後報告の宛先と形式は未定。現行運用では
「各エージェントの成果は
director (クロエ) が巻き取り、マスター向け意思決定まとめを作る」
(2026-07-11 マスター指示) が先行しており、これとの整合が論点。

## 選択肢

| 案 | 内容 | メリット | デメリット |
|----|------|----------|-----------|
| A | director への inter-agent 報告のみ (director がマスター向けに集約) | 現行運用と一致。報告経路が一本化 | director の context 消費が増える。director 不在時の報告先が宙に浮く |
| B | director 報告 + dashboard 通知 (分担成立・完了を envelope で可視化) | operator が scrollback に頼らず把握できる (#87 の観測可能性論点) | 通知 envelope の新設が要る |

## 影響

ADR-0044 の実装 (kaoiro issue #87 派生) のうち、報告規約の文面
([coordination-footer-scope](coordination-footer-scope.md)) が
ブロックされる。

## 判断材料

- director が未指名の作業、および指名 director の疲労・離脱時の報告先
  フォールバック (F2 の指名は都度・非永続)
- dashboard 側の表示設計コスト (subagent-tasks の集約表示との関係)

## 暫定方針

なし (未決)。

## 解決時のアクション

- [ ] 報告規約を確定し協調指針の文面へ反映する
- [ ] 必要なら通知 envelope を protocol spec に追記する
- [ ] 本 open-question を close (削除)
