---
title: discord-wrapper 未接続中の inbound 取りこぼし
description: discord-wrapper が gateway 未接続の間に届いた外部人間の返信をロスト容認とするか、Discord REST で backfill するか。
status: open
urgency: low
blocks: []
opened: 2026-07-04
decided: null
---

## 背景

Discord gateway は接続中のイベントのみ受信する。discord-wrapper 停止中
(再起動・障害)に届いた返信は、そのままではロストする
([protocol-external-human](../specs/protocol-external-human.md))。

## 選択肢

| 案 | 内容 | メリット | デメリット |
|----|------|----------|-----------|
| A | best-effort(backfill しない、ロスト容認) | 実装最小 | 停止中の返信は届かない |
| B | 再接続時に Discord REST で未読を backfill | 取りこぼしなし | 実装コスト・重複排除・順序整合が要る |

## 影響

- inbound の信頼性のみ。outbound / Tier A・B の骨格には影響しない。

## 判断材料

- 実運用で discord-wrapper がどれだけ落ちるか(runner 監督下で低頻度想定)。
- 取りこぼしの実害(operator は Discord 本体で原文を後追いできる)。

## 暫定方針

**A(best-effort)**。low priority。取りこぼしは operator が Discord 本体で
確認できるため実害が小さい。

## 解決時のアクション

- [ ] Decision recorded(必要になれば ADR / spec 追補)
- [ ] `../specs/protocol-external-human.md` に backfill 方針を反映(B 採用時)
