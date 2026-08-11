---
title: viewer / operator ロールの情報公開ポリシ — allow-list 方式と envelope 別マトリクス
status: accepted
date: 2026-06-22
opened: 2026-06-22
supersedes: []
superseded_by: null
related_specs: [protocol, threat-model, protocol-inter-agent]
related_adrs: [11, 12, 13, 22, 25, 27, 28, 30, 40, 41, 42, 43, 44]
---

# ADR-0021 — viewer / operator ロールの情報公開ポリシ

## Status

Accepted

## Context

[ADR-0011](0011-phase3-reliability-and-auth.md) / [ADR-0012](0012-response-display-and-dashboard-scope.md)
で「指示・承認・返答ログは operator 限定」とは決めたが、viewer ロールが
**何を見られるか** の全体方針は未定義のまま、必要が出るたびに個別パッチで
deny-list を継ぎ足してきた:

- `log` / `result` 配信を operator 限定([ADR-0012](0012-response-display-and-dashboard-scope.md))。
- `permission_request.input` を viewer から除去(本 ADR の前史)。
- `state_change.ext`(`cwd` / `model` / `context` / `rate_limits` /
  `slash_commands`)を viewer から除去(#46 実装フェーズ、コミット 9b32c34 /
  ef7b606。catch-all で全 type の `ext` を削除)。

この継ぎ足し方式には 3 つの構造的問題がある:

1. **新 envelope type の viewer 配信デフォルトが不明** — catch-all は素通し
   なので、新規追加の type は機微フィールドを含んでいても **viewer に
   配信される**。開発者が能動的に「これは operator 限定」と判断しない限り
   漏洩が起きる(fail-open)。
2. **viewer の「正しい見え方」が文書化されていない** — どこまで grid を
   描けるか、詳細パネルは何を見せるかが暗黙。spec を読んでも判断できない。
3. **`permission_request` envelope の `input` 以外**(`tool_name` /
   `request_id` / `truncated`)が viewer に素通ししており、operator が
   何のツールを使おうとしているか viewer から推測できる(部分的 leak)。

issue #46 はそもそも「viewer ロールの権限・情報公開範囲を **spec-elicitation
でしっかり詰める**」が本旨だった。そのポリシをここで明文化する。

## Decision

### F1: 2 ロール固定(operator / viewer)

中間ロール(admin 等)は YAGNI。`operator` = 管理者として全権、`viewer` =
閲覧専用。3 ロール化は別 ADR を要する。

### F2: viewer 配信は allow-list 方式(operator 限定がデフォルト)

サーバ → クライアント方向の **すべての envelope / event** は、明示的に
viewer 配信が宣言されたものだけが viewer へ届く。それ以外は viewer から
**完全除去**(envelope は push しない、snapshot からも外す)。

実装は `agents_channel.ex` の `sanitize_envelope_for/2` を allow-list 構造
へ書き換える(catch-all で素通しせず、`:viewer` 句が type ごとに明示
判定する)。新しい envelope type を追加する開発者は viewer 配信の要否を
**能動的に判断** することを強制される(fail-closed)。

### F3: envelope type × role マトリクス

`agents:lobby` トピックで配信する events(envelope 含む)の viewer 可視性を
定義する:

| event / envelope.type | operator | viewer | 備考 |
|---|---|---|---|
| `envelope` `state_change` | ✓ そのまま | ✓ `ext` を除去 | grid 描画の起点。`ext` は `cwd` 等の機微を含むため viewer 除去(catch-all で将来 ext 追加項目も自動カバー)。`state` フィールドは viewer に必要(`waiting_permission` 等の grid 表示) |
| `envelope` `permission_request` | ✓ そのまま | ✓ 合成 `state_change(waiting_permission)` に置換 | viewer は `input` / `tool_name` / `request_id` を一切受け取らない。grid presence は保つため、type を `state_change` に書き換え `payload={}` / `ext` 除去で配信(直前の wrapper 発の `state_change(waiting_permission)` と重複するが冪等) |
| `envelope` `log` | ✓ | ✗ 完全除去 | ADR-0012、シークレット混入の主経路 |
| `envelope` `result` | ✓ | ✗ 完全除去 | ADR-0012、同上 |
| `envelope` `task`(予約) | TBD | ✗ デフォルト deny | 仕様確定時に再判断(ADR-0019)、明示宣言なき限り viewer 非配信 |
| `snapshot`(join 時) | 全 agent / 全 type を sanitize 適用 | 同左(`permission_request` は合成 `state_change` に置換) | grid 起点 |
| `history`(join 時) | ✓ | ✗ push しない | ADR-0012 |
| `history_cleared`(broadcast) | ✓ | ✗ | viewer は log 自体見られないので意味なし。allow-list 方針に合わせて intercept して operator 限定 push |
| `agent_deleted`(broadcast) | ✓ | ✓ | grid 整合のため必要(agent_id のみで機微なし) |

`permission_request` envelope の合成置換について: wrapper は
`waiting_permission` 遷移時に `state_change(waiting_permission)` も emit する
(`host.ts:#apply({kind: "permission_request"})`)。よって viewer は
`state_change` 経由で既に状態を知っている。だが snapshot は **最新 envelope
1 件** を返す仕様で、`permission_request` が後で上書きするため、snapshot で
viewer が当該 agent を見失わないよう合成置換が必要。

### F4: 入力方向(client → server)の role gate は据置

`instruction` / `permission_decision` / `interrupt` / `clear_history` /
`delete_agent` は既に operator 限定([protocol](../specs/protocol.md))。
本 ADR は **配信方向のみ** を対象とする。

### F5: ロール拡張の手順

新 envelope type を追加するときは:

1. 仕様 PR で当該 type の viewer 配信要否を明記。
2. operator 限定がデフォルト。viewer 配信したい場合は `sanitize_envelope_for/2`
   の `:viewer` 句に明示的に句を追加し、テストで両ロールの可視性を
   covering する。
3. 機微フィールドが ext に乗る場合は引き続き catch-all の ext 除去で守られる
   (allow した type でも viewer には ext は届かない)。

### F6: agent 間開示 (peer directory)

F1〜F5 は client (dashboard) 向けの `agents:lobby` 配信を対象とする。
[issue #160](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/160)
で agent が peer の稼働状況を読んで委任判断を行う要求が生じたため、
**第 3 の開示主体として `agent` を定義する**(2026-07-28 追記、
[phase-27](../plans/phase-27-list-agents-metadata.md))。

**F6-1 — `agent` は `operator` の部分集合ではない。** operator が
見る経路(`agents:lobby` / `AgentsChannel.sanitize_envelope_for/2`)と
agent が見る経路(`wrapper:<id>` /
`WrapperChannel.handle_in("directory_request", …)`)は別実装であり、
片方の allow-list がもう片方を守らない。両者は独立に判断する。

**F6-2 — peer directory も allow-list 方式。** `directory_entry/4` が
明示列挙した field だけが agent 間に出る。envelope の `ext` を丸ごと
流し込む実装は禁止する(F2 と同じ fail-closed)。allow-list は
**nested 階層まで適用** する — `ext` 由来の構造体を載せる場合も
canonical key だけを写した新しい map を組み立て、未知の nested key は
開示しない。

**F6-3 — 現時点の allow 集合**: `agent_id` /
`persona{id, name, sprite_set}` / `display_name` / `state` / `engine` /
`model` / `effort` / `context` / `session_started_at` / `turns` /
`last_activity_at` / `conversation` / `rate_limits`。
`persona{...}` から後ろ 6 field(`context`〜`rate_limits`)は
[#160](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/160)
(phase-27)で追加。`display_name`(issue #219 D19)は `persona.name` と
独立した mutable な通称 — `persona.name` は pack 由来の canonical
name として rename の影響を受けず不変のまま、`display_name` のみが
稼働中の rename を反映する。

**F6-4 — 明示 deny(継続除外)**: `cwd`、`permission`(`sandbox` /
`approval`)、`permission_mode` / `fast_mode`、`session_id`、
`pending_permission`(特に `input`)、`pending_question`、
`slash_commands`、`models` catalog、`resume_snapshot` /
`resume_drift`、`model_source` / `effort_source`、
`session_capabilities`、`cost`。委任判断に不要か、operator 固有の
作業内容を推測させるため。`session_capabilities` は
`supports_context_usage` を `context` 投影の gate 入力として **server
内部で読むだけ** で、値そのものは peer に出さない
([ADR-0040](0040-context-usage-capability.md) D1 の 3-state 判定を
dashboard と揃えるため)。

**F6-5 — `conversation` は相手 `agent_id` までを開示し、
`conversation_id` は開示しない。** 開示範囲として決定されたのが
「active な会話の有無 + 相手 agent_id 一覧」(#160 決定 4)であり、
識別子はその範囲を超えるため。範囲外だから出さないという判断であって、
[#17](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/17) の
conversation_id 機密性についてここで結論を出したわけではない。信頼
境界そのものの再評価は F6-6 の将来項目に含める。

**F6-6 — 妥当性の根拠と再評価 (issue #197 段階2 で実施)。** 本節は
もともと「現状 kaoiro は単一 operator 配下の閉じた系であり、peer は
同一の人間が起動した agent に限られる」を根拠に、稼働状況の相互可視化
による露出リスクは小さく operator 介在の削減という便益が上回ると
結論し、「外部 inbound 導入時、または agent 間の信頼境界が operator
単位でなくなった時点で再評価する」という条件を置いていた。

[ADR-0050](0050-principal-model-and-graded-access-control.md) の
Phase A (identity 化 + admin role、issue #197 / #198) はこの根拠の
一部 — 「同一の人間が起動した agent」という前提 — を崩し始める。
principal は user / agent に型分離され (D1)、user 側は viewer を含む
複数の role を持つ。ADR-0050 の Context 自身が「本 ADR の決定はまさに
その条件を発火させる」と明記しており、issue #197 の制約節もこれを
引き継いでいる。したがって本節は例外を書き足す形を採らず、実際に
再評価する。

**再評価の結論。** [ADR-0050](0050-principal-model-and-graded-access-control.md)
D5 を根拠として、agent への user 開示を **identity (id / kind /
display_name / role) までに限定した上で明示的に受容する**(F6-8)。
D5 が「原則見える」の範囲を identity までとし、state と活動 (何を
しているか、誰とやり取り中か) を per-pair 権限 (D3) の対象と切り
分けているのに対応する。

**role は agent の authorization 根拠ではなく、server enforcement の
説明 metadata である。** D5 の言葉を借りれば「agent が role を知って
も authority は変わらない。強制するのは server 側であって agent の
認識ではない」。この位置づけにより、開示範囲を identity に絞って
露出面を最小化しつつ、認可判断そのものは一貫して server 側に残る —
agent 側が role を誤読・悪用しても、実際の権限行使は server の
allow-list / per-pair 権限が別途強制するため直接の脆弱性にはならない。

state / 活動の開示は本節の対象外のまま据え置く。これは per-pair 権限
そのものの導入ではない — 加算モデルの edge 判定・グラフ編集ツール等
D3/D9 の設計変更は Phase B (#199) のスコープであり、本 ADR はここで
実装に踏み込まない。ADR-0050 Phase B が導入されたら、user 側の開示も
同じ per-pair 権限テーブルで再フィルタする。それまでは F6-8 の allow
集合が上限。

**次の再評価条件**: 外部 inbound
([#98](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/98))
導入時、または ADR-0050 Phase B (per-pair 権限、#199) の実装時。

**F6-7 — 拡張手順。** peer directory に新 field を足すときは、F5 の
viewer 判断と同様に **agent 開示の要否を明示判断** し、F6-3 / F6-4 の
どちらかに列挙してからテストで両主体の可視性を covering する。

**F6-8 — user 開示の allow 集合 (issue #197 段階2)。** agent への
user 開示は F6-3 (agent entry の allow 集合) とは独立の allow-list
とする。理由は F6-1 と同型 — user directory (`wrapper:<id>` 経由) と
agent directory (同じ経路の別 payload) を同じ集合で管理すると、片方
向けに緩めた判断がもう片方の allow-list をも緩めてしまう。

現時点の allow 集合: `id` / `kind`(常に literal `"user"`) /
`display_name` / `role`(`"operator"` \| `"viewer"`)。F6-6 の再評価
結論が言う identity 相当の 4 field に限る。state・活動 (現在何を
しているか、誰とやり取り中か) に相当する概念は user には無く、開示
対象にもならない。

role を解決できない (allow-list から revoke された、config が未知に
なった等) user は entry ごと省略する。`role` は wire 必須 field で
あり、F6-3 の agent entry と異なり per-field の「不明」を表現する
余地が無いため。

新 field を足すときの手順は F6-7 と同じ(agent 開示の要否判断 →
F6-3 / F6-8 いずれかへ列挙 → 両主体の可視性を covering するテスト)。

## Consequences

### Positive

- viewer 漏洩の **fail-closed** 化。新 type 追加時の見落とし事故が
  構造的に防げる。
- `permission_request` envelope の `tool_name` / `request_id` の viewer
  漏洩が止まる(operator が使っているツールの推測経路を塞ぐ)。
- viewer ロールの仕様が一覧表で読める(threat-model.md / protocol.md
  にも反映)。
- F6 で agent 間開示も同じ allow-list 規律に載り、peer directory へ
  field を足すときの判断手順が viewer と揃った(#160)。

### Negative

- viewer 用の合成 `state_change` 変換が一段挟まる(snapshot/broadcast の
  hot path に minor な変換コスト)。
- 新 type 追加時に「viewer に出すか」を明示判断する手間が増える。
  ただし allow-list の意図そのものなので許容。

### Neutral

- 既存の operator 配信は無変更(operator 句は `envelope` を素通し)。
- ext の catch-all 除去は据置(F3 の `state_change` 句は `Map.delete("ext")`
  を含む)。
- `agent_deleted` は viewer も受信(grid 整合のため allow-list に明示
  列挙)。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| 現状の catch-all 素通し(deny-list 継ぎ足し)を維持 | 新 type 追加時に viewer 漏洩が継続。事故が起きるまで気づけない構造的問題が残る |
| `permission_request` envelope を viewer にも素通しで `input` だけ落とす(現状)| `tool_name` / `request_id` から operator の作業状況が推測でき、Defense-in-depth として不十分 |
| viewer から `permission_request` を **完全に** 除去(snapshot からも外す)| 最新が `permission_request` のとき viewer の grid から agent が消える。合成 `state_change` への置換で grid 整合を保つ方を採用 |
| 3 ロール化(admin / operator / viewer)| YAGNI。現状の機能では 2 ロールで足りる。必要になった時点で別 ADR |

## Related

- specs: [protocol](../specs/protocol.md)(配信先表記を本 ADR に合わせて
  統一)、[threat-model](../specs/threat-model.md)(マトリクスを引用)。
- 関連 ADR: [0011](0011-phase3-reliability-and-auth.md)(role/token 認証の
  土台)、[0012](0012-response-display-and-dashboard-scope.md)(log/result の
  operator 限定の出発点)、[0013](0013-user-token-cookie-persistence.md)
  (token 保管)。
- F6 の由来: [issue #160](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/160)、
  実装は [phase-27](../plans/phase-27-list-agents-metadata.md)。開示 field の
  wire は [protocol-inter-agent](../specs/protocol-inter-agent.md)
  「peer directory の情報境界」が正本。
- 由来: [issue #46](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/46)。
