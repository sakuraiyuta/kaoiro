---
title: ユーザトークンの httpOnly cookie 永続化(リロード耐性)
status: accepted
date: 2026-06-15
opened: 2026-06-15
supersedes: []
superseded_by: null
related_specs: [protocol, architecture, threat-model]
related_adrs: [5, 11, 21, 42]
---

# ADR-0013 — ユーザトークンの httpOnly cookie 永続化(リロード耐性)

## Status

Accepted

## Context

ダッシュボード(`dashboard/`, Svelte)はユーザトークン(ADR-0011)を
URL の `?token=…` で受け取り、受領直後に `history.replaceState` で
アドレスバーから消し、以降は JS のメモリにしか保持していなかった。その
ため**ブラウザをリロードすると URL 側もメモリ側も両方トークンを失い**、
再接続は空 params となって `Auth.client_role/1` が fail-closed(ADR-0011,
issue #28)で拒否する。トークン永続化層が未実装の状態だった(issue #45)。

制約:

- ブラウザ標準の WebSocket はカスタム `Authorization` ヘッダを付けられず、
  WS で使える資格情報は実質「クエリ(現状)」か「cookie」の二択。
- ダッシュボードは agent 応答由来の transcript / mermaid を描画する XSS 面
  を持つ(DOMPurify 導入済みが傍証)。Web Storage 方式はトークンが JS から
  読めるため、XSS でセッション窃取まで被害が広がる。operator ロールは
  リモートのツール実行・承認ができ漏洩コストが高い。
- **確立済みの WebSocket 上では `Set-Cookie` できない**(cookie は HTTP
  レスポンスヘッダでしか更新できない)。

issue #45 にて my-spec-elicitation で方式を収束(2026-06-15 ユーザ決定)。

## Decision

ユーザトークンを **httpOnly + 暗号化 session cookie** で永続化する。

1. **器 = Phoenix 既存の署名付き session cookie を再利用**(`_kaoiro_server_key`)。
   httpOnly・SameSite=Lax は既に構成済み。新規 cookie や手動パースを足さない。
2. **格納 = トークンを session に入れ、session を暗号化**(`encryption_salt`
   を追加)。`connect/3` と `/session/refresh` は毎回 `Auth.client_role/1` で
   再検証するため**失効が次の接続/refresh で反映**され、暗号化により cookie
   jar 上でもトークンが秘匿される(稼働中ソケットの即時排除は下記の限界)。
3. **有効期限 = `max_age` 3 日のスライディングウィンドウ**。開いている SPA が
   `GET /session/refresh` を定期(12h)に叩いて cookie を再発行 → **開いている
   限り失効しない**。閉じた/切断後は最後の更新から 3 日で失効。絶対上限は
   設けない。
4. **トークン→cookie の交換は 2 経路**。(a) prod = `GET /?token=…` を
   `RootRedirect`(Plug.Session 後段)で検証 → `put_session` → クリーンな
   `/index.html` へ 302(トークンは SPA にもアドレスバーにも残らない)。
   (b) dev = Vite(:5173)が SPA を配信し RootRedirect を経由しないため、SPA が
   受け取った `?token=` を `POST /session/new`(Vite proxy 経由。cookie は HTTP
   なら proxy を通る)へ投げて cookie をセットする(クライアント駆動)。
5. **WS 認証は短命チケット経由**(`connect/3` は ticket → token param →
   session の順で解決)。**Vite の proxy は WS upgrade に Cookie を転送せず、
   :4000 直結(cross-port)でもブラウザは cookie を送らないため、cookie を WS に
   乗せられない**(検証で確定)。そこでリロード時は SPA が `GET /session/ticket`
   (cookie 付き HTTP=proxy を通る)で `Phoenix.Token` **暗号化**の**短命
   チケット(30 秒)**を取得し、WS を `?ticket=`(param は proxy を通る)で
   接続する。`connect/3` がチケットを復号してトークンへ戻す。署名のみだと
   ticket を持つ者がトークンを Base64 復元できてしまうため暗号化必須(#47
   レビュー)。**トークン自体は JS に出ない**(チケットからも復元不可)。
   初回ロード(`?token=` あり)は token param で接続しつつ cookie を
   セットする。prod は同一 origin 直結で cookie が WS に乗るため session
   フォールバックも効く。
6. **secure フラグ = prod のみ**。既存 `force_ssl`(`rewrite_on:
   [:x_forwarded_proto]`)前提で、`Application.compile_env(:kaoiro_server,
   :session_secure, false)` を `prod.exs` で `true` に。dev(http localhost)
   は false。CSRF は SameSite=Lax + prod の `check_origin`(`url` host 既定)で
   抑止する。

## Consequences

### Positive

- リロード・ブラウザ再起動でも再接続が維持され、運用・開発の摩擦が消える。
- httpOnly + 暗号化でトークンは JS にも cookie jar の平文にも出ない。XSS が
  取れるのは短命チケット(数十秒)止まりで、再利用可能なトークンは窃取できない。
- 失効は接続・`/session/refresh` ごとの再検証で反映される(refresh が 401 を
  返すと正規クライアントは自発的に切断する)。

### Negative

- 開いている間の失効防止に SPA からの定期 HTTP heartbeat が要る(WS 上では
  cookie 更新不可のため)。
- cookie を WS に乗せられない(Vite proxy 非転送 + cross-port 非送出)ため、
  リロード認証に「HTTP でチケット取得 → param 接続」の一手間が要る。`connect/3`
  は ticket / token param / session の 3 経路を持つ。
- **稼働中ソケットの即時強制切断**: 当初は不可だったが issue #47 で解決済み。
  当初 `ClientSocket` は connect 時のみ token を検証し `id/1` が `nil`
  (`Endpoint.disconnect` 経路なし)で、失効は次接続まで反映されなかった。
  #47 で `id/1` を token 由来の socket id(`Auth.socket_id/1` = token の
  SHA-256、生 token は非保持)にし、明示ログアウト(`DELETE /session`)と
  refresh の 401(失効)で `Endpoint.broadcast(id, "disconnect", %{})` により
  稼働中ソケットを即時切断する。

### Neutral

- OAuth 本実装(ADR-0005 本線)は引き続き将来。cookie はトークンを運ぶだけ。
- session は従来休眠していた(`put_session` 未使用)ため、暗号化追加で壊れる
  既存セッションはない。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| Web Storage(localStorage)にトークン保持 | JS から可読 → XSS でセッション窃取。operator 漏洩コストが高い |
| 専用 httpOnly cookie を新設 | `connect_info: [:x_headers]` で手動パース。既存 session 再利用で足りる |
| session に role のみ格納(token 非保持) | 失効が cookie 有効期限まで効かない。token 再検証の即時失効を優先 |
| token を署名のみ(暗号化なし)で格納 | cookie jar から平文トークンが読める。operator は暗号化で秘匿 |
| 絶対上限つき有効期限 | 「開いている限り無期限」の運用要件と相反。スライディングのみ採用 |
