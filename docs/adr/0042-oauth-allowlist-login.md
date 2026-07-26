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
  connect/refresh (最長 12h) + 明示 revoke で失効に落ちる。
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

- RBAC の役割粒度は operator / viewer の現行 2 値を維持。細分化
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
