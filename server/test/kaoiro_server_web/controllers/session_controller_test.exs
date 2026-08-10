defmodule KaoiroServerWeb.SessionControllerTest do
  # Mutates :client_tokens; init_test_session seeds the session (ADR-0013).
  use KaoiroServerWeb.ConnCase, async: false

  import KaoiroServer.OAuthAllowlistFixture

  alias KaoiroServer.Auth

  @oauth_env_keys [
    :oauth_nextcloud_client_id,
    :oauth_nextcloud_client_secret,
    :oauth_nextcloud_base_url,
    :oauth_allowlist_path
  ]

  setup do
    clear_env()
    on_exit(&clear_env/0)
  end

  defp clear_env do
    Application.delete_env(:kaoiro_server, :client_tokens)
    Enum.each(@oauth_env_keys, &Application.delete_env(:kaoiro_server, &1))
  end

  # POST /session/new only accepts JSON (SessionController.create/2); the
  # ConnTest default is multipart, which the endpoint now rejects.
  defp json_req(conn), do: put_req_header(conn, "content-type", "application/json")

  test "create: 有効な token(body)を session に交換する (204)", %{conn: conn} do
    Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator")

    conn = conn |> json_req() |> post("/session/new", %{token: "tok-op"})

    assert conn.status == 204
    assert get_session(conn, "client_token") == "tok-op"
  end

  test "create: 不正な token は 401 で session に入らない", %{conn: conn} do
    Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator")

    conn = conn |> json_req() |> post("/session/new", %{token: "wrong"})

    assert conn.status == 401
    assert get_session(conn, "client_token") == nil
  end

  test "create: フォーム由来の content-type は 415 (login CSRF 防止)", %{conn: conn} do
    # cross-site の HTML form は urlencoded / multipart / text-plain しか
    # 送れない。JSON を必須にすることで、Lax が cookie を止めても応答の
    # Set-Cookie で session を差し替えられる経路を塞ぐ。
    Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator")

    conn = post(conn, "/session/new", %{token: "tok-op"})

    assert conn.status == 415
    assert get_session(conn, "client_token") == nil
  end

  test "create: token 無しは 400", %{conn: conn} do
    conn = conn |> json_req() |> post("/session/new", %{})
    assert conn.status == 400
  end

  test "create: token login で user が解決され、繰り返しログインで同じ user になる (issue #197)",
       %{conn: conn} do
    token = "tok-op-#{System.unique_integer([:positive])}"
    Application.put_env(:kaoiro_server, :client_tokens, "#{token}:operator:CI Runner")

    conn = conn |> json_req() |> post("/session/new", %{token: token})
    assert conn.status == 204

    # get_or_create/4 on the same source returns the EXISTING entry
    # (display_name unaffected by the nil passed here), so this
    # indirectly proves the controller already created it with the
    # configured name.
    source = {:token, Auth.client_token_hash(token)}
    user = KaoiroServer.Users.get_or_create(source, "user", nil)
    assert user.display_name == "CI Runner"

    conn2 = build_conn() |> json_req() |> post("/session/new", %{token: token})
    assert conn2.status == 204

    assert KaoiroServer.Users.get_or_create(source, "user", nil).id == user.id
  end

  test "ticket: 有効な session から検証可能な WS チケットを発行する", %{conn: conn} do
    Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator")

    conn =
      conn
      |> init_test_session(%{"client_token" => "tok-op"})
      |> get("/session/ticket")

    assert %{"ticket" => ticket} = json_response(conn, 200)
    assert is_binary(ticket) and ticket != ""

    assert {:ok, "tok-op"} =
             Phoenix.Token.decrypt(KaoiroServerWeb.Endpoint, "client_ws", ticket, max_age: 30)
  end

  test "ticket: session が無ければ 401", %{conn: conn} do
    conn =
      conn
      |> init_test_session(%{})
      |> get("/session/ticket")

    assert conn.status == 401
  end

  test "有効な session は 204 で更新される", %{conn: conn} do
    Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator")

    conn =
      conn
      |> init_test_session(%{"client_token" => "tok-op"})
      |> get("/session/refresh")

    assert conn.status == 204
    assert get_session(conn, "client_token") == "tok-op"
  end

  test "session が無ければ 401", %{conn: conn} do
    conn =
      conn
      |> init_test_session(%{})
      |> get("/session/refresh")

    assert conn.status == 401
  end

  test "失効した token は 401 で session が破棄され socket も切断される (#47)", %{conn: conn} do
    Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator")
    socket_id = KaoiroServer.Auth.socket_id("revoked")
    KaoiroServerWeb.Endpoint.subscribe(socket_id)

    conn =
      conn
      |> init_test_session(%{"client_token" => "revoked"})
      |> get("/session/refresh")

    assert conn.status == 401
    assert get_session(conn, "client_token") == nil
    assert_receive %Phoenix.Socket.Broadcast{topic: ^socket_id, event: "disconnect"}
  end

  describe "delete: ログアウト (#47)" do
    test "session を破棄し socket を強制切断する (204)", %{conn: conn} do
      Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator")
      socket_id = KaoiroServer.Auth.socket_id("tok-op")
      KaoiroServerWeb.Endpoint.subscribe(socket_id)

      conn =
        conn
        |> init_test_session(%{"client_token" => "tok-op"})
        |> delete("/session")

      assert conn.status == 204
      assert get_session(conn, "client_token") == nil
      assert_receive %Phoenix.Socket.Broadcast{topic: ^socket_id, event: "disconnect"}
    end

    test "session が無くても 204 (切断対象なし)", %{conn: conn} do
      conn =
        conn
        |> init_test_session(%{})
        |> delete("/session")

      assert conn.status == 204
    end
  end

  describe "auth-methods (ADR-0042)" do
    test "どちらも未設定なら token=false / oauth=[]", %{conn: conn} do
      assert %{"token" => false, "oauth" => []} =
               conn |> get("/session/auth-methods") |> json_response(200)
    end

    test "設定済みの認証手段だけを返す", %{conn: conn} do
      Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator")
      configure_nextcloud()

      assert %{"token" => true, "oauth" => ["nextcloud"]} =
               conn |> get("/session/auth-methods") |> json_response(200)
    end

    test "認証なしで参照できる (ログイン画面の出し分け用)", %{conn: conn} do
      configure_nextcloud()

      assert %{"token" => false, "oauth" => ["nextcloud"]} =
               conn
               |> init_test_session(%{})
               |> get("/session/auth-methods")
               |> json_response(200)
    end
  end

  describe "OAuth session (ADR-0042)" do
    test "ticket: identity を暗号化して運ぶ", %{conn: conn} do
      put_allowlist("nextcloud:ao:operator")

      conn =
        conn
        |> init_test_session(%{"oauth_identity" => identity()})
        |> get("/session/ticket")

      assert %{"ticket" => ticket} = json_response(conn, 200)

      assert {:ok, %{provider: "nextcloud", uid: "ao"}} =
               Phoenix.Token.decrypt(KaoiroServerWeb.Endpoint, "client_ws", ticket, max_age: 30)
    end

    test "ticket: 許可リストから消えた identity は 401", %{conn: conn} do
      put_allowlist("nextcloud:kuroe:operator")

      conn =
        conn
        |> init_test_session(%{"oauth_identity" => identity()})
        |> get("/session/ticket")

      assert conn.status == 401
    end

    test "refresh: 許可リストにあれば 204 で session を維持する", %{conn: conn} do
      put_allowlist("nextcloud:ao:viewer")

      conn =
        conn
        |> init_test_session(%{"oauth_identity" => identity()})
        |> get("/session/refresh")

      assert conn.status == 204
      assert get_session(conn, "oauth_identity") == identity()
    end

    test "refresh: 許可リスト行の削除で 401 + 稼働中 socket を切断する", %{conn: conn} do
      put_allowlist("# 行を削除した状態")
      socket_id = Auth.oauth_socket_id("nextcloud", "ao")
      KaoiroServerWeb.Endpoint.subscribe(socket_id)

      conn =
        conn
        |> init_test_session(%{"oauth_identity" => identity()})
        |> get("/session/refresh")

      assert conn.status == 401
      assert get_session(conn, "oauth_identity") == nil
      assert_receive %Phoenix.Socket.Broadcast{topic: ^socket_id, event: "disconnect"}
    end

    test "delete: identity 由来の socket を切断する", %{conn: conn} do
      put_allowlist("nextcloud:ao:operator")
      socket_id = Auth.oauth_socket_id("nextcloud", "ao")
      KaoiroServerWeb.Endpoint.subscribe(socket_id)

      conn =
        conn
        |> init_test_session(%{"oauth_identity" => identity()})
        |> delete("/session")

      assert conn.status == 204
      assert get_session(conn, "oauth_identity") == nil
      assert_receive %Phoenix.Socket.Broadcast{topic: ^socket_id, event: "disconnect"}
    end

    test "create: token ログインは同じ session の identity を捨てる", %{conn: conn} do
      Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator")
      put_allowlist("nextcloud:ao:operator")

      conn =
        conn
        |> init_test_session(%{"oauth_identity" => identity()})
        |> json_req()
        |> post("/session/new", %{token: "tok-op"})

      assert conn.status == 204
      assert get_session(conn, "oauth_identity") == nil
      assert get_session(conn, "client_token") == "tok-op"
    end
  end

  defp identity, do: %{provider: "nextcloud", uid: "ao"}

  defp configure_nextcloud do
    Application.put_env(:kaoiro_server, :oauth_nextcloud_client_id, "nc-id")
    Application.put_env(:kaoiro_server, :oauth_nextcloud_client_secret, "nc-secret")
    Application.put_env(:kaoiro_server, :oauth_nextcloud_base_url, "https://cloud.test")
  end
end
