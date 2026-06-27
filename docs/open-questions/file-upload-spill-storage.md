---
title: ファイルアップロード — wrapper の spill-to-FS / 常時 FS 化の必要性
description: wrapper の pending_uploads を純メモリ完結から temp FS へ spill する案の未決論点。並列 upload で RSS が問題化した場合のみ検討。
status: open
urgency: low
blocks: []
opened: 2026-06-27
decided: null
---

## 背景

[ADR-0025](../adr/0025-file-upload-wire-and-wrapper-rendering.md) F3 で
pending_uploads を純メモリ完結に確定した(ディスク不到達原則 = ADR-0020
F3 を強化)。 並列 upload(最大 in-flight 20 × 128 MB)で RSS ピークが問題
化した場合、 wrapper 内部で閾値超え spill(B)あるいは常時 temp FS(C)へ
切り替える余地を残す。

## 選択肢

| 案 | 内容 | メリット | デメリット |
|--|--|--|--|
| A | 純メモリ完結を据え置き(MVP) | ディスク不到達原則最大化、 実装最小 | 並列大ファイルで RSS ピーク |
| B | 閾値超え spill(小=RAM / 大=temp FS) | メモリ圧低減、 大ファイル対応 | temp file の衛生(perm 0600 / cleanup-on-crash / 命名衝突)が増える、 ディスク到達 |
| C | 常時 temp FS(統一) | メモリ圧最小、 1 経路 | 全ファイルがディスク到達、 不要 I/O |

## 影響

いずれも wrapper 内部実装の話で、 **protocol 不変**。 B/C 採用時は
wrapper のテスト面が拡張する(perm / unlink / GC タイミング)。
ADR-0020 F3 「ディスク不到達」の解釈を「単純にディスクに書かない」から
「短命の temp ファイルは許容」へ緩める必要が出る。

## 判断材料

- 並列 upload 運用での wrapper RSS 実測(Stage C 完了後)
- ホスト OS の `tmpfs` 領域容量と permission
- 機微データ漏洩リスク(temp ファイルのクラッシュ時残存)

## 暫定方針

A — MVP では純メモリ完結。 RSS が問題化した実測を待つ。

## 解決時のアクション

- [ ] RSS 観測メトリクスを plan に追記
- [ ] 閾値・ spill 戦略を spec 化
- [ ] ADR 昇格、 本ファイル削除
