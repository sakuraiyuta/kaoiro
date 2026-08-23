---
title: ファイルアップロード — (2) FS + Read 方式への再実装トリガと境界
description: content-block 直送(1)でメモリ/速度に問題が出た時に wrapper-local FS + Read 誘導(2)へ切り替える判断境界の未決論点。
status: open
urgency: low
blocks: []
opened: 2026-06-27
decided: null
---

## 背景

[#52 issue 本文](https://github.com/sakuraiyuta/kaoiro/issues/52)
は 「まず (1) 内容をプロンプト展開して SDK メッセージに添付。 問題が出たら
(2) wrapper ホスト FS にファイルを置き Read させる方式へ再実装を検討」と
規定している。 [ADR-0025](../adr/0025-file-upload-wire-and-wrapper-rendering.md)
F1 / F3 で (1) 方式(wrapper-internal レンダリング + 純メモリ完結)を MVP
として確定したが、 (2) への切替判断境界は未確定。

## 選択肢

| 案 | 内容 | メリット | デメリット |
|--|--|--|--|
| A | メモリ/速度に問題が出たら (2) へ wrapper 内部実装を切替(protocol 不変) | issue 本文の既定、 切替コストを wrapper 内に閉じ込められる | 「問題が出た」の閾値が曖昧 |
| B | 当面 (1) を据え置き、 切替判断は別 issue で起票時に再評価 | 現状維持、 判断を先送り | 問題顕在化時に意思決定の場がない |

## 影響

(1) で運用が成立する限り波及なし。 (2) へ切替時は wrapper の内部実装
(SDK 呼び出し時の prompt 注入と Read 誘導の有無)に閉じる。 protocol /
client / server は不変
([ADR-0025](../adr/0025-file-upload-wire-and-wrapper-rendering.md) F1 の
wrapper-internal 原則)。

## 判断材料

- (1) 運用での実測メモリピーク・ SDK 呼び出しレイテンシ(Stage C 完了後の
  実機運用で観測)
- Claude API の content block 限界に近づいた時の挙動安定性
- Read 誘導が SDK / モデルでどれだけ確実に発火するか(誘導不安定なら (2) は
  unreliable)

## 暫定方針

A — issue 本文の既定。 切替閾値は phase-1 (Stage C) 完了後の運用観測で
決める。

## 解決時のアクション

- [ ] 観測メトリクス(メモリ・ レイテンシ)を plan に追記
- [ ] (2) 採用なら ADR で記録、 wrapper の内部実装変更
- [ ] 本ファイルを ADR 昇格 → 削除
