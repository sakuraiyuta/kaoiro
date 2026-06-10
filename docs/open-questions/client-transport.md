---
title: クライアント接続方式の選定
description: クライアント向け接続を Phoenix Channels にするか素の WebSocket(+SSE)にするか、各言語クライアント実装の調査を経て決定する。
status: open
urgency: medium
blocks: [protocol]
opened: 2026-06-10
decided: null
---

## 背景

クライアントは別プロジェクト化し、サーバ ↔ クライアント API は公開
プロトコルとして文書化する
([ADR-0007](../adr/0007-client-separation-reference-dashboard.md))。
Phoenix Channels は同梱リファレンスダッシュボード(TS)には自然だが、
非 JS クライアント(neovim プラグイン = Lua、ターミナル CUI 等)には
Channels ワイヤプロトコルの実装負担が生じ得る。Tracker: issue #11。

## 選択肢

| 案 | 内容 | メリット | デメリット |
|----|------|----------|-----------|
| A | Phoenix Channels のみ + ワイヤ形式を spec で固定 | サーバ実装が最小 | 非 JS クライアントが Channels 実装を負担 |
| B | Channels(同梱用)+ 素の WebSocket エンドポイント併設 | 外部クライアントは素の WS だけで済む | サーバに2経路、仕様も2系統 |
| C | 素の WebSocket のみ | 仕様が1つで言語非依存 | Phoenix の再接続・Presence 等を自前化 |

## 影響

未決の間、クライアント向け公開 API の文書化
([protocol](../specs/protocol.md) のクライアント方向)が確定しない。
リファレンスダッシュボードは Channels で先行実装可能(案 A/B どちらでも
無駄にならない)。

## 判断材料

各言語(Lua/Python/Rust/Go/C# 等)の Phoenix Channels クライアント
ライブラリの品質・保守状況・サンプルの有無(issue #11 の調査タスク)。

## 暫定方針

調査完了まで未決。リファレンスダッシュボードは Phoenix Channels で先行する。
調査・決定は [Phase 1.5](../plans/phase-1.5-minimal-server-client.md) の
タスク 1.5-1 として行う。

## 解決時のアクション

- [ ] 決定を `adr/NNNN-client-transport.md` に記録
- [ ] [protocol](../specs/protocol.md) のクライアント方向 API に反映
- [ ] issue #11 をクローズ
- [ ] このファイルを削除
