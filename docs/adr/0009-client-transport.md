---
title: クライアント接続は Phoenix Channels に一本化
status: accepted
date: 2026-06-11
opened: 2026-06-10
supersedes: []
superseded_by: null
related_specs: [protocol, architecture]
related_adrs: [7, 10, 25]
---

# ADR-0009 — クライアント接続は Phoenix Channels に一本化

## Status

Accepted

## Context

クライアントは別プロジェクト分離・公開プロトコル文書化が決定済み
([ADR-0007](0007-client-separation-reference-dashboard.md))。接続方式を
Phoenix Channels にするか素の WebSocket(+読み取り専用 SSE 併設)にするかが
未決だった。Channels は同梱リファレンスダッシュボード(TS)には自然だが、
非 JS クライアント(neovim プラグイン = Lua、ターミナル CUI 等)に Channels
ワイヤプロトコルの実装負担が生じ得る、というのが懸念だった(issue #11)。

2026-06 の調査で以下が判明した:

- Channels ワイヤプロトコル V2(`[join_ref, ref, topic, event, payload]` の
  5 要素配列、接続時 `?vsn=2.0.0`)は公式ガイド
  [Writing a Channels Client](https://hexdocs.pm/phoenix/writing_a_channels_client.html)
  で文書化された公開プロトコルであり、Phoenix 1.3/1.4 期の導入以来
  1.8 系まで形式不変。内部実装への依存にはならない。
- Supabase Realtime が同プロトコルをそのまま公開 API として文書化し、
  多言語クライアントを成立させている先例がある。
- 非 JS 言語のクライアントライブラリ実態(2026-06 時点):
  C# は [PhoenixSharp](https://github.com/Mazyod/PhoenixSharp)(活発・V2)、
  Go は [nshafer/phx](https://github.com/nshafer/phx)(V2・保守中)、
  Rust は
  [liveview-native/phoenix-channels-client](https://github.com/liveview-native/phoenix-channels-client)
  (現役 V2、crates.io 停滞のため git 依存)。Python は保守された V2
  クライアント不在だが `websockets` 上の自作が容易。Lua(neovim)は
  Channels クライアント皆無で、WebSocket 層自体が標準にない。
- 決定打: Lua の負担の本体は WebSocket 層(RFC 6455 クライアントの純 Lua
  自作)であり、**素の WebSocket 案でも同じだけかかる**。さらに素 WS 案は
  再接続・heartbeat・要求/応答相関(ref)・トピック購読の仕様を自前設計する
  ことになり、Channels のライフサイクル部分の再発明にしかならない。

## Decision

- クライアント向け接続は **Phoenix Channels に一本化**する。素の WebSocket
  エンドポイントは併設しない。
- ワイヤ形式は **V2 serializer 固定**(接続時 `vsn=2.0.0` を必須)とし、
  kaoiro の公開プロトコル文書([protocol](../specs/protocol.md))には公式
  ガイドへの参照 + kaoiro 固有のトピック/イベント定義を記載する。
- 読み取り専用 SSE は**見送り**(Elixir 側に保守されたライブラリが無く
  手書き前提のため)。必要が生じた時点で open-question として再起票する。
- 非 JS クライアントは各言語の WebSocket ライブラリ + Channels V2 フレーム
  実装で接続する(上記ライブラリ実態を参照)。

## Consequences

### Positive

- サーバ実装が最小(Channels の再接続・heartbeat・PubSub 統合・Presence を
  そのまま使える)。
- 仕様が 1 系統で、公開プロトコル文書は公式ガイド参照 + イベント定義のみで
  済む。
- リファレンスダッシュボード(ADR-0007)と外部クライアントが同一経路を通り、
  適合性検証がそのまま機能する。

### Negative

- Lua(neovim)クライアントは WebSocket 層 + Channels フレーミングの自作が
  確定する(ただし素 WS 案でも WS 層の負担は同等)。
- Python クライアントは小さな Channels V2 クライアントの自作・保守が必要。

### Neutral

- ワイヤプロトコルのバージョンは Phoenix 側の serializer バージョン交渉
  (`vsn`)に乗る。kaoiro エンベロープ自体のバージョニングは
  [ADR-0010](0010-protocol-precisification.md) で確定。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| Channels(同梱用)+ 素の WS 併設(2 経路) | 仕様 2 系統の保守負担。素 WS 側でライフサイクル仕様の再発明が必要。調査の結果、非 JS クライアントの負担軽減効果はほぼ無い |
| 素の WebSocket のみ | Phoenix の再接続・Presence・PubSub 統合を自前化。join_ref/ref/topic/heartbeat 相当の再発明になり Channels に対する優位なし |
| 読み取り専用 SSE 併設 | Elixir 側に保守されたライブラリ不在(手書き前提)。需要が未確認のため見送り、必要時に再起票 |
