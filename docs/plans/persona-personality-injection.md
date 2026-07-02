---
title: Persona Personality Injection — feature-local plan
description: 人格プロンプト注入の実装スライス(project-wide ロードマップ外の feature-local plan)。
status: planned
phase: 0
depends_on: []
last_updated: 2026-07-02
---

# Persona Personality Injection — feature-local plan

## Goal

同じ `persona.id` を持つエージェントが、再起動をまたいで同じ**口調**でも
応答するようにする。仕様は
[persona-personality-injection](../specs/persona-personality-injection.md)、
決定記録は [ADR-0026](../adr/0026-persona-personality-injection.md)。

## Note: feature-local phasing

kaoiro の `plans/` は phase-0 〜 phase-8 の**プロジェクト全体ロードマップ**
番号を使っている。本 plan はロードマップ外の feature-local plan で、
以下の feature-local phase-0 / phase-1 はこの plan 内でのみ意味を持つ番号
である(project の phase-0-project-setup 等とは無関係)。

## Feature phase-0 — dogfoodable minimum

### Acceptance Criteria

- [ ] `Persona` 型に `personality_prompt_file?: string` と
  `language?: string` を追加(`protocol/src/index.ts` +
  `wrapper/src/persona.ts` の `parseConfig`)
- [ ] `wrapper/personas/{ao,momo,kuroe}.md` を新規同梱
  ([specs/personas.md](../specs/personas.md) の性格付けを実際の
  口調プロンプトに具体化)
- [ ] wrapper 起動時に `personality_prompt_file` 未指定なら
  `wrapper/personas/<persona.id>.md` をデフォルト解決する
- [ ] `wrapper/src/host.ts` の `systemPrompt` を
  `{ type: 'preset', preset: 'claude_code', append: <personality> +
  <共通フッター暫定1文> }` に組み替え
- [ ] `default` ペルソナは personality を append せず、共通フッター
  のみ append される
- [ ] 参照ファイル不在時は `ConfigError` で fail-fast する
- [ ] `agent.{ao,kuroe,momo}.json` を新スキーマに合わせて更新
  (personality_prompt_file / language を追加、または未指定で
  デフォルト解決に任せる)
- [ ] `wrapper/kaoiro.config.example.json` に新フィールドの記述を追加
- [ ] 目視で ao / momo / kuroe の応答口調が明らかに違うことを確認
  (SHOULD 目標、厳密テストは要らない)

### Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 0-1 | protocol/src/index.ts の `Persona` 拡張 | ⏳ | 2 フィールド追加、既存互換 |
| 0-2 | wrapper/src/persona.ts の `parseConfig` 拡張 | ⏳ | 新フィールド受理 + 長さ・パス検証 |
| 0-3 | wrapper/personas/ ディレクトリ + 4 体分のスケルトン | ⏳ | ao/momo/kuroe.md を執筆、default は不要 |
| 0-4 | 起動時解決ロジック(config 指定 → 同梱デフォルト → なし) | ⏳ | wrapper/src/host.ts か新規モジュール |
| 0-5 | host.ts の `systemPrompt` を append 形に組み替え | ⏳ | 共通フッター暫定 1 文をハードコード |
| 0-6 | agent.{ao,kuroe,momo}.json を新スキーマに移行 | ⏳ | 既定値のみで動く形が望ましい |
| 0-7 | kaoiro.config.example.json に新フィールドの例を追加 | ⏳ | 使い方の例示 |
| 0-8 | wrapper test 追加(parseConfig / 解決ロジック) | ⏳ | 参照ファイル不在時の ConfigError も含む |
| 0-9 | 手動 dogfooding 確認(3 体で応答口調の差を目視) | ⏳ | 目視 SHOULD、機械テストは要らない |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## Feature phase-1 — open-question 決着後の拡張

phase-0 の実装を回した後、以下の open-question が decide されたら段階的に
拡張する。順不同、独立に着手可。

- [persona-common-footer](../open-questions/persona-common-footer.md) 決着
  → 共通フッターの構造化・合成順の明示・暫定ハードコードの差し替え
- [persona-language-dispatch](../open-questions/persona-language-dispatch.md)
  決着 → `persona.language` に応じた personality / 共通フッターの分岐
- [persona-behavioral-prompt](../open-questions/persona-behavioral-prompt.md)
  / [persona-voice-distinctiveness](../open-questions/persona-voice-distinctiveness.md)
  / [persona-personality-vs-dialogue](../open-questions/persona-personality-vs-dialogue.md)
  は個別に issue 化されるまで no-op

## Followups (in-phase but unfinished)

なし(feature phase-0 未着手)。

## Open Questions Blocking This Phase

- [persona-common-footer](../open-questions/persona-common-footer.md) —
  暫定ハードコード方針で phase-0 は進められるが、共通フッターの中身が
  未決のまま実装が固定化するリスクがある。中優先で追う。

## See Also

- Specs covered:
  [persona-personality-injection](../specs/persona-personality-injection.md),
  [personas](../specs/personas.md)
- ADR: [ADR-0026](../adr/0026-persona-personality-injection.md)
