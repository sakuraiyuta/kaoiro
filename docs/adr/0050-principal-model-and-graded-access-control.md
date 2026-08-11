---
title: principal モデル — user/agent の型分離・3 role 階層・per-pair 権限の加算モデル
status: accepted
date: 2026-08-11
opened: 2026-08-05
supersedes: []
superseded_by: null
related_specs: [auth-and-authz, protocol, protocol-inter-agent, threat-model]
related_adrs: [7, 13, 21, 24, 28, 30, 33, 42]
---

# ADR-0050 — principal モデルと段階的アクセス制御

## Status

Accepted (2026-08-11、マスター決裁により `proposed` から昇格。Phase A
(identity 化)が [issue #197](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/197)
で実装完了したことによる)。
実装 issue は [#197](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/197)
(identity 化、実装完了) /
[#198](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/198)
(admin role) /
[#199](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/199)
(per-pair 権限) /
[#200](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/200)
(永続化基盤) /
[#201](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/201)
(グラフ編集ツール)。

Phase B 以降(#198-#201)の着手前に決めるべき論点 —— ADR-0021 を改訂
するか supersede するか(#198)、agent→agent edge の既定(#199、加算
モデルを素朴に適用すると inter-agent messaging が全面停止する)、スト
アを DETS で足すか SQLite を導入するか(#200)—— は各 issue の着手時に
個別に決着させる。

## Context

kaoiro の認可は 2 role (operator / viewer) 固定で、operator は実質無制限の
全権を持つ ([ADR-0021](0021-role-information-disclosure-policy.md) F1)。
`docs/specs/auth-and-authz.md` の Known gaps は、この構造が抱える穴を
3 つ明示している:

- **operator role 細分**: operator は spawn / interrupt / approve / clear を
  含む全権。単一テナント前提
- **マルチテナント隔離**: 全 operator が全エージェントを操作可能。
  エージェントの所有者境界が無い
- **監査ログ**: 「誰がいつどの agent に何を送ったか」の永続記録が無い

いずれも [ADR-0042](0042-oauth-allowlist-login.md) が Out of scope として
将来送りにしたものである。単一利用者の間は成立していたが、中規模以上の
運用ではいずれも実害になる。加えて、user は kaoiro 内部の identity を
持たない (OAuth identity (provider + uid) か共有トークンのみ) ため、
ログにも envelope にも「誰が」が残らず、AI エージェントも指示元を
認識できない。

さらに ADR-0021 F6-6 は peer directory の妥当性根拠を「現状 kaoiro は
単一 operator 配下の閉じた系であり、peer は同一の人間が起動した agent に
限られる」と置き、**「agent 間の信頼境界が operator 単位でなくなった
時点で本節を再評価する」**という条件を明記している。本 ADR の決定は
まさにその条件を発火させる。

本 ADR は、これら 4 つ (identity / role 階層 / per-pair 権限 / 永続化) を
一体の設計として決める。

## Decision

### D1 — user と agent は型を分ける。共通抽象は `Principal` のみ

`User` と `Agent` を別の型とし、権限グラフの node としてのみ共通の
`Principal` (`id` / `kind` / `display_name`) 抽象を切る。分ける軸は
「人間か AI か」ではなく **authority の出所**。

根拠:

1. **同一性の SoT が違う**。`agent_id` は kaoiro が採番する
   ([ADR-0024](0024-agent-instance-identity-and-spawn-auth.md) D3、
   `<scope>.<rand>`)。user の同一性は外部 IdP (OAuth provider + uid) 由来で
   SoT が kaoiro の外にある。統合型にすると「user を spawn する」
   「agent を許可リストに書く」といった意味の壊れた操作面が構造的に生える
2. **帰責が非対称**。agent の行動は最終的にどれかの user に帰責されるが、
   user の行動は誰にも帰責されない終端である。型で表現しないと
   user → agent → agent の責任連鎖が平坦化し、監査が成立しない
3. **前例がある**。[ADR-0028](0028-external-human-messaging.md) D3 は
   外部人間 messaging を inter-agent の一般化にせず専用 type / tool へ
   分離した。理由は「trust model を 1 経路に同居させると条件分岐漏れが即
   脆弱性になる」。将来 agent の送信先が agent / 内部 user / 外部人間の
   3 経路になると authority がそれぞれ違うため、同じ罠を踏む

派生規則:

- `kind` は wire 上の必須フィールドとする。agent が peer の人間 / AI を
  判別できないと、受信メッセージに authority があるかを判定できない
- id 空間は単一。既存 charset `[A-Za-z0-9._-]`
  ([#61](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/61)) を守る
- **`kind` は id から derive しない**。store の属性として持つ。id の
  prefix に意味を持たせると、偽装がそのまま権限判定に効く

**実装状況**: user 側は issue #197 段階2 で `%{id, kind, display_name,
role}` として実装済み。agent 側は issue #197 時点では `persona.name` で
`display_name` を代用しており(ADR-0030 D2 の暫定 carve-out)、`Principal`
抽象が agent 側では実現していなかった。
[issue #219](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/219)
で agent にも `persona`(pack 由来、session 中不変)から独立した
`display_name` フィールドが実装され、`Principal` (`id` / `kind` /
`display_name`) が user / agent 双方で本来の形どおり成立するように
なった。

### D2 — role は admin / operator / viewer の 3 値

[ADR-0021](0021-role-information-disclosure-policy.md) F1 (2 ロール固定、
3 ロール化は YAGNI) を覆す。

| role | 定義 |
|---|---|
| admin | 権限グラフの編集者かつ全可視。**隠蔽の対象にならない**。per-pair 権限の対象外で常に全権 |
| operator | agent を操作できる主体。どの agent を操作できるかは per-pair 権限で決まる |
| viewer | ゲスト。既定は grid 上の存在確認のみ |

viewer の元々の意図は「オフィスに来たゲストに、従業員が働いている様子を
見せる」程度であって会話ログの開示ではない。現行 ADR-0021 F3 の viewer
可視性はこの意図と一致しているため **変更しない**。

**MUST — admin は隠蔽できない。** 権限グラフ上で admin を非表示にする
edge は引けない。引けてしまうと監査が破綻する。この帰結として、admin
権限を持つ人間に対して何かを隠すことは原理的にできない。

**MUST — ブートストラップ経路を残す。** kaoiro は fail-closed 設計
(ADR-0042) であり、admin が 1 人も居ない状態では権限編集が永久にできない
(lockout)。env / ファイル直編集による初期 admin 宣言が唯一の入口となる。
D3 の加算モデルではこの経路が edge の初期投入手段も兼ねる。

### D3 — per-pair 権限は 4 段階・加算モデル

権限を **プロンプト投入可 / 会話ログ閲覧可 / 一覧表示のみ / 完全非表示**
の 4 段階とし、user→agent / user→user / agent→agent の組ごとに与える。

**加算モデル** —— 明示的に与えた権限以外は持たない。edge が 0 本なら
(admin を除き) 何も見えず何もできない。減算モデル (role が既定権限を
与え、edge が絞る) を採らない理由は 3 つ:

1. kaoiro は既に ADR-0021 F2 の allow-list、ADR-0029 F3、OAuth 許可リストの
   fail-closed と、「明示宣言がなければ届かない」を設計原則にしている。
   ここだけ fail-open の島を作ると原則の一貫性が壊れる
2. 減算 → 加算の移行は、実運用データがある状態では既存ユーザの権限が
   消える破壊的変更になる。利用者 1 人の現時点なら移行コストがほぼゼロ
3. OSS 公開とビジネス展開を視野に入れる以上、緩い既定で出荷した後に
   締めると既存利用者の環境が壊れる

**合成規則**: global role が天井、per-pair はその範囲内でのみ絞る。
viewer に per-pair で「プロンプト投入可」は与えられない。
[ADR-0033](0033-permission-model-dual-axis.md) の dual-axis と同型の構造。

### D4 — spawn 時に spawner へ full edge を自動付与する (所有者概念)

加算モデルを素朴に適用すると、新しく spawn した agent は誰からも見えず
誰も操作できない状態で生まれ、運用が成立しない。spawn 時に spawner へ
full edge を自動付与する。

これは D3 の「明示的に与えたもの以外は持たない」原則を破らない ——
**spawn という行為自体が明示的な権限主張**だからである。Unix でプロセスを
起動したユーザがその所有者になり、ファイルを作れば作成者に rw が付くのと
同じ構造。

本決定は ADR-0042 が Out of scope とした「マルチテナント隔離
(エージェントの所有者境界)」に踏み込む。

### D5 — 可視性は 2 段。identity は原則開示、state と活動は per-pair

kaoiro はマルチ AI エージェント参加型の仮想オフィスであり、その場に
参加している entity は原則として role 込みで見える形にする。ただし
「原則見える」の範囲は **identity (id / name / kind / role) まで**とし、
state と活動 (何をしているか、誰とやり取り中か) は per-pair 権限の
対象とする。

「現在誰がいるか」と「誰に働きかけるか」は別問題であり、前者は知られて
構わない。開示が防御を弱めないことは ADR-0028 D4 が外部人間の contact
一覧について既に結論している (「一覧開示は防御を弱めない —— enforce が
担保、office 比喩」)。agent が role を知っても authority は変わらない。
強制するのは server 側であって agent の認識ではない。

**実装レベルの fail-closed は維持する。** 「原則見える」は実装の
デフォルト挙動ではなく **設定のデフォルト値**として実現する。実装既定を
open にすると ADR-0021 F2 の allow-list 構造が壊れ、新 field 追加時の
漏洩事故が復活する。

### D6 — 会話ログの可視性は agent 単位。transitive な隠蔽は保証しない

会話ログの閲覧権限は agent 単位で与える。ある agent のログを閲覧できる
user は、**その agent と会話した全 user の発言**を見る。

根拠は「その agent の上司なら、当該 agent の作業はすべて確認できるのが
当然」という運用要求。発言者単位のフィルタ (非表示 user の発言を伏せる)
は文脈を壊す上に、伏せ字の存在自体が情報を漏らすため採らない。

**帰結として、user→user の「完全非表示」は transitive には成立しない。**
user B に対して user C を完全非表示にしても、B と C が同じ agent A と
会話していれば、A のログ経由で C の発言が B に見える。この性質は仕様に
明記する。

「特定の user には隠したい」という要求と「上司は全部見える」という要求は
一見矛盾するが、**階層で解決する**。隠蔽が成立するのは対等な立場の
operator 同士であり、admin および上位の operator からは隠せない (D2)。
現実のオフィスで「A には内緒で」と言えるのが A と対等以上の立場の人間
だけであるのと同じ構造。

### D7 — dashboard 経路と agent 経路は同一の権限テーブルを引く (MUST)

ADR-0021 F6-1 の通り、operator が見る経路 (`agents:lobby` /
`AgentsChannel.sanitize_envelope_for/2`) と agent が見る経路
(`wrapper:<id>` / `WrapperChannel` の directory 応答) は別実装であり、
片方の allow-list が他方を守らない。

per-pair 権限は **両経路が同じ権限テーブルを引く**構造とする。別々に
判定すると「グラフ上は非表示にしたのに agent 側からは見えている」という
乖離が生じ、権限設定そのものが信用できなくなる。

### D8 — 実装フェーズ順: A → B-1 → B-2 → C

| Phase | 内容 | 対応 issue |
|---|---|---|
| A | identity 化 + admin role。認可 SoT はテキストのまま | #197 / #198 |
| B-1 | ストア + per-pair 権限の**振る舞いを同時に投入** | #199 / #200 |
| B-2 | ブートストラップ経路で edge を手書き投入し、振る舞いを検証 | #199 |
| C | グラフ編集ツール | #201 |

**振る舞いを B-1 でストアと同時に入れる**のが要点。編集ツールを先に
作って振る舞いを後回しにすると、編集ツールが何を編集しているのかを
検証できず、D7 の経路間乖離もツール完成時まで露見しない。何より、
enforce のない設定 UI は「設定したつもりで効いていない」という、
セキュリティ機能として最悪の状態を生む。

加算モデルでも admin は全権を保つ (D2) ため、B-1 投入時点で操作不能には
ならない。B-2 の時点で「特定 operator を特定 agent から締め出す」という
実運用価値が既に得られる。

**Phase B では OAuthAllowlistWatcher の watcher 機構を移行する。**
[#170](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/170) は
2026-08-05 に完了済み (commit `2d64000` / `8ef15fc`) で、許可リストの
テキストファイルを認可 SoT として file_system イベント + periodic
reconcile で watch する。構造化ストアへ移すとこの前提が変わるため、
watcher を「ファイル watch」から「ストア変更通知」へ置き換える作業が
Phase B に含まれる。

### D9 — グラフ編集ツールは独立クライアントとして作る

権限編集 UI は同梱 dashboard 内の画面ではなく、独立クライアントとして
実装する。同梱 dashboard はあくまでリファレンス実装
([ADR-0007](0007-client-separation-reference-dashboard.md)) であり、
運用者が専用クライアントを用意して既定 dashboard の配信を停止する運用も
設計上視野に入っているため。

副産物として、**権限編集の protocol surface を wire に定義する必要が
生じる**。結果として運用者が独自の admin ツールを実装できるようになり、
dashboard と同じ「リファレンス実装 + 差し替え可能」の構図が権限編集にも
成立する。

グラフは live 反映とする (agent は spawn / stop で動的に増減し、D4 により
spawn 時には edge も自動で増えるため)。

### D10 — 権限変更そのものを監査する

「誰がいつ誰に何の edge を引いたか」を監査証跡として永続化する。加算
モデルで権限を厳密にしても、権限変更そのものが追跡できなければ意味が
ない。auth-and-authz.md の Known gaps にある監査ログ
([#156](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/156)) と
合流する領域であり、統合するか分担するかは #200 で決める。

## Future work (本 ADR では決めない)

- **user 間の伝言取次ぎ**。agent が「他 user に伝言を頼む」プロンプトに
  対応できるようにする拡張。D5 で全 user 一覧を agent に開示する方針を
  採ったのは、この拡張性を見込んでのこと。ただし現状は展望に留め、
  実装スコープには含めない
- **user のグリッド一覧表示と相互チャット**。UI 上で agent と user が
  並んで見える形。実現しても D1 の型分離は維持する —— UI 上で並ぶことと
  型が同じであることは別物であり、同一性が高まるほど kind の明示は
  重要になる

## Consequences

### Positive

- 認可の全域が fail-closed で一貫する。「明示宣言がなければ届かない」が
  envelope 配信 (ADR-0021 F2) から権限グラフまで同じ原則で通る
- 監査が成立する。user に identity が付き、権限変更にも証跡が残る
- 中規模運用が可能になる。operator ごとに触れる agent を分けられる
- OSS 公開・ビジネス展開への布石。セキュリティモデルは後から強化しにくく、
  初期に厳しい側へ倒すのが正解
- 権限編集が wire protocol になることで、運用者が独自 admin ツールを
  作れる (D9)

### Negative

- **ADR-0021 F1 を覆す。** 同 ADR の改訂または supersede が必要 (どちらに
  するかは #198 で決定)。F3 / F4 / F6 も広範な書き換えが要る
- 実装コストが大きい。特に per-pair 判定への移行 (`require_operator/1` を
  通る operator-only inbound 約 22 種の分類)、`sanitize_envelope_for/2` の
  fan-out hot path 変更、独立クライアントの新規開発
- 加算モデルは agent の動的生成と相性が悪く、D4 の所有者概念で補わないと
  運用が成立しない。agent→agent edge の既定は未解決 (#199)
- 実装済みの OAuthAllowlistWatcher (#170) が前提とする「テキストファイルが
  認可 SoT」が Phase B で変わり、watcher 機構の移行が要る

### Neutral

- Phase A の時点では既存の operator / viewer の挙動は変わらない。
  admin を上位に足すだけで、降格の実体は Phase B
- viewer の可視性 (ADR-0021 F3) は元の意図通りなので手を入れない

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| **減算モデル** (role が既定権限を与え、edge が絞る) | 移行は滑らかだが「明示的に与えたもの以外は外す」という安全側の原則を満たさない。kaoiro 他部位の fail-closed と不整合。利用者 1 人の今なら加算への移行コストがほぼゼロ |
| **user / agent の統合型** | 同一性の SoT が違い (外部 IdP vs 内部採番)、帰責も非対称。統合すると監査の責任連鎖が平坦化する。ADR-0028 D3 が同型の判断で経路分離を選んだ前例もある |
| **発言者単位のログフィルタ** | 会話の文脈が壊れる。伏せ字の存在自体が情報を漏らすため隠蔽も不完全。中途半端 |
| **会話単位の権限** (自分が参加した会話だけ見える) | 最も厳密だが「その場が見える」仮想オフィスの思想と真っ向から衝突し、実装コストも最大。D6 の「上司は全部見える」要求も満たせない |
| **dashboard 内の権限編集画面** | 実装コストは安いが、dashboard がリファレンス実装であり差し替え可能である以上、権限編集がそこに閉じると差し替え時に編集手段を失う |
| **編集ツールを先に作り、振る舞いを後で実装** | 編集ツールの正しさを検証できず、D7 の経路間乖離も露見しない。enforce のない設定 UI は最も危険。加算モデルでも admin が全権を保つため、振る舞いを先に入れても操作不能にはならない |
| **admin にも隠せる仕組み** | 実現したら監査が破綻する。root を持つことの帰結として原理的に諦める |

## Related

- specs: `auth-and-authz` (境界の地図、Known gaps の 3 項目が本 ADR の
  出発点)、`protocol` (権限編集 surface の追加先)、
  `protocol-inter-agent` (peer directory の情報境界)、`threat-model`
- 関連 ADR: [0007](0007-client-separation-reference-dashboard.md)
  (クライアント分離 → D9)、
  [0013](0013-user-token-cookie-persistence.md) (cookie / ticket)、
  [0021](0021-role-information-disclosure-policy.md)
  (**F1 を覆す / F6-6 の再評価条件が発火**)、
  [0024](0024-agent-instance-identity-and-spawn-auth.md) (agent_id 採番)、
  [0028](0028-external-human-messaging.md) (一方向 authority、経路分離の
  前例 → D1 / D5)、
  [0030](0030-agent-directory-and-explicit-restore.md) (AgentDirectory、
  永続対象の決定 → #200 の未解決事項)、
  [0033](0033-permission-model-dual-axis.md) (dual-axis → D3 の合成規則)、
  [0042](0042-oauth-allowlist-login.md) (**Out of scope 記述を撤回**)
- 関連 issue: #197 / #198 / #199 / #200 / #201 (実装)、
  [#156](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/156)
  (監査ログ)、
  [#170](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/170)
  (認可 SoT の watcher、実装済み・Phase B で移行対象)
