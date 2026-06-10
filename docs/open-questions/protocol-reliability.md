---
title: プロトコルの信頼性規約(seq/イベント ID、permission 相関・タイムアウト)
description: 順序保証・重複排除のための seq/イベント ID と、permission_request の相関 ID・タイムアウト既定の確定。
status: open
urgency: medium
blocks: [protocol, phase-3-server-multiagent]
opened: 2026-06-11
decided: null
---

## 背景

issue #4 が挙げた信頼性・運用 4 項目のうち、(2) 再接続時の再同期規約と
(4) agent_id 文字種制約は [protocol](../specs/protocol.md) へ反映済み。
残る 2 項目は Phase 3(複数エージェント・双方向)の実装実態と併せて
確定すべきため、本 open-question として切り出す。

1. **seq/イベント ID**: エンベロープに順序保証・重複排除のための連番
   またはイベント ID を持たせるか。現状は agent_id ごと last-write-wins
   で表示用途には十分だが、複数ラッパー・再接続・ログ蓄積で必要になり得る。
2. **permission_request の相関 ID とタイムアウト既定**: 承認要求と応答を
   突合する相関 ID、無応答時の既定動作(タイムアウトで deny 等)と既定値。

## 選択肢

| 案 | 内容 | メリット | デメリット |
|----|------|----------|-----------|
| A | Phase 3 の双方向実装時に実消費者で確定 | 実態に合う(ADR-0010 と同じ方針) | 確定が Phase 3 まで遅れる |
| B | 先に机上で確定 | 早く固まる | 実装実態とズレるリスク |

## 影響

未決の間、エンベロープは at-most-once 表示(last-write-wins)のままで、
監査ログ・リプレイ用途には使えない。permission_request は予約 type の
ため現状未使用であり、実装上のブロックはない。

## 判断材料

Phase 3 のタスク 3-2(指示・承認の双方向ルーティング)の実装で、相関 ID
とタイムアウトの実要件が判明する。タイムアウト既定値などの設計判断は
ユーザ承認が必要(issue #4)。

## 暫定方針

案 A。Phase 3 着手時に本件を解決してから双方向メッセージを spec 追補する。

## 解決時のアクション

- [ ] 決定を `adr/NNNN-protocol-reliability.md` に記録
- [ ] [protocol](../specs/protocol.md) へ反映
- [ ] このファイルを削除
