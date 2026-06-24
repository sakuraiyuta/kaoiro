---
title: Phase 4 — ホスト常駐 runner
description: 各ホストに常駐 runner を置き、wrapper の spawn/監督/再起動とホスト登録・生存通知・session 列挙を担わせる。
status: planned
phase: 4
depends_on: [phase-3-server-multiagent]
last_updated: 2026-06-24
---

# Phase 4 — ホスト常駐 runner

## Goal

各ホストに常駐プログラム runner を 1 つ置き、サーバと wrapper の間で**ホスト内
エージェント群のライフサイクル**を担わせる。wrapper の直結トポロジは維持しつつ、
UI からの起動・再起動・取りまとめの主体を導入する(supervisor 専任、
[ADR-0023](../adr/0023-host-runner-architecture.md))。これは UI からのリモート
spawn([#22](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/22))と
セッション復帰([ADR-0014](../adr/0014-session-resume-and-restore.md))の前提層。

なお [#22](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/22) 自体は本層の
上に載る **起動指示 UI + client→server 要求**(spawn/resume)へ範囲を限定し、ホスト
概念・spawn 中継・schema・runner 実行は本フェーズのタスク(4-1〜4-6)が担う。

## Acceptance Criteria

- [ ] runner がサーバへ常時接続し、自ホストを登録・生存通知する。
- [ ] operator 指示で runner がホスト内 wrapper を spawn / stop / restart する。
- [ ] 1 wrapper = 1 agent = 1 process を runner が監督し、クラッシュを隔離する。
- [ ] wrapper は従来どおりサーバへ直結し、データ経路は runner を通らない。
- [ ] 二重起動が server owner フェンシング + runner ローカルロックの二段で防がれる。
- [ ] runner / wrapper が `kaoiro-runner` 単一バイナリとして配布できる
      ([ADR-0018](../adr/0018-runner-distribution.md))。
- [ ] operator が起動 UI から (host / persona / 登録済み cwd / 初期プロンプト) を
      指定して新規 spawn でき、同 UI から既存セッションの resume もできる(範囲=中。
      任意 cwd / 任意 repo clone は初版外、
      [#22](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/22))。

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 4-1 | 制御 envelope(spawn/stop/restart/enumerate-sessions)の schema 確定 | ✅ | #66 で確定。[protocol](../specs/protocol.md)「runner 制御メッセージ」へ追補・[ADR-0023](../adr/0023-host-runner-architecture.md) に決定記録。#22 と共有 |
| 4-2 | server: ホスト登録・生存通知の受け口 + spawn 中継経路 | ⏳ | 「ホスト」概念をサーバへ導入(現状 agent_id 単位のみ) |
| 4-3 | server: runner ローカルロックと連携した二重起動防止 | ⏳ | owner フェンシング(既存)+ runner ロック([ADR-0014](../adr/0014-session-resume-and-restore.md) F4) |
| 4-4 | runner: プロセス監督ループ + config 解決 + spawn/stop/restart | ⏳ | TS/Node。wrapper config(agent_id/persona/server_url/token/...)を解決して spawn |
| 4-5 | runner: session JSONL 列挙 + resume 起動 | ⏳ | 当該 cwd 配下を列挙、T3 実在検証([ADR-0014](../adr/0014-session-resume-and-restore.md) F2/F6) |
| 4-6 | wrapper: resume flag(`--resume <session_id>` 等)追加 | ⏳ | [ADR-0014](../adr/0014-session-resume-and-restore.md) phase-1 と整合 |
| 4-7 | `kaoiro-runner` 単一バイナリ化 | ⏳ | [ADR-0018](../adr/0018-runner-distribution.md)。主要機能が出揃ってからでも可 |
| 4-8 | dashboard: 起動指示 UI(host/persona/登録済み cwd/初期プロンプト)+ client→server spawn 要求 | ⏳ | #22 phase-0。範囲=中(任意 cwd/repo 除外)。cwd は runner config allow-list 由来。4-1/4-2/4-4 依存 |
| 4-9 | dashboard: 起動 UI に resume(runner 列挙の session_id 候補選択)追加 | ⏳ | #22 phase-1。4-5/4-6 依存。JSONL メタ最小露出(operator)/cwd 実在検証。表示履歴復元は [#50](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/50) 連携 |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## 起動 UI スコープ (#22)

- 範囲 = **中**(host+persona 選択 + 初期プロンプト + 登録済み cwd 選択)。
  任意 cwd / 任意 repo clone は RCE 面拡大のため初版外
  ([threat-model](../specs/threat-model.md) T1/T5、却下)。
- 選択可能 cwd の許可リストは **runner config** が保持し、登録時に persona と
  並べて申告(host 側へ複雑性を寄せる、
  [ADR-0023](../adr/0023-host-runner-architecture.md))。schema は 4-1 /
  [protocol](../specs/protocol.md)「runner 制御メッセージ」(#66 確定)。
- 新規 / resume は単一の起動導線で「新規 / 既存セッション再開」を切替(暫定)。
- spawn 成否は `spawn_result` 受信で UI(グリッド/トースト)へ反映(暫定)。

## Followups (in-phase but unfinished)

なし。

## Open Questions Blocking This Phase

なし(制御 envelope schema は #66 で確定。[protocol](../specs/protocol.md)「runner
制御メッセージ」)。

## See Also

- ADR: [0023](../adr/0023-host-runner-architecture.md)(本フェーズの決定)、
  [0014](../adr/0014-session-resume-and-restore.md)(resume の生存単位)、
  [0018](../adr/0018-runner-distribution.md)(配布)。
- Specs: [architecture](../specs/architecture.md),
  [protocol](../specs/protocol.md), [threat-model](../specs/threat-model.md)。
- 関連 issue:
  [#23](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/23)(本フェーズ)、
  [#22](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/22)(起動指示 UI +
  要求層。範囲=中、resume 含む)。
- Previous: [phase-3-server-multiagent](phase-3-server-multiagent.md)
