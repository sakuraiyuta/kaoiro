---
title: Phase 3 — サーバ集約 + 複数エージェント + 双方向
description: Elixir/Phoenix サーバで複数ラッパーを集約し、指示・承認を双方向ルーティングする。
status: planned
phase: 3
depends_on: [phase-2-client-character]
last_updated: 2026-06-11
---

# Phase 3 — サーバ集約 + 複数エージェント + 双方向

## Goal

サーバ(Elixir/Phoenix)で複数ラッパーを WebSocket 集約し、複数エージェントを
同時可視化、特定エージェントへ指示・承認を送れるようにする。

## Acceptance Criteria

- [ ] 複数 Claude Code を並行運用し同時可視化
- [ ] 「どれが何をしているか/どれが手待ちか」が一目で分かる
- [ ] 任意の1体に指示を送れる(双方向)
- [ ] 権限承認をクライアント UI から許可/拒否できる
- [ ] ペルソナ割り当て(どのホスト/プロセスがどのペルソナか)をユーザが指定
- [ ] 再起動をまたいでペルソナが維持される
- [ ] 接続断(`disconnected`)・トークン認証・TLS・ハートビート

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 3-1 | Phoenix Channels で複数ラッパー集約 | ⏳ | 1接続=1 GenServer |
| 3-2 | 指示・承認の双方向ルーティング | ⏳ | |
| 3-3 | ラッパートークン認証 + TLS + ハートビート | ⏳ | 稼働想定はセルフホスト基盤の既存リバースプロキシ配下(2026-06-11 決定)。TLS はプロキシ終端、Phoenix は平文 HTTP |
| 3-4 | ユーザアクセス制御 stub(ホワイトリスト) | ⏳ | [ADR-0005] |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## Followups (in-phase but unfinished)

- 本格的な OAuth + RBAC は将来([ADR-0005](../adr/0005-access-control-oauth-stub.md))。

## Open Questions Blocking This Phase

なし。

## See Also

- Specs: [architecture](../specs/architecture.md),
  [protocol](../specs/protocol.md)
- ADRs: [0002](../adr/0002-local-wrapper-websocket-topology.md),
  [0003](../adr/0003-persona-identity-persistence.md),
  [0005](../adr/0005-access-control-oauth-stub.md)
- Previous: [phase-2-client-character](phase-2-client-character.md)
