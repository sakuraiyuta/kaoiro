---
title: viewer / operator ロールの情報公開ポリシ — allow-list 方式と envelope 別マトリクス
status: accepted
date: 2026-06-22
opened: 2026-06-22
supersedes: []
superseded_by: null
related_specs: [protocol, threat-model]
related_adrs: [11, 12, 13, 22, 25]
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

## Consequences

### Positive

- viewer 漏洩の **fail-closed** 化。新 type 追加時の見落とし事故が
  構造的に防げる。
- `permission_request` envelope の `tool_name` / `request_id` の viewer
  漏洩が止まる(operator が使っているツールの推測経路を塞ぐ)。
- viewer ロールの仕様が一覧表で読める(threat-model.md / protocol.md
  にも反映)。

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
- 由来: [issue #46](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/46)。
