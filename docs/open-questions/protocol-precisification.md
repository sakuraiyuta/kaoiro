---
title: プロトコルの精緻化
description: 共通イベントの type/payload 型体系、方向別メッセージ種別、バージョニング方針の確定。
status: open
urgency: medium
blocks: [protocol, phase-1.5-minimal-server-client]
opened: 2026-06-04
decided: null
---

## 背景

[protocol](../specs/protocol.md) は外枠(`version`/`agent_id`/`ts`/`type`/
`state`/`payload`/`ext`)のみ v0 として固定し、中身は未確定。具体的には
`type` と `payload` の型体系、方向別(ラッパー→サーバ / クライアント→サーバ)の
メッセージ種別、バージョニング/後方互換の方針が残っている。

なお **SDK 側のイベント仕様は確定済み**
([agent-sdk-events](../specs/agent-sdk-events.md)、2026-06 検証)。残るのは
kaoiro 自身の共通エンベロープ(type/payload)設計であり、SDK 仕様の不明点では
ない。

## 選択肢

| 案 | 内容 | メリット | デメリット |
|----|------|----------|-----------|
| A | Phase 1 で Agent SDK の実メッセージを観測してから型を確定 | 実態に合う、空振りしない | 確定が Phase 1 まで遅れる |
| B | 先に机上で全型を確定 | 早く固まる | SDK 実態とズレて作り直すリスク |

## 影響

未決の間、`protocol` spec は `provisional`、Phase 1 のエンベロープ実装が
暫定のままになる。外枠 v0 は固定済みのため着手自体は可能。

## 判断材料

Agent SDK の実メッセージ列(型名・フィールド)は確定済み
([agent-sdk-events](../specs/agent-sdk-events.md))。アダプタ実装(Phase 1
タスク 1-2)での実観測も済み。残るエンベロープの type/payload は、サーバ・
クライアントという実消費者なしには確定できない。

## 暫定方針

案 A。SDK 実メッセージの観測は Phase 1 で完了。type/payload の確定は
[Phase 1.5](../plans/phase-1.5-minimal-server-client.md) のタスク 1.5-4 で、
最小サーバ + 最小クライアントの実消費者検証により行う。外枠 v0 は固定のまま。

## 解決時のアクション

- [ ] 決定を `adr/NNNN-protocol-precisification.md` に記録
- [ ] [protocol](../specs/protocol.md) を更新し `status: accepted` へ
- [ ] このファイルを削除
