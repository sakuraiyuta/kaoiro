---
title: Phase 1.5 — 最小サーバ + 最小クライアント(トレーサーバレット)
description: 最小 Phoenix サーバと文字/色のみの最小 Web 表示で縦串を通し、エンベロープを実消費者で確定する。
status: done
phase: 1.5
depends_on: [phase-1-wrapper-state-machine]
last_updated: 2026-06-11
---

# Phase 1.5 — 最小サーバ + 最小クライアント(トレーサーバレット)

## Goal

ラッパー → Phoenix サーバ → Web クライアント(文字/色のみ)の縦串を最小実装で
貫通させる。kaoiro エンベロープ(type/payload)を実消費者ありで確定し、
TS↔Elixir 境界の統合リスクをキャラ絵(Phase 2)より先に潰す
(採否の経緯: issue #2)。

## Acceptance Criteria

- [x] 最小 Phoenix サーバがラッパー 1 個の WebSocket 接続を受け、
      状態イベントをクライアントへ中継できる(E2E スモーク検証済)
- [x] 最小 Web 表示(文字/色のみ)がブラウザで状態変化に追従する
      (Playwright で追従・リロード後のスナップショット復元を実証)
- [x] エンベロープの type/payload が実消費者で検証され、
      [protocol](../specs/protocol.md) を `accepted` へ更新できる
      ([ADR-0010](../adr/0010-protocol-precisification.md))
- [x] クライアント接続方式が決定される
      ([ADR-0009](../adr/0009-client-transport.md): Channels 一本化、
      2026-06 調査に基づき決定済み)

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1.5-1 | クライアント接続方式の調査・決定 | ✅ | issue #11。Channels 一本化に決定([ADR-0009](../adr/0009-client-transport.md)) |
| 1.5-2 | 最小 Phoenix サーバ(1 ラッパー受信 → 中継) | ✅ | `server/`(Channels 中継 + AgentStates)+ ラッパー側 `ServerLink`。認証・複数集約は Phase 3 へ |
| 1.5-3 | 最小 Web 表示(文字/色のみ) | ✅ | `server/priv/static/` — 依存ゼロの Channels V2 直実装(公開プロトコル実装可能性の実証)。Svelte 版は issue #12([ADR-0007](../adr/0007-client-separation-reference-dashboard.md))で置換 |
| 1.5-4 | エンベロープ type/payload の確定 | ✅ | 実証範囲のみ確定([ADR-0010](../adr/0010-protocol-precisification.md))。protocol spec を accepted 化 |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## Scope Boundaries

- キャラ絵・表情マッピングは扱わない(Phase 2)。
- 複数エージェント集約・双方向ルーティング・認証/TLS は扱わない(Phase 3)。
- 表示は文字/色のみ。見た目の作り込みはしない。

## Open Questions Blocking This Phase

なし(client-transport は [ADR-0009](../adr/0009-client-transport.md)、
protocol-precisification は
[ADR-0010](../adr/0010-protocol-precisification.md) で解消)。

## See Also

- Specs: [protocol](../specs/protocol.md),
  [architecture](../specs/architecture.md)
- ADRs: [0002](../adr/0002-local-wrapper-websocket-topology.md),
  [0007](../adr/0007-client-separation-reference-dashboard.md),
  [0009](../adr/0009-client-transport.md)
- Previous: [phase-1-wrapper-state-machine](phase-1-wrapper-state-machine.md)
- Next: [phase-2-client-character](phase-2-client-character.md)
