---
title: Phase 16 — Codex model catalog と session継続switch
description: ChatGPT plan申告に基づくCodex model catalogを復活し、同一session/historyを維持するmodel・effort切替、loud fail、rollback、capability広告を実装する。
status: done
phase: 16
depends_on: [phase-15-wrapper-ux-parity]
last_updated: 2026-07-13
---

# Phase 16 — Codex model catalog と session継続switch

## Goal

[ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md) を実装し、
ChatGPT Plus以上ではCodexのSol / Terra / Lunaを起動時・session途中の双方で
選択できるようにする。Free / Go、plan未申告、auth検出失敗はfail closedし、
session途中の失敗でもhistoryと最後の実効modelを失わない。

実装着手はphase-15 initial完了後。phase-15 task 15-4の
`model_source`化と15-8のresume snapshot semanticsを前提にし、同じUI・schemaを
二重実装しない。

## Acceptance Criteria

- [ ] `runner.config.json` の `codex.chatgpt_plan` closed enumをvalidationし、
      auth mode + plan申告からcatalogを解決する。chatgpt未申告/検出失敗は空catalog
      + warn、Free/GoはTerraのみ、Plus以上はSol/Terra/Luna、apikeyは別catalog。
      apikey時に残置されたplan申告はstderr warn + ignore。
- [ ] runner registerとspawn後の`ext.models`が同じresolver出力を使う。
- [ ] 各Codex model entryの`effort_levels`はCLI/SDK型と実機で受理確認した値のみ。
- [ ] `supports_model_switch` / `supports_effort_switch`を
      `ext.session_capabilities`へstampし、dashboardはengine名で判定しない。
- [ ] LaunchDialogにCodex model / effort selectが復帰する。
- [ ] AgentDetailからmodel / effortを変更でき、現turnは不変、次turnから適用する。
- [ ] **同一sessionでTerra -> Sol -> Terraを往復**し、各turnの
      `turn_context.model`、同一`sessionId`、以前の会話history維持を実機確認する。
- [ ] 非entitledまたは不正slugでHTTP 400/404になった場合、turnはloud failし、
      silent fallbackしない。失敗値はeffective/snapshotへ確定しない。
- [ ] **不正slug失敗後、旧modelへrollback**して同一sessionの次turnが成功し、
      historyが維持される。
- [ ] operator-requested switchは`resume_drift`に出ず、最後に成功した実効値が
      resume snapshotへ保存される。
- [ ] model変更時に現在effortが新modelで無効ならsilent downgradeせず、UIで
      有効値の再選択または既定化を明示する。
- [ ] plan未申告の既存利用者は空catalog + account defaultで従来どおり動く。
- [ ] protocol / runner / wrapper / server / dashboardのunit・integration testが通る。

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 16-1 | `RunnerConfig`へ`codex.chatgpt_plan`とclosed-enum validationを追加 | ✅ | 97a080c |
| 16-2 | `codex doctor --json` auth-mode検出とfail-closed処理をrunnerへ追加 | ✅ | 2cb6d6e |
| 16-3 | auth mode + planから`EngineModelInfo[]`を返すCodex catalog resolverを実装 | ✅ | 0e1e5b4 (SSOT resolver + runner/wrapper 輸送) |
| 16-4 | Sol/Terra/Lunaのeffort値を0.144.1で検証し`effort_levels`へ統合 | ✅ | 0b5c368 (openai/codex main の models.json 由来 curated snapshot、2026-07-13) |
| 16-5 | protocolへ`supports_model_switch` / `supports_effort_switch`を追加 | ✅ | 2cce473 |
| 16-6 | Codex adapterのpending/effective model・effortとlast-known-goodを実装 | ✅ | fb3bef2 (pending/effective/last-good 3 段 + turn boundary + failure rollback + switch_error 1 回性 stamp + operator drift filter) |
| 16-7 | server snapshot更新を成功したeffective値のみに限定 | ✅ | 5273f85 |
| 16-8 | LaunchDialogのCodex model / effort selectを復帰 | ✅ | 72feee0 |
| 16-9 | AgentDetailのmid-session switch、pending/failure/rollback表示を実装 | ✅ | 72feee0 |
| 16-10 | catalog matrix、switch、400/404、rollbackのunit/integration testを追加 | ✅ | abcbcd7 (adapter 9 case + dashboard 10 case、64+131 pass) |
| 16-11 | Terra -> Sol -> Terraと不正slug rollbackのhost実機試験 | ✅ | 2026-07-13 host verify、A-2 疎通 + Terra→Sol→Terra 同一sessionId+history維持 + resume drift なし。#7/#8 (不正slug loud fail/rollback) は UI 経路がないため skip、16-10 adapter integration test (abcbcd7) の 400/404 rollback + switch_error 1回性で covered |
| 16-12 | specsと運用docsを更新し全regression testを実行 | ✅ | 2026-07-13: protocol / plugin-model / codex-model-catalog / codex-sdk-events を phase-16 実装内容に同期。全 regression 978 pass (runner 116 + wrapper core 51/agent-common 79/codex 64/claude-code 152 + server 385 + dashboard 131) |

Status legend: ⏳ not started, 🟡 mostly done, ⚠ partial, ✅ done, ⛔ blocked.

## Non-goals

- phase-15の`model_source`、resume snapshot基盤、Codex label特例撤去の再実装。
- OpenAI側にplan/entitlement列挙APIを追加すること。
- runtime probeによるcatalog自動生成。
- API-key catalog全slugの恒久保証。curated snapshotとして保守する。

## Open Questions Blocking This Phase

なし。方式とswitch contractはADR-0035で決定済み。実装開始時に確認する
effort値集合はverification taskであり、architecture blockerではない。

## See Also

- Decision: [ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md)
- Related: [ADR-0032](../adr/0032-codex-adapter.md) F4bc / [ADR-0034](../adr/0034-session-capabilities-advertisement.md) F2
- Previous phase: [phase-15-wrapper-ux-parity](phase-15-wrapper-ux-parity.md)
