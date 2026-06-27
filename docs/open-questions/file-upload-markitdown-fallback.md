---
title: ファイルアップロード — Office 変換の markitdown フォールバック
description: MVP 採用の officeparser(pure JS)で品質が不足する用途で markitdown CLI(Python)経由を fallback として併設するかの未決論点。
status: open
urgency: low
blocks: []
opened: 2026-06-27
decided: null
---

## 背景

Phase 7 Stage A の spike(IN3)で Office 変換ライブラリを比較し、 MVP は
**officeparser**(pure JS、 MIT、 docx/xlsx/pptx 1 lib 対応、 ADR-0018
単一バイナリ化親和性)を採用した。 Microsoft 製 **markitdown**(Python
CLI)は markdown 化品質が高く既存 `my-markitdown` skill 資産があるが、
Python 依存のため wrapper 配布が重い(ADR-0018 と相性悪)。

複雑なレイアウトの xlsx・ アニメーション付き pptx・ 表が多い docx で
officeparser の出力が不十分な場合、 markitdown を **fallback バックエンド**
として併設する余地を残す。

## 選択肢

| 案 | 内容 | メリット | デメリット |
|--|--|--|--|
| A | officeparser のみ(MVP) | 実装最小、 pure JS、 ADR-0018 親和性 | 複雑レイアウトで markdown 品質が不足する可能性 |
| B | wrapper config で `office_backend: officeparser \| markitdown` 選択可能、 既定は officeparser、 markitdown は subprocess 起動 | 品質要求に応えられる、 既存 skill 資産活用 | Python ランタイム同梱 or 別途インストール、 ADR-0018 単一バイナリ化に逆風 |
| C | 自動 fallback(officeparser 失敗時に markitdown 試行) | UX 良 | 失敗判定の閾値が曖昧、 実装複雑 |

## 影響

A の場合は protocol 不変、 wrapper の Office 変換は 1 経路。 B/C は wrapper
内部実装の話で **protocol 不変**(client/server は変換種別を意識しない、
ADR-0025 F1 wrapper-internal)。 B 採用時は wrapper config に backend
選択フィールド追加、 markitdown 経路は my-markitdown skill 流儀で subprocess
起動。

## 判断材料

- 運用で officeparser の出力品質が不足する報告が出るか
- ADR-0018 単一バイナリ化のタイミング(Python 同梱 vs 別途要求の比較)
- 既存 my-markitdown skill との API 整合性

## 暫定方針

A — MVP は officeparser 単体。 品質要求が出たら B(明示 backend 選択)を
追加。 C(自動 fallback)は実装複雑なので採用しない。

## 解決時のアクション

- [ ] 品質要求の事例集約
- [ ] wrapper config に `office_backend` フィールド追加
- [ ] markitdown subprocess 経路実装(my-markitdown skill 流儀)
- [ ] ADR 昇格、 本ファイル削除
