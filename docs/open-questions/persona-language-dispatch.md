---
title: persona.language の消費ロジック
description: Persona の language フィールドを実行時にどう消費するか(personality 選択、フッター切替、SDK 側の言語指示)。
status: open
urgency: low
blocks: [persona-personality-injection]
opened: 2026-07-02
decided: null
---

## 背景

[persona-personality-injection](../specs/persona-personality-injection.md)
は `Persona` に `language?: string` フィールドを追加した(未指定は `"ja"`
既定)。future-proof 目的で下地だけ敷いたため、phase-0 では読み込みのみで
dispatch ロジックは持たない。

多言語対応を実装する phase-1 段階で、`language` を何にどう消費するかを
decide する必要がある([ADR-0026](../adr/0026-persona-personality-injection.md)
の D4 決定に紐付く後続議論)。ドキュメント言語方針は
[ADR-0006](../adr/0006-doc-language-i18n.md) が担っている。

## 選択肢

| 案 | 内容 | メリット | デメリット |
|----|------|----------|-----------|
| A | `personality_prompt_file` を `<id>.<lang>.md` 命名で切り替え | 人格記述そのものが言語ごと。翻訳ではなくロケール別の書き分けが可能 | ペルソナ数 × 言語数のファイル管理。language が違うと立ち絵の一貫性を保つ工夫が要る |
| B | 共通フッターだけを language で切り替え、personality は 1 ファイル | 実装コスト最小。personality は英日どちらでも通用する書き方を心がける | エージェント応答言語は個人記述の言語に引きずられる可能性 |
| C | language に応じて SDK 側の言語指示(「always respond in Japanese」等)を追加 append | 応答言語を強制できる | personality の口調と応答言語が別軸で管理される複雑さ |

上記は相互排他ではなく、A+C や B+C の組み合わせも成立する。decide 時に
組み合わせて選ぶ余地を残す。

## 影響

- phase-1 の実装内容がここで決まる。phase-0 は「language 読み込みのみ、
  dispatch なし」で回るため、本 open-question の未決は phase-0 は
  ブロックしない。
- 多言語対応するペルソナが将来何体になるかで採択が変わる可能性がある。

## 判断材料

- 実際にペルソナを多言語化する需要が出るか(外部公開段階で発生見込み)。
- ペルソナごとに別言語で書くケースがあるか、それとも全体を英訳するか。
- [ADR-0006](../adr/0006-doc-language-i18n.md) の「ベータ前に全英訳」
  マイルストーンでどこまで人格側を含めるか。

## 暫定方針

未定。phase-1 に入るタイミングで再議論する。それまでは phase-0 で
language フィールド読み込みのみを実装しておく。

## 解決時のアクション

- [ ] Decision recorded in `adr/NNNN-persona-language-dispatch.md`
- [ ] Spec `../specs/persona-personality-injection.md` の
      「データモデル」節と「Constraints」節を更新
- [ ] `../plans/persona-personality-injection.md` の phase-1 タスクを
      具体化
- [ ] This file moved to ADR or deleted
