---
title: Phase 29 — footer 外部化と persona cache 外出し
description: footer のファイル外部化と persona extraction cache の分離を実装する。
status: done
phase: 29
depends_on: []
last_updated: 2026-08-03
---

# Phase 29 — footer 外部化と persona cache 外出し

## Goal

[ADR-0045](../adr/0045-footer-file-externalization.md) の footer 外部化を
実装し、[ADR-0046](../adr/0046-persona-cache-relocation.md) と kaoiro
issue #173 による persona cache の `:ro` 対応を完了する。

## Tasks

| # | Task | Owner | Status | Notes |
|---|------|-------|--------|-------|
| 29-1 | footer 機構実装 | あお | ✅ 完了 | ADR-0045 |
| 29-2 | cache 外出し | あお | ✅ 完了 | ADR-0046 / #173 |
| 29-3 | docs 整合 sweep | もも | ✅ 完了 | 第 1・第 2 弾 |
| 29-4 | レビュー | ふじ | ✅ 完了 | 3 巡 (must-fix 計 3) → approve |

Status legend: ✅ done, 🟡 in progress, ⚠ partial, ⏳ not started, ⛔ blocked.

## Acceptance Criteria

- [x] `mix test` が green (749 passed)
- [x] `:ro` の persona dir で cold start が成功する (chmod 0500 test)
- [x] footer ファイルの編集が再起動なしで次の接続に反映される (inotify 実機検証)

## See Also

- ADRs: [0045](../adr/0045-footer-file-externalization.md),
  [0046](../adr/0046-persona-cache-relocation.md)
- Specs: [persona-pack-schema](../specs/persona-pack-schema.md),
  [deployment](../specs/deployment.md)
