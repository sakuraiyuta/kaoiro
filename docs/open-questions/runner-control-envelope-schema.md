---
title: runner 制御メッセージ(spawn/stop/restart/enumerate-sessions)の schema
description: runner ↔ server の制御メッセージのトピック設計・イベント名・payload の確定。supervisor 専任は決定済み。
status: open
urgency: medium
blocks: [phase-4-host-runner]
opened: 2026-06-24
decided: null
---

## 背景

[ADR-0023](../adr/0023-host-runner-architecture.md) で「runner は supervisor 専任
(spawn/stop/restart/監視 + session 列挙)」「wrapper はサーバへ直結維持」が決定済み。
残る論点は **runner ↔ server の制御メッセージの具体形**。現状 [protocol](../specs/protocol.md)
は client→wrapper 制御(instruction / permission_decision / interrupt /
clear_history / delete_agent)のみ定義し、runner 向け制御・ホスト登録は未定義。

この制御経路は UI からのリモート spawn([#22](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/22))と
セッション復帰([ADR-0014](../adr/0014-session-resume-and-restore.md) phase-1)が
共有する。protocol 変更は予約追補に留まらず**新規メッセージ種別の追加**となる。

## 選択肢

| 論点 | 案 |
|------|-----|
| トピック設計 | (a) 専用 `runner:<host_id>` トピック / (b) 既存 `wrapper:` 系へ相乗り |
| メッセージ形式 | (a) Channels イベント(既存 instruction 等と同型、推奨)/ (b) envelope `type` を増やす |
| host 識別子 | 設定固定の `host_id` / 登録時にサーバ採番 |
| 認証 | agent_id 別トークン(ADR-0011)と別に **host 別トークン**を設けるか([ADR-0011](../adr/0011-phase3-reliability-and-auth.md) 拡張) |
| server→runner payload | `spawn`(agent_id / persona / cwd / server_url / token / resume session_id?)/ `stop`・`restart`(agent_id)/ `enumerate_sessions`(cwd) |
| runner→server payload | `register`(host_id / 稼働可能ペルソナ / 選択可能 cwd 許可リスト / capabilities)/ `heartbeat` / `sessions`(JSONL メタ list)/ `spawn_result`(成否) |

## 影響

protocol の「方向別メッセージ種別」、server の新規 channel(例 `RunnerChannel`)、
runner 実装(Phase 4)、#22 の spawn UI、[ADR-0014](../adr/0014-session-resume-and-restore.md)
の resume 経路すべてに波及。Phase 4 タスク 4-1 の前提。

## 判断材料

- 既存の制御は **Channels イベント方式 + operator gate** で統一されており、(a) が
  自然。envelope `type` は state/log/result/task の観測データ用で、制御は方向別
  メッセージが既定路線。
- spawn は実質リモートコード実行(RCE)。**operator 限定**、resume 対象 session_id
  は当該 agent 束縛 cwd 配下に**実在検証**、JSONL メタ露出は最小限
  ([threat-model](../specs/threat-model.md) T1/T2/T3、[ADR-0014](../adr/0014-session-resume-and-restore.md) F6)。
- 二重起動防止は server owner フェンシング + runner ローカルロックの二段
  ([ADR-0014](../adr/0014-session-resume-and-restore.md) F4)。ロック状態を
  どの制御メッセージで観測・調停するかも要設計。
- version 方針([ADR-0015](../adr/0015-protocol-version-stamping.md)): 新規メッセージ
  種別の追加は受信側の未知無視で前方互換だが、`version` 据え置きか上げるかは確定時判断。
- 選択可能 cwd の許可リストは runner config が保持し `register` で申告(#22 F3。
  host 側へ複雑性を寄せる、[ADR-0023](../adr/0023-host-runner-architecture.md))。

## 暫定方針

専用 `runner:<host_id>` トピック + **Channels イベント方式**。server→runner =
`spawn` / `stop` / `restart` / `enumerate_sessions`、runner→server = `register` /
`heartbeat` / `sessions` / `spawn_result`。host 別トークン認証を ADR-0011 の枠組で
追加。詳細は Phase 4 着手時に [ADR-0023](../adr/0023-host-runner-architecture.md) を
追補して確定。

## 解決時のアクション

- [ ] [protocol](../specs/protocol.md) の「方向別メッセージ種別」へ runner 制御行を追補
- [ ] [phase-4-host-runner](../plans/phase-4-host-runner.md) のタスク 4-1 を進行/完了へ
- [ ] このファイルを削除(必要なら [ADR-0023](../adr/0023-host-runner-architecture.md) を追補)
