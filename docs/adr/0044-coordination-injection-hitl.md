---
title: 協調指針の共通フッター自動注入と director 媒介の自律協調
status: proposed
date: 2026-07-29
opened: 2026-07-28
supersedes: []
superseded_by: null
related_specs: [protocol-inter-agent, persona-personality-injection, threat-model]
related_adrs: [21, 22, 29, 43]
---

# ADR-0044 — 協調指針の共通フッター自動注入と director 媒介の自律協調

## Status

Proposed (2026-07-28 起草、2026-07-29 に proposed へ差し戻し)。実装は
kaoiro issue #87 (調査の傘) からの派生 issue で扱う。実装 phase は
着手時に採番する。

本 ADR は 2026-07-28 13:55 に my-idea-brief 経由の意図確認をもって
accepted として起草した。その約 2 時間後の
[#168 comment-2287](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/168#issuecomment-2287)
でマスターは **P5「永続 director 役は定義しない。都度 operator 指示 +
permission_broker 都度承認」** を決裁しており、永続 director 役を
前提とする F2 はこれと矛盾する。F1 (フッター注入) と F3 (受動発動) は
P5 と独立に成立するが、ADR 全体の HITL 境界が未確定であるため status
を proposed へ戻す。再決裁を要する論点は F2 のみ。

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

### F2 — HITL 境界は「director 媒介で自律」(要再決裁)

> **未確定**: 本節は上記 P5 決裁 (永続 director 役は定義しない) と
> 矛盾する。P5 は phase-28 の session reset 文脈で下されたが文言は
> 一般的であり、協調の文脈へ及ぶか否かを含めて再決裁が要る。以下は
> 差し戻し前の記述であり、確定仕様ではない。

作業分担の合意は **director 役を経由すれば operator 承認不要**
(事後報告) とする。peer 同士の直接分担は director への報告を条件に
許可する。これに伴い、現行運用「作業配分の約束は escalate 対象」
(2026-07-21 決裁) を改訂する。前提として `send_to_agent` の
auto-allow を protocol-inter-agent の「Phase 2 以降」から前倒しで
決定する必要がある — 範囲は
[send-to-agent-auto-allow](../open-questions/send-to-agent-auto-allow.md)
で確定する。

director 役の定義・指定・永続化は未定である。
[ADR-0043](0043-agent-initiated-session-reset.md) D2 は同じ論点を
session reset の文脈で扱い、他 agent 起点の専用経路と永続 director 役
をいずれも不採用として operator の都度指名に委ねた。協調の文脈で
別扱いにするならその根拠が要る。

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

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| Claude Code skill (SKILL.md) 配布 | engine 依存の仕組みになる |
| フッター + skill の併用 | SoT 管理の複雑化 |
| 完全自律 + 事後報告 (director なし) | 暴走・重複作業のリスク |
| 分担確定は operator 承認 (現状維持) | 自律性の向上が限定的 |
| 能動監視 (polling 常駐) | token コストと雑音 |
