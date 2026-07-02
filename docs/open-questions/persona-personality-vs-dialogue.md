---
title: セリフ吹き出し UI 導入時の人格プロンプト再検討
description: 将来 seri-fu(吹き出し / セリフ表示)UI を導入する際、人格プロンプトの持ち方をどう再設計するか。
status: open
urgency: low
blocks: []
opened: 2026-07-02
decided: null
---

## 背景

[personas](../specs/personas.md) は 15 行目で「口調・一人称などの会話設定
は…将来セリフ表示等を導入する際に別途決定する」と記載している。今回の
[persona-personality-injection](../specs/persona-personality-injection.md)
は口調系をカバーしたが、対象は Claude Agent SDK への注入までであり、
セリフ吹き出し / 発話 UI が持つ「短さ・言い切り・一度に読める分量」等の
制約は考慮していない。

将来 kaoiro dashboard に吹き出し UI を導入する段階で、既存の
`personality_prompt_file` をどう扱うかを予約する。

## 選択肢

| 案 | 内容 | メリット | デメリット |
|----|------|----------|-----------|
| A | 既存 `personality_prompt_file` のスタイル指示に「吹き出しに収まる短さ」等を後付け | フィールド追加不要 | 通常出力と吹き出し出力を同じプロンプトで両立させる制約 |
| B | 吹き出し用の専用フィールド(`dialogue_style_prompt?` 等)を追加 | 通常出力と吹き出し出力を分けて設計できる | データモデル拡張。同期させないと二重管理になる |
| C | 吹き出し UI 自体を spec 化する時にセットで再検討 | 現時点で決めない = 情報不足時に判断しない | 決定タイミングが遠くなる |

## 影響

- 現在のスコープでは対象外なので、実装への影響なし。
- 吹き出し UI 導入 spec が起こされた時に、必ず本 open-question を trigger
  として参照する。

## 判断材料

- 吹き出し UI の具体的な仕様(何を、どのくらいの分量で、どのタイミングで
  出すか)。
- 「地の応答テキスト」と「吹き出しセリフ」を両方持たせるか、片方だけか。
- personas.md 15 行目の「将来セリフ表示等」がどう具体化するか。

## 暫定方針

**C**(吹き出し UI spec 起こし時に併せて decide する)。現時点では何も
実装しない。

## 解決時のアクション

- [ ] Decision recorded in `adr/NNNN-persona-personality-vs-dialogue.md`
      or 吹き出し UI spec に統合
- [ ] Spec `../specs/persona-personality-injection.md` の「スコープ」節に
      吹き出し UI との連携方針を追記
- [ ] This file moved to ADR or deleted
