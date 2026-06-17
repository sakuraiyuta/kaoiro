---
title: 非スコープ
description: kaoiro が初期に扱わない範囲(本格 OAuth/RBAC、アニメ/3D 描画、エージェント本体改変、高度な感情分析、同梱ダッシュボードの会話オーサリング化・永続履歴)。
status: accepted
related: [overview]
---

# 非スコープ

## Purpose

kaoiro が初期に扱わない範囲を明示する。スコープは [overview](overview.md)。

## Definition

やらないこと(初期。将来検討):

- **エージェント本体の機能改変・自作**。kaoiro はラッパー/可視化層に徹する。
- **高度な感情分析**。まずは味付けとして最小限
  ([plans/phase-4-emotion-filter](../plans/phase-4-emotion-filter.md))。
- **本格的な OAuth 認証・多人数アクセス・RBAC**。プロトタイプはアクセス制御を
  stub(メールのホワイトリスト: テキスト/SQLite)に留める
  ([ADR-0005](../adr/0005-access-control-oauth-stub.md))。
- **アニメ/3D の高度な描画**。プロトタイプは静的な表情差分の切り替え
  ([ADR-0004](../adr/0004-client-rendering-staged.md))。
- **クライアント本体のリッチ化(別プロジェクトとして分離)**。多様な
  クライアント(Electron GUI / ターミナル CUI / neovim プラグイン等)は別
  プロジェクト(リポジトリ)として分離し、本体に同梱するのはリファレンス用
  ダッシュボード(ブラウザ)のみ
  ([ADR-0007](../adr/0007-client-separation-reference-dashboard.md))。
  ただし同梱ダッシュボードは「単体で最低限実用」を満たす**情報リッチな
  operator コンソール**まで踏み込んでよい(状態一覧・表情・承認・指示入力に
  加え、返答表示を含む。
  [ADR-0012](../adr/0012-response-display-and-dashboard-scope.md))。線引きは
  当初「機能数」ではなく「**新たな公開プロトコル面 / サーバ永続を要するか**」
  だったが、[ADR-0020](../adr/0020-dashboard-battery-included-client.md) で
  「**battery-included な最低限実用クライアント**」へ格上げし、最低限実用に
  要する**新たな公開プロトコル面の追加を許容**する(中断・アップロード・
  skill 補完・クライアント更新・モデル/effort 選択 等)。以下は引き続き非
  スコープ: 会話オーサリング環境化(フルチャット)、**サーバでの会話/ファイル
  永続**(将来 issue #24)、外部クライアント級の高機能化。

## See Also

- 関連 specs: [overview](overview.md)
- ADRs: [0004](../adr/0004-client-rendering-staged.md),
  [0005](../adr/0005-access-control-oauth-stub.md),
  [0007](../adr/0007-client-separation-reference-dashboard.md),
  [0012](../adr/0012-response-display-and-dashboard-scope.md),
  [0020](../adr/0020-dashboard-battery-included-client.md)
