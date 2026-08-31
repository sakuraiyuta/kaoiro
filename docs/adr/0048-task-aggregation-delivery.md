---
title: task の server 集約・進捗間引き・スナップショット
status: accepted
date: 2026-08-04
opened: 2026-06-16
supersedes: []
superseded_by: null
related_specs: [protocol, subagent-tasks]
related_adrs: [19, 47]
---

# ADR-0048 — task の server 集約・進捗間引き・スナップショット

## Status

Accepted (2026-08-04、マスターとの相談で決定。kaoiro issue #170)。
[ADR-0019](0019-subagent-workflow-entity-and-task-envelope.md) が server に
課した「子タスクの active set 維持・配信」の具体
([subagent-tasks](../specs/subagent-tasks.md) 段階2 の前提)を確定する。

## Context

ADR-0019 で subagent / workflow を親付き子エンティティとして通知する方針は
決定済みだが、server 側の保持モデル・進捗更新の頻度・後続接続クライアント
へのスナップショット提供は未決だった。

判断材料: 既存の再接続再同期は `snapshot`(join 直後 push、`agent_id` ごと
last-write-wins、[protocol](../specs/protocol.md))。server はメモリ保持のみ
(永続なし)で、再起動で消える前提は既存と同じ。また AgentDetail のログ肥大で
dashboard 入力が重くなった実績(kaoiro issue #174)があり、envelope 量の
無制御な増加は避けたい。

## Decision

### F1: フラットな task テーブル + 親 `agent_id` 参照

server は子タスクを親 agent エンティティ配下のコレクションではなく、
フラットな task テーブルとして保持し、各 task が親 `agent_id` を参照する。
親と子の寿命管理を独立に扱え、`task_type` の異なるタスク(将来の tasklist、
[ADR-0047](0047-task-envelope-schema.md) F4)も同じテーブルに同居できる。
ライフサイクルは親セッションに束縛される(ADR-0019 F1)ため、親エージェント
の離脱時には紐づく task を破棄する。

### F2: `kind=updated` は wrapper 発行側で間引く

進捗更新(`kind=updated`)は wrapper の発行側で一定間隔 + 差分閾値により
間引く。`started` / `completed` は間引かず常に即時発行する。`usage` の
頻繁更新による envelope 増と dashboard 負荷(#174 の教訓)を発生源で抑える。
具体の間隔・閾値は段階1 実装時に定める。

### F3: 後続接続へは既存 snapshot 枠で接続時一括送信

後続接続クライアントへの現在集合の提供は、既存 `snapshot`(join 直後 push)
の枠に task の active set を含めて一括送信する。定期スナップショット
envelope は設けない。protocol 追加が最小で、last-write-wins の既存意味論に
そのまま乗る。

## Consequences

### Positive

- 保持・配信の実装方針が確定し、段階2(server 集約・中継)に着手できる。
- 間引きが発行側にあるため、server・クライアント双方の負荷を同時に抑える。
- snapshot の既存枠を使うため protocol の追加が最小。

### Negative

- 間引きにより、クライアントの見る進捗メタ(usage 等)は最新値より
  遅れうる(`completed` で最終値に収束する)。
- 間引きパラメータは wrapper 側の実装事項となり、engine 間
  (claude-code / codex)で発行粒度を揃える配慮が要る。

### Neutral

- メモリ保持のみで再起動により消える — 既存エンティティと同じ前提。
- task テーブルの掃除タイミングは親エージェントの離脱に従う。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| 親 agent エンティティ配下の子コレクション | 親の再接続・削除処理と子の寿命管理が結合する。異なる `task_type` の同居も難しい |
| `task_progress` を毎回そのまま流す | usage の頻繁更新で envelope が膨らみ、dashboard 負荷(#174)を再現しうる |
| 定期スナップショット envelope | 定常トラフィックが増える。既存の join 時 push + last-write-wins で足りる |

## Related

- spec: [subagent-tasks](../specs/subagent-tasks.md)(段階2)、
  [protocol](../specs/protocol.md)(snapshot の既存意味論)。
- 関連 ADR: [0019](0019-subagent-workflow-entity-and-task-envelope.md)
  (責務の決定元)、[0047](0047-task-envelope-schema.md)(envelope スキーマ)、
  [0021](0021-role-information-disclosure-policy.md)(viewer/operator
  情報公開ポリシ — 本 addendum が適用する fail-closed 既定)。
- 由来: open-question subagent-task-aggregation(2026-06-16 起票)を
  本 ADR へ昇格。

## Addendum (issue #170, 2026-08-09): task の配信は operator 限定

**決定。** `task` envelope のライブ配信、および snapshot の `tasks` キー
(F3)は **operator 限定**とし、`viewer` ロールには一切配信しない。
マスターとの相談を経てこはくが決定、理由は 3 つ:

1. [ADR-0047](0047-task-envelope-schema.md) F3 の進捗メタ
   (`summary` / `last_tool_name` 等)は粗いライフサイクルを超えた
   内容ベアリング情報であり、[ADR-0021](0021-role-information-disclosure-policy.md)
   が operator 限定としてきた `log`/`result` 相当の粒度に近い。
2. issue #170 自体の目的が「operator が内部活動を把握する」ことで、
   viewer 向けの要求はそもそも無い。
3. ADR-0021 F2 の fail-closed 既定(未知 type は viewer へ配信しない)
   が既に narrow-by-default を志向しており、あとから広げる方が
   先に広げて漏洩を起こすより安全に倒せる。

**実装。**

- ライブ配信: `AgentsChannel.sanitize_envelope_for/2` に `"task"` 専用の
  分岐は**追加しない**。`log`/`result`/`hosts` など既存の operator 限定
  type と同じ経路 — 明示的な viewer 許可節を持たない type は
  `:viewer, _ -> :drop` の既定分岐へ落ちる — にそのまま乗るため、
  ゼロ行の変更で要件を満たす(N3 訂正、クロエ 2026-08-09: これは
  「未知 type に備えた fail-closed の保険」ではなく、
  hosts/log/result と同じ主経路そのもの — server gate に依存した
  結果であって、防御的フォールバックではない)。
- snapshot: `AgentsChannel.handle_info(:after_join, socket)` が
  `role == :operator` のときのみ `TaskStates.snapshot()` を
  `tasks` キーへ積み、viewer join には常に `tasks: %{}` を返す。

将来 viewer 向けに task 可視化を広げる場合は、この addendum か新規 ADR
の改訂を経てから行う(サニタイズ側の暗黙拡張はしない)。

**由来**: kaoiro issue #170 実装セッション(あお、2026-08-09)。
