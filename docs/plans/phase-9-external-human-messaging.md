---
title: Phase 9 — 外部人間メッセージング(Discord)
description: AI エージェントが Discord 経由で外部の人間へ双方向メッセージを送受信する。Stage 0 = Tier A 安全スライス、Stage 1 = Tier B(zero-tool 受付 LLM、spike gate)。
status: planned
phase: 9
depends_on: [phase-8-inter-agent-messaging, phase-4-host-runner]
last_updated: 2026-07-04
---

# Phase 9 — 外部人間メッセージング(Discord)

AI エージェント(オフィスのスタッフ)が Discord 経由で外部の人間へメッセージ
を投げ、返信も受け取れるようにする。inter-agent([phase-8](phase-8-inter-agent-messaging.md))
の superset。envelope schema 等の機械的仕様は
[protocol-external-human spec](../specs/protocol-external-human.md)、決定背景は
[ADR-0028](../adr/0028-external-human-messaging.md)。

本 plan は project ロードマップ番号 phase-9。feature-local スライスは下記
Stage 0 / Stage 1 として plan 内に畳む(phase-8 が Stage A〜D を内包したのと
同じ形)。

## Goal

operator の連絡先(共同研究者等)へ、agent が明示ツール呼び出し + operator
承認を経て Discord メッセージを送り、返信を operator が dashboard で追える。
外部人間の発言は agent の行動を駆動しない(一方向 authority)。

## Non-goals(本 Phase の外)

- email / Slack チャネル(future issue + docs に予定として残す)
- 外部人間からの指示受付(権限付与モデル、
  [external-human-recv-permission-model](../open-questions/external-human-recv-permission-model.md))
- 外部入力を agent が作業に取り扱う経路
  ([external-human-agent-consumes-input](../open-questions/external-human-agent-consumes-input.md))
- contact 管理の GUI 化(v1 は config ファイル、
  [external-human-contact-management-ux](../open-questions/external-human-contact-management-ux.md))

## Stage 0 — Tier A 安全スライス(最小・LLM 不使用)

injection 面ゼロで双方向 transport の骨格を実証する。inbound は決定論。

### Acceptance Criteria

- [ ] discord-wrapper entity が bot 接続を保持し token をプロセス内に閉じる
- [ ] config ファイルの contact whitelist(論理 id・表示名・配送先 DM|channel・生 target)を読む
- [ ] agent が `send_to_human` を呼ぶ → operator に宛先 + 本文全文で都度承認 → whitelist enforce → Discord 送信、AI/kaoiro 発を明示
- [ ] inbound は Tier A(固定テンプレ返信 + 原文を operator へ verbatim 中継)、LLM 不使用
- [ ] `external_message`(両 direction)が operator 限定配信(viewer 完全除去)
- [ ] 1 会話 3 turn を server(ConversationStates)で機械強制
- [ ] spec の envelope schema と実装が一致(typecheck / lint パス)

### Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 9-1 | spec 確定 + protocol.md に `external_message` type 追補 | ⏳ | |
| 9-2 | discord-wrapper entity(bot 接続・token 閉じ込め・runner 監督) | ⏳ | discord.js 想定 |
| 9-3 | contact whitelist config 読み込み + 解決 + enforce | ⏳ | 生 ID は wrapper 内 |
| 9-4 | `send_to_human` / `list_contacts` / `whoami` ツール(wrapper MCP) | ⏳ | send_to_agent と同型 |
| 9-5 | outbound routing(server)+ permission_broker 全文承認 | ⏳ | |
| 9-6 | inbound Tier A(固定テンプレ返信 + 原文 operator 中継) | ⏳ | LLM 不使用 |
| 9-7 | quota 3 turn を ConversationStates へ拡張 | ⏳ | |
| 9-8 | dashboard に external_message log 表示(operator 限定) | ⏳ | |
| 9-9 | E2E: agent → 外部人間 → 返信 → operator 観測の 1 ラウンド | ⏳ | |

## Stage 1 — Tier B(zero-tool 受付 LLM、spike gate)

**着手前に red-team spike を必須ゲートとする。**

### Acceptance Criteria

- [ ] red-team spike: injection で Tier B 不変条件(原文 verbatim / 同一相手固定 / zero-tool)が破れないことを確認
- [ ] zero-tool Haiku フィルタが inbound に `ext.interpretation` を付与(原文 body は不変)
- [ ] responder が限定返信を生成(発信してきた同一相手に固定)
- [ ] Haiku 失敗時に Tier A へ fail-soft 縮退
- [ ] working agent の live session に非注入
- [ ] フィルタを agent-agnostic module 化(将来の別 wrapper 抽出に開放)

### Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 9-10 | red-team spike(injection 耐性検証) | ⏳ | Tier B 採用の gate |
| 9-11 | zero-tool Haiku フィルタ(ext.interpretation 付与) | ⏳ | plugin-model フィルタ初適用 / issue #18 |
| 9-12 | responder(同一相手固定の限定返信) | ⏳ | |
| 9-13 | fail-soft(Haiku 落ち → Tier A) | ⏳ | |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## Followups (in-phase but unfinished)

なし。

## Open Questions Blocking This Phase

- [external-human-inbound-llm-tier](../open-questions/external-human-inbound-llm-tier.md)
  — Stage 1(Tier B)の最終採用を gate

## See Also

- Specs covered:
  [protocol-external-human](../specs/protocol-external-human.md),
  [protocol](../specs/protocol.md), [plugin-model](../specs/plugin-model.md)
- ADR: [0028](../adr/0028-external-human-messaging.md)
- Previous phase: [phase-8-inter-agent-messaging](phase-8-inter-agent-messaging.md)
- kaoiro issue #98(実装)、#96(Tier B red-team spike)、#97(email/Slack 将来)、
  #18(メッセージフィルタ)
