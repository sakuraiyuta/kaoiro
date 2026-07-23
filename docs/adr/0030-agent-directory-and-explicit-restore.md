---
title: サーバ再起動越しの agent identity 永続と client 明示復元(一括/個別)
status: accepted
date: 2026-07-06
opened: 2026-07-06
supersedes: []
superseded_by: null
related_specs: [protocol, architecture]
related_adrs: [12, 14, 21, 23, 24]
---

# ADR-0030 — サーバ再起動越しの agent identity 永続と client 明示復元(一括/個別)

## Status

Accepted(実装完了 2026-07-06 — phase-11 phase-0..2、手動 dogfooding 検収済)

## Context

[ADR-0014](0014-session-resume-and-restore.md) は agent の session 復元機構
(client → server → runner の spawn-with-resume)を定義し、`SessionPointers`
(`agent_id → {session_id, cwd}`)を DETS で永続化した。実装済みの
`restore` / `resume_disconnected`
([agents_channel.ex](../../server/lib/kaoiro_server_web/channels/agents_channel.ex))
は disconnected agent を対象に spawn + `resume_session_id` を
`runner:<host_id>` へ broadcast する。しかし現状:

- **agent identity(persona)が揮発**:
  `agents_channel.ex agent_persona/1` は `AgentStates.snapshot()` から persona
  を読む。server 再起動で AgentStates は消えるため、restore の spawn payload
  に persona を積めなくなり、再起動を跨いだ resume 経路が壊れる。
- **client 側からの「知られているエージェント一覧」取得手段が無い**:
  再起動直後は AgentStates が空 = エージェント 0 台の表示。runner/wrapper が
  自発再接続してくるまで、operator が復元操作する対象すら見えない。
- [ADR-0014 A4](0014-session-resume-and-restore.md)「JSONL 正本」により
  返答ログの永続化([#24](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/24))は不要と確定。永続すべきは identity(persona)と存在事実のみ。

goal: **server と runner が同時ダウン・再起動した後、client 側の「前回の
状態を復元」ボタン操作(一括 / 個別)によって、直前まで動いていた各エージェ
ントを最後の session_id で resume-spawn できる**。復元は operator 明示のみ、
自動は行わない([#41](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/41))。

## Decision

- **D1(store 分割)**: 新規 DETS store `KaoiroServer.AgentDirectory` を追加し
  `agent_id → %{persona, last_seen}` を保持する。`SessionPointers`(resume
  ポインタ、ADR-0014 F1)は据置。identity 台帳と resume ポインタは概念が別
  なので独立させる。
- **D2(書き込みタイミング)**:
  - **spawn 時**(`agents_channel.ex build_spawn_payload/4`)に persona を
    fire-and-forget で `AgentDirectory.record/2` する。`SessionPointers` /
    `PermissionModes` と同型パターン。
  - **envelope 到着時**(AgentStates.put)に `last_seen` を更新する。
    persona は session 中に変わらない(ADR-0029 F9)ため上書きしない。
- **D3(読み替え)**: `agent_persona/1` を `AgentDirectory.get(agent_id)` の
  persona 参照に切替。AgentStates 依存を除去して再起動耐性を得る。既存
  restore / resume_disconnected の wire は変更しない。
- **D4(client への一覧提供)**: server は operator role の join snapshot 経路
  を拡張し、AgentDirectory の全 entry を配信する(新規 topic は増やさない)。
  client 側は AgentStates.snapshot() と merge して live/offline を判定する。
  viewer には配信しない(D10)。**client 側の「offline 表示」は directory-only
  (AgentStates に entry が無い、= サーバ再起動起因)と live disconnected
  (entry はあるが state=disconnected、= wrapper 単独切断・ホットリロード起因)
  の両者を統合し、1 か所のオフラインセクションで復元 UI を提供する — 障害の
  出方で UX を分岐させない(2026-07-07 追記)。**
- **D5(復元 UX)**: dashboard に 2 系統のボタンを配置する:
  - **一括**: ヘッダ or 設定メニューに「前回の状態を復元」— offline entry
    全件に対して個別 resume-spawn を順次発火。
  - **個別**: offline 表示中の agent tile(または詳細)から 1 体のみ
    resume-spawn。
  - どちらも既存 `resume_disconnected` wire を 1 体ずつ呼ぶ。バッチ専用の
    wire は作らない。
- **D6(entry ライフサイクル)**:
  - 追加: spawn 時のみ。
  - 更新: envelope 到着時に last_seen のみ。
  - 削除: operator 明示削除のみ(dashboard に「エージェントを台帳から削除」
    操作)。自動 GC は初回スコープ外(将来: last_seen が N 日超過で候補入り、
    明示承認で削除)。**2026-07-07 実装**: `delete_agent` handler が
    directory-only entry (`AgentStates` 不在で `AgentDirectory` のみ)も
    受け付けるよう拡張し、`AgentStates` (memory) + `AgentDirectory` +
    `SessionPointers` + `PermissionModes` の 4 store を一括 purge する。
    live agent への削除は既存 `AgentStates.delete/1` の disconnected guard
    がそのまま効く(不変)。復元不可なゾンビ agent(`no_session` 等で
    復元 spawn が繰り返し失敗するケース)を operator が明示掃除できる。
- **D7(host_id 非永続)**: agent_id の命名規約(ADR-0024 D3 `<host_id>.<rand>`)
  から `host_id_of/1` で常時算出可能なため、host_id 単独の永続は不要。
  AgentDirectory には格納しない。
- **D8(復元失敗のハンドリング)**: 復元不可要因(host runner offline /
  persona pack missing / session JSONL missing = ADR-0014 T3 検証失敗)は
  既存 `spawn_result` エンベロープで個別に client へ返る。一括復元はベスト
  エフォート(部分成功可)、client は各 tile に error 表示。特別な集計 API は
  作らない。**復元ボタンの表示は client 側で `envelope.state === "disconnected"`
  のみで判定し、session_id の有無で gate しない — 実復元可否(SessionPointer
  の存在)はサーバ側判定に一任し、失敗は spawn_result → sticky icon で
  surface する(2026-07-07 追記)。**

  **fresh-restore 追補(phase-25, 2026-07-23)**: SessionPointer は
  cwd / engine / snapshot を保持しつつ session_id だけが nil のケース
  (`/clear` detach = ADR-0036 F3 追補 / 未発話 session = ADR-0014 Q-A4)が
  ある。以前は server の `session_pointer/1` が binary session_id を
  要求していたため復元ボタンが `no_session` → ⚠ で必ず失敗した。phase-25
  でこの経路を **fresh-restore** として救済する: server は `resume_session_id`
  を omit した spawn payload に `apply_resume_snapshot: true` を stamp し、
  runner は fresh 分岐で snapshot を再適用して同 model / effort / engine /
  permission 設定の fresh session として立ち上げ直す。詳細は
  [ADR-0014 F1 追補「session_id なし pointer の fresh-restore」](0014-session-resume-and-restore.md)
  および [phase-25 計画](../plans/phase-25-fresh-restore-without-session.md)。
  なお D8 本体の「復元ボタンは disconnected のみで gate」ポリシーは不変で、
  session_id の有無で表示制御しないという原則は fresh-restore 導入後も
  そのまま維持される。
- **D9(二重接続防止)**: 既存 `require_disconnected/1`(ADR-0014 F4)を再利用。
  live agent は復元対象から除外される。
- **D10(権限)**: 一覧・復元操作とも operator 限定
  ([ADR-0021](0021-role-information-disclosure-policy.md) の role gate 流用)。
  viewer には AgentDirectory 由来の offline 一覧を返さない。
- **D11(rate limit)**: 一括復元の spawn は同期順次で発火(server 側の
  for-loop、broadcast のみ)。特別な rate limit は不要 — 実際の spawn 実行は
  runner 側 in-flight lock で守られる。実運用で問題化したら本 ADR を改訂する。
- **D12(グローバル設定)**: 現状サーバは mutable な global config を持たない
  (すべて env 外出し)。本 ADR はスコープに含めない。将来 dashboard-driven
  config が発生した時点で別 ADR で追加する。

## Consequences

### Positive

- サーバ・runner 再起動後もエージェント一覧が空にならず、operator が
  明示操作で全体/個別に復元可能になる。
- ADR-0014 A4「JSONL 正本」を維持したまま goal 達成(履歴永続不要)。
- 既存 `SessionPointers` / `PermissionModes` と同型 DETS パターンで実装
  コストが低い(store 追加 + spawn hook + 参照差替え + client 配信 +
  dashboard UI)。
- resume path のうち session_id / cwd(SessionPointers)・permission_mode
  (PermissionModes)は既に永続、追加は persona 1 項目のみ。

### Negative

- AgentDirectory entry のライフサイクル(削除)を operator に委ねるため、
  長期運用で古い entry が溜まる可能性がある。将来 GC 検討(D6)。
- 一括復元時は多数の runner に spawn broadcast が走る。実運用で問題化したら
  D11 に rate limit を追加する。

### Neutral

- 「前回の状態」とは persona + session_id + cwd + permission_mode の 4 点のみ
  で、返答ログや agent 内部状態(idle/thinking 等)は復元されない — ADR-0014
  A4 との整合。
- Client 側の live/offline 判定は AgentDirectory と AgentStates.snapshot の
  merge で行う(server は両方を素直に配信)。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| `SessionPointers` を拡張して persona + last_seen を含める | pointer 概念が identity 領域まで膨らむ。ADR-0014 の書きぶり(「pointer のみ、履歴なし」)と相性が悪い |
| AgentStates 全体を永続 | 揮発でよいエンベロープ・履歴まで含まれ ADR-0014 A4 に反する |
| サーバ crash からの自動 resume | 二重接続リスク、operator の意思決定を奪う、user 方針(明示操作)に反する |
| 一括復元用の新規 wire(`bulk_restore`)を追加 | 既存 restore / resume_disconnected を 1 体ずつ呼ぶだけで済むため冗長 |
| entry の自動 GC(N 日で削除) | 初回スコープでは operator 混乱を招く可能性。将来オプション |
| ADR-0014 の phase-3 として組み込む | 0014 は resume 機構本体、本件は identity 永続 + UX で概念が別 |

## 実装フェーズ(ロードマップ、plan 化時に切り出す)

- **phase-0**: `AgentDirectory` GenServer + DETS 追加、spawn / envelope 到着
  hook、`agent_persona/1` 差替え、テスト(`SessionPointers` テスト template
  流用)。
- **phase-1**: operator role join snapshot への AgentDirectory 配信、
  dashboard 側で AgentStates と merge して live/offline 判定するロジック。
- **phase-2**: dashboard に個別復元ボタン(offline agent tile)、一括復元
  ボタン(ヘッダ)、`spawn_result` エラーの UI 反映。
- **phase-3**(将来): entry 削除 UI、last_seen による GC の是非を issue で追う。

## Related

- 依存 ADR: [0014](0014-session-resume-and-restore.md)(resume 機構本体、
  pointer 永続)、[0024](0024-agent-instance-identity-and-spawn-auth.md)
  (agent_id 命名規約から host_id 算出)
- 参照 ADR: [0012](0012-response-display-and-dashboard-scope.md)(A4 JSONL
  正本方針)、[0021](0021-role-information-disclosure-policy.md)(operator
  role gate)、[0023](0023-host-runner-architecture.md)(runner が spawn
  実行主体)
- 関連 issue:
  [#41](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/41)(本 ADR
  で解消)、
  [#24](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/24)(諦め
  方針)、
  [#88](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/88)(将来の
  per-persona 設定永続化と同型パターン)
- 関連 specs: [protocol](../specs/protocol.md)(spawn / resume 経路)、
  [architecture](../specs/architecture.md)
