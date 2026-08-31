---
title: ペルソナアセットはサーバ管理、マニフェスト + content-addressed 配信
status: superseded
date: 2026-06-10
opened: 2026-06-10
supersedes: []
superseded_by: 29
related_specs: [protocol, architecture]
related_adrs: [3, 5, 7, 29]
---

# ADR-0008 — ペルソナアセットはサーバ管理、マニフェスト + content-addressed 配信

## Status

Superseded by [ADR-0029](0029-persona-server-sot-and-pack-distribution.md)
(2026-07-05)。サーバがアセットを持つ方針は継承しつつ、配布単位を
「立ち絵のみのマニフェスト」から「zip pack(人格プロンプト + 立ち絵)」
に拡張し、auto-watch による自動反映と「野良 persona 禁止」の enforce を
統合した。

以下は歴史的経緯として残す。

## Context

`persona.sprite_set` は文字列であり、別プロジェクト化した外部クライアント
([ADR-0007](0007-client-separation-reference-dashboard.md))がこれを実際の
画像へ解決する手段が未定義だった。全クライアントが既に接続している唯一の
コンポーネントはサーバである。リクエスト毎にアーカイブを圧縮して配信する
案は CPU とレイテンシを毎回払う。

## Decision

- ペルソナアセット(立ち絵・表情差分)の**正本はサーバが管理**する。
  ラッパーは同一性(`persona.id`、
  [ADR-0003](0003-persona-identity-persistence.md))のみを持ち、サーバが
  見た目(アセット)を持つ。サーバの agent 非依存は維持される。
- 配信の一次形式は**マニフェスト JSON**(persona.id → 状態別画像 URL +
  コンテンツハッシュ + バージョン)+ **content-addressed な静的ファイル**。
  ハッシュ付き URL は不変でキャッシュ無期限、クライアントはハッシュ差分で
  増分同期する。
- 一括アーカイブは**アップロード受付時に1回生成**して保存する
  (オンデマンド圧縮はしない)。
- **段階導入**: 第1段階は管理者がサーバのデータディレクトリへ直接配置
  (配信のみ実装)。アップロード API(検証: zip-slip / サイズ上限 / MIME
  制限・SVG 除外、認可: RBAC のアップロードロール、
  [ADR-0005](0005-access-control-oauth-stub.md))は後段。
- メタデータは SQLite、実ファイルはファイルシステムに置く。

## Consequences

### Positive

- 全クライアントで見た目が一貫し、試用時にアセットの別途入手が不要。
- サーバ負担はほぼ静的ファイル配信とストレージのみ(圧縮・変換の常時負荷
  なし)。
- マニフェストのハッシュにより増分同期・キャッシュ戦略が自明になる。

### Negative

- サーバにアセット保管・マニフェスト生成・(後段)アップロード検証の責務が
  増える。
- アップロード API は RBAC のロール設計(ADR-0005)と連動して後段に
  持ち越し。

### Neutral

- クライアントのローカル上書き(オフライン利用・カスタムスキン)は
  マニフェスト仕様で許す余地を残す。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| オンデマンド圧縮アーカイブ配信(原案) | リクエスト毎に CPU・レイテンシを払う |
| 外部静的ホスト委譲(Nextcloud 等) | 可用性の結合と CORS の手間が増え、ラボ規模で利なし |
| クライアント側アセットパック | 試用の敷居と表示の一貫性を損なう |
