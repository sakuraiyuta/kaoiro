---
title: エンベロープの type/payload は実証範囲のみ確定し、残りは予約名とする
status: accepted
date: 2026-06-11
opened: 2026-06-04
supersedes: []
superseded_by: null
related_specs: [protocol, agent-sdk-events]
related_adrs: [9]
---

# ADR-0010 — エンベロープの type/payload は実証範囲のみ確定し、残りは予約名とする

## Status

Accepted

## Context

[protocol](../specs/protocol.md) は外枠(フレームキー)のみ v0 として固定し、
`type`/`payload` の型体系、方向別メッセージ種別、バージョニング方針が未確定
だった(open-question protocol-precisification、2026-06-04 起票)。

検討した選択肢:

| 案 | 内容 | 評価 |
|----|------|------|
| A | 実消費者で実証された範囲のみ確定し、残りは予約名 | 採用 |
| B | 先に机上で全型を確定 | SDK/実装の実態とズレて作り直すリスク(起票時に却下済みの「机上先行」と同型) |
| C | 確定を見送り provisional のまま進む | Phase 1.5(実消費者で確定する)の目的を放棄 |

判断材料: SDK 側のイベント仕様は確定済み
([agent-sdk-events](../specs/agent-sdk-events.md))。Phase 1.5 のトレーサー
バレットで実消費者(サーバ・クライアント)が揃い、実際にワイヤを流れたのは
`type: state_change` のエンベロープと、サーバ→クライアントの
`snapshot`/`envelope` イベントのみ(Phase 2/3 の機能はまだ存在しない)。

## Decision

- `type` は**閉じた enum** とし、実証済みの `state_change` のみ payload 型を
  確定する。`log` / `permission_request` / `result` は**予約名**として列挙し、
  payload は使用フェーズの実装時に追補する。
- 方向別メッセージ種別は現存の 3 つ(ラッパー→サーバ `envelope`、
  サーバ→クライアント `snapshot` / `envelope`)を確定。双方向
  (指示・承認: クライアント→サーバ→ラッパー)は Phase 3 着手時に追補する。
- バージョニング方針: 受信側は**未知キーを無視**(前方互換)。キー追加・
  予約 type の追補は同一 version のまま。既存キーの意味変更・削除など
  破壊的変更のみ `version` を上げる。`ext` はフィルタの名前空間で、コアは
  解釈しない。
- [protocol](../specs/protocol.md) を `status: accepted` へ更新する。
  以後の変更は通常の spec 改訂 + 必要に応じた ADR で扱う。

## Consequences

### Positive

- 実装と仕様が一致した状態で protocol が accepted になり、Phase 1.5 の
  目的(実消費者によるプロトコル確定)が完了する。
- 予約名方式により、Phase 3 の双方向設計を先取りで誤って固定しない。

### Negative

- `log`/`permission_request`/`result` と双方向メッセージの payload は
  未定義のまま残り、各フェーズ着手時に spec 追補の作業が発生する。

### Neutral

- トランスポート層(Channels V2)のバージョニングは `vsn` 交渉に乗る
  ([ADR-0009](0009-client-transport.md))。本 ADR の version は
  アプリ層エンベロープのもの。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| 全種別を机上確定(案 B) | Phase 3 実装の実態とズレて作り直すリスク。起票時に却下した机上先行と同型 |
| 確定見送り(案 C) | protocol が provisional のまま残り、実消費者で確定するという Phase 1.5 の存在意義を放棄する |
