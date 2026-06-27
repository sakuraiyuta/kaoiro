---
title: 同梱ダッシュボードを battery-included な最低限実用クライアントへ格上げ(新プロトコル面の追加を許容)
status: accepted
date: 2026-06-17
opened: 2026-06-17
supersedes: []
superseded_by: null
related_specs: [non-goals, overview, architecture, protocol]
related_adrs: [7, 12, 25]
---

# ADR-0020 — 同梱ダッシュボードを battery-included な最低限実用クライアントへ格上げ

## Status

Accepted

## Context

dogfooding(kaoiro 自身のダッシュボードで日常的に Claude Code を駆動する)を
進めるには、同梱ダッシュボードが claude.ai / Claude Code GUI に相当する最低限の
操作を備える必要がある。現状で不足している主な操作: 生成中の中断、ファイル
アップロード、skill 入力補完、クライアント更新、モデル / effort 選択、トークン
実数表示。

[ADR-0012](0012-response-display-and-dashboard-scope.md) は既に同梱ダッシュ
ボードを「最小限」から「情報リッチな operator コンソール」へ格上げ済み。ただし
その線引きは「機能数ではなく **新たな公開プロトコル面 / サーバ永続を要するか**」
であり、**新プロトコル面を要するリッチ化は依然ゲートされていた**。

上記の不足機能はいずれも**新たな公開プロトコル面**を要する(中断 op、利用可能
skill 一覧の公開、アップロード転送、更新制御、選択ダイアログのリレー)。現行の
ADR-0012 線引きのままでは非スコープに落ちる。

公開方針: kaoiro は導入直後(初期設定を除く)に最低限の作業がすぐできる
"battery included" を目指す。それ以上 / 顧客カスタムを要する人は自作クライアント
(neovim プラグイン kaoiro.nvim を志向)へ。
[ADR-0007](0007-client-separation-reference-dashboard.md) のクライアント分離
方針と両立する。

## Decision

- **(F1) 同梱ダッシュボードを「battery-included な最低限実用クライアント」と
  位置づける**。導入直後に最低限の対話運用が単体で完結する状態を提供する。
- **(F2) ADR-0012 の線引きを改訂し、新たな公開プロトコル面の追加を許容する**。
  最低限実用に必要な操作(中断・アップロード・skill 補完・クライアント更新・
  モデル / effort 選択)のための新 op / メッセージは可とする。プロトコルは
  公開・バージョニングされる
  ([ADR-0007](0007-client-separation-reference-dashboard.md) /
  [ADR-0015](0015-protocol-version-stamping.md))ため、追加面も同梱クライアントで
  dogfooding される。
- **(F3) 依然として非スコープ**(ADR-0012 後段は維持):
  - 会話オーサリング環境化(フルチャット)。
  - サーバでの会話 / ファイルの永続(将来 issue #24)。アップロード等の
    ファイルは **wrapper-local 着地・サーバ素通し**を原則とする。
  - 外部クライアント級の高機能化(自作クライアントの領分)。
- **(F4) 具体機能は個別 issue で追跡**する。仕様確定が重いもの(ファイル
  アップロード)は実装前に my-spec-elicitation を通す。
- [non-goals](../specs/non-goals.md) を本決定に合わせて更新する。

## Consequences

### Positive

- ダッシュボード単体で Claude Code を実用駆動でき、dogfooding が進む。
- 追加プロトコル面が同梱クライアントで常時検証され、外部クライアント
  (kaoiro.nvim 等)の実装土台になる(ADR-0007 の dogfooding 精神と整合)。

### Negative

- 公開プロトコル面が増え、後方互換維持の責務が広がる。
- ダッシュボードの保守面が更に広がる(ADR-0012 に続く拡張)。

### Neutral

- サーバ永続・フルチャットは引き続き非スコープで、肥大の歯止めは維持。
- 既存のダッシュボード機能 issue(#34 等)は本決定で優先度の前提が変わり、
  再優先度付けの対象になる。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| ADR-0012 の線引き(新プロトコル面を要するリッチ化は不可)を維持 | 中断・アップロード等が全て非スコープに落ち、dogfooding が成立しない |
| これらの機能を自作クライアント(kaoiro.nvim 等)側だけで実装 | 同梱だけで最低限実用にならず "battery included" に反する。導入の敷居が上がる |
| サーバ永続も併せて解禁(フルクライアント化) | 肥大・secrets-at-rest のリスク。最低限実用には不要で、外部クライアントの領分 |

## Related

- specs: [non-goals](../specs/non-goals.md)(本決定で更新)、
  [overview](../specs/overview.md)、[architecture](../specs/architecture.md)、
  [protocol](../specs/protocol.md)(追加 op)。
- 関連 ADR: [0007](0007-client-separation-reference-dashboard.md)
  (クライアント分離・同梱方針)、
  [0012](0012-response-display-and-dashboard-scope.md)(本決定が線引きを改訂)。
- 追跡 issue: 中断 / アップロード / skill 補完(#34)/ クライアント更新 /
  モデル・effort 選択 / トークン実数 / 操作ファイル確認。
- 由来: my-idea-brief(走り書き「claude.ai GUI 相当機能を一通り実装して
  dogfooding」)。
