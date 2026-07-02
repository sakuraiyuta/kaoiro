---
title: 共通フッターの中身と合成順
description: 全ペルソナに append される共通フッター(kaoiro 環境認識等)の中身と、人格記述との合成順序をどう決めるか。
status: open
urgency: medium
blocks: [persona-personality-injection]
opened: 2026-07-02
decided: null
---

## 背景

[persona-personality-injection](../specs/persona-personality-injection.md)
では、`default` ペルソナへの扱いを「性格付けなし、共通フッターのみ注入」と
確定した。この判断の帰結として、**共通フッターの中身**を決めないと
`default` の append 内容が空になり、phase-0 実装が止まる。

一方、共通フッターは全ペルソナ (`default` 以外にも ao / momo / kuroe) にも
載る可能性が高く、「kaoiro 環境で動作している」ことをエージェント自身に
認識させるか、どこまで自己認識(persona ID / name の名乗り)を含めるか、
personality と共通フッターの合成順をどうするかは独立した設計判断になる。

## 選択肢

| 案 | 内容 | メリット | デメリット |
|----|------|----------|-----------|
| A | 空(フッターなし) | 実装最小。default は append 完全省略、他は personality のみ append | default が「素の Claude Code」となり、kaoiro 環境情報がエージェントに伝わらない |
| B | 環境認識のみ(1〜2 文) | 「kaoiro クライアント越しに操作されている」等の短い環境情報。実装コスト低 | 実用効果が薄い可能性。preset に類似情報が既にある場合は冗長 |
| C | 環境認識 + 自己認識 | B + 「あなたのペルソナ ID は 'ao'、名前は 'あお' です」等 | personality 側と自己認識が二重管理になり、一貫性チェックが増える |

合成順の候補(独立軸):

- 順序 1: `preset + personality + 共通フッター`(personality が上、フッターが下)
- 順序 2: `preset + 共通フッター + personality`(フッターが上、personality が下)

一般には後ろの指示ほど優先されがちなので、personality を最後に置くか
フッターを最後に置くかで挙動が変わる可能性がある。実測が要る。

## 影響

- **phase-0 の実装**: 暫定ハードコード方針で進めることは可能だが、共通
  フッターの中身が未決のまま実装が固定化すると、後で差し替えるコストが
  発生する。
- **default ペルソナの挙動**: A を選ぶと default は「素の Claude Code」と
  同等になり、kaoiro 環境で動いている自覚がなくなる。
- **他ペルソナの応答一貫性**: 環境認識を含めるかで、エージェントが自身の
  存在文脈を語る際の表現が変わる可能性がある。

## 判断材料

- dogfooding で「エージェントが kaoiro 越しであることを意識してほしい」
  シーンがどのくらいあるか。
- Claude Code preset の中に既に類似の環境情報が含まれているか(SDK ソース
  or 出力の観測)。
- personality と共通フッターを合成した実際の応答が、どちらの合成順で
  自然か(実測)。

## 暫定方針

**B(環境認識 1 文をハードコード)**。phase-0 実装ではフッターを「この
エージェントは kaoiro クライアント越しに操作されています」相当の 1 文で
ハードコードし、personality の後に append する(順序 1)。dogfooding で
observability を上げてから中身と合成順を再検討する。

## 解決時のアクション

- [ ] Decision recorded in `adr/NNNN-persona-common-footer.md`
- [ ] Spec `../specs/persona-personality-injection.md` の「共通フッター
      (暫定)」節を更新
- [ ] `../plans/persona-personality-injection.md` の phase-1 タスク
      「共通フッター構造化」を消化済みに移す
- [ ] This file moved to ADR or deleted
