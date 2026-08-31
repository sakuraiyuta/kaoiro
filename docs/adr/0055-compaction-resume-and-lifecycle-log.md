---
title: compaction 後の自動再開とセッションライフサイクル時系列の保持
status: accepted
date: 2026-08-31
opened: 2026-08-09
supersedes: []
superseded_by: null
related_specs: [protocol-inter-agent, protocol]
related_adrs: [43]
---

# ADR-0055 — compaction resume と lifecycle log

## Status

Accepted (2026-08-31、issue #200 の spec-elicitation でのオペレータ裁定)。
実装は [phase-33](../plans/phase-33-compaction-resume-lifecycle.md)。

## Context

agent は compaction 後に自力で作業へ戻らない (2026-08-09 実測: 圧縮完了後
waiting_input で停止)。現行運用は director が `list_agents` の使用率急落を
見て手動で起こすが、director 自身が compact したときは起こす者がいない
(issue #200)。加えてオペレータには、各 agent がいつどの操作で
compaction / clear-reinit / disconnect 等へ遷移したのかを事後に追える
時系列が無く、問題発生時のデバッグが session ごとの記憶と散在ログに
依存している (2026-08-31 オペレータ要求)。

検討の起点はセッション再起動時の既存通知 (planned disconnect の
`reconnecting` / `reconnected` 合成 envelope) と同型の server 経由案
だったが、既存機構は「自分の再起動を**他人**へ知らせる」向きであり、
compaction は切断を伴わないため復帰検知の前提も欠く。一方 compaction の
完了は wrapper が `compact_boundary` log で局所観測できることが既に
仕様化されている。

## Decision

要求を 2 層に分離する。

1. **resume の配送は wrapper 局所で完結させる。**
   `request_compact` に optional `resume_prompt` を追加し、予約時
   (full context がある時点) に agent 自身が書く。wrapper が
   `compact_boundary` を観測したら、固定前置テンプレート +
   resume_prompt 逐語を threshold 通知と同じ直列化 instruction queue
   経由の user turn として注入する。省略時は現状と完全一致 (opt-in)。
   Claude engine 限定。compaction 中に wrapper が落ちた場合、予約は
   消えてよい。
2. **遷移の記録は server が時系列で保持する。**
   新設イベント 1 本 `session_lifecycle` (kind / trigger / 発生時刻) で
   wrapper が観測可能な遷移 (compact 開始/完了、session reset、閾値通知
   発火、resume_reserved / resume_fired) を server へ報告し、server 既知
   の disconnect / reconnect も同じ時系列へ合流させる。保持は DETS
   永続化、agent ごと既定 10,000 件で古い順に破棄、上限は env
   (`SESSION_LIFECYCLE_MAX_EVENTS_PER_AGENT`) で変更可。記録は peer への
   通知を伴わない。参照は operator 向け pull query (`require_operator`
   gate、`list_conversations` と同型) を first cut とする。

## Rejected

- **resume の server 経由配送** (完了イベント + 合成 envelope 返送) —
  再開の信頼性が server 往復に依存する。可観測性の要求は記録層が独立に
  満たすため、配送まで server に載せる理由が無い。
- **`reconnecting`/`reconnected` 機構の直接流用** — 通知の向きが逆で、
  切断・復帰検知の前提を欠く。
- **kind ごとの個別イベント新設** — kind 追加のたびに protocol 改訂に
  なる。
- **in-memory ring buffer 保持** — restart を跨いだデバッグができない。
  書き込み頻度は低く永続化の負担は小さい。
- **dashboard タイムライン UI の同時実装** — スコープ肥大。
  [lifecycle-timeline-ui](../open-questions/lifecycle-timeline-ui.md)
  へ分離し、issue #175 はこの記録層の消費者として再定義する。

## Consequences

- compaction を跨ぐ作業継続が予約時の自筆指示で自動化され、director の
  手動 kick 運用 (と director 自身の compact 時の空白) が不要になる。
- resume_reserved / resume_fired が時系列に残るため、wrapper 消失で
  予約が消えたケースを事後に判別できる。
- codex engine は当面 disconnect 系のみが時系列に載る
  ([codex-lifecycle-observability](../open-questions/codex-lifecycle-observability.md)
  で保留)。
- 自動 compaction の発動側 (#158 決定 P2: operator 承認必須) には
  一切触れない。
