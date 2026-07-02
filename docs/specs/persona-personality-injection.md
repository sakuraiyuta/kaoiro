---
title: 人格プロンプト注入
description: ペルソナごとの口調・一人称・語尾・返答スタイルを Claude Agent SDK の systemPrompt.append 経由で注入する仕組み。
status: provisional
related: [personas, protocol, threat-model]
---

# 人格プロンプト注入

## Purpose

[personas](personas.md) はペルソナ立ち絵の性格付け (ao=クール控えめ、
momo=元気オーバーリアクション、kuroe=淡々とした冷静な有能秘書) を、これまで
**立ち絵生成用の設計資料としてのみ**保持していた。口調・一人称等の会話設定は
「消費する機能が現行仕様に無いため対象外」としていたが、kaoiro が dogfooding
可能な段階に入り、実行時の会話にも一貫したキャラクター性を持たせる価値が
出てきた。

本 spec は、ペルソナごとの人格記述 (口調・一人称・語尾・返答スタイル) を
Claude Agent SDK の `systemPrompt` に追記する仕組みを定める。既存の
[ADR-0003](../adr/0003-persona-identity-persistence.md)(ペルソナ同一性の
永続化)を延長し、「同じ persona は再起動をまたいで同じ**口調**でも喋る」を
実現するのがゴール。

## Definition

### スコープ

対象は**会話出力の見た目**(口調・一人称・語尾・返答スタイル)のみ。以下は
本 spec の対象外:

- タスク姿勢(慎重度・進捗報告頻度・ツール使用の癖) — 将来課題
  ([persona-behavioral-prompt](../open-questions/persona-behavioral-prompt.md))
- 感情フィルタとの連携([plans/phase-6-emotion-filter](../plans/phase-6-emotion-filter.md))
- セリフ吹き出し / 発話 UI([persona-personality-vs-dialogue](../open-questions/persona-personality-vs-dialogue.md))
- サーバ側 / dashboard 側からの人格編集 UI

### データモデル

wrapper 側の `Persona` に 2 フィールドを追加する。既存の
[protocol](protocol.md) の Persona 型を拡張する。

| フィールド | 型 | 既定 | 意味 |
|---|---|---|---|
| `personality_prompt_file` | `string?` | 未指定なら同梱デフォルト解決 | 人格記述 md への相対パス(config 基準)|
| `language` | `string?` | 未指定なら `"ja"` | 人格記述の想定言語。将来の多言語 dispatch の下地 |

`agent.<persona>.json` の例:

```json
"persona": {
  "id": "ao",
  "name": "あお-yuta-lab",
  "sprite_set": "ao",
  "personality_prompt_file": "./personas/ao.md",
  "language": "ja"
}
```

### 同梱 + オーバーライドの解決規則

wrapper 起動時に人格記述を以下の順で解決する:

1. `config.persona.personality_prompt_file` が指定されていればそれを読む
2. 未指定なら `wrapper/personas/<persona.id>.md` を読む(同梱デフォルト)
3. どちらも存在しなければ、`default` ペルソナと同等 (共通フッターのみ) 扱い

同梱ファイルは wrapper リポジトリに直接置く(`wrapper/personas/*.md`)。
サーバ経由の配信は行わない — 人格文字列は wrapper 内で完結する。

初期同梱の 3 体:

- `wrapper/personas/ao.md` — クールで控えめ、一人称「わたし」
- `wrapper/personas/momo.md` — 元気で大きめリアクション、一人称「もも」
- `wrapper/personas/kuroe.md` — 淡々とした有能秘書、一人称「わたくし」

`default` は人格記述を持たない(共通フッターのみ)。

### SDK への注入

Claude Agent SDK の `systemPrompt` は `{ type: 'preset', preset: 'claude_code',
append?: string }` を受ける。この `append` に「人格記述 + 共通フッター」を
入れる。

```typescript
systemPrompt: {
  type: 'preset',
  preset: 'claude_code',
  append: `${personalityPrompt}\n\n${commonFooter}`,
}
```

`preset: 'claude_code'` によって Claude Code 相当の tool 使用マナー・安全指示
は保持される。人格記述はその末尾に足される追記であり、preset を置換しない。

### 共通フッター(暫定)

全ペルソナ (`default` 含む) に対して、環境認識の 1 文を append 末尾に足す。
中身と合成順の最終決定は
[persona-common-footer](../open-questions/persona-common-footer.md) に委ねる。
初期実装の暫定方針は「このエージェントは kaoiro クライアント越しに操作されて
います」相当の 1 文をハードコード。

### 変更可能範囲

人格記述は **wrapper 起動時に固定** する。mid-session での差し替えは行わない
(SDK の `systemPrompt` は query 開始時のみ有効なため)。

サーバ側 / dashboard から人格記述を上書き / 拡張する経路は用意しない
([threat-model](threat-model.md) の allowed_tools と同じ扱い)。

Envelope (state_change / log / result) に人格文字列は載せない。dashboard に
渡るのは従来通り `persona.id` / `persona.name` のみ。

## Constraints

- MUST: SDK への注入は `systemPrompt: { type: 'preset', preset: 'claude_code',
  append: ... }` の `append` を使う。`preset` を捨てて自作 string に置換しない。
- MUST: 人格文字列を Envelope に載せない
  ([threat-model](threat-model.md))。
- MUST NOT: サーバ側から人格文字列を上書き / 拡張する経路を実装しない
  ([ADR-0003](../adr/0003-persona-identity-persistence.md) の「サーバは
  agent 非依存」原則を尊重)。
- SHOULD: 人格記述 md は 200〜1000 字を目安とする。hard 上限は設けない
  (fail-fast の hard 制約はスコープの緩さと整合しないため)。
- SHOULD: ペルソナ間の判別可能性(口調から persona を識別できること)は努力
  目標。厳密化は問題化した時点で
  [persona-voice-distinctiveness](../open-questions/persona-voice-distinctiveness.md)
  経由で別課題化する。
- MAY: `persona.language` は将来の多言語 dispatch のための下地。phase-0 では
  読み込みのみで dispatch ロジックは持たない。

## Open Questions

- [persona-common-footer](../open-questions/persona-common-footer.md) — 共通
  フッターの中身と合成順(phase-0 の default ペルソナ挙動をブロック)
- [persona-behavioral-prompt](../open-questions/persona-behavioral-prompt.md) —
  タスク姿勢の注入(将来課題)
- [persona-voice-distinctiveness](../open-questions/persona-voice-distinctiveness.md)
  — 判別可能性の厳密化トリガ
- [persona-language-dispatch](../open-questions/persona-language-dispatch.md) —
  `persona.language` の消費ロジック(phase-1 で必要)
- [persona-personality-vs-dialogue](../open-questions/persona-personality-vs-dialogue.md)
  — セリフ吹き出し UI 導入時の再検討

## See Also

- Related specs: [personas](personas.md), [protocol](protocol.md),
  [threat-model](threat-model.md)
- ADRs: [ADR-0003](../adr/0003-persona-identity-persistence.md)(ペルソナ
  同一性)、[ADR-0006](../adr/0006-doc-language-i18n.md)(言語方針)、
  [ADR-0026](../adr/0026-persona-personality-injection.md)(本 spec の
  決定記録)
- Plan: [persona-personality-injection](../plans/persona-personality-injection.md)
