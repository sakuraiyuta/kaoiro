---
title: 協調指針の共通フッター自動注入と都度指名 director 下の責務内自律
status: accepted
date: 2026-07-29
opened: 2026-07-28
supersedes: []
superseded_by: null
related_specs: [protocol-inter-agent, persona-personality-injection, threat-model]
related_adrs: [21, 22, 29, 43, 45]
---

# ADR-0044 — 協調指針の共通フッター自動注入と都度指名 director 下の責務内自律

## Status

Accepted (2026-07-28 起草、2026-07-29 マスター再決裁で F2 を改訂)。
実装は kaoiro issue #87 (調査の傘) からの派生 issue で扱う。実装 phase
は着手時に採番する。

起草時の F2 は**永続的な** director 役を前提としており、その約 2 時間後
に下された
[#168 comment-2287](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/168#issuecomment-2287)
の P5「永続 director 役は定義しない。都度 operator 指示 +
permission_broker 都度承認」と矛盾していた。2026-07-29 のマスター再決裁
により F2 を「operator が都度指名する director のもとで各エージェントに
責務が割り当てられ、その責務の範囲内で自律する」形へ改訂し、永続役を
定義しない点で P5 および
[ADR-0043](0043-agent-initiated-session-reset.md) D2 と整合させた。
F1 (フッター注入) / F3 (受動発動) は起草時から変更しない。

## Context

kaoiro 上で複数エージェントを並行運用する際、operator が毎回協調の
やり方を指示しなくても、エージェント群が互いの状況を見て自律的に
作業分担・共同作業できるようにしたい (kaoiro issue #87)。

観察基盤は phase-27 で整備済み: `list_agents` は peer の実行特性
(engine / model / effort) と稼働状況 (context / session_started_at /
turns / last_activity_at / conversation / rate_limits) を返す。
一方で行動指針の注入機構はなく、`send_to_agent` は
[ADR-0022](0022-pending-permission-authoritative-source.md) の
`canUseTool` 経路で毎回 operator 承認を要する
([protocol-inter-agent](../specs/protocol-inter-agent.md) は
auto-allow を「Phase 2 以降」と保留)。運用ルール上も「作業配分の
約束は escalate 対象」(2026-07-21 決裁) であり、自律的な作業分担は
成立しない。

## Decision

### F1 — 注入経路は server SoT 共通フッターの拡張

「他エージェントの状況を `list_agents` で観察し、自分で判断し、
必要なら `send_to_agent` で協調して作業分担・共同作業する」行動
指針を、[ADR-0029](0029-persona-server-sot-and-pack-distribution.md)
の server 集約 SoT 共通フッターに追記し、kaoiro 上で起動した**全
エージェント**へ system prompt append で自動注入する。engine 非依存
の既存機構の延長であり、Claude Code skill (SKILL.md) 形式の配布は
採らない。指針の文面と長さは
[coordination-footer-scope](../open-questions/coordination-footer-scope.md)
で確定する。

### F2 — HITL 境界は「都度指名 director のもとでの責務内自律」

**永続的な director 役は定義しない。** operator が作業単位ごとに
director を都度指名する
([ADR-0043](0043-agent-initiated-session-reset.md) D2 および #168 P5 と
同じ形)。指名された director は配下エージェントへ役割 (責務範囲) を
割り当て、各エージェントはその責務の範囲内では operator 承認なしに
`send_to_agent` で協調 (作業分担の合意・調整・事後報告) してよい。
責務の外へ出る判断は director への確認、または operator への escalate
とする。

HITL の起点は **director の指名と責務範囲の設定** であり、責務内の
個々の `send_to_agent` ではない。これに伴い現行運用「作業配分の約束は
escalate 対象」(2026-07-21 決裁) を、責務範囲内に限って改訂する。
前提として `send_to_agent` の auto-allow を protocol-inter-agent の
「Phase 2 以降」から前倒しで決定する必要がある — 技術的な適用範囲は
[send-to-agent-auto-allow](../open-questions/send-to-agent-auto-allow.md)
で確定する。

**破壊的操作は責務内自律の対象外。** session reset (`/new`・`/clear`)
は ADR-0043 D2/D4 のとおり、対象エージェント自身の tool 呼び出し +
permission broker 都度承認を維持する。director が配下の reset を直接
起動する経路は作らない。

### F3 — 発動は受動 (作業契機)

協調判断の発動は、自分がタスクを受けた時・行き詰まった時に peer
状況を確認して行う**受動型**とする。idle エージェントが定期的に
peer を監視して支援を申し出る能動監視 (polling 常駐) はスコープ外。

## Consequences

### Positive

- operator の指示なしにエージェント群の作業分担が成立し、並行運用
  のスループットが上がる。
- 注入は ADR-0029 の既存 SoT 機構の延長で、server 側の一元管理を
  保てる。受動型のため常駐機構の token コストが発生しない。

### Negative

- `send_to_agent` の operator 承認が縮小し、エージェント間の暴走
  対話・重複作業のリスクが増す (#87 の「終わり方設計」「観測可能性」
  論点、および
  [work-division-conflict-guard](../open-questions/work-division-conflict-guard.md)
  で追う)。
- 共通フッターが肥大すると全エージェントの context を常時消費する
  (ADR-0029 の文字数 SHOULD 目安との折り合いが必要)。

### Neutral

- dashboard の観測経路 (inter-agent message の operator 限定配信、
  [ADR-0021](0021-role-information-disclosure-policy.md)) は不変。
  自律化するのは送信の承認であって開示範囲ではない。
- director が指名されていない作業では従来どおり `send_to_agent` に
  operator 承認を要する。自律が働くのは指名と責務割り当てを経た範囲に
  限られ、既定状態は現行のままである。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| Claude Code skill (SKILL.md) 配布 | engine 依存の仕組みになる |
| フッター + skill の併用 | SoT 管理の複雑化 |
| 完全自律 + 事後報告 (director なし) | 暴走・重複作業のリスク |
| 永続 director 役を定義し指名を持続させる | 役割が固定され operator の統制点が失われる。#168 P5 / ADR-0043 D2 で不採用 |
| 分担確定は operator 承認 (現状維持) | 自律性の向上が限定的 |
| 能動監視 (polling 常駐) | token コストと雑音 |
