---
title: 疲労を protocol state と分離したペルソナ modifier として扱う
status: accepted
date: 2026-08-21
opened: 2026-08-21
supersedes: []
superseded_by: null
related_specs: [persona-pack-schema, personas, protocol]
related_adrs: [29, 40]
---

# ADR-0054 — 疲労を protocol state と分離したペルソナ modifier として扱う

## Status

Accepted

## Context

issue #162 は context 使用率が高いエージェントを、既存の稼働 state を
読み替えずに疲労表情で示したい。`fatigued` を protocol の `state` 語彙へ
追加すると、wrapper・server・dashboard の状態遷移、既存の表情網羅性、rolling
upgrade の互換性までを巻き込む。一方で疲労は `thinking` や `done` と排他的な
実行状態ではない。

persona pack の sprite は従来の必須 7 状態だけだった。疲労用の絵を持つ pack
を受け入れつつ、未対応 pack と CSS 顔フォールバックを壊さず、未知の state id
を許容しない必要がある。

疲労信号は先行決定 P2/P4 に従い `ext.context.used_percentage >= 60` とする。
issue #254 は後から `ext.context_budget.work_budget_percentage` を wire に
追加したが、これは soft 作業予算の比率であり、当初の疲労信号とは別物である。
将来どちらを採るかが変わっても、呼び出し側へ判断を散らしてはならない。

## Decision

`fatigued` は **protocol state ではなく直交 modifier** とする。wire 上の
`state` に `fatigued` は現れず、`KnownState` / `expressionFor` の語彙にも
追加しない。dashboard は元の state を label・CSS variant として保ったまま、
疲労時だけ sprite 解決に `fatigued` を渡し、CSS 顔には `data-fatigued` を付ける。
sprite 自体には CSS modifier を重ねない。

疲労判定は `isFatigued(envelope)` 一箇所に閉じる。現時点では capability
`supports_context_usage` が明示的 true で、有限な
`ext.context.used_percentage >= 60` のときだけ true とする。capability の
欠落・false、context の欠落、非数値は false に fail-closed する。将来
`work_budget_percentage` を採る裁定に変わる場合も、この関数の本体とそのテスト
だけを差し替える。

疲労 sprite への差し替え対象は `idle` と `waiting_input` だけとする。
`disconnected`、作業中、完了、error は元 state を保つ。`disconnected` 優先を
別の early return で重ねず、`FATIGUE_ELIGIBLE_STATES` allowlist を唯一の判定
機構にする。issue #162 実装中の mutation で early return の削除が green の
ままだったため、こはく裁定で冗長な early return を削除し、allowlist へ
`disconnected` を混入する mutation が TB-7 を red にすることを確認した。

persona pack は必須 7 state に加え、allowlist 済み optional sprite id
`fatigued` を宣言できる。server は必須 7 の包含と required ∪ optional への
部分集合を両方検証する。収集・キャッシュ完全性判定は `manifest.states` を
SoT とし、宣言済みの `fatigued.png` 欠落は pack を不完全として再展開/拒否し、
未宣言の余分な PNG は manifest に公開しない。未知 id は reject する。

実ペルソナの `fatigued.png` 生成と provenance は issue #163 の責務であり、
本決定は schema・受け入れ・表示経路だけを定義する。

## Consequences

- 未対応 pack は既存の idle sprite フォールバックを使い、default persona は
  CSS 顔の最小限の疲労表現を得る。
- wrapper の context notice threshold と dashboard の fatigue threshold は同じ
  60 だが、別ホスト・別目的の独立定数であり、相互導出しない。
- fatigue を state 遷移や chip/timeline へ広げる必要が生じた場合は、別途
  表示スコープを決める follow-up とする。
