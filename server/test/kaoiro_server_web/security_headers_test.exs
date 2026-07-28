defmodule KaoiroServerWeb.SecurityHeadersTest do
  use KaoiroServerWeb.ConnCase, async: true

  alias KaoiroServerWeb.SecurityHeaders

  describe "レスポンスヘッダ (#155)" do
    test "静的配信にも 4 ヘッダが付く", %{conn: conn} do
      # favicon は Plug.Static が router より前で halt する経路。SPA の
      # index.html と同じ位置づけで、:browser pipeline には到達しない。
      conn = get(conn, "/favicon.ico")

      assert conn.status == 200
      assert get_resp_header(conn, "x-content-type-options") == ["nosniff"]
      assert get_resp_header(conn, "x-frame-options") == ["DENY"]

      assert get_resp_header(conn, "referrer-policy") == [
               "strict-origin-when-cross-origin"
             ]

      assert [csp] = get_resp_header(conn, "content-security-policy")
      assert csp =~ "default-src 'self'"
      assert csp =~ "frame-ancestors 'none'"
    end

    test "router 経由のレスポンスにも付く", %{conn: conn} do
      conn = get(conn, "/api/personas")

      assert conn.status == 200
      assert get_resp_header(conn, "x-content-type-options") == ["nosniff"]
      assert [_csp] = get_resp_header(conn, "content-security-policy")
    end
  end

  describe "CSP の中身" do
    setup %{conn: conn} do
      [csp] =
        conn |> get("/favicon.ico") |> get_resp_header("content-security-policy")

      {:ok, csp: csp}
    end

    test "script-src は unsafe-inline / unsafe-eval を許さない", %{csp: csp} do
      # ここが緩むと {@html} で描く untrusted なエージェント出力に対する
      # 多層防御が消える (DOMPurify 単独依存に戻る)。
      assert csp =~ "script-src 'self';"
      refute csp =~ "unsafe-eval"
    end

    test "mermaid のため style-src だけ unsafe-inline を許す", %{csp: csp} do
      assert csp =~ "style-src 'self' 'unsafe-inline'"
    end

    test "connect-src に WS オリジンが入る", %{csp: csp} do
      # test env は check_origin を持たないので、fallback の endpoint URL
      # 由来 (config.exs の url: [host: "localhost"] + Phoenix 既定 port。
      # 実際の待ち受け port 4002 ではなく「ブラウザに広告する URL」)。
      assert csp =~ "connect-src 'self' ws://localhost:4000"
    end
  end

  # ふじ 2nd review must-fix (#155): TLS reverse proxy 配備では
  # rewrite_on: [:x_forwarded_proto] が scheme だけを書き換えるため、
  # conn は内部 port を持ったままになる。既存の connect_src/3 テストは
  # 正規化済み文字列を直接渡していて、この形を通していなかった。
  describe "request_origin/2 (proxy 配備の外向き port 復元)" do
    @tls_url [host: "kaoiro.example", port: 443, scheme: "https"]

    # proxy は http://host:4000 へ転送し、x-forwarded-proto だけが https を
    # 伝える (config/prod.exs の force_ssl rewrite_on と同じ経路)。
    defp proxied_conn(host) do
      :get
      |> Plug.Test.conn("http://#{host}:4000/index.html")
      |> Plug.Conn.put_req_header("x-forwarded-proto", "https")
      |> Plug.RewriteOn.call(Plug.RewriteOn.init([:x_forwarded_proto]))
    end

    test "前提の pin: rewrite 後も conn は内部 port を持ったまま" do
      conn = proxied_conn("kaoiro.example")

      assert conn.scheme == :https
      assert conn.port == 4000
    end

    test "外向き scheme/host が一致するとき port は :url から復元する" do
      assert SecurityHeaders.request_origin(proxied_conn("kaoiro.example"), @tls_url) ==
               "https://kaoiro.example"
    end

    test "復元した origin が check_origin の TLS エントリと一致する" do
      # 復元前は https://kaoiro.example:4000 となり一致せず、connect-src が
      # 'self' だけに落ちて production の socket が CSP block されていた。
      origin = SecurityHeaders.request_origin(proxied_conn("kaoiro.example"), @tls_url)

      assert SecurityHeaders.connect_src(
               [
                 "https://kaoiro.example",
                 "http://localhost:4000",
                 "http://127.0.0.1:4000"
               ],
               origin,
               "https://unused.example"
             ) == ["'self'", "wss://kaoiro.example"]
    end

    test "loopback 直アクセスは conn の値のまま復元しない" do
      conn = Plug.Test.conn(:get, "http://localhost:4000/index.html")

      assert SecurityHeaders.request_origin(conn, @tls_url) == "http://localhost:4000"
    end

    test "偽装 Host は :url と一致しないので復元されない" do
      conn = proxied_conn("attacker.example")
      origin = SecurityHeaders.request_origin(conn, @tls_url)

      assert origin == "https://attacker.example:4000"

      assert SecurityHeaders.connect_src(
               ["https://kaoiro.example", "http://localhost:4000"],
               origin,
               "https://unused.example"
             ) == ["'self'"]
    end

    test "plain-HTTP 直結配備は外向き port がそのまま一致する" do
      conn = Plug.Test.conn(:get, "http://linux-host.example:4000/index.html")
      url = [host: "linux-host.example", port: 4000, scheme: "http"]

      assert SecurityHeaders.request_origin(conn, url) == "http://linux-host.example:4000"
    end

    test "url に scheme が無い (dev/test) 場合は conn の値を使う" do
      conn = Plug.Test.conn(:get, "http://localhost:4002/index.html")

      assert SecurityHeaders.request_origin(conn, host: "localhost") ==
               "http://localhost:4002"

      assert SecurityHeaders.request_origin(conn, nil) == "http://localhost:4002"
    end
  end

  describe "connect_src/3" do
    # plain-HTTP 配備で runtime.exs が組み立てる check_origin。
    @plain_http [
      "http://linux-host.example:4000",
      "http://localhost:4000",
      "http://127.0.0.1:4000"
    ]

    test "リクエスト元と一致する 1 件だけを ws へ写す" do
      # ふじ advisory (#155): check_origin は「socket を開いてよい発信元」、
      # connect-src は「このページが繋いでよい宛先」。全件写すと外部 host
      # 向けのページに ws://localhost:4000 が載る。
      assert SecurityHeaders.connect_src(
               @plain_http,
               "http://linux-host.example:4000",
               "http://unused.example"
             ) == ["'self'", "ws://linux-host.example:4000"]

      assert SecurityHeaders.connect_src(
               @plain_http,
               "http://localhost:4000",
               "http://unused.example"
             ) == ["'self'", "ws://localhost:4000"]
    end

    test "TLS 配備は既定ポート省略形と一致する" do
      # conn 側は port 443 を持つので、正規化しないと突き合わない。
      assert SecurityHeaders.connect_src(
               ["https://kaoiro.example.com", "http://localhost:4000"],
               "https://kaoiro.example.com",
               "https://unused.example"
             ) == ["'self'", "wss://kaoiro.example.com"]
    end

    test "check_origin に無い origin には ws 宛先を出さない" do
      # そのオリジンからの socket は check_origin 側で 403 になるので、
      # CSP でも許可しないのが整合的。
      assert SecurityHeaders.connect_src(
               @plain_http,
               "http://attacker.example",
               "http://unused.example"
             ) == ["'self'"]
    end

    test "check_origin がリストでなければ endpoint の URL を使う" do
      assert SecurityHeaders.connect_src(true, "http://any.example", "http://localhost:4002") ==
               ["'self'", "ws://localhost:4002"]

      assert SecurityHeaders.connect_src(
               false,
               "http://any.example",
               "https://kaoiro.example.com"
             ) == ["'self'", "wss://kaoiro.example.com"]
    end

    test "origin として使えない要素は落とす" do
      # Phoenix は :conn やワイルドカードも受け付ける。CSP のソース式に
      # ならない値をそのまま流すと policy 全体が壊れる。
      assert SecurityHeaders.connect_src(
               [:conn, "//*.example.com", "http://localhost:4000"],
               "http://localhost:4000",
               "http://unused.example"
             ) == ["'self'", "ws://localhost:4000"]
    end
  end
end
