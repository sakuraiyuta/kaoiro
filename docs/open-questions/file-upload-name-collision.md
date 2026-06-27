---
title: ファイルアップロード — 同一 instruction 内の同名ファイル UX
description: 同一 instruction で同じ filename を持つ複数ファイルを添付した時の表示・ disambiguate の未決論点。protocol レベルでは衝突しない(upload_id ごと独立)。
status: open
urgency: low
blocks: []
opened: 2026-06-27
decided: null
---

## 背景

[ADR-0025](../adr/0025-file-upload-wire-and-wrapper-rendering.md) F2 で
upload は `upload_id`(client 採番)ごと独立を確定した。 filename は表示
専用フィールドであり、 protocol レベルでは同名衝突は発生しない
(wrapper / server は upload_id で識別)。 ただし client UI や wrapper の
SDK content blocks に渡す時の filename 表示で衝突が見え、 ユーザ混乱に
なりうる。

## 選択肢

| 案 | 内容 | メリット | デメリット |
|--|--|--|--|
| A | upload_id ごと独立、 filename は表示専用 — 衝突しない(protocol レベル)。 表示重複は client の disambiguate UX に任せる | protocol 不変、 wrapper も unchanged | client 実装ごとに UX 一貫性が無い |
| B | wrapper / client で明示的に suffix 付与(例: `image.png` / `image (2).png`)| 表示一貫性 | 仕様面 +1、 wrapper / client 両方に実装 |

## 影響

A の場合は protocol / 実装不変。 B 採用時は client 側の disambiguate
ロジックを spec 化(wrapper 側はそのまま filename を SDK へ流す or
wrapper で renaming するか別途決定)。

## 判断材料

- 実際に同名複数添付の UX 不具合が報告されるか
- SDK / モデルが filename をどれだけ参照するか(content block 内の filename
  表示が応答に影響するか)

## 暫定方針

A — protocol レベルでは衝突しないので未対応。 表示の disambiguate は
client の責務とし、 リファレンスダッシュボードでは送信時に suffix 付与
する程度で十分。

## 解決時のアクション

- [ ] disambiguate ルール(suffix 付与の場所と形式)を spec 化
- [ ] client / wrapper の実装変更
- [ ] ADR 昇格、 本ファイル削除
