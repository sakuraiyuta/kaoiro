---
title: クライアントは別プロジェクト分離、リファレンスダッシュボードを同梱
status: accepted
date: 2026-06-10
opened: 2026-06-10
supersedes: []
superseded_by: null
related_specs: [architecture, non-goals, protocol]
related_adrs: [4, 5, 8, 9, 12, 20]
---

# ADR-0007 — クライアントは別プロジェクト分離、リファレンスダッシュボードを同梱

## Status

Accepted

## Context

クライアントの提供形態が問題だった。Electron ベースのリッチ GUI・ターミナル
CUI・neovim プラグインなど多様なクライアントをユーザが選べるようにしたい。
一方、クライアントを別途用意しないと試せない形は導入の敷居が高い。また、
リファレンス実装を LiveView で作るとサーバ内部の PubSub を直接消費し、外部
クライアントが使う公開 API を通らないため、参照実装・適合性検証としての
価値を失う。

## Decision

- クライアント実装は**別プロジェクト(リポジトリ)として分離**する。サーバ ↔
  クライアント API は**公開プロトコルとして文書化・バージョニング**する。
- 本体には**リファレンス用の簡易ダッシュボード(ブラウザ)を同梱**し、
  Phoenix で配信する。実装は **Svelte 5 + Vite(素の SPA、SvelteKit
  不使用)**。プロトコル層(接続・購読・指示・承認応答)は Svelte 非依存の
  素の TS モジュールに分離する。
- 簡易ダッシュボードは LiveView ではなく、**外部クライアントと同一の公開
  API を消費**する(dogfooding = プロトコルの参照実装・適合性検証)。
- サーバ設定で簡易ダッシュボードの**静的配信のみオフ**にできる
  (チャネル/API は常時有効)。既定はオン。
- スコープは最小限(状態一覧・表情・承認・指示入力)に固定する
  ([non-goals](../specs/non-goals.md))。

## Consequences

### Positive

- ブラウザだけで試用でき、導入の敷居が低い。
- 公開 API が同梱クライアントで常時検証される(参照実装・適合性テスト)。
- クライアントがアダプタ/フィルタに続く第3の拡張面として明確になる。

### Negative

- 公開 API の後方互換維持が責務になる。
- サーバリポジトリに TS ビルド(Vite)が同居する。

### Neutral

- 接続方式は Phoenix Channels に一本化で決定済み
  ([ADR-0009](0009-client-transport.md))。
- 同梱ダッシュボードのソース位置は repo ルートの `dashboard/`(issue #44 で
  `server/assets/` から移出、独立 pnpm ルート + 独立 lockfile)。「同梱」は
  リリースビルド時に成果物を焼き込む形で維持し、成果物はコミットしない
  (`server/Dockerfile` の node ステージ)。別リポジトリ化は依然未着手。
- 描画種別の段階導入([ADR-0004](0004-client-rendering-staged.md))は各
  クライアントの関心事になる。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| LiveView でダッシュボード実装 | 公開 API を通らず参照実装にならない |
| クライアントも本体に同梱(モノレポ) | 多様なクライアントの増殖に不向き、コアが肥大 |
| 同梱クライアントなし | 試用の敷居が高い |
| SvelteKit 採用 | SSR/ルーティング機構が過剰。素の Vite SPA で足りる |
