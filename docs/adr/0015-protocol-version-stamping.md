---
title: 全通信への version 付与と不一致時の警告(ベストエフォート受理)
status: accepted
date: 2026-06-16
opened: 2026-06-16
supersedes: []
superseded_by: null
related_specs: [protocol]
related_adrs: [10, 14, 19, 25, 47]
---

# ADR-0015 — 全通信への version 付与と不一致時の警告

## Status

Accepted

## Context

エンベロープには既に `version` があり、バージョニング方針は「受信側は未知キーを
無視(無言の前方互換)」だった([protocol](../specs/protocol.md))。しかし
2点の不足がある: (1) version が乗るのはラッパー → サーバのエンベロープのみで、
`instruction` / `permission_decision` / `snapshot` 等の非エンベロープ payload は
version を持たない。(2) 不一致は黙って受理され、互換性問題に気づけない。
ラッパー/サーバ/クライアント3者間の不一致を検知したい。

## Decision

- version を **3者すべてのメッセージにフラットな外枠キーとして付与**する
  (案A)。非エンベロープ payload にも `version` を足す。エンベロープが既に
  `version` / `ts` / `seq` をフラットな外枠キーとして持つ既存設計に揃える。
- ただし `attach_chunk` は JSON オブジェクトではない binary transport frame の
  ため、フラットなキーを置けない。**恒久 carve-out**として version 付与・検査の
  対象外とする。binary header へ version を追加するには破壊的な wire 変更と
  protocol version の bump が必要であり、得られる効果に見合わない。
- 受信側は自分の version と **完全一致のみ正常**とみなし、不一致なら
  **警告ログ**を出す。
- ただし **ベストエフォートで受理して処理は継続**する(不一致でも止めない)。
- 不明要素の切り捨ては現状維持(未知エンベロープキーは既存の前方互換方針で
  黙って無視)。
- 将来 `ts` 等の共通メタも同じ「共通フレームキー」枠組みで全メッセージに
  追加できる(今回は version のみ)。

## Consequences

### Positive

- 互換性不一致が警告で可視化される。
- version/ts 等の共通メタを全通信で一貫して扱える(既存エンベロープと同一流儀)。

### Negative

- 各メッセージの生成・受信箇所に version の付与/検査を足す必要がある。

### Neutral

- version は現状 `"0"` 単一。完全一致判定は単一値比較。
- トランスポート層 version(Channels `vsn` 交渉、[ADR-0009](0009-client-transport.md))
  とは独立。
- **build identity**([ADR-0053](0053-build-identity.md)、issue #218 追記)
  **とも独立**。ここでの version は wire メッセージの形状互換性であり、
  artifact(runner / server image)がどの git commit 由来かとは別軸 —
  混同すると「docs-only commit で互換性エラーが出る」ような誤った設計に
  なる。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| 案B(全メッセージを `{version, kind, payload}` で統一エンベロープ化) | 既存エンベロープの `type` と二層化・冗長。確定済み v0 設計を作り替える churn が見合わない |
| 不一致でも無言で受理(現状維持) | 互換性問題に気づけない |
| 不一致を即エラーで拒否 | 運用が止まる。ベストエフォート受理を優先 |

## Related

- spec: [protocol](../specs/protocol.md) バージョニング方針。
- 関連 ADR: [0010](0010-protocol-precisification.md)、
  [0014](0014-session-resume-and-restore.md)。
- 由来: my-idea-brief(走り書き「通信プロトコルのバージョン情報付与」)。

## Addendum (issue #208 ふじレビュー MF-1, 2026-08-21): `attach_chunk` の恒久 carve-out

**決定。** `attach_chunk` は固定長ヘッダと生バイト列からなる binary transport
frame であり、JSON のフラット外枠キーを持てないため、version 付与・検査の
恒久的な対象外とする。これは既存の Decision に明文化した carve-out であり、
ADR の status は Accepted のまま維持する。

binary header へ version を追加する案は、既存 frame の破壊的変更と protocol
version の bump を要する。JSON frame と同じキーを載せられない実装制約に対しては
費用対効果が見合わないため採用しない。適用箇所と wire 形は
[protocol](../specs/protocol.md) の「version 棚卸し」が正本である。

**由来。** issue #208 のふじレビュー must-fix 1。下位 spec だけが例外を
宣言していた不整合を、この ADR の Decision へ改訂して解消した。
