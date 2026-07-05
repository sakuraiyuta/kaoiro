---
title: 人格プロンプト注入
description: ペルソナごとの口調・一人称・語尾・返答スタイルを Claude Agent SDK の systemPrompt.append 経由で注入する仕組み。プロンプト本文の SoT は server 側 persona pack、配送は WS ハンドシェイクで push。
status: provisional
related: [personas, persona-pack-schema, protocol, threat-model]
---

# 人格プロンプト注入

## Purpose

[personas](personas.md) はペルソナ立ち絵の性格付け (ao / momo / kuroe /
fuji) を、当初「立ち絵生成用の設計資料としてのみ」保持していたが、
kaoiro が dogfooding 可能な段階に入り、実行時の会話にも一貫した
キャラクター性を持たせる価値が出た。

本 spec は、ペルソナごとの人格記述 (口調・一人称・語尾・返答スタイル)
を Claude Agent SDK の `systemPrompt` に追記する仕組みを定める。既存の
[ADR-0003](../adr/0003-persona-identity-persistence.md)(ペルソナ同一性
の永続化)を延長し、「同じ persona は再起動をまたいで同じ**口調**でも
喋る」を実現するのがゴール。

**適用モデル**: [ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md)
に基づき、人格プロンプトの一次ソースは server 集約 SoT(persona pack
zip の `personality.md`)。wrapper は WS ハンドシェイクで server から
受信して SDK に注入する。旧モデル(wrapper 同梱 md ロード)は
[ADR-0026](../adr/0026-persona-personality-injection.md) にて確立
されたが、ADR-0029 で supersede された。

## Definition

### スコープ

対象は**会話出力の見た目**(口調・一人称・語尾・返答スタイル)のみ。
以下は本 spec の対象外:

- タスク姿勢(慎重度・進捗報告頻度・ツール使用の癖) — 将来課題
  ([persona-behavioral-prompt](../open-questions/persona-behavioral-prompt.md))
- 感情フィルタとの連携([plans/phase-6-emotion-filter](../plans/phase-6-emotion-filter.md))
- セリフ吹き出し / 発話 UI([persona-personality-vs-dialogue](../open-questions/persona-personality-vs-dialogue.md))
- dashboard 側からの人格編集 UI

### データモデル

wrapper 側の設定に人格関連フィールドは持たない。`persona.id` /
`persona.name` / `persona.sprite_set` のみが wrapper 起動時 config に
残る([setup-wizards](setup-wizards.md))。

人格プロンプト本文は server 側 persona pack の `personality.md`
([persona-pack-schema](persona-pack-schema.md))に置く。作成者は
persona pack zip 内で編集する。

### プロンプトの配送(WS ハンドシェイク)

wrapper が server に接続した直後の**ハンドシェイクメッセージ**で、
server から wrapper に「人格記述 + 共通フッター」を結合済みの
プロンプト文字列を push する。詳細メッセージ形式は
[protocol](protocol.md) 参照。

- 未知の `persona.id` を名乗る wrapper 接続は server が reject する
  (「野良 persona 禁止」の enforce、
  [ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md))。
- server 到達不能時は wrapper spawn 自体が失敗する(fail-closed)。
  ローカルフォールバックは持たない。

### SDK への注入

Claude Agent SDK の `systemPrompt` は `{ type: 'preset', preset:
'claude_code', append?: string }` を受ける。ハンドシェイクで受信した
プロンプト文字列をそのまま `append` に入れる。

```typescript
systemPrompt: {
  type: 'preset',
  preset: 'claude_code',
  append: promptFromHandshake,   // server 側で personality + footer 結合済み
}
```

`preset: 'claude_code'` によって Claude Code 相当の tool 使用マナー・
安全指示は保持される。人格記述はその末尾に足される追記であり、preset
を置換しない。

### 共通フッター

全ペルソナ (`default` 含む) に対して、環境認識の 1 文を append 末尾に
足す。**結合は server 側で行う**
([ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md)
F5)。

- 中身:「このエージェントは kaoiro クライアント越しに操作されて
  います」相当の 1 文([ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md)
  D5)。
- 合成順: `preset(claude_code) + personality + common footer`。
- 中身と合成順の変更は、pack 更新ではなく server 実装の変更として扱う
  (全ペルソナ共通のため)。

### 変更可能範囲

- 人格記述は **wrapper 起動時(ハンドシェイク時)にスナップショット
  で確定** する。mid-session での差し替えは行わない
  ([ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md)
  F9)。SDK の `systemPrompt` が query 開始時のみ有効なことに加え、
  「会話中に persona が変わる」不確実性を持ち込まない。
- 取り込みディレクトリ内の zip が更新された場合、接続中 wrapper には
  反映されない。次回接続時のスナップショットに反映される。
- server 側 / dashboard から人格記述を上書き / 拡張する経路は用意しない
  ([threat-model](threat-model.md) の allowed_tools と同じ扱い)。
- Envelope (state_change / log / result) に人格文字列は載せない。
  dashboard に流れるのは従来通り `persona.id` / `persona.name` のみ。

## Constraints

- MUST: SDK への注入は `systemPrompt: { type: 'preset', preset:
  'claude_code', append: ... }` の `append` を使う。`preset` を捨てて
  自作 string に置換しない。
- MUST: 人格文字列を wrapper→server の Envelope に載せない
  ([threat-model](threat-model.md))。
- MUST: server 側で `personality + common footer` を結合して配送する。
  wrapper 側では結合ロジックを持たない
  ([ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md)
  F5)。
- MUST: 未知の `persona.id` を名乗る wrapper 接続は server が reject
  する。
- MUST: server 到達不能時は wrapper spawn が失敗する(fail-closed)。
- MUST NOT: wrapper 側にローカル md をロードするフォールバックを
  実装しない。
- MUST NOT: wrapper 側で prompt をキャッシュしない(SoT 侵害防止)。
- SHOULD: 人格記述 md は 200〜1000 字を目安とする。hard 上限は設けない。
- SHOULD: ペルソナ間の判別可能性(口調から persona を識別できること)
  は努力目標。厳密化は問題化した時点で
  [persona-voice-distinctiveness](../open-questions/persona-voice-distinctiveness.md)
  経由で別課題化する。

## Open Questions

- [persona-behavioral-prompt](../open-questions/persona-behavioral-prompt.md) —
  タスク姿勢の注入(将来課題)
- [persona-voice-distinctiveness](../open-questions/persona-voice-distinctiveness.md)
  — 判別可能性の厳密化トリガ
- [persona-language-dispatch](../open-questions/persona-language-dispatch.md) —
  多言語 dispatch。旧モデルの `persona.language` フィールドは撤去された
  ため、pack の manifest.json に `language` 相当を追加するかを含めて
  再検討要
- [persona-personality-vs-dialogue](../open-questions/persona-personality-vs-dialogue.md)
  — セリフ吹き出し UI 導入時の再検討

## See Also

- Related specs: [personas](personas.md),
  [persona-pack-schema](persona-pack-schema.md),
  [protocol](protocol.md), [threat-model](threat-model.md)
- ADRs: [ADR-0003](../adr/0003-persona-identity-persistence.md)(ペルソナ
  同一性)、[ADR-0006](../adr/0006-doc-language-i18n.md)(言語方針)、
  [ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md)
  (本 spec の適用モデル、旧 ADR-0026 を supersede)
- Plan: [phase-10-persona-server-sot](../plans/phase-10-persona-server-sot.md)
