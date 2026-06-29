---
title: Phase 8 — エージェント間メッセージング
description: 複数 AI エージェントの直接対話を可能にする。Stage A 仕様整合→Stage B Phase 1 MVP(ユーザ明示指示)→Stage C Phase 2 permission gate 改善。Stage D Phase 3(自発判断)は #87 完了後。
status: planned
phase: 8
depends_on: [phase-3-server-multiagent, phase-4-host-runner]
last_updated: 2026-06-29
---

# Phase 8 — エージェント間メッセージング

複数 AI エージェントが kaoiro サーバを介して直接メッセージをやり取り
できるようにする。kaoiro issue #17 の本実装、kaoiro issue #18
(メッセージフィルタ)とセット、kaoiro issue #87(複数 AI エージェント
間の協調コミュニケーション設計の調査)が前提整理を兼ねる傘 issue。

envelope schema 等の機械的仕様は
[protocol-inter-agent spec](../specs/protocol-inter-agent.md)(後続作業
で起こす)に切り出し、本 plan は段階的実装計画のみを扱う。

## Goal

ユーザの「@agent-a と @agent-b で X について議論して結論を出して」と
いった明示指示を起点に、エージェント A・B が kaoiro サーバ経由で
メッセージをやり取りし、相談・議論・依頼の 3 系統の対話を構造化された
envelope で実現する。観測経路を二重化し、dashboard で対話の全過程を
追えること。

## Non-goals(本 Phase の外、#87 完了後の Stage D 以降)

- エージェントが**自発的に**他エージェントへ問合せる経路(Phase 3)
- 自動承認 + quota/cooldown による無人運用
- 自然言語による「次の発話者選定」(AutoGen の動的 group chat 相当)
- メッセージのフィルタ・検閲・変換(kaoiro issue #18 で別途扱う、
  Phase 2 以降に検討)

## Stage A — pre-spike(仕様整合確認)

実装着手前に既存 envelope 規約・送信ツール経路・dashboard log 表示の
現状を把握し、新規 envelope 種が違和感なく載るかを確認する。

| 項目 | 目的 | アウトプット |
|--|--|--|
| IN1 | 既存 envelope の命名規約(runner 制御 #66、 subagent-tasks 等)を読み、`from`/`to` の指す対象、 kind 文字列の case、 共通 base 型の有無を把握 | spec ドラフト着手時の整合ガイド |
| IN2 | 送信ツールの実装場所(wrapper の MCP/in-process tool 注入経路) | `send_to_agent` ツールの設置場所決定 |
| IN3 | dashboard log の表示経路と既存 log envelope 形状 | observation path での `inter_agent_message` 描画方針確定 |

完了基準: 上記 3 項目の調査結果を spec ドラフト
`docs/specs/protocol-inter-agent.md`(新規)に反映し、 envelope schema
を機械可読な形で確定する。

## Stage B — Phase 1: ユーザ明示指示による A→B(MVP)

ユーザが明示的に「@agent-a → @agent-b」と指示した場合のみ
エージェント間メッセージが流れる最小実装。 wire + ツール + routing +
observation + 承認 + 安全弁の骨格を実証する。

**Phase 1 完了時点でユーザレビュー → コミット → push を挟む。**
Stage C への進行は次セッション以降で判断。

### IN(含む)

- `send_to_agent(agent_id, message, kind, meta)` ツール(wrapper)
- envelope schema 9 種 kind(`request` / `response` / `query` /
  `inform` / `propose` / `accept` / `reject` / `escalate-to-user` /
  `done`)。 fields: `from` / `to` / `conversation_id` / `turn_number` /
  `kind` / `payload` / `meta {done, propose_next, confidence?,
  reject_reason?}` / `owner {kind, id}`
- server: envelope ルーティング(B のセッションへ deliver) +
  observation broadcast(dashboard log stream へ複製)
- dashboard: `kind: "inter_agent_message"` を A・B 両方の log 欄に
  表示
- wrapper: ツール呼び出しを既存 `permission_broker` の都度承認に
  繋ぐ。 dialog に宛先 `agent_id` と payload 抜粋を表示
- ハード制限 config: `max_turns` / `max_tokens` / `max_wallclock` /
  `max_concurrent_agents` per conversation。 既定値は spec 側で確定。
  超過時は server が conversation を強制終了、 dashboard に「未合意
  打ち切り」ステータスを記録

### OUT(明示的に外す、Stage C 以降または将来)

- 都度承認 dialog の UX 改善(まず素の dialog で動かす)
- 自動承認 / quota / cooldown
- 自発判断(LLM が自分で `send_to_agent` を選ぶ経路は許可するが、
  permission_broker の都度承認で常にユーザに介入余地を残す)
- メッセージフィルタ(kaoiro issue #18)
- conversation の再開・履歴 resume(Phase 4 / ADR-0014 範疇)
- リモート host 間ルーティング(まず同一 server 内のエージェント間)

### 完了基準

- ユーザが dashboard から「@agent-a 〜 @agent-b と X について相談
  して」と指示 → A が `send_to_agent` を呼ぶ → 都度承認後に B の
  セッションに envelope が到達 → B が応答 → 同経路で A に返り、
  両 dashboard log に対話履歴が観測できる
- ハード制限(max_turns 等)が機械的に効き、 quota 超過で自動停止
  する
- spec の envelope schema と実装が一致(typecheck / lint パス)

### 層別スライス(順序)

| 順 | 層 | 内容 |
|--|--|--|
| 1 | spec | `docs/specs/protocol-inter-agent.md` を確定(envelope / kind / meta / owner / ハード制限既定値) |
| 2 | server | envelope routing + observation broadcast + hard limit 監視タイマー |
| 3 | wrapper | `send_to_agent` ツール定義、 permission_broker への接続、 受信 envelope の SDK 入力注入 |
| 4 | dashboard | `inter_agent_message` の log 表示、 permission dialog の宛先表示 |
| 5 | config | `max_turns` / `max_tokens` / `max_wallclock` /`max_concurrent_agents` の設定項目化 |
| 6 | E2E | 2 エージェント環境で相談 → 議論 → 合意 → done の 1 ラウンドを通す |

## Stage C — Phase 2: permission gate 改善 + リファクタ

Phase 1 の都度承認 dialog をエージェント間メッセージング用に磨き、
Stage B で目立った重複・命名の整理を行う。 kaoiro issue #17 のゴールは
Stage C 完了まで。

### IN(含む)

- permission dialog の専用 UI(送り手 / 受け手 / kind / payload 全文 /
  meta の構造化表示)
- 「この conversation はこの先全部許可」のオプトイン(per
  conversation_id の whitelist、 セッション内有効)
- リファクタ: Stage B で重複した envelope バリデーション、 quota 監視
  ロジックを sites of duplication で集約
- kaoiro issue #18(メッセージフィルタ)着手要否の判断

### OUT(Stage D 以降)

- 永続的な whitelist(プロセス再起動越え)
- 完全自動承認(quota のみ機械ガード)
- 自発判断による相手選定

### 完了基準

- permission dialog でメッセージ内容を読まずに承認しないで済む
  情報量を確保
- 同一 conversation の連続承認が「都度クリック」から「最初の同意」
  で進む
- リファクタ後も Stage B の E2E が通る

## 将来 — Stage D / Phase 3(#87 完了後)

kaoiro issue #87(複数 AI エージェント間の協調コミュニケーション設計の
調査)の結論待ち。観点:

- 自動承認 + quota/cooldown による無人運用の境界
- 自発判断(broker は人 / 自動 routing)
- consensus / consent / 多数決 / tie-breaker の運用ルール
- conversation owner 概念の自動エスカレーション規則
- kaoiro issue #18(メッセージフィルタ)実装

Phase 3 着手は本 plan のスコープ外。 #87 の方針が固まった時点で
別 plan(または本 plan の追補)として起こす。

## 参照

- [protocol-inter-agent spec](../specs/protocol-inter-agent.md)(後続
  作業で起こす envelope 機械的定義)
- [protocol spec](../specs/protocol.md) — 既存 envelope 共通基盤
- [ADR-0010 protocol-precisification](../adr/0010-protocol-precisification.md)
- [ADR-0019 subagent/workflow entity and task envelope](../adr/0019-subagent-workflow-entity-and-task-envelope.md) — 既存 envelope 命名規約の参考
- kaoiro issue #17 — エージェント間メッセージング本体(本 plan の起点)
- kaoiro issue #18 — メッセージフィルタ(Stage C 以降の判断材料)
- kaoiro issue #87 — 複数 AI エージェント間の協調コミュニケーション
  設計の調査(Stage D 以降の前提整理)
