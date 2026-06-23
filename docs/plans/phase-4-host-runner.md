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

## Acceptance Criteria

- [ ] runner がサーバへ常時接続し、自ホストを登録・生存通知する。
- [ ] operator 指示で runner がホスト内 wrapper を spawn / stop / restart する。
- [ ] 1 wrapper = 1 agent = 1 process を runner が監督し、クラッシュを隔離する。
- [ ] wrapper は従来どおりサーバへ直結し、データ経路は runner を通らない。
- [ ] 二重起動が server owner フェンシング + runner ローカルロックの二段で防がれる。
- [ ] runner / wrapper が `kaoiro-runner` 単一バイナリとして配布できる
      ([ADR-0018](../adr/0018-runner-distribution.md))。

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 4-1 | 制御 envelope(spawn/stop/restart/enumerate-sessions)の schema 確定 | ⏳ | [runner-control-envelope-schema](../open-questions/runner-control-envelope-schema.md) を解決し [protocol](../specs/protocol.md) へ追補。#22 と共有 |
| 4-2 | server: ホスト登録・生存通知の受け口 + spawn 中継経路 | ⏳ | 「ホスト」概念をサーバへ導入(現状 agent_id 単位のみ) |
| 4-3 | server: runner ローカルロックと連携した二重起動防止 | ⏳ | owner フェンシング(既存)+ runner ロック([ADR-0014](../adr/0014-session-resume-and-restore.md) F4) |
| 4-4 | runner: プロセス監督ループ + config 解決 + spawn/stop/restart | ⏳ | TS/Node。wrapper config(agent_id/persona/server_url/token/...)を解決して spawn |
| 4-5 | runner: session JSONL 列挙 + resume 起動 | ⏳ | 当該 cwd 配下を列挙、T3 実在検証([ADR-0014](../adr/0014-session-resume-and-restore.md) F2/F6) |
| 4-6 | wrapper: resume flag(`--resume <session_id>` 等)追加 | ⏳ | [ADR-0014](../adr/0014-session-resume-and-restore.md) phase-1 と整合 |
| 4-7 | `kaoiro-runner` 単一バイナリ化 | ⏳ | [ADR-0018](../adr/0018-runner-distribution.md)。主要機能が出揃ってからでも可 |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## Followups (in-phase but unfinished)

なし。

## Open Questions Blocking This Phase

- [runner-control-envelope-schema](../open-questions/runner-control-envelope-schema.md)
  — 制御 envelope(spawn/stop/restart/enumerate-sessions)の具体スキーマ(4-1 の前提)。

## See Also

- ADR: [0023](../adr/0023-host-runner-architecture.md)(本フェーズの決定)、
  [0014](../adr/0014-session-resume-and-restore.md)(resume の生存単位)、
  [0018](../adr/0018-runner-distribution.md)(配布)。
- Specs: [architecture](../specs/architecture.md),
  [protocol](../specs/protocol.md), [threat-model](../specs/threat-model.md)。
- 関連 issue:
  [#23](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/23)(本フェーズ)、
  [#22](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/22)(UI からの
  リモート spawn、本層の上に載る)。
- Previous: [phase-3-server-multiagent](phase-3-server-multiagent.md)
