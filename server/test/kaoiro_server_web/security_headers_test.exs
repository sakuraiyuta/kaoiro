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
