---
title: codex engine の遷移観測と resume 対応
description: codex の compaction 観測手段が無く、session_lifecycle と resume_prompt の codex 対応を保留している
status: deferred
urgency: low
blocks: []
opened: 2026-08-31
decided: 2026-08-31
---

# codex engine の遷移観測と resume 対応

## 背景

[ADR-0055](../adr/0055-compaction-resume-and-lifecycle-log.md) の resume
は `compact_boundary` の局所観測に依存し、`request_compact` 自体が
Claude 限定 (codex は `/compact` 経路が無く engine 側 auto-compaction
前提)。session_lifecycle の記録も codex では当面 server 既知の
disconnect 系のみになる。

## 選択肢

- A: codex SDK の compaction 観測手段を調査し、observable なら producer
  を追加する
- B: engine 側 auto-compaction 前提を維持し、対象外のままとする

## 影響

codex agent の時系列は disconnect 系のみで、compaction 起因の挙動を
事後に追えない。

## 判断材料

codex SDK のイベント仕様 ([codex-sdk-events](../specs/codex-sdk-events.md))
に compaction 境界の確定イベントが現れるかどうか。

## 暫定方針

B (オペレータ裁定 2026-08-31: 周辺の未実装・未対応部分も含め将来課題と
する。しばらくは Claude のみでよい)。
