---
title: Phase 3 — サーバ集約 + 複数エージェント + 双方向
description: Elixir/Phoenix サーバで複数ラッパーを集約し、指示・承認を双方向ルーティングする。
status: in_progress
phase: 3
depends_on: [phase-2-client-character]
last_updated: 2026-06-11
---

# Phase 3 — サーバ集約 + 複数エージェント + 双方向

## Goal

サーバ(Elixir/Phoenix)で複数ラッパーを WebSocket 集約し、複数エージェントを
同時可視化、特定エージェントへ指示・承認を送れるようにする。

## Acceptance Criteria

- [x] 複数 Claude Code を並行運用し同時可視化(3 接続同時を実機検証)
- [x] 「どれが何をしているか/どれが手待ちか」が一目で分かる
- [x] 任意の1体に指示を送れる(双方向)
- [x] 権限承認をクライアント UI から許可/拒否できる(relay 実機検証済。実エージェントの ask 経路起動は issue #1 調査中)
- [x] ペルソナ割り当て(どのホスト/プロセスがどのペルソナか)をユーザが指定(wrapper config、Phase 1 から)
- [x] 再起動をまたいでペルソナが維持される(安定 agent_id + config、[ADR-0003](../adr/0003-persona-identity-persistence.md))
- [x] 接続断(`disconnected`)・トークン認証・TLS・ハートビート(TLS はプロキシ終端)

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 3-1 | Phoenix Channels で複数ラッパー集約 | ✅ | 1接続=1 channel プロセス + `AgentStates`(owner 追跡で再接続レース防止)。実装は Phase 1.5 から、disconnected 導出で完結(2026-06-11) |
| 3-2 | 指示・承認の双方向ルーティング | 🟡 | `instruction` / `permission_decision` relay + 承認 UI + wrapper の `PermissionBroker`(600 秒 deny、[ADR-0011](../adr/0011-phase3-reliability-and-auth.md))実装・実機検証済。残: 実エージェントで canUseTool ask 経路を起動する条件(issue #1 調査中) |
| 3-3 | ラッパートークン認証 + TLS + ハートビート | ✅ | agent_id 別トークン([ADR-0011])。TLS はプロキシ終端(2026-06-11 決定)、ハートビートは Channels 組み込み。切断は terminate で `disconnected` をサーバ導出 |
| 3-4 | ユーザアクセス制御 stub(ホワイトリスト) | ✅ | ユーザトークン + role(viewer/operator、[ADR-0011])。env 未設定は dev mode(全接続 operator) |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## Followups (in-phase but unfinished)

- issue #1: 実エージェント(Agent SDK ヘッドレス)で canUseTool ask 経路を
  起動する条件の確定。配線(`PermissionBroker` → 承認 UI)は実装済みで、
  ask 経路が有効化されれば機能する。
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
