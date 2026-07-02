---
title: ペルソナ判別可能性の厳密化トリガ
description: 口調から persona を識別できる程度(判別可能性)を SHOULD 止まりで放置するか、いつどんな条件で厳密化するかを予約する。
status: open
urgency: low
blocks: []
opened: 2026-07-02
decided: null
---

## 背景

[persona-personality-injection](../specs/persona-personality-injection.md)
は判別可能性を SHOULD 止まりとした。「並べたときに、応答口調から
どのペルソナか一目で識別できる」ことを目標にはするが、機械的検証はしない。
理由: dogfooding フェーズで検証の重さを避けたかったこと、SDK preset の
指示と人格記述の相互作用を運用観察してから決めたかったこと
([ADR-0026](../adr/0026-persona-personality-injection.md))。

問題化した時点で本 open-question を trigger にして厳密化方針を decide する。

## 選択肢

| 案 | 内容 | メリット | デメリット |
|----|------|----------|-----------|
| A | SHOULD 止まりを維持、問題化するまで何もしない | 追加コストゼロ。「動いてるうちは触らない」 | 問題化の判定が主観的で、決定を先延ばしにしがち |
| B | 定期的な出力サンプリングと目視評価のワークフローを spec 化 | 主観だが定期的にチェックする姿勢を制度化できる | 運用負荷。dogfooding 段階では過剰の可能性 |
| C | 自動判別テスト(別 LLM に「これはどの persona ?」と当てさせる)を追加 | 客観的な指標が得られる | 別 LLM 呼び出しのコスト・実装コスト・テストのブレ |

## 影響

- 問題化するまで実装への影響なし。
- 厳密化を採択した場合、SDK preset の指示強度と衝突する箇所の書き換えが
  必要になる可能性(personality 側で強い上書きを書く等)。

## 判断材料

- 実運用で「どのペルソナが応答したか区別がつかない」場面が観察されるか。
- 判別しづらいことが実害(愛着形成の失敗、状態把握の困難化)につながる
  頻度。
- Claude Code preset の「簡潔さ・事実確認」等の指示がどの程度支配的か。

## 暫定方針

**A**(SHOULD 止まりを維持)。observation で問題を検知したら新規 issue を
起票し、そこから本 open-question を decide に持ち込む。

## 解決時のアクション

- [ ] Decision recorded in `adr/NNNN-persona-voice-distinctiveness.md`
- [ ] 厳密化する場合は `../specs/persona-personality-injection.md` の
      Constraints を SHOULD → MUST に格上げ、検証手段を追記
- [ ] This file moved to ADR or deleted
