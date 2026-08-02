---
title: ファイルアップロード — モデル受理可種別の publish と client pre-block UX
description: wrapper が `ext.capabilities` でモデル受理可種別を公開し client が disable UI へ反映する案の未決論点。
status: open
urgency: low
blocks: []
opened: 2026-06-27
decided: null
---

## 背景

[ADR-0025](../adr/0025-file-upload-wire-and-wrapper-rendering.md) F8
(A4-α)で「弾く場所は wrapper、 client は規範を持たない」を採用した。
モデルが画像非対応(将来 codex 等)の時は client が事前ブロックせず
wrapper が reject し、 client は reject error を表示する。 UX 改善案として
wrapper が capability を publish し client が disable UI に使う方向が
有りうるが、 MVP では知識重複回避を優先して非採用。

## 選択肢

| 案 | 内容 | メリット | デメリット |
|--|--|--|--|
| A | 当面 A4-α(wrapper reject 後に client が error 表示)で運用 | 知識が wrapper に一元化、 protocol 面の追加なし | UX は「送って 1 秒以内に reject」のフィードバック |
| B | `ext.capabilities`(`{image:bool, document:bool, ...}` 等)を state_change.ext に追加、 client が disable UI へ反映 | UX 良(disable で送れないことが事前に分かる)、 protocol 仕様で第三者 client も利用可 | 知識を 2 系統に publish(wrapper 一元化を侵食)、 protocol 面 +1 |

## 影響

A の場合は protocol 不変。 B 採用時は `state_change.ext` に新フィールド
追加(version 据え置き、 ADR-0015 で前方互換維持)、 client は新フィールド
を読んで disable UI を出す。 model 切替(#54)と同様の「能力情報の前出し」
の延長線として整合する。

## 判断材料

- 画像非対応モデルを実際に使う場面が現れるか(現状 Claude 系は広範対応)
- UX 上で「reject トーストを見て送り直す」が許容範囲か(運用観測)
- 第三者クライアント(kaoiro.nvim 等)実装者から capability 情報の要望が
  出るか

## 暫定方針

A — MVP は wrapper の reject と client の error 表示で十分とみなす。

**現況 (2026-08-03 追記): 実装は事実上 B を採っている。**
phase-14 / phase-15 で
[ADR-0034](../adr/0034-session-capabilities-advertisement.md) が
`state_change.ext.session_capabilities` を導入し、`supports_attachments`
と `attachment_types`(現状 `["image"]` のみ)を wrapper が spawn 直後から
advertise する。Codex アダプタは `supports_attachments: true` +
`attachment_types: ["image"]` を出し、UI 側の Composer は attach ボタンの
disable と picker / paste / drop の画像限定をこの capability だけで判定
している(engine 名で分岐しない)。当 OQ が想定した `ext.capabilities` と
いう独立フィールドではなく、session capability の一部として実現された点が
案 B との差分。

したがって残る論点は「A か B か」ではなく、**`attachment_types` の語彙を
`image` 以外へ広げるか(document / text 等の細分)** に縮小している。

## 解決時のアクション

- [x] capability のフィールド形を spec 化(`ext.session_capabilities` の
      `supports_attachments` / `attachment_types`、[protocol](../specs/protocol.md))
- [x] wrapper が capability を導出して advertise する経路を実装
      (ADR-0034、両 engine)
- [x] client の attach ボタン disable / picker 限定 UI を実装
- [ ] 残論点(`attachment_types` の語彙拡張)を判断し、本 OQ を
      ADR-0034 の追補へ畳んで削除する
