---
title: アクセス制御は OAuth + RBAC、プロトタイプは stub
status: accepted
date: 2026-06-04
opened: 2026-06-04
supersedes: []
superseded_by: null
related_specs: [architecture]
related_adrs: [7, 8, 11, 13, 42]
---

# ADR-0005 — アクセス制御は OAuth + RBAC、プロトタイプは stub

## Status

Accepted

## Context

クライアント ↔ サーバのユーザアクセスをどう制御するかが問題だった。将来は
多人数アクセスと権限付与が要るが、プロトタイプ段階でフルの認証・認可を組むのは
重い。ラッパー認証([ADR-0002](0002-local-wrapper-websocket-topology.md))とは
別レイヤである。

## Decision

- **OAuth 認証**で多人数アクセスを可能とし、**RBAC**(閲覧のみ/指示可能 等)を
  行う。
- **プロトタイプは stub** とし、許可メールアカウントを**テキストまたは SQLite の
  ホワイトリスト**で管理する。

## Consequences

### Positive

- 早期に多人数の素地を持ちつつ、本実装は後段に回せる。

### Negative

- stub → 本実装への移行コスト。
- OAuth プロバイダ・権限粒度は未確定(将来詰める)。

### Neutral

- 権限モデル(閲覧のみ/指示可能/承認可能 など)の粒度は実装時に確定。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| 認証なし | 公開運用ができない |
| 最初からフル OAuth + RBAC | プロトタイプには過剰、開発が遅れる |
