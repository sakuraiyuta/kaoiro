---
title: 非スコープ
description: kaoiro が初期に扱わない範囲(本格 OAuth/RBAC、アニメ/3D 描画、エージェント本体改変、高度な感情分析)。
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

## See Also

- 関連 specs: [overview](overview.md)
- ADRs: [0004](../adr/0004-client-rendering-staged.md),
  [0005](../adr/0005-access-control-oauth-stub.md)
