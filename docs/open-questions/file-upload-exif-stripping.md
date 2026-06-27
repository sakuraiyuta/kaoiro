---
title: ファイルアップロード — EXIF / メタデータ stripping の必要性
description: アップロード画像の EXIF / メタデータ(撮影位置・ 機器情報など)を wrapper で strip するかの未決論点。プライバシー観点。
status: open
urgency: low
blocks: []
opened: 2026-06-27
decided: null
---

## 背景

[ADR-0025](../adr/0025-file-upload-wire-and-wrapper-rendering.md) は MVP
で添付バイト列を wrapper → SDK にそのまま通す方針。 画像の EXIF には
撮影位置 / 機器 / 撮影時刻 等が含まれる場合があり、 機微画像運用が出てきた
場合は wrapper で strip する必要が出る。 現状は dogfooding 中心のため
未決。

## 選択肢

| 案 | 内容 | メリット | デメリット |
|--|--|--|--|
| A | そのまま wrapper → SDK へ通す(MVP) | 実装最小、 元データ忠実性 | 機微 EXIF が漏れる |
| B | wrapper で strip(opt-out 可)| プライバシー safe | strip 実装(sharp 等)が追加、 元情報が必要なケース(写真分析等)で困る |
| C | client の picker で選択時に strip / そのまま を選ばせる UX | ユーザ意思反映 | UX 複雑化、 client / wrapper 両方に実装 |

## 影響

A の場合は protocol / 実装不変。 B / C 採用時は wrapper の fit-to-SDK
処理の前段に strip ステップが入る(画像のみ)。 protocol 不変
(wrapper-internal 実装)。

## 判断材料

- 機微 EXIF を含む画像を運用で扱う場面が出るか
- 撮影位置等を残したい正当ユースケース(地理情報込みの画像分析)とのバランス
- fit-to-SDK で採用予定の image ライブラリ(sharp 等)の EXIF API

## 暫定方針

A — MVP では strip しない。 機微画像運用が出たら B(opt-out 可)を検討。

## 解決時のアクション

- [ ] EXIF strip 仕様(opt-out フラグの位置・ デフォルト)を spec 化
- [ ] wrapper の fit-to-SDK 前段に strip ステップ追加
- [ ] ADR 昇格、 本ファイル削除
