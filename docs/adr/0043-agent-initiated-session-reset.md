---
title: agent 自身が turn 境界で要求する session reset
status: accepted
date: 2026-07-28
opened: 2026-07-28
supersedes: []
superseded_by: null
related_specs: [protocol, threat-model]
related_adrs: [21, 22, 33, 36, 44]
---

# ADR-0043 — agent-initiated session reset

## Status

Accepted (2026-07-28、[#158 comment-5384365227](https://github.com/sakuraiyuta/kaoiro/issues/158#issuecomment-5384365227)
の決定記録および [#158 comment-5384365348](https://github.com/sakuraiyuta/kaoiro/issues/158#issuecomment-5384365348)
の Phase B 実機受け入れを根拠とする)。実装は
[phase-28-agent-initiated-session-ops の Phase C](../plans/phase-28-agent-initiated-session-ops.md#phase-c--自発-newclear-詳細化-2026-07-28クロエ裁定)
で行う。

## Context

[ADR-0036](0036-session-lifecycle-commands.md) は `/new`・`/clear` を
operator-only の第一級 control operation として定めた。F1 は user text を
wrapper が再 parse せず、client/server が exact reserved command を防御する原則を
採用し、F6 は busy な agent の reset を拒否して自動 interrupt と queue を採らない。

Phase 28 は context 疲労を agent 自身が検知・判断して回復操作を提案できるように
する。Phase B の `request_compact` は、MCP tool の `canUseTool` 経路で operator の
都度承認を得てから wrapper が action を実行する形を実機受け入れした。この経路を
`/new`・`/clear` にも適用したい。ただし reset は wrapper process を入れ替えるため、
tool call の最中に実行すると当該 turn の完了、tool result、ログ相関を壊す。

したがって必要なのは、text command の意味を増やすことではなく、agent 自身が許可を
得て reset を**予約**し、現在の turn が完了した境界で ADR-0036 F2 の既存 reset
経路へ要求を渡す限定的な起点追加である。runner の kill + fresh relaunch、session
pointer、operator 起点 reset の意味論は変更しない。

## Decision

### D1 — F1 の起点を agent 自身へ拡張する

ADR-0036 F1 の起点は operator に加えて **agent 自身 (self-initiated)** を許可する。
Claude wrapper は `request_session_reset` MCP tool を提供し、agent は自身に対してのみ
`mode: "new" | "clear"` と任意の `reason` を渡せる。承認済み request は turn 境界で
wrapper から server へ `session_reset_request {mode, reason?}` として送る。server は
origin を `agent_self` として記録し、既存の capability / pending lock / state /
cooldown gate を通して既存 runner push 経路へ合流させる。

この追加は wrapper による user text の再 parse を導入しない。ADR-0036 F1 の
`/new`・`/clear` exact instruction reject、および attachment を含む入力の扱いは
そのまま維持する。operator が入力した local command と agent が tool で要求する
control operation は別経路である。

### D2 — 他 agent 起点の専用経路は作らない

agent A が agent B の reset を直接要求する専用 protocol / tool は導入しない。永続的な
director 役も作らない。operator が必要に応じて director を指名し、指示された agent
が**自分自身**の tool を呼び、operator が都度承認する既存の責務分離で足りる。

### D3 — F6 に self-initiated reset の deferred 実行を追補する

`request_session_reset` の tool call が承認された時点では reset を実行せず、wrapper は
予約受理を返す。当該 turn の `result` を処理して wrapper 自身が turn 境界を確定した
後にだけ server へ request を送る。permission の時点と実行の時点が異なることは、
deferred reset の意図した挙動である。

operator 起点 reset に対する ADR-0036 F6 の busy 拒否、自動 interrupt 不採用、queue
待機不採用は全て維持する。agent 起点も server の同じ gate へ入るため、予約後に
state / pending lock / cooldown が不適格なら reset は拒否される。reset の実行系
(kill + fresh relaunch) は ADR-0036 F2 を変更せず再利用する。

### D4 — permission は「重」とし、tool call ごとに broker 承認する

`request_session_reset` は Phase 28 P2 の「重」操作であり、`canUseTool` を通じて
permission_broker の都度承認を必要とする。auto-allow、永続許可、agent 自己承認は
導入しない。operator は reason と mode を確認して予約を許可または拒否する。

### D4 追補 (2026-07-28 — 承認の permission mode 従属)

実機受け入れで、dogfood の Claude persona (`permission_mode=auto`) では
承認ダイアログが operator に出ないことが判明した。`auto` 等の自律 mode
では SDK が mode の意味論として tool 呼び出しを自動承認するため、
canUseTool → permission_broker 経路が発火しない。wrapper の gate 実装
(READ_ONLY_TOOLS 非登録 → canUseTool 行き) は正しく、`default` 系 mode
では都度ダイアログが出る。

マスター決裁 (2026-07-28): **承認は agent の permission mode に従属する**
ことを正式仕様とする。D4 の「auto-allow・永続許可・agent 自己承認を導入
しない」は「kaoiro 側が mode を迂回する独自の auto-allow 機構を持たない」
の意味に限定される。mode 自体が与える自動承認は、operator が当該 agent
に与えた自律性の一部として有効であり、厳格な都度承認が必要な agent は
operator が mode を `default` 系に設定することで gate を回復する。この
セマンティクスは `request_compact` / `send_to_agent` を含む canUseTool
経由の全 tool に共通する。

### D5 — handoff は機構化せず、外部化を tool description で促す

reset 前の handoff summary を protocol や server state に保存する機構は作らない。
agent は `request_session_reset` を呼ぶ前に、必要な引き継ぎを WORKLOG 等の外部永続先へ
書き出す。tool description はこの責務を明記する。compact の要約内蔵を new/clear に
一般化しない。

## Consequences

### Positive

- context 疲労を認識した agent が、operator の確認を保ったまま自ら fresh session を
  求められる。
- reset を turn 境界に限定するため、tool result・ログ・現在 turn の完了を途中で失わない。
- server / runner の reset 実行系を再利用し、operator 起点との gate と失敗 semantics を
  一致させられる。
- user text の再 parse を避け、reserved command 防御と model 入力の責務境界を保つ。

### Negative

- tool 承認後にも turn 完了まで reset は実行されず、承認と実行に時間差がある。
- reservation 後に state が変われば server が拒否しうるため、agent は次 turn で失敗を
  知ることになる。
- handoff の外部化は agent の運用責務であり、機構的な完全性保証はない。

### Neutral

- Codex には `request_session_reset` を露出しない。対象は Claude wrapper の
  MCP tool 経路である。
- viewer への情報境界は ADR-0021 のままであり、origin / reason を viewer へ
  開示しない。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| 他 agent が任意の agent の reset を直接起動する専用経路 | P5 により不要。operator が都度 director を指名し、対象 agent 自身の tool と承認で成立する |
| 自動 interrupt 後に直ちに reset | tool write / 現在 turn の出力と context 破棄を一操作に束ねる危険があり、ADR-0036 F6 の却下を維持する |
| busy 終了まで reset を queue | 後から実行される破棄で入力先を誤認するため、ADR-0036 F6 の却下を維持する |
| wrapper が user text を再 parse して agent reset とみなす | F1 の control と model 入力を混ぜない原則、および reserved command 防御を破る |

## References

- 決定記録: [issue #158 comment-5384365227](https://github.com/sakuraiyuta/kaoiro/issues/158#issuecomment-5384365227)
- Phase B 実機受け入れ: [issue #158 comment-5384365348](https://github.com/sakuraiyuta/kaoiro/issues/158#issuecomment-5384365348)
- 実装計画: [phase-28 Phase C](../plans/phase-28-agent-initiated-session-ops.md#phase-c--自発-newclear-詳細化-2026-07-28クロエ裁定)
- 改訂元: [ADR-0036](0036-session-lifecycle-commands.md) F1, F2, F6
- permission の先例: ADR-0022, ADR-0033
- viewer 情報境界: ADR-0021
