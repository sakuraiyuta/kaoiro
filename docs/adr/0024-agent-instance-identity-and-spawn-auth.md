---
title: エージェントのインスタンス同一性と spawn 認証 — persona=型 / agent_id=インスタンス、runner 一本化の発行型認証
status: accepted
date: 2026-06-24
opened: 2026-06-24
supersedes: []
superseded_by: null
related_specs: [protocol, threat-model, architecture]
related_adrs: [3, 11, 14, 18, 23, 29, 30]
---

# ADR-0024 — エージェントのインスタンス同一性と spawn 認証

## Status

Accepted

## Context

「同じ性質のエージェントを複数 spawn したい」(例: 同一 persona の作業者を 2 体
並走)という需要を満たそうとすると、現行の認証モデルが壁になる。issue
[#22](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/22) の決定1
(spawn 要求でサーバが補完する範囲)の議論(2026-06-24)で論点が顕在化した。

### 現行モデルの実態(地盤)

- **agent_id は 1 インスタンスの安定識別子**。顔・機嫌・session ポインタ・
  restore の単位であり([ADR-0003](0003-persona-identity-persistence.md))、
  **再起動をまたいで同一**であることが必須([ADR-0014](0014-session-resume-and-restore.md)、
  [protocol](../specs/protocol.md))。
- 同一 agent_id の二重接続は state 層で 1 枠に collapse(last-write-wins +
  owner フェンシング、`agent_states.ex`)。**同じ agent_id を 2 体に使うことは
  同一性の衝突であり不可**。
- wrapper 認証は **agent_id 別の事前登録トークン**(`:wrapper_tokens` =
  `agent_id:token` の 1:1 マップ、[ADR-0011](0011-phase3-reliability-and-auth.md)
  D3)。新しいエージェントを足すたびにサーバ設定へトークン登録が要る。
- 結果、**「未登録 agent_id の wrapper を何の資格で繋がせるか」が未定義**で、これが
  複数インスタンス化の唯一の障害。dashboard からの spawn(#22)では operator が
  agent 別 wrapper トークンを知り得ないという gap も同根。

### 設計の軸

混乱の根は agent_id に「型」と「インスタンス」の 2 役を負わせていたこと。kaoiro は
spawn が**実質リモートコード実行**であり、セキュリティを最優先する(2026-06-24
ユーザ決定)。この前提で、分離(漏洩時の被害局所化)を弱める案は採らない。

## Decision

### D1 — 概念: persona = 型 / agent_id = インスタンス

persona をエージェントの「性質/型」(id・表示名・立ち絵)、agent_id を実行中
インスタンスの一意 ID と位置づける。**「同じ性質を複数 spawn」= 同一 persona ×
別々の unique agent_id**。persona と agent_id は別軸であり(spawn payload も
register も両者を別に持つ)、データモデル上すでに成立している。残る障害は認証だけ。

### D2 — spawn 認証経路を runner に一本化(常駐 or ワンショット)

**すべての spawn を runner 起動経由に統一**する。「runner = 常駐デーモン」前提は
外し、`kaoiro-runner spawn --persona … --cwd …` のような**非常駐・ワンショット**
起動も runner の一形態として認める([ADR-0018](0018-runner-distribution.md) の
単一バイナリ配布と整合)。

これにより信頼の起点が 1 本に収束する:

- **per-host runner トークン**(`:runner_tokens`、[ADR-0023](0023-host-runner-architecture.md))で
  ホストを認証。
- 認証済み runner 経由の spawn に対し、**server が per-agent 資格情報を発行・
  注入**する(D4)。
- **per-agent トークンの事前登録は spawn 経路では不要**になる。

### D3 — agent_id の採番: `<scope>.<rand>`、生成時 1 回・restart 安定

agent_id を `"<scope>.<rand>"` 形式とする(scope = host/グループ名前空間、rand =
一意サフィックス)。文字種は現行 `[A-Za-z0-9._-]` で `.` を許容済み(無改修)。

- 採番は **server/runner 側で「インスタンス生成時に 1 回だけ」**。
- runner が **supervised restart をまたいで同一 agent_id を保持**するため、
  ADR-0014 の「再起動で同一」要件と整合する(クラッシュ再接続で別人化しない)。

### D4 — server が server_url + per-agent token を spawn payload に注入

現行の relay は client payload を素通しするのみ(`agents_channel.ex`
`handle_in("spawn")`)。これを拡張し、**server が `server_url`(自分の endpoint)と
per-agent token を spawn payload に注入してから runner へ中継**する。

- 秘匿値(per-agent token)はサーバ内に留まり、operator/クライアントは保持しない。
- これは **#22 の決定1 = 案A(サーバ補完)を確定**するものである。

### D5 — 二重 live join を明示拒否

現行のサイレント last-write-wins を、**「すでに live owner がいる agent_id の join は
拒否」**へ変更する(防御的)。ランダム suffix(D3)で衝突は実質ゼロだが、偶発二重
起動を不可視のまま上書きさせず、明示エラーで可視化する。

### 棚上げ / 却下した代替案

- **ワイルドカード wrapper トークン**(`host-1.*:token` 等): 最小改修で runner-less
  直結を救えるが、漏洩時の被害が「1 agent」から「スコープ内全 agent」(`*.*` なら
  全 wrapper なりすまし相当)へ拡大し、セキュリティ最優先方針に反する。**今回不採用**。
  runner-less 直結の需要が顕在化したときの検討項目として
  [#71](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/71) に棚上げ。
- **allocate ハンドシェイク**(wrapper が `POST /agent/allocate` で id+短命 token を
  取得して接続): 分離は最強だが、runner 経路(D2)が内部で同等を実現するため機構が
  重複する。runner-less を本気でやる場合の参考案として #71 にメモ。
- **同一 agent_id の相乗り**: 同一性の衝突(ADR-0003)。却下。

## 未確定の従属点(実装時に確定)

- **per-agent token の発行方式と寿命**: 署名済み短命トークン(stateless・期限で
  自然失効)か、server 保持のレジストリ(stateful・明示 revoke 可)か。runner の
  supervised restart はサーバへ戻らず子を再起動するため、token が restart をまたいで
  有効である必要がある(寿命設定、または runner が制御チャネル経由で再取得する等の
  再発行機構)。本 ADR は **「server が発行し runner が配送する」**ところまでを決定
  し、機構詳細は phase-4 の #22 再配線で詰める。

## D4 追補 — per-agent_id revoke 経路 (2026-07-23、[#72](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/72))

D4 が採用した `Phoenix.Token` 署名方式は stateless で secret_key_base
ローテーションが唯一の revoke 手段だった (fleet 全体一括失効の重量
オプション)。個別の agent_id を revoke したい ── 特に OSS 公開後の
compromise 対応で必要 ── ため、以下を **署名方式は不変のまま additive
拡張** として追加する。

- **`KaoiroServer.TokenDenylist`** (新規 DETS 永続 store):
  `agent_id => {revoked_at_iso, ...}` を保持。`Auth.authorize_wrapper/2`
  が既存の signature check より **前** で `revoked?/2` を照合し、
  listed agent_id は `{:error, :unauthorized}` を返す。dev モード
  (`KAOIRO_WRAPPER_TOKENS` 未設定 = 誰でも通る) でも denylist は
  override せず維持 (security 操作を dev convenience に潰させない)。
- **書き込みは synchronous + `:dets.sync/1` fsync-gated**: operator の
  revoke ack と `agent_deleted` / `revoked` broadcast は永続確定後に
  発火する ── crash が revoke と disk 書き込みの間に落ちても revocation
  が消えない (ふじ #72 M2 review advisory)。`ClearWatermarks` も同じ
  synchronous+fsync 方針を採用済み (ふじ #109 M7-a must-fix、2026-07-23);
  `PermissionModes` は現状 lazy sync のまま (operator 選好の記録で、
  fsync 前 crash なら「未反映で復帰」と semantics 上等価)。
- **store corruption 時は fail-closed** (ふじ #72 M2 must-fix、
  2026-07-23): DETS open エラーや malformed row を検出したら init を
  `{:stop, ...}` で落とし、元ファイルを削除せず forensic 用に保持する。
  operator が意図的に rename + 再起動して空 denylist から始める。
- **`delete_agent` 経路の auto-revoke** (ふじ #72 M3 must-fix):
  `agents_channel.purge_agent_records/1` は
  `revoke + fsync → wrapper:<id> revoked broadcast → live cut-off →
  store purge` の順で線形化。revoke が最初なので途中 crash でも
  「token 有効なのに directory 消失」の逆転は起こらず、`AgentStates.delete`
  と revoke の隙間に rejoin してきた live channel も broadcast で
  即切断される。
- **operator 明示 revoke**: `agents_channel` の `revoke_wrapper_token`
  operator-only handler。live / disconnected 双方対応 (進行中の
  compromise を即断つ用途)。live channel は `wrapper:<id>` topic 上の
  `revoked` broadcast を intercept して `handle_out` で
  `{:stop, :shutdown, socket}` する (同 topic の他 event と混ざらないよう
  reason field で区別: `operator_revoke` / `agent_deleted`)。
- **粒度は agent_id 単位** ── ADR-0024 D3 の `<host>.<rand>` 12 char
  random suffix により、purge 済み id と将来 spawn の id 衝突は無視でき、
  「revoke = 恒久」の semantics で運用できる。`TokenDenylist.restore/2`
  は明示 UI (未実装) からのみ使う想定で、`delete_agent` の purge から
  除外している。

`Auth.mint_wrapper_token/1` の docstring も 2 revoke channel を明示、
`docs/specs/auth-and-authz.md` の gap 表もこの追補で「実装済」に更新済み。

## Consequences

### Positive

- 認証経路が 1 本(per-host runner トークン + server 発行 per-agent トークン)に
  収束し、**per-agent トークンの事前登録が撤廃**される。
- 分離が最強(per-agent 秘匿値が漏れない / スコープ共有秘密を作らない)。
- **persona の複数インスタンス化が解禁**(同性質エージェントの複数 spawn)。
- 単一バイナリ・ワンショット配布([ADR-0018](0018-runner-distribution.md) / #70)と
  整合。常駐不要なので「デーモンを置きたくない」需要にも沿う。
- #22 の token/server_url 供給 gap を D4 で解消(決定1 = 案A 確定)。

### Negative

- spawn したいホストには runner バイナリ + per-host トークンが要る(ただし常駐
  不要・ワンショット可。摩擦は per-agent 登録より小さい)。
- 素の `node wrapper` 直結は first-class でなくなる(従来の固定 `agent_id:token`
  手動運用は引き続き可。runner-less の本格対応は #71)。
- server に per-agent token の発行機構を実装する負荷(寿命/再発行は上記従属点)。
- join 経路に二重 live 拒否(D5)の分岐が増える。

### Neutral

- runner の配布・常駐形態は [ADR-0018](0018-runner-distribution.md) に従う。
- manual 直結の既存トークン運用(ADR-0011 D3)は据え置き(本 ADR は spawn 経路に
  発行型認証を**追加**するもので、D3 を supersede しない)。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| ワイルドカード wrapper トークン(`<scope>.*:token`) | 漏洩被害がスコープ全体へ拡大し、セキュリティ最優先方針に反。需要顕在時の検討項目として #71 へ棚上げ |
| allocate ハンドシェイク(`POST /agent/allocate`) | runner 経路(D2)が同等を内包し機構重複。runner-less 本格対応時の参考案として #71 にメモ |
| 同一 agent_id の相乗り | 同一性の衝突(ADR-0003、顔/機嫌/session/履歴が混線) |
| per-agent token を runner ローカルで生成 | server が allocation を統制できず revoke/監査が弱い。発行は server 側に置く |
| 起動ごとに agent_id をランダム再採番 | restart で別人化し restore(ADR-0014)が壊れる。採番は生成時 1 回 |

## Related

- 追補(amend)対象: [ADR-0011](0011-phase3-reliability-and-auth.md) D3(per-agent_id
  事前登録トークンに、runner 媒介の**発行型**認証経路を追加。supersede ではない)。
- 関連 ADR: [0003](0003-persona-identity-persistence.md)(persona / agent_id 同一性)、
  [0014](0014-session-resume-and-restore.md)(restart 安定性 / F4 ローカルロック)、
  [0018](0018-runner-distribution.md)(配布・単一バイナリ・ワンショット)、
  [0023](0023-host-runner-architecture.md)(runner アーキテクチャ / host トークン)。
- 関連 specs: [protocol](../specs/protocol.md)(spawn payload への server 注入・
  制御メッセージ)、[threat-model](../specs/threat-model.md)(spawn = RCE 面、
  operator 限定)、[architecture](../specs/architecture.md)。
- 棚上げ / 参考: [#71](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/71)
  (ワイルドカードトークン / allocate)。
- 実装: Phase 4([phase-4-host-runner](../plans/phase-4-host-runner.md))の #22 再配線。
- 由来: issue [#22](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/22) 決定1 の議論(2026-06-24)。
