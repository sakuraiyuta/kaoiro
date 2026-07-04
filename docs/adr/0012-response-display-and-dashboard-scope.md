---
title: 返答表示と同梱ダッシュボードのスコープ改訂
status: accepted
date: 2026-06-14
opened: 2026-06-11
supersedes: []
superseded_by: null
related_specs: [non-goals, protocol, threat-model, overview]
related_adrs: [7, 10, 11, 14, 16, 20, 21, 22, 27]
---

# ADR-0012 — 返答表示と同梱ダッシュボードのスコープ改訂

## Status

Accepted

## Context

Phase 3 で指示は送れるようになったが、エージェントの応答テキストがどこにも
表示されない(ダッシュボードにも wrapper のターミナルにも)。実運用検証初日
(2026-06-11)に顕在化し、「指示は届くが何と答えたか見えない」状態で双方向の
実用性が大きく削がれていた(旧 open-question `response-display`)。

[non-goals](../specs/non-goals.md) と
[ADR-0007](0007-client-separation-reference-dashboard.md) は同梱ダッシュボードを
「状態一覧・表情・承認・指示入力」の最小限に固定し、返答表示はこのリストに
含まれていなかった。「同梱は単体で最低限実用であるべき」という目標に照らすと、
指示の返答が見えないのは機能の半完成であり、スコープ線引きの再判断が本質的論点
だった。

2026-06-14、ユーザと UI 方向性を相談(my-spec-elicitation)。見た目(ダーク
テーマ・顔/立ち絵・等幅フォント)は固定したまま、画面遷移・表示項目・機能を
確定した。

## Decision

- **(F1) 返答表示をスコープに含める**。同梱ダッシュボードの位置づけを
  「最小限」から「**情報リッチな operator コンソール**」へ改訂する。線引きの
  判定基準は「機能数」ではなく「**新たな公開プロトコル面 / サーバ永続を
  要するか**」。公開 API 消費・無永続に収まるリッチ化は可とする
  ([non-goals](../specs/non-goals.md) を更新)。
- **(F3) 既定画面はタイル一覧(俯瞰)**。エージェントをクリックでアニメ遷移し
  **全画面の詳細**を表示する。
- **(F2/F6) グリッドカードは現状の表示項目**(顔・名前・状態・agent_id)を
  保持(リッチカード)。承認の許可/拒否はカードに置かず、要対応
  badge(点滅)で気付かせ、許可/拒否は詳細で行う。
  - **更新(2026-06-16)**: 当初はカードにも指示入力を保持していたが撤去。
    指示送信は詳細画面のみとし、俯瞰グリッドには編集 UI を置かない方針に。
- **(F5) 返答はチャット風の `log` ストリーム**で表示。`assistant` テキストを
  逐次中継し、`tool_use`/`tool_result`(ツール入出力)は折りたたみ既定・
  クリックで展開する。
- **(F8) 盲点インジケータ**。全画面詳細は他エージェントの要対応を見落とす盲点を
  生むため、「**他に N 体が要対応 →**」を常時表示(色は最緊急状態に追従:
  error > waiting_permission)、クリックで一覧へ戻す。
- **(F7) サーバはインメモリ・リングバッファ履歴**を持ち、join 時に snapshot
  (最新)+ 履歴を返す(再読込・再接続で復元)。**ディスク永続はしない**
  (再起動で消える)。永続(再デプロイ耐性)は仕様策定込みで issue #24 へ。
  履歴の**正本は wrapper ホストの SDK JSONL** とし、本リングバッファはその
  再構築可能な投影と位置づける(resume 経由の再構築は
  [ADR-0014](0014-session-resume-and-restore.md))。
- **(F9) 返答ログ(`log`/`result`、特に tool 入出力)は operator role のみへ
  配信**。viewer はグリッド(顔・状態)まで。viewer=俯瞰 / operator=操作+詳細
  と role が画面に一致する([threat-model](../specs/threat-model.md))。

プロトコル詳細(`log`/`result` payload・配信制御・履歴再同期)は
[protocol](../specs/protocol.md)、実装計画は
[plans/response-display](../plans/phase-3.5-response-display.md)。

## Consequences

### Positive

- 指示→返答が同梱ダッシュボード単体で完結し、実運用検証のブロッカーが解消。
- 返答表示が公開 API(`log`/`result`)を増やし、外部クライアントも使う面を
  dogfooding できる(ADR-0007 の精神と整合)。
- Wizardry 風の枠付き窓がリッチ化の自制(会話オーサリング環境化の回避)として
  働く(issue #21 の実装方針)。

### Negative

- 同梱ダッシュボードの責務と保守面が広がる(ADR-0007 の「最小限」を改訂)。
- `log` ストリームで wire 量が増える。

### Neutral

- viewer/operator の既存 role に配信制御を乗せるだけで、新規認可機構は作らない。
- インメモリ履歴は `AgentStates` の小改修で足り、新規 DB 依存なし。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| 返答中継のみ実装し表示は外部クライアントへ委譲(旧案 C) | 同梱だけで実運用検証が完結しない |
| ダッシュボードを「最小限」のまま維持 | 指示の返答が見えず双方向が半完成 |
| 返答を result のみ表示(最終応答1件、旧案 A) | ターン途中の経過が見えない |
| フルチャット会話ペイン(旧案 D) | 会話オーサリング環境化で過剰 |
| 常時 master-detail 2ペイン | 俯瞰(多数の顔)を細いリストに圧縮 |
| モーダル/スライドで一覧を画面外へ | 一覧性(goal A)を失う |
| グリッドカードを簡素化(顔/名/状態のみ) | 情報密度を望むユーザ意向に反する |
| 返答ログを全 role へ配信 | viewer にシークレットが露出し得る |
| サーバ履歴をディスク永続(B)を今回実施 | 書き込み量増・secrets-at-rest → issue #24 |
| サーバ履歴なし(最新1件のみ) | 再読込でログが消える |

## Related

- 解消: issue #13(返答表示)、旧 open-question `response-display`
- 実装: [plans/response-display](../plans/phase-3.5-response-display.md)
  (phase-0 MVP / phase-1 ゲーム風ポリッシュ = issue #21)
- 将来: issue #24(履歴ディスク永続)、#25(3列+応答タイムライン)、
  #16(token/context を `ext` で可視化)
- 関連 ADR: [0007](0007-client-separation-reference-dashboard.md)、
  [0010](0010-protocol-precisification.md)、
  [0011](0011-phase3-reliability-and-auth.md)、
  [0014](0014-session-resume-and-restore.md)
