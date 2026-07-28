---
title: 脅威モデル(双方向ルーティング)
description: クライアント → エージェントへの指示・承認がもたらす脅威と緩和策(issue #10)。
status: accepted
related: [protocol, architecture]
---

# 脅威モデル(双方向ルーティング)

## Purpose

Phase 3 の双方向ルーティング(指示・承認)は、**設計上、クライアント
からエージェント同居マシンでのツール実行を意味する**。本格運用・外部
公開前に脅威と緩和策を一筆残す(issue #10)。

## Definition

### 前提(入口の防御)

| レイヤ | 防御 | 出典 |
|---|---|---|
| 経路 | リバースプロキシ終端の TLS。VPN 内限定配備のみ例外として plain HTTP を許容(`KAOIRO_PLAIN_HTTP`、[deployment](deployment.md) 1.5 — token/cookie が VPN 内平文で流れるため、経路の秘匿は VPN(WireGuard)に委譲) | 2026-06-11 決定 / 2026-07-26 VPN 直結モード |
| ラッパー接続 | agent_id 別トークン | [ADR-0011](../adr/0011-phase3-reliability-and-auth.md) |
| クライアント接続 | ユーザトークン + role(指示・承認は operator のみ。token は httpOnly + 暗号化 cookie に保持) | 同上 / [ADR-0013](../adr/0013-user-token-cookie-persistence.md) |

### 脅威

1. **指示 = リモートツール実行**: operator トークンを得た攻撃者は、
   エージェントに任意の指示を送れる。エージェントの権限内で
   ファイル読み書き・コマンド実行が起こり得る(開発マシンへの侵入と
   同等の影響範囲)。
2. **承認の悪用**: 攻撃者が `permission_decision` を allow で返すと、
   本来人間が止めるはずだったツール実行が通る。
3. **tool input 経由の情報漏えい**: `permission_request` の `input` には
   コマンドライン・ファイルパス・環境値などシークレットが混入し得る。
   閲覧権限(viewer)にも配信されるため、トークン管理が緩いと漏れる。
4. **statusline メタ(`ext`)経由の情報漏えい**: state_change の `ext` に
   付く cwd(作業ディレクトリの絶対パス = ファイルシステム構成・プロジェクト
   名が露出)や model / context / rate_limits は、当初 catch-all で viewer にも
   素通ししていた(#16 由来)。cwd は特に機微(#46)。
5. **セッション resume/召喚 = リモート起動 + 履歴露出**: クライアントから
   サーバ経由で wrapper を resume 起動する経路は脅威1(リモートツール実行)の
   延長([ADR-0014](../adr/0014-session-resume-and-restore.md)、issue #22)。
   さらに候補提示で runner が返す JSONL のメタ(先頭プロンプト要約等)は会話
   断片の露出面となり、任意 session_id / 任意 cwd の resume 要求は他者の会話を
   読む/継続する経路にもなり得る。

### 緩和策

| 緩和策 | 状態 |
|---|---|
| 指示・承認を operator role に限定 | Phase 3 で実装 |
| `KAOIRO_CLIENT_TOKENS` 未設定時はクライアント接続を fail-closed(全拒否)— 誤設定で operator が無防備に公開される事故を防ぐ(起動時に警告ログ) | Phase 3.5([issue #28](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/28)) |
| `permission_request.input` のサイズ上限(16KB 切り詰め、`truncated` 明示) | Phase 3 で実装([protocol](protocol.md)) |
| ラッパー側の `allowedTools` 上限 — 指示が来ても実行可能なツールは ラッパー設定が天井(サーバ・クライアントからは拡張不可) | ラッパー設計で担保(canUseTool はサーバ側から上書き不可) |
| 指示の監査ログ(誰が・いつ・どの agent に何を送ったか) | 将来(SQLite 導入時) |
| tool input のマスキング(シークレットパターンの伏字) | 将来 |
| 返答ログ(`log`/`result`、tool 入出力含む)を operator 限定配信 | Phase 3.5([ADR-0012](../adr/0012-response-display-and-dashboard-scope.md)) |
| envelope の `ext`(cwd / model / context / rate_limits / slash_commands / 将来追加分)を全 type で viewer 除去 | #46 で実装(コミット 9b32c34 / ef7b606) |
| viewer 配信を **allow-list 方式** へ転換(operator 限定がデフォルト、viewer 配信は明示宣言)。`permission_request` envelope を viewer 完全除去(合成 `state_change(waiting_permission)` に置換し grid 整合保持) | #46 / [ADR-0021](../adr/0021-role-information-disclosure-policy.md) |
| log/result 等 operator 限定 envelope は `agents:lobby` に平文 broadcast され `AgentsChannel.handle_out` が per-subscriber で絞り込む(購読時点 gate ではない)。`agents:lobby` の購読者を `AgentsChannel` のみに保つ不変条件で担保し、operator 専用トピック分離は採用しない | #27(評価の上 **現状維持** を決定。新規購読者は下記 MUST 参照) |
| **agent 間開示**(peer directory)を viewer/operator とは別軸の第 3 主体として定義し、`directory_entry` の明示列挙 field のみ agent に出す allow-list とする。`ext` の nested key を素通しせず canonical key だけを写す。`cwd` / permission / `session_id` / `pending_permission` / `session_capabilities` 等は継続除外 | #160 / [ADR-0021](../adr/0021-role-information-disclosure-policy.md) F6([protocol-inter-agent](protocol-inter-agent.md)「peer directory の情報境界」が field の正本) |
| ユーザトークンを httpOnly + 暗号化 session cookie に保持(XSS でも JS から読めず、cookie jar 上でも秘匿)。CSRF は SameSite=Lax + prod の `check_origin` で抑止 | Phase 3.5([ADR-0013](../adr/0013-user-token-cookie-persistence.md)) |
| ブラウザ側の多層防御ヘッダ(CSP / `X-Content-Type-Options: nosniff` / `X-Frame-Options: DENY` / `Referrer-Policy: strict-origin-when-cross-origin`)を **endpoint の静的配信より前段**で付与(`KaoiroServerWeb.SecurityHeaders`)。`index.html` と built assets は router を通らないため `:browser` pipeline では SPA 本体に効かない。CSP は `script-src 'self'`(untrusted なエージェント出力を `{@html}` で描く経路の DOMPurify 単独依存を解消)、`frame-ancestors 'none'`(クリックジャッキング経由の operator 操作誘導)、`connect-src` は `check_origin` と同じ配備由来オリジンを `ws:`/`wss:` へ写す。nginx を置かない VPN 内直結配備([deployment](deployment.md) 1.5)では付与主体がサーバしかない | #155 で実装 |
| OAuth + RBAC 本実装 | 将来([ADR-0005](../adr/0005-access-control-oauth-stub.md)) |
| セッション召喚時に runner が返す JSONL メタ(先頭プロンプト要約等)を operator role 限定・最小限に露出(T2、[ADR-0014](../adr/0014-session-resume-and-restore.md)) | 将来(resume 機能と同時) |
| resume 対象 session_id を当該 agent 束縛 cwd 配下に実在検証し、他 cwd/任意パスの resume を拒否(T3、runner が検証) | 将来(resume 機能と同時) |
| 起動指示 UI(#22)は任意 cwd / 任意 repo clone を提示せず、選択可能 cwd を runner-config の allow-list に限定して RCE 面を bound(範囲=中、T1/T5) | 将来([#22](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/22) / [ADR-0023](../adr/0023-host-runner-architecture.md)) |
| spawn 認証を runner 起動経由(常駐 or ワンショット)に一本化し、per-host runner トークン + サーバ発行の per-agent token で認証(秘匿値はサーバ内に留め operator/クライアントへ出さない)。漏洩被害がスコープ全体へ広がるワイルドカード共有トークンは**不採用**(検討は #71 へ棚上げ) | 将来([ADR-0024](../adr/0024-agent-instance-identity-and-spawn-auth.md) D2/D4 / [#22](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/22)) |

## Constraints

- MUST: 指示・承認の受理は operator role のみ([protocol](protocol.md))。
- MUST: 返答ログ(`log`/`result`)の配信は operator role のみ
  ([ADR-0012](../adr/0012-response-display-and-dashboard-scope.md))。
- MUST: envelope の `ext`(statusline メタ: cwd / model / context /
  rate_limits / slash_commands / 将来追加分)の配信は operator role のみ
  (#46。viewer には全 type で除去)。
- MUST: viewer 配信は **allow-list 方式**。`agents:lobby` の event /
  envelope.type のうち、明示的に viewer 配信を宣言したものだけが viewer へ
  届く。未宣言の type は viewer 完全除去(fail-closed、
  [ADR-0021](../adr/0021-role-information-disclosure-policy.md))。
- MUST: `permission_request` envelope は viewer 完全除去。grid 整合のため
  合成 `state_change(waiting_permission)`(`payload={}` / `ext` なし)に
  置換して viewer へ配信([ADR-0021](../adr/0021-role-information-disclosure-policy.md))。
- MUST: **agent 間開示も allow-list 方式**。peer directory
  (`directory_request`)は viewer 配信とは **別実装・別経路** であり、
  片方の allow-list がもう片方を守らない。`directory_entry` が明示列挙
  した field だけを出し、`ext` の未知 nested key は canonical key への
  写し替えで落とす(ADR-0021 F6、#160)。peer directory に field を
  足すときは viewer 配信の要否と同様に **agent 開示の要否も明示判断**
  する。
- MUST: `agents:lobby` を直接購読してよいのは `AgentsChannel` のみ
  (#27)。`WrapperChannel` は log/result の tool I/O を含む全 envelope を
  同トピックへ平文 broadcast し、role 絞り込みは `AgentsChannel.handle_out`
  (`sanitize_envelope_for/2`)が per-subscriber で行う。よって同トピックを
  新たに購読するプロセス(監視フック・将来機能・テスト)を足す場合は、必ず
  同等の role gate を購読側で適用すること。operator 専用 PubSub トピック分離
  は #27 で評価したが、現状購読者が `AgentsChannel` のみで実害がないため
  不採用とし、この不変条件で defense-in-depth を代替する。
- MUST: ラッパーはサーバから受けた指示で `allowedTools` /
  `canUseTool` の設定を変更しない(実行能力の天井はローカル設定)。
- MUST: resume 対象 session_id は当該 agent の束縛 cwd 配下に実在するものに
  限定する(他 cwd/任意パスの resume を拒否、
  [ADR-0014](../adr/0014-session-resume-and-restore.md))。
- MUST: セッション召喚時の JSONL メタ配信は operator role のみ。
- SHOULD: operator トークンは viewer と分け、配布範囲を最小にする。

### Session-reset control (`/new`・`/clear`、phase-17)

`session_reset` は operator、または permission_broker に都度承認された agent 自身が
agent の実行環境を強制再起動できる
高権限操作(fresh wrapper spawn + 旧 session 放棄、model / effort /
permission_mode / sandbox / network_access は phase-15 D8 の最終
effective 値で再適用)。乱発は work-in-progress の喪失や DoS 相当に
なり得るため、**6 段防御**で権限境界を守る
([ADR-0036](../adr/0036-session-lifecycle-commands.md))。

- **起点・承認検証**: operator 起点の `AgentsChannel.handle_in("session_reset", ...)`
  は従来どおり先頭で `require_operator/1` を通り、viewer は forbidden。agent 自身の
  `WrapperChannel.handle_in("session_reset_request", ...)` は wrapper topic に bind された
  自 agent にしか作用せず、Claude の `request_session_reset` tool に対する
  permission_broker 都度承認後、当該 turn 完了時だけ送信される([ADR-0043](../adr/0043-agent-initiated-session-reset.md))。
  他 agent 起点の専用経路は持たない。
- **capability advertise**: `ext.session_capabilities.supports_session_reset`
  - `session_reset_modes` を wrapper adapter が spawn 直後に stamp。
  未 stamp / false / true+空 modes は fail-closed で dashboard の
  Composer intercept が発火せず、server の relay も
  `unsupported_session_reset` reject。engine 名判定を禁止して adapter
  側の advertise を SSOT とする([ADR-0034](../adr/0034-session-capabilities-advertisement.md) F2 継承)。
- **host binding (exact match)**: `RunnerChannel.session_reset_result` で
  `AgentId.host_id_from(agent_id) == host_id` の完全一致を要求。
  ADR-0024 D3 の `<host_id>.<rand>` allocation-inverse を厳格に
  逆演算するため、host_id が dot を含む場合の **nested-prefix
  spoof**(naive な `starts_with?` で通ってしまう別 host の
  agent_id の詐称)を防ぐ。
- **reserved_session_command reject**: 旧 / 外部 client が literal
  `/new`・`/clear` を `send_instruction` に送ってきた場合、server 側
  の handler の先頭で `reserved_session_command` として loud reject し、
  engine に一度も渡さない(client-side intercept だけに頼らない多層
  防御)。
- **SessionResets pending lock**: `check_and_acquire/5` が単一
  `handle_call` 内で lock 有無 + KaoiroState (`idle`/`waiting_input`)
  - dispatch-cooldown を atomic に検証(ADR-0036 F6 の TOCTOU 芯)。
  reset pending 中は instruction / set_model / set_effort /
  set_permission_mode / **resume_session** をすべて
  `session_reset_pending` で reject(2026-07-12 ε 実装時の race
  分析で ADR-0036 F2 の列挙漏れとして resume_session を追加)。
  2 秒の dispatch-cooldown は async state-report lag 保護 (instruction
  dispatch と wrapper state_change 到達の race を塞ぐ)。
- **viewer 情報境界**: `session_reset_started` / `session_reset_completed`
  / `session_reset_failed` broadcast は `intercept` + `handle_out` で
  operator-only (`session_reset_started` の origin / reason も viewer に流さない)。`session_boundary` envelope は viewer 側で payload を
  `{"mode"}` のみに sanitize(request_id / previous_session_id /
  to_session_id は viewer に不可視化、
  [ADR-0021](../adr/0021-role-information-disclosure-policy.md) 継承 +
  ADR-0036 F3)。

## Open Questions

なし(監査ログ・マスキングは上表の通り将来項目)。

## See Also

- 関連 specs: [protocol](protocol.md), [architecture](architecture.md)
- ADRs: [0002](../adr/0002-local-wrapper-websocket-topology.md),
  [0005](../adr/0005-access-control-oauth-stub.md),
  [0011](../adr/0011-phase3-reliability-and-auth.md),
  [0012](../adr/0012-response-display-and-dashboard-scope.md),
  [0014](../adr/0014-session-resume-and-restore.md),
  [0021](../adr/0021-role-information-disclosure-policy.md),
  [0023](../adr/0023-host-runner-architecture.md)
