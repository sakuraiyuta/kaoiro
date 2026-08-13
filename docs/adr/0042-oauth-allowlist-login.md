---
title: dashboard の OAuth 個人認証 (Google/GitHub/Nextcloud) + 許可リスト
status: accepted
date: 2026-07-26
opened: 2026-07-26
supersedes: []
superseded_by: null
related_specs: [auth-and-authz, threat-model]
related_adrs: [5, 11, 13, 21]
---

# ADR-0042 — dashboard の OAuth 個人認証 + 許可リスト

## Status

Accepted (2026-07-26 マスター指示により issue #65 を実装対象へ昇格、
仕様確定)

## Context

dashboard の認証は共有トークン (`KAOIRO_CLIENT_TOKENS` = `token:role`)
のみで、「役割」は識別できるが「人」を識別できない (ADR-0011/0013)。
ADR-0005 は本線を「OAuth + RBAC、プロトタイプは許可メールの
ホワイトリスト stub」と定めており、本 ADR はその本実装の方式決定。

前提となる既存配管 (ADR-0013 / #47):

- session cookie (httpOnly + 暗号化、3 日スライディング + 12h refresh)
- WS 認証は 30 秒暗号化 ticket 経由、`connect/3` は
  ticket → token param → session の順で解決
- logout / refresh 401 は `Auth.socket_id/1` 宛 broadcast で稼働中
  socket を即時切断

現状 server に OAuth ライブラリ・HTTP client・Ecto はない (依存 7 個)。

## Decision

1. **ライブラリ = assent** (pow-auth/assent) + HTTP client (Req)。
   Google / GitHub は組み込み strategy、Nextcloud は
   `Assent.Strategy.OAuth2.Base` のカスタム strategy
   (authorize `/apps/oauth2/authorize`、token
   `/apps/oauth2/api/v1/token`、identity は OCS
   `/ocs/v2.php/cloud/user?format=json`)。ueberauth は plug 結合と
   依存の厚みで不採用。
2. **provider 設定は env** (`runtime.exs`):
   `KAOIRO_OAUTH_{GOOGLE,GITHUB,NEXTCLOUD}_CLIENT_ID` / `_CLIENT_SECRET`
   と `KAOIRO_OAUTH_NEXTCLOUD_BASE_URL`。id + secret (+ Nextcloud は
   base_url) が揃った provider のみ有効。redirect URI は endpoint の
   `url` 設定から導出:
   `{scheme}://{host}[:{port}]/auth/{provider}/callback`。
3. **許可リスト = テキストファイル**。path は
   `KAOIRO_OAUTH_ALLOWLIST_PATH`。書式は 1 行 1 エントリ
   `provider:identifier[:role]`、`#` コメント・空行可、role 省略時は
   viewer (安全側既定)。identifier は google = email (小文字比較)、
   github = login、nextcloud = user id。認証時と再検証時に毎回 parse
   (env token と同じ方針 — 失効が次の connect/refresh で反映)。
   未設定・ファイル欠落・エントリ不一致は OAuth 認証拒否
   (fail-closed)。malformed 行は warn + skip (fail-visible)。
   SQLite (ADR-0005 の選択肢) は Ecto 不在の現状に対し過剰で不採用。
   運用者が編集する静的設定なので DETS も不適。
4. **session には identity を格納** (`%{provider, uid}`)。role は
   格納せず、connect / refresh のたび許可リストで再解決する
   (token 経路の `Auth.client_role/1` 再検証と同型)。ticket は
   identity を暗号化して運び、socket id は
   `sha256("oauth:" <> provider <> ":" <> uid)`。寿命・refresh・
   logout・強制切断は ADR-0013 / #47 の機構をそのまま使う。
   **provider の access token は identity 取得後に破棄し保存しない**
   (Nextcloud OAuth2 は scope 非対応で token がフルアクセスのため)。
5. **token 認証との併存**: `KAOIRO_CLIENT_TOKENS` 未設定時は token
   認証無効 (既存 fail-closed のまま = server 側変更なし)。dashboard
   は新設 `GET /session/auth-methods`
   (`{"token": bool, "oauth": [provider, ...]}`) で UI を出し分け、
   token 入力フォームは token 有効時のみ、OAuth ボタンは有効 provider
   のみ表示する。
6. **route**: `GET /auth/:provider` (302 → provider。state/PKCE の
   session_params は session に保存)、`GET /auth/:provider/callback`
   (state 検証 → identity 取得 → 許可リスト照合 → `put_session` →
   302 `/index.html`)。失敗は 302
   `/index.html?auth_error={provider_error|not_allowed|invalid_state}`
   で dashboard 側がログイン画面に文言表示。

## Consequences

### Positive

- 個人単位の認証と role 付与ができ、許可リストの行削除が次の
  connect/refresh (最長 12h) + 明示 revoke で失効に落ちる。稼働中 socket
  への反映は #158(操作のたび再解決)に加え #170(変更を一度も操作しない
  passive socket にも change-driven に効く)で強化済み — 詳細は本 ADR
  末尾の Addendum。
- ADR-0013 の cookie/ticket/logout 配管を identity 差し替えのみで
  再利用し、WS 層・channel 層 (role gate) は無変更。

### Negative

- server に新規依存 (assent + HTTP client) が入る。
- Google は redirect URI に https を要求する (localhost を除く) ため、
  plain-HTTP 配備 (KAOIRO_PLAIN_HTTP、例: linux-host) では Google
  ログインは使えない。GitHub / Nextcloud は http redirect 可の想定
  (実装時に要確認)。
- 同一人物が複数 provider で入ると別 identity になる (統合はしない)。

### Neutral

- ~~RBAC の役割粒度は operator / viewer の現行 2 値を維持。細分化~~
  **撤回 (2026-08-14、issue #198)。** role は admin / operator / viewer
  の 3 値になった ([ADR-0050](0050-principal-model-and-graded-access-control.md)
  D2)。許可リストのテキスト形式は `provider:identifier[:role]` のまま
  で、role 語に `admin` が加わっただけなので、本 ADR の形式と issue #170
  の watcher の前提は変わらない。以下は撤回前の記述: 細分化
  (approver 等) は将来。
- 監査ログ・マルチテナント隔離は本 ADR のスコープ外 (auth-and-authz
  Known gaps のまま)。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| ueberauth + strategies | plug 結合が厚く Nextcloud strategy がない。assent は素の関数群で test しやすい |
| 許可リストを env 直書き | エントリが増えると .env が肥大 (#83 の問題意識)。ファイル分離が運用しやすい |
| 許可リストを SQLite | Ecto 不在。静的設定に DB は過剰 (ADR-0005 の stub 選択肢だが現状と乖離) |
| 許可リストを DETS | server が書く runtime 状態向け。運用者が手編集する設定には不向き |
| session に role を格納 | 失効が cookie 期限まで効かない。ADR-0013 と同じ理由で毎回再解決 |
| provider token の保持 | Nextcloud token がフルアクセスで漏洩コスト過大。identity 取得後に破棄 |

## Addendum (issue #170, 2026-08-05): passive socket への change-driven disconnect

**背景。** #158 は「operator 操作のたびに role を再解決し、不一致なら
disconnect」という方式で稼働中 socket への降格反映を実現したが、これは
「操作した瞬間に切る」方式であり、降格後に一度も operator 操作をしない
socket は `AgentsChannel.handle_out` の operator 限定配信(tool input
等)を受け続けていた。#158 実装時点でこれは fan-out のホットパスで毎
envelope × 毎 subscriber に許可リストを読み直すコストを理由に意図的に
見送られていた(あお判断)。

**決定。** 見送りの再検証の結果、ホットパスに触れない別方式を採用した:

- `KaoiroServer.OAuthAllowlistWatcher` が許可リストファイルの変更を
  file_system イベント(fast path、bounded debounce)と periodic
  reconcile(backstop、event 取りこぼしを bound)の両方で検知する。
- 検知のたびに許可リストの **snapshot 差分**(`{provider, identifier}
  => role` の追加・削除・role 変更)だけを計算し、変更があった identity
  にだけ `Endpoint.broadcast(oauth_socket_id, "disconnect", %{})` を撃つ
  (#47/#158 と同じ機構の再利用、新しい broadcast 経路は増やさない)。
  稼働中 socket の列挙は一切行わない(そのための機構はこのコードベース
  に存在しないことを実測済み)。
- 差分計算の checkpoint は `:persistent_term` に保持する。認可判断の
  SoT は変わらず許可リストファイル自身(`role_for/2` は今までどおり
  毎回ファイルを読み直す)で、checkpoint は watcher プロセスの再起動を
  越えて「どこまで反映したか」を追跡するためだけの補助状態。
  `:persistent_term.put/2` は global GC を誘発するため、差分が空なら
  put しない。
- `AgentsChannel.join/3` は connect → join の間に許可リストが変わった
  socket を live re-resolve で弾く(connect と join の間、transport が
  socket-id topic の subscribe を終える前に watcher の disconnect が
  発火すると取りこぼす窓があるため、join 自体を最後の砦にする)。

**Negative(このコードベースにとっての新しいトレードオフ)。**

- watcher プロセスの crash → restart 自体は、**retained checkpoint と
  現在の内容が unchanged なら disconnect も `:persistent_term.put` も
  発生しない**(checkpoint は BEAM プロセスの生死と無関係に
  `:persistent_term` に残るため)。副作用が出るのは
  **crash のタイミングが「reconcile 途中(diff 計算後・broadcast 完了前)」
  または「broadcast 一部失敗」に重なった場合のみ**で、その場合は
  checkpoint が古いまま残り、restart 後(または次の periodic reconcile)
  で **その時点の changed identities だけ**へ再度 disconnect が飛びうる
  (broadcast は idempotent なので、稼働中でない socket への重複送信は
  無害)。「稼働中の全 socket へ」ではなく「変更のあった identity へ、
  条件が揃えば重複送信され得る」が正確な記述。
  `:persistent_term.put/2` の global GC コストも、この**実変更があった
  ときだけ**発生する(空 diff では put しない設計、moduledoc 参照)。
  root supervisor は `max_restarts` を明示設定していない(OTP 既定 =
  3 回 / 5 秒)ため、この watcher(や既存の PersonaWatcher/
  FooterWatcher)がその範囲を超えて crash し続ければ server 全体が落ちる
  ——これは既存の supervision tree の性質であり、上記の「変更時のみ
  disconnect し得る」副作用の回数を直接規定するものではない(3 回に
  限られるのは crash-loop 自体の話であって「全 socket への disconnect」
  の話ではない)。
- file_system イベントが失われる(backend 未起動 / event drop / 親 dir
  の一時欠落)場合、変更の反映は periodic reconcile 任せになり、最大
  `@reconcile_interval_ms` だけ遅延しうる(無期限に遅延することはない
  — 詳細は `OAuthAllowlistWatcher` moduledoc 「Detection」節)。
- 許可リストが部分書き込み中に読まれると、完全な内容に復旧するまでの
  間、正当な operator も含めて過剰に disconnect されうる
  (fail-closed の意図的な選択、LKG 維持はしない)。運用は temp-file +
  atomic rename での編集を推奨するが、これは確率を下げるだけで保証で
  はない。

詳細な設計判断(ふじレビュー、あお承認)は issue #170 のコメント履歴、
実装は `KaoiroServer.OAuthAllowlistWatcher` のモジュール doc を参照。
