---
title: 既存エージェントの召喚(既存セッション再開)— 設計
description: 既存セッション(claude agents 相当)を列挙し resume で召喚する機能と呼び出しボタンの設計論点。
status: open
urgency: medium
blocks: []
opened: 2026-06-15
decided: null
---

## 背景

wrapper は現状つねに新規セッションを開始する(`wrapper/src/host.ts` で
`session_id: ""` を送り、SDK が新規発行)。過去の文脈を引き継いだ「続き」が
できないため、wrapper を動かすマシンの既存セッション(`claude agents` 相当 =
SDK `listSessions()` / `~/.claude/projects/*.jsonl`)を「召喚」して再開し、参照
クライアントから呼び出せるようにしたい。やりたいことは明確だが、相互依存する
設計論点が多く、まず論点を残す(詳細収束は my-spec-elicitation で行う)。

## 選択肢(論点)

| 論点 | 案 |
|------|-----|
| セッション列挙の主体・経路 | wrapper がローカル列挙 → server 集約 → client 表示。列挙手段は SDK `listSessions()` か `claude agents` shell-out か |
| server 側のセッション保持 | 一覧をサーバが保持するなら wrapper が session_id を報告する仕組みが要る。履歴ディスク永続は issue #24 未実装に依存 |
| 再開の意味 | `resume`(履歴ロード)/ `continue`(直近継続)/ `forkSession`(分岐)の使い分けと UI 文言(召喚 / 再開 / 分岐) |
| 再開後の入力 | resume したセッションに以降の streaming 入力(指示・承認)を流せるか(SDK 挙動が未確認) |
| 召喚プロトコル | `wrapper:{agent_id}` への新イベント(例 `summon {session_id}`)。payload は session_id のみか metadata も含むか([protocol](../specs/protocol.md) へ追補) |
| 呼び出しボタンの認可 | operator のみか(viewer 不可)。指示・承認と同等が自然 |
| 別プロセス / 別マシン | 別プロセスの session を resume できるか(鍵・スコープ)。無効 / 削除済み session_id の SDK エラー挙動とハンドリング |

## 影響

未着手の間は wrapper は新規セッションのみで、過去の作業文脈を引き継げない(実害
は機能欠如のみ。既存挙動は壊れない)。サーバ側のセッション一覧提供は issue #24
(履歴永続)と密接で、先行すると二重実装になりうる。

## 判断材料

- SDK には `resume` / `continue` / `forkSession` オプションがある
  (`@anthropic-ai/claude-agent-sdk` 型定義)。
- server はセッション履歴を保持せず最新 envelope + リングバッファのみ
  (`server/lib/kaoiro_server/agent_states.ex`)。
- 通信は Phoenix Channels、inbound は現状 `instruction` / `permission_decision`
  のみ(`wrapper/src/transport.ts`)。召喚は新イベント追加が必要。

## 暫定方針

機能追加は行いたい(優先度は中)。ただし論点が相互依存するため、詳細設計は
my-spec-elicitation で収束させてから ADR / plan へ昇格する。issue #24(履歴
永続)との順序関係を先に整理する。

## 解決時のアクション

- [ ] my-spec-elicitation で設計を収束(列挙経路・resume 意味・プロトコル・認可)
- [ ] 召喚イベントと認可を [protocol](../specs/protocol.md) へ追補
- [ ] wrapper / server / ダッシュボードの実装
- [ ] このファイルを ADR へ昇格(または削除)
