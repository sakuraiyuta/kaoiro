---
title: Tasklist (todo) を task envelope に相乗りさせる
status: accepted
date: 2026-08-04
opened: 2026-08-04
supersedes: []
superseded_by: null
related_specs: [protocol, subagent-tasks, codex-sdk-events]
related_adrs: [47]
---

# ADR-0049 — Tasklist (todo) を task envelope に相乗りさせる

## Status

Accepted (2026-08-04、マスターとの相談で決定。kaoiro issue #188)。
[ADR-0047](0047-task-envelope-schema.md) F4 が予定した `task_type` 拡張の
最初の適用。

## Context

kaoiro issue #188。エージェント自身が管理する todo リスト(Claude Code の
Tasklist、Codex の `todo_list`)の内容と進捗を operator が dashboard で
見られるようにしたい。#180(subagent/workflow の稼働可視化)とは別軸で、
「子タスクが走っているか」ではなく「エージェント自身の todo 項目の内訳」を
見せる。

判断材料: 源イベントは両 engine とも**リスト全体の更新**として届く
(Claude Code の todo 更新、Codex SDK 0.144.1 の ThreadItem `todo_list`
— `items[]: {text, completed}`、[codex-sdk-events](../specs/codex-sdk-events.md)。
現状 codex adapter はこれを破棄している)。ADR-0047 は `task_type` を
拡張可能 enum とし、tasklist の追補を明示的に予定していた。

## Decision

### F1: type `task` に相乗りし、リスト全体を置換配信する

別 type は新設せず、type `task` の `task_type: "tasklist"` として運ぶ。
tasklist はエージェントごとに**単一エンティティ**(項目ごとにエンティティ化
しない)とし、todo リスト全体を optional フィールド `items`
(項目テキスト + 項目 status)で運ぶ。更新はリスト全体の置換
(last-write-wins)で、源イベントの形と素直に対応する。

### F2: 対象は親エージェント自身の todo のみ

親セッションの stream から観測できる範囲に限定する。subagent(子)の
todo は拾わない — 子 transcript の読込は
[ADR-0019](0019-subagent-workflow-entity-and-task-envelope.md) が
「v0 では重い」と退けた経路であり、同じ判断を踏襲する。

### F3: Claude Code / Codex 両 engine を対象とする

Codex は ThreadItem `todo_list` の破棄をやめて同じ envelope へ変換する。
`completed` boolean は項目 status へマップする(Codex には in_progress
相当が無いため、engine 間で項目 status の粒度差は許容する)。

### F4: 細部は実装時に protocol 追補で確定する

`items` の項目 status 語彙、`kind` の使い分け(全体置換が主体のため
`updated` 中心)、間引き([ADR-0048](0048-task-aggregation-delivery.md)
F2)の tasklist への適用は、実装着手時に protocol の予約 `task` 行へ
追補して確定する(`version` 据え置き)。UI 表現(表示位置・折りたたみ)は
クライアント責務で、issue #188 に記録する。

## Consequences

### Positive

- type を増やさず、#180 と同じ envelope・同じ server 集約
  ([ADR-0048](0048-task-aggregation-delivery.md) のフラット task テーブル /
  snapshot 枠)に乗る。
- 両 engine の源イベント(リスト全体更新)と wire の形が一致し、wrapper に
  項目 diff 計算が要らない。

### Negative

- 項目単位の粒度(#180 の子タスク表示との対称性)は失う。項目ごとの
  イベント履歴は追えない。
- engine 間で項目 status の粒度が異なる(Codex は completed の二値)。

### Neutral

- tasklist エンティティの寿命・掃除は他の task と同じく親離脱に従う
  (ADR-0048 F1)。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| todo 項目ごとに task エンティティ化 | wrapper に項目 diff 計算が要り、Codex(completed のみ)と非対称。源イベントの形とも合わない |
| 別 envelope type を新設 | type enum が増え、ADR-0047 の単一 type 方針と逆行する |
| subagent の todo も対象にする | 子 transcript の読込が要り重い(ADR-0019 と同じ判断) |

## Related

- spec: [protocol](../specs/protocol.md)(予約 `task` 行)、
  [subagent-tasks](../specs/subagent-tasks.md)、
  [codex-sdk-events](../specs/codex-sdk-events.md)(`todo_list` 源イベント)。
- 関連 ADR: [0047](0047-task-envelope-schema.md)(task envelope スキーマ、
  `task_type` 拡張枠)。
- 由来: kaoiro issue #188 の HITL 論点をマスター相談で決着(表示先などの
  UI 決定は issue 側に記録)。
