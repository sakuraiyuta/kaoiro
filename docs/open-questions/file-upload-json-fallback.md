---
title: ファイルアップロード — `attach_chunk_b64` JSON ingress fallback の必要性
description: binary frame 押下が重い simple-client(neovim Lua / Python 等)向けに JSON base64 ingress を fallback として用意するかの未決論点。
status: open
urgency: low
blocks: []
opened: 2026-06-27
decided: null
---

## 背景

[ADR-0025](../adr/0025-file-upload-wire-and-wrapper-rendering.md) F2 で
転送 wire を binary frame chunked 単一経路に確定した(base64 膨張回避 /
フレーム効率最大)。 一方、 simple-client(neovim Lua / Python 等で
ArrayBuffer push が重い実装)が出てきた場合、 JSON ingress(`attach_chunk`
の base64 同梱版)を fallback として併設するかは未決。

## 選択肢

| 案 | 内容 | メリット | デメリット |
|--|--|--|--|
| A | 単一 binary 経路で MVP、 fallback なし | wire が 1 経路、 仕様明快、 「間口を広げる」も実装責任の方を客先に求める | 簡易実装の客先には敷居あり(Phoenix Channels V2 binary は実装可だが工数) |
| B | simple-client から要望が出たら `attach_chunk_b64`(JSON `{upload_id, chunk_index, data_b64}`)を追加 | UX 良(simple-client 対応)、 wire の互換性は保てる(両経路) | protocol 面 +1、 ingress 2 系統、 spec の維持コスト |

## 影響

A の場合は protocol 不変。 B 採用時は新 client→server event 1 個追加
(version 据え置き、 ADR-0015 で前方互換維持)。 wrapper は両 ingress を
同じ pending_uploads に集約。

## 判断材料

- 第三者クライアント(kaoiro.nvim Lua / Python CLI 等)実装者からの要望
- simple-client の実装難度実測(Phoenix Channels V2 binary を ArrayBuffer
  なしで実装する場合のコード量)
- 既存 Channels client ライブラリ(phoenix-elixir, websockex 等)のバイナリ
  対応状況

## 暫定方針

A — 単一 binary 経路で MVP。 要望が顕在化したら B を追加(後方互換)。

## 解決時のアクション

- [ ] simple-client 要望の集約
- [ ] `attach_chunk_b64` の wire 仕様化
- [ ] ADR 昇格、 本ファイル削除
