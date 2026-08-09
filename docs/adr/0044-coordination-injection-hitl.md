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
採らない。指針の文面と長さは案 A (短い行動原則のみ) で確定した
(2026-08-08 マスター決裁、詳細は下記追補)。

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
前提となる `send_to_agent` の auto-allow は、protocol-inter-agent の
「Phase 2 以降」から前倒しし、案 B (conversation 単位 whitelist) で
確定した (2026-08-08 マスター決裁、詳細は下記追補)。

**破壊的操作は責務内自律の対象外。** session reset (`/new`・`/clear`)
は ADR-0043 D2/D4 のとおり、対象エージェント自身の tool 呼び出し +
permission broker 都度承認を維持する。director が配下の reset を直接
起動する経路は作らない。

### F3 — 発動は受動 (作業契機)

協調判断の発動は、自分がタスクを受けた時・行き詰まった時に peer
状況を確認して行う**受動型**とする。idle エージェントが定期的に
peer を監視して支援を申し出る能動監視 (polling 常駐) はスコープ外。

### 追補 (2026-08-09、issue #175 — 残 open-question の決着)

2026-08-08 マスター決裁により、F1/F2 が前提としていた残り 2 件の
open-question を決着した。

- **send-to-agent-auto-allow**: 案 B (conversation 単位 whitelist) を
  採用。最初に operator 承認 (`canUseTool`) を経て server に accepted
  された送信のみがその `(conversation_id, to)` の組合せを確立し、
  以降の `send_to_agent` を自動許可する — canUseTool の承認を経ただけ
  (server がまだ受理していない、または reject/unknown) では組合せは
  成立しない (`to` も束縛するのは外部レビューでの指摘、
  [#211](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/211)
  参照 — conversation_id 単独では reject 後の宛先差し替えが dialog を
  飛ばしてしまう)。暴走ガード (#177 で一部対応) がまだ弱い現状では、
  狭い範囲の自動許可が安全という判断。詳細な実装挙動 (dispatch 待機中
  の受信レースへの耐性を含む) は
  [protocol-inter-agent](../specs/protocol-inter-agent.md) 「自動承認」
  節を正とする。
- **coordination-footer-scope**: 案 A (短い行動原則のみ) を採用。
  kind の使い分けや報告形式といった手順の詳細はフッターに含めない。
  不足が判明すれば運用計測後に拡張する。長さ担保の機構は
  [ADR-0045](0045-footer-file-externalization.md) F5 で別途決着済み。

両 open-question は decided 反映のうえ close (削除) した。実装は本
issue ([#175](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/175))
で行う ([protocol-inter-agent](../specs/protocol-inter-agent.md)
「承認フロー」節、server 側 `priv/footers/system-footer.md`)。

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
  で追う)。**追補 (2026-08-09、issue #177)**: 「終わり方」の一部 —
  完了済み conversation が再開して done / escalate の ping-pong が
  止まらなくなる不具合 — は #177 が server 側 tombstone
  (`conversation_closed` での再開拒否) と wrapper 側 lifecycle
  (`localDone` / `remoteDone` / `closed`、stale/duplicate turn の
  拒否) で機械的に閉じた
  ([protocol-inter-agent](../specs/protocol-inter-agent.md)
  「conversation のライフサイクルと終了後の扱い」節)。残る論点
  (意味的に同一の提案が形を変えて繰り返されるループの検知等) は
  #87 のまま継続する。
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
