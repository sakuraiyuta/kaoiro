---
title: ラッパーはローカル動作、WebSocket で中央サーバへ集約
status: accepted
date: 2026-06-04
opened: 2026-06-04
supersedes: []
superseded_by: null
related_specs: [architecture]
related_adrs: [1, 23]
---

# ADR-0002 — ラッパーはローカル動作、WebSocket で中央サーバへ集約

## Status

Accepted

## Context

ラッパーをどこで動かし、サーバとどう繋ぐかが問題だった。ラッパーは Agent SDK
をホストするため非 Elixir(TS、[ADR-0001](0001-agent-sdk-integration.md))で
あり、かつエージェントを spawn・観測する都合上エージェントと同居する必要がある。
複数ホスト/プロセスを跨ぐ構成も求められる。

## Decision

ラッパーは各エージェントと同居して**ローカル動作**。複数ホスト/プロセスが
**Phoenix Channels(WebSocket)**で中央サーバ(Elixir)へ接続する。サーバは
1接続=1 GenServer で最新状態を保持・配信する。

> **追補([ADR-0023](0023-host-runner-architecture.md))**: 本トポロジ(wrapper の
> サーバ直結)は維持したまま、各ホストに常駐 runner を 1 つ置き、wrapper の
> spawn / 監督 / ホスト登録などライフサイクル管理を担わせる監督層を追加した。
> runner はデータ経路を終端せず、wrapper は引き続き直結する(直結は不変)。本 ADR
> は supersede されておらず accepted のまま。

## Consequences

### Positive

- ラッパーがローカルでエージェントを直接観測でき、分散モデルが自然。
- 非 Elixir(TS)ラッパーと整合。ファイアウォール越え・認証が容易。
- サーバ側は OTP の監視・PubSub が活きる。

### Negative

- 公開前提のため、ラッパーごとのトークン認証 + TLS + ハートビートが必須。
- 接続断を表す `disconnected` 状態の管理が必要。

### Neutral

- クライアント ↔ サーバのユーザ認証は別レイヤ
  ([ADR-0005](0005-access-control-oauth-stub.md))。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| 分散 Erlang(全ホスト BEAM + cookie 共有) | 結合が強すぎ、非 Elixir ラッパーと不整合 |
| ラッパーをサーバ内に同居 | エージェントが別ホストのとき成立しない |
