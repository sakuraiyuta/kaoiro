---
title: 外部人間メッセージング — 人間を外部チャネルの participant 化・一方向 authority・discord-wrapper トポロジ
status: accepted
date: 2026-07-04
opened: 2026-07-04
supersedes: []
superseded_by: null
related_specs: [protocol-external-human, protocol, protocol-inter-agent]
related_adrs: [10, 17, 21]
---

# ADR-0028 — 外部人間メッセージング

## Status

Accepted

## Context

エージェント間メッセージング(inter-agent、[phase-8](../plans/phase-8-inter-agent-messaging.md)
実装済み)と同じノリで、AI エージェントが Discord 等で**外部の人間**へ
メッセージを投げ、返信も受け取れるようにしたい(kaoiro の対象: 自分/研究室
のオフィス的運用)。

inter-agent は両端が kaoiro 管理下だが、外部人間は端点が kaoiro の外にある。
これが (1) 双方向にするか、(2) kaoiro に実装するか外部 MCP にするか、
(3) untrusted な外部入力の扱い、を分岐させる。仕様正本は
[protocol-external-human](../specs/protocol-external-human.md)。

## Decision

### D1: 双方向 transport / 一方向 authority

transport は双方向(agent ↔ 外部人間)、authority は一方向。外部人間の
発言は agent の行動を破壊的/非破壊的/調査問わず**一切駆動しない**。外部
入力は operator への通知に留め、実行判断は operator と agent 自身の生成
内容にのみ帰属させる。これが本機能の中核セキュリティ性質。

### D2: discord-wrapper トポロジ(server は broker 堅持)

Discord 接続は専用 discord-wrapper(外部チャネル adapter entity)が保持し、
bot token をそこに閉じる。server は `to` でルーティングするのみで broker に
徹する。「末端は wrapper(agent)と client(operator)、server は橋渡し」の
原則を保ち、既存 inter-agent の routing / observation / quota を再利用する。

### D3: 専用 type・ツールで経路分離

untrusted-external 経路を trusted-agent 経路と**コード分離**するため、
`external_message` type と `send_to_human` tool を新設する(inter-agent の
一般化はしない)。trust model を 1 経路に同居させると条件分岐漏れが即
脆弱性になるため。

### D4: outbound = whitelist + 全文都度承認

宛先は operator が config ファイルで作る whitelist 内のみ。enforce は
discord-wrapper。agent には論理 contact id + 表示名までしか開示せず、生の
Discord ID / PII は wrapper 内に留める(一覧開示は防御を弱めない — enforce
が担保、office 比喩)。送信は `permission_broker` で宛先 + 本文全文を operator
に提示し都度承認。外部人間へは AI/kaoiro 発を明示する。

### D5: inbound = Tier A(既定・安全)/ Tier B(spike gate)

- **Tier A**(phase-0): LLM を使わず固定テンプレ返信 + 原文を operator へ
  verbatim 中継。injection 面ゼロ。fail-soft の縮退先。
- **Tier B**(phase-1): 「LLM を通す」≠「ツールを持つ agent を通す」を分離し、
  **zero-tool の受付 LLM**(Haiku、text→text のみ)で要約を `ext.interpretation`
  に付与(discord-wrapper のフィルタ列 = plugin-model フィルタ機構の初適用)、
  responder が限定返信を生成。working agent には非注入。原文 verbatim 保持・
  同一相手固定を MUST とし、最終採用は実装前 red-team spike で確定
  ([external-human-inbound-llm-tier](../open-questions/external-human-inbound-llm-tier.md))。

### D6: 安全弁・保持

1 会話 3 turn 上限を server の `ConversationStates` で機械強制。会話内容は
ephemeral(server 非永続)、contact 一覧 config のみ永続。`external_message`
は両 direction とも operator 限定配信([ADR-0021](0021-role-information-disclosure-policy.md))。

## Consequences

### Positive

- inter-agent の envelope routing / observation / quota / permission_broker を
  再利用でき、実装が薄い。
- server の broker 原則・operator 限定配信・agent 非依存を崩さない。
- 一方向 authority + 経路分離で、外部からの prompt injection / 破壊操作 /
  exfil を構造的に抑える。
- 長らく未実装だった plugin-model のフィルタ機構の初適用(Tier B)になり、
  issue #18(メッセージフィルタ)の初実体を兼ねる。

### Negative

- 新エンティティ種別(discord-wrapper)と新 type / tool / config surface が
  増える。bot token 管理・常時接続の運用が加わる。
- Tier B は injection 面を持ち、実装前 spike というゲート工程を要する。
- discord-wrapper 未接続中の inbound はロストする(容認、
  [external-human-inbound-loss](../open-questions/external-human-inbound-loss.md))。

### Neutral

- v1 は Discord のみ。email / Slack は将来 issue + docs に予定として残す。
- 外部人間からの指示受付(権限付与)は将来課題
  ([external-human-recv-permission-model](../open-questions/external-human-recv-permission-model.md))。
- contact 管理の GUI 化は将来
  ([external-human-contact-management-ux](../open-questions/external-human-contact-management-ux.md))。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| 片方向通知のみ | 「相手に聞いて返信を受ける」体験に届かない |
| 外部入力を agent が指示として処理(Tier C) | フルツール + タスク文脈 + 秘密で破壊/exfil/lateral の危険 |
| server 側 Discord adapter | 「末端は wrapper と client、server は broker」原則に違反 |
| inter_agent_message を recipient type=agent\|human に一般化 | trust model が 1 経路に同居し条件分岐漏れが即脆弱性 |
| contact 一覧を agent から隠す | enforce は wrapper で担保、開示しても防御は弱まらず利便のみ損なう |
| contact 管理を dashboard UI で(v1) | client を視覚表現に集中させたい + raw Discord ID の server 経路を避ける。将来課題へ |
| 外部会話の永続保存 | 新規永続面で非スコープ(将来 #24)抵触、第三者プライバシ懸念 |

## Related

- specs: [protocol-external-human](../specs/protocol-external-human.md)(正本)、
  [protocol](../specs/protocol.md)(`external_message` type 追補)、
  [protocol-inter-agent](../specs/protocol-inter-agent.md)(superset 元)。
- ADR: [0010](0010-protocol-precisification.md)(予約 type 追補)、
  [0017](0017-wrapper-multientity-packages.md)(multientity)、
  [0021](0021-role-information-disclosure-policy.md)(operator 限定配信)。
- kaoiro issue #18(メッセージフィルタ)。
