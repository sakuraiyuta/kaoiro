---
title: compaction resume と lifecycle log
description: request_compact の resume_prompt (wrapper 局所) と session_lifecycle 時系列保持・operator query の実装
status: in_progress
phase: 33
depends_on: []
last_updated: 2026-08-31
---

# Phase 33 — compaction resume と lifecycle log

[ADR-0055](../adr/0055-compaction-resume-and-lifecycle-log.md) の実装。
issue #200 が親。段階は feature-local に A/B/C とする (project-wide の
phase 番号との衝突回避)。

## Stage A — wrapper 局所 resume (issue #200 の原初要求)

- [x] `request_compact` に optional `resume_prompt` パラメータを追加
      (Claude wrapper のみ。承認ダイアログには reason 同様 echo)
- [x] `compact_boundary` 観測時、固定前置テンプレート + resume_prompt
      逐語を直列化 instruction queue へ user turn として注入
- [x] 省略時の挙動が現状と完全一致することの回帰テスト
- [x] 注入経路 MUST (固定テンプレート、model 由来逐語は resume_prompt
      本文のみ) の反映とテスト

受け入れ: resume_prompt 付き compact 承認 → 圧縮完了後に agent が
自動で作業再開する実機確認。server 変更ゼロ。実装・自動テストは完了
(2026-08-31)。実機確認 (実際の compact_boundary 発火での再開) は
未実施。

## Stage B — session_lifecycle 記録

- [ ] wrapper→server `session_lifecycle` イベント新設
      (kind / trigger / 発生時刻)
- [ ] wrapper 側 producer: compact 開始/完了 (trigger: request_compact /
      sdk_auto)、閾値通知発火、resume_reserved / resume_fired
- [ ] server 側で disconnect / reconnect / session reset を同一時系列へ
      合流
- [ ] DETS 保持 (agent ごと既定 10,000 件・古い順破棄、
      `SESSION_LIFECYCLE_MAX_EVENTS_PER_AGENT` で変更可)

## Stage C — operator query

- [ ] operator 向け pull query イベント (`require_operator` gate、
      `list_conversations` と同型)
- [ ] protocol.md のイベント表更新 (実装と同時)

## Out of scope

- dashboard タイムライン UI ([lifecycle-timeline-ui](../open-questions/lifecycle-timeline-ui.md)、別 issue)
- codex engine の compact 観測 ([codex-lifecycle-observability](../open-questions/codex-lifecycle-observability.md)、deferred)
- 自動 compaction の発動 (既存 P2 決定の維持)
