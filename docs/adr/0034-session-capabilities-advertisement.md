---
title: セッション機能 (session capabilities) の envelope advertisement
status: accepted
date: 2026-07-11
opened: 2026-07-11
supersedes: []
superseded_by: null
related_specs: [protocol, plugin-model]
related_adrs: [22, 32, 33, 35, 36, 37]
---

# ADR-0034 — セッション機能 (session capabilities) の envelope advertisement

## Status

Accepted (実装は [phase-15-wrapper-ux-parity](../plans/phase-15-wrapper-ux-parity.md))。

## Context

[phase-14](../plans/phase-14-codex-adapter.md) で Codex adapter が accepted 昇格した後の実運用検証で、UI 側で「機能可用性を engine 名で分岐しがちなコード動線」が複数箇所存在することが判明した。具体例:

- Composer の添付 (file upload) ボタン: Codex adapter は attach_open を wholesale reject するが、engine 名で「Codex なら disable」判定を入れると、将来 Codex が画像入力等の attachment を実装した際 false negative になる (SDK 側実装は追随せず UI だけ古い判定で塞ぐ)。
- AskUserQuestion (`ask_user_question` MCP tool) の可用性: Codex では MCP bridge 経由で提供しているが、実運用上 plan tier (Free / Go) や別の実装制約で「その session で dialog が発火しない」ケースが起こりうる (もも実運用視点、2026-07-11 挙動確認)。
- session 単位で可変な項目 (auth mode / plan tier / wrapper 実装状況の差) を engine 名だけでは表現不能。

engine 名判定が持ち込む false negative/positive のリスクは、engine 進化が続く限り恒常的に発生する。判定軸を engine 名から「その session が advertise する機能集合」に置換し、UI は capability advertise のみを見て機能可用性を判断する設計へ寄せる。

phase-14 の envelope schema ([ADR-0033](0033-permission-model-dual-axis.md)) が既に「実効値 (`ext.permission`) を engine 中立に載せる」パターンを確立しているため、機能可用性も同じパターンで拡張する自然な延長。

## Decision

### F1 — envelope schema `ext.session_capabilities` の追加

wrapper は **spawn 直後の最初の state_change から** `state_change.ext.session_capabilities` を stamp する (adapter 構築時に capability を組み立て、初回 state_change で送出)。以降の state_change でも同じ ext を維持し、session 中に変化しうる値は変化時に更新する。

session_init 相当のイベント (Claude の `SDKSystemMessage(init)`、Codex の `thread.started`) を**待たない** — Codex は毎ターン `codex exec` を新規 spawn する process モデル ([codex-sdk-events](../specs/codex-sdk-events.md)) のため `thread.started` は初ターン発生まで到達せず、末尾の fail-closed default と組むと起動直後の Codex agent が「未対応」誤表示になる ([phase-15](../plans/phase-15-wrapper-ux-parity.md) の楽観 stamp 原則と同じ path で流す):

```json
{
  "type": "state_change",
  "state": "idle",
  "ext": {
    "engine": "codex",
    "permission": { "sandbox": "workspace-write", "approval": "never" },
    "session_capabilities": {
      "supports_attachments": false,
      "supports_user_input_dialog": true,
      "user_input_modes": ["plan"]
    }
  }
}
```

未 stamp (フィールド未提供) 時、UI は保守的に「機能なし」と解釈する (false 相当。attach ボタン disabled、質問 dialog 系 UI は「未対応」表示)。fail-closed。

### F2 — 初期 field 集合

`@kaoiro/protocol` の envelope 型に次を追加:

| field | 型 | 意味 |
|---|---|---|
| `supports_attachments` | `boolean` | 添付ファイル (file upload) を受け入れるか。false のとき Composer の attach ボタンは disabled + tooltip「このセッションでは未対応」 |
| `supports_user_input_dialog` | `boolean` | `ask_user_question` (MCP tool / SDK 特別分岐 いずれでも) が使えるか。false のとき AgentDetail の質問 UI 系は「未対応」表示 |
| `user_input_modes` | `string[]` (optional) | dialog が使える権限 mode / sandbox の条件集合 (例: `["plan"]` = plan mode でのみ dialog が発火する)。空/未指定 = 無条件 |

追加 field の `supports_model_switch` / `supports_effort_switch` は [ADR-0035](0035-codex-model-catalog-and-mid-session-switch.md) F4 とphase-16で Codex に実装済みで、`supports_effort_switch` は #108 で Claude にも実装した。`supports_session_reset` / `session_reset_modes` は [ADR-0036](0036-session-lifecycle-commands.md) F5とphase-17で実装済み。将来の field (例: `supports_cwd_tracking`) も本 ADR の枠内で envelope schema + agent-common 型を追補して追加できる。

### F3 — UI 判定原則

UI は engine 名 (`ext.engine`) では機能可用性を判定しない。以下の対応:

- Composer 添付ボタン: `ext.session_capabilities.supports_attachments === true` のときのみ enabled
- AgentDetail / Composer の質問 UI: `ext.session_capabilities.supports_user_input_dialog === true` のときのみ活性、`user_input_modes` が指定されていて現在の mode がその集合に含まれないときは「条件付き未対応」表示

`ext.engine` は依然 envelope 上に残るが、その用途は表示 (engine バッジ) と log/telemetry のみに限定する。機能可用性の判定に engine 名を使ってはならない (レビュー時に検出)。

### F4 — engine adapter 側の advertise 実装

`@kaoiro/agent-common` の `EngineAdapter` interface に capability 取得 hook を追加せず、各 adapter が state stamp 経路 (`#statusExt` 相当) で直接 `session_capabilities` を組み立てる。理由: capability は session-lifetime にわたる「静的な事実」ではなく、adapter 実装 + spawn 時選択 + auth mode の合成結果なので、adapter 内部で組み立てて envelope に流す形が実態に近い。

初期実装:

- `wrapper/claude-code` (Claude adapter): `supports_attachments: true` / `supports_user_input_dialog: true` (無条件)。将来 SDK 側で条件が付いた際は本箇所で追加分岐。
- `wrapper/codex` (Codex adapter): 現状 `supports_attachments: false` / `supports_user_input_dialog: true`。plan tier 判定は [codex-model-catalog](../specs/codex-model-catalog.md) の `codex doctor` 情報から派生させたいが plan tier 自体が取得不能なため、MVP は無条件 true。Free/Go plan で dialog が使えない挙動が観測されたら、その時点で `user_input_modes` を advertise する形へ縮退。

### F5 — deprecation / migration

engine 名判定はレビュー時に禁止し、既存コードで engine 名分岐しているものは phase-15 実装時に本 ADR の判定へ置換する。envelope 上 `ext.session_capabilities` の未 stamp 期間はない (phase-15 の同一 PR で両 adapter の advertise を実装するため、UI 側の fail-closed default が実効果を持つのは開発中の中間状態のみ)。

## Consequences

### Positive

- 機能可用性判定が engine 名から解放され、engine 進化 (Codex の画像入力対応等) で UI 側判定を追随修正しなくてよくなる。
- session 単位で可変な条件 (plan tier / auth mode / wrapper 実装差) を第一級表現できる。
- UI の engine 分岐が減る (engine 名は表示専用に一本化)。
- 未 stamp 時 fail-closed により、adapter 実装漏れが「機能表示だけ生きて実挙動が壊れる」形にならず、UI 上も明示的に「未対応」表示になる。

### Negative

- envelope size がわずかに増える (数バイト〜数十バイト、session ごと 1 回 + 変化時のみ)。
- 各 adapter で advertise を漏れなく実装する保守負担が発生 (追加 field の度)。テストで未 stamp 検出を必須化することでカバー。

### Neutral

- viewer 配信は [ADR-0021](0021-role-information-disclosure-policy.md) の ext allow-list で自動カバー (ext は viewer 完全除去)。session_capabilities も operator-only。
- [ADR-0022](0022-pending-permission-authoritative-source.md) の authoritative source 原則 (`state_change.ext` を SoT とする) は本 ADR で同じパターンを踏襲、supersede しない。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| engine 名で分岐 (現行実装の暗黙前提) | Codex 進化で false negative / positive、session 単位差を表現不能 (もも実運用指摘の中核) |
| capability を engine registration (`HostInfo.engines[]`) に載せる (host-static) | session 単位差 (auth mode / plan tier / spawn 時選択) を表現不能。runner が host 起動時に固定値を返す形になり、実際の session 挙動から乖離する |
| capability を `EngineAdapter` interface に hook (`capabilities(): CapSet`) として持たせる | interface 面が肥大化。capability は session state の一部なので、state stamp の経路と同期させたい (envelope を source-of-truth 化) |
| 未 stamp 時に「true 相当」で開放 (fail-open) | adapter 実装漏れが UI 上「対応」表示のまま実挙動が壊れる形になる。fail-closed default が安全 |

## Related

- 由来: [phase-14-codex-adapter](../plans/phase-14-codex-adapter.md) の実運用検証で見えた engine 名判定リスク (D4/D5 の設計転換)。
- 実装: [phase-15-wrapper-ux-parity](../plans/phase-15-wrapper-ux-parity.md)。
- 関連 ADR: [ADR-0022](0022-pending-permission-authoritative-source.md) (authoritative source パターン踏襲)、[ADR-0032](0032-codex-adapter.md) (Codex adapter の engine 追加起点)、[ADR-0033](0033-permission-model-dual-axis.md) (ext による engine 中立化パターンの先行例)。
- 関連 specs: [protocol](../specs/protocol.md) (`ext.session_capabilities` 追補)、[plugin-model](../specs/plugin-model.md) (EngineAdapter との関係)。
- 関連 issue: [#102](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/102) — list_agents の peer 情報充実 (engine / model / effort 等)。phase-8 の「directory は名前解決の最小限」判断の見直し。着手は phase-15 の envelope schema 確定後、本 ADR の session capability advertise パターンと親和的なので同じ原則 (state stamp = SoT) を継承する見込み。
