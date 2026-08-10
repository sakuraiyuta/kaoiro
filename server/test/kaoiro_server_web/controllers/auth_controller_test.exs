defmodule KaoiroServerWeb.AuthControllerTest do
  # Mutates the :oauth_* config and stubs assent's HTTP adapter (ADR-0042).
  use KaoiroServerWeb.ConnCase, async: false

  import KaoiroServer.OAuthAllowlistFixture

  alias KaoiroServer.OAuthTestAdapter

  @provider_token "secret-provider-access-token"

  @env_keys [
    :oauth_nextcloud_client_id,
    :oauth_nextcloud_client_secret,
    :oauth_nextcloud_base_url,
    :oauth_allowlist_path,
    :client_tokens
  ]

  setup do
    clear_env()
    on_exit(&clear_env/0)
  end

  describe "GET /auth/:provider" do
    test "未設定 provider は 404", %{conn: conn} do
      assert conn |> get("/auth/nextcloud") |> response(404)
      assert conn |> get("/auth/facebook") |> response(404)
    end

    test "provider へ 302 し state を session に置く", %{conn: conn} do
      configure_nextcloud()

      conn = get(conn, "/auth/nextcloud")

      assert redirected_to(conn) =~ "https://cloud.test/apps/oauth2/authorize?"

      assert %{provider: "nextcloud", params: %{state: state}} =
               get_session(conn, "oauth_session_params")

      assert is_binary(state)
    end
  end

  describe "GET /auth/:provider/callback" do
    test "未設定 provider は 404", %{conn: conn} do
      assert conn |> get("/auth/nextcloud/callback") |> response(404)
    end

    test "許可リストにある identity を session に格納して dashboard へ返す", %{conn: conn} do
      configure_nextcloud()
      put_allowlist("nextcloud:ao:operator")
      stub_provider()

      conn = callback(conn)

      assert redirected_to(conn) == "/index.html"
      assert get_session(conn, "oauth_identity") == %{provider: "nextcloud", uid: "ao"}
      # state は使い捨て。
      assert get_session(conn, "oauth_session_params") == nil
    end

    test "許可された login で user が解決され display_name に provider 名を使う (issue #197)", %{
      conn: conn
    } do
      configure_nextcloud()
      put_allowlist("nextcloud:ao:operator")
      stub_provider()

      callback(conn)

      user = KaoiroServer.Users.get_or_create({:oauth, "nextcloud", "ao"}, "user", nil)
      assert user.display_name == "ao"
    end

    test "同じ identity での再ログインは同じ user_id になる (issue #197)", %{conn: conn} do
      configure_nextcloud()
      put_allowlist("nextcloud:ao:operator")
      stub_provider()
      callback(conn)
      first = KaoiroServer.Users.get_or_create({:oauth, "nextcloud", "ao"}, "user", nil)

      stub_provider()
      callback(build_conn())
      second = KaoiroServer.Users.get_or_create({:oauth, "nextcloud", "ao"}, "user", nil)

      assert first.id == second.id
    end

    test "provider の access token は session に残らない", %{conn: conn} do
      configure_nextcloud()
      put_allowlist("nextcloud:ao:operator")
      stub_provider()

      conn = callback(conn)

      refute inspect(conn.private[:plug_session]) =~ @provider_token
      refute inspect(conn.resp_cookies) =~ @provider_token
    end

    test "OAuth ログインは同じ session の client_token を捨てる", %{conn: conn} do
      configure_nextcloud()
      put_allowlist("nextcloud:ao:operator")
      stub_provider()
      Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator")

      conn =
        conn
        |> init_test_session(%{"client_token" => "tok-op"})
        |> callback()

      assert get_session(conn, "client_token") == nil
      assert get_session(conn, "oauth_identity") == %{provider: "nextcloud", uid: "ao"}
    end

    test "許可リスト外は not_allowed で拒否する (fail-closed)", %{conn: conn} do
      configure_nextcloud()
      put_allowlist("nextcloud:kuroe:operator")
      stub_provider()

      conn = callback(conn)

      assert redirected_to(conn) == "/index.html?auth_error=not_allowed"
      assert get_session(conn, "oauth_identity") == nil
    end

    test "許可リスト未設定は not_allowed で拒否する (fail-closed)", %{conn: conn} do
      configure_nextcloud()
      stub_provider()

      conn = callback(conn)

      assert redirected_to(conn) == "/index.html?auth_error=not_allowed"
      assert get_session(conn, "oauth_identity") == nil
    end

    test "state が一致しなければ invalid_state", %{conn: conn} do
      configure_nextcloud()
      put_allowlist("nextcloud:ao:operator")
      stub_provider()

      conn = start_flow(conn)

      conn = get(conn, "/auth/nextcloud/callback", %{"code" => "c", "state" => "forged"})

      assert redirected_to(conn) == "/index.html?auth_error=invalid_state"
      assert get_session(conn, "oauth_identity") == nil
    end

    test "request を経ずに callback を叩けば invalid_state", %{conn: conn} do
      configure_nextcloud()
      put_allowlist("nextcloud:ao:operator")
      stub_provider()

      conn = get(conn, "/auth/nextcloud/callback", %{"code" => "c", "state" => "whatever"})

      assert redirected_to(conn) == "/index.html?auth_error=invalid_state"
    end

    test "別 provider 用の state は流用できない", %{conn: conn} do
      configure_nextcloud()
      Application.put_env(:kaoiro_server, :oauth_github_client_id, "gh-id")
      Application.put_env(:kaoiro_server, :oauth_github_client_secret, "gh-secret")
      put_allowlist("nextcloud:ao:operator")
      stub_provider()

      conn = start_flow(conn)
      %{params: %{state: state}} = get_session(conn, "oauth_session_params")

      conn = get(conn, "/auth/github/callback", %{"code" => "c", "state" => state})

      assert redirected_to(conn) == "/index.html?auth_error=invalid_state"
    end

    test "provider がエラーを返せば provider_error", %{conn: conn} do
      configure_nextcloud()
      put_allowlist("nextcloud:ao:operator")
      stub_provider()

      conn = start_flow(conn)
      %{params: %{state: state}} = get_session(conn, "oauth_session_params")

      conn =
        get(conn, "/auth/nextcloud/callback", %{
          "error" => "access_denied",
          "state" => state
        })

      assert redirected_to(conn) == "/index.html?auth_error=provider_error"
      assert get_session(conn, "oauth_identity") == nil
    end

    test "github も同じ経路で login を uid にする", %{conn: conn} do
      Application.put_env(:kaoiro_server, :oauth_github_client_id, "gh-id")
      Application.put_env(:kaoiro_server, :oauth_github_client_secret, "gh-secret")
      put_allowlist("github:ao:operator")

      # /user/emails は /user を含むので、先に並べた方が優先される。
      OAuthTestAdapter.install([
        {"/login/oauth/access_token", 200,
         %{"access_token" => @provider_token, "token_type" => "bearer"}},
        {"/user/emails", 200,
         [%{"email" => "ao@example.com", "primary" => true, "verified" => true}]},
        {"/user", 200, %{"id" => 42, "login" => "ao", "name" => "ao"}}
      ])

      conn = get(conn, "/auth/github")
      %{params: %{state: state}} = get_session(conn, "oauth_session_params")
      conn = get(conn, "/auth/github/callback", %{"code" => "auth-code", "state" => state})

      assert redirected_to(conn) == "/index.html"
      assert get_session(conn, "oauth_identity") == %{provider: "github", uid: "ao"}
      refute inspect(conn.resp_cookies) =~ @provider_token
    end

    test "token 交換が失敗すれば provider_error", %{conn: conn} do
      configure_nextcloud()
      put_allowlist("nextcloud:ao:operator")

      OAuthTestAdapter.install([
        {"/apps/oauth2/api/v1/token", 401, %{"error" => "invalid_client"}}
      ])

      conn = callback(conn)

      assert redirected_to(conn) == "/index.html?auth_error=provider_error"
      assert get_session(conn, "oauth_identity") == nil
    end
  end

  # Runs the whole flow: start it to mint the state, then hand that state
  # back on the callback the way the provider would.
  defp callback(conn) do
    conn = start_flow(conn)
    %{params: %{state: state}} = get_session(conn, "oauth_session_params")

    get(conn, "/auth/nextcloud/callback", %{"code" => "auth-code", "state" => state})
  end

  defp start_flow(conn), do: get(conn, "/auth/nextcloud")

  defp stub_provider do
    OAuthTestAdapter.install([
      {"/apps/oauth2/api/v1/token", 200,
       %{"access_token" => @provider_token, "token_type" => "bearer"}},
      {"/ocs/v2.php/cloud/user", 200,
       %{
         "ocs" => %{
           "meta" => %{"status" => "ok", "statuscode" => 200},
           "data" => %{"id" => "ao", "display-name" => "ao", "email" => "ao@example.com"}
         }
       }}
    ])
  end

  defp configure_nextcloud do
    Application.put_env(:kaoiro_server, :oauth_nextcloud_client_id, "nc-id")
    Application.put_env(:kaoiro_server, :oauth_nextcloud_client_secret, "nc-secret")
    Application.put_env(:kaoiro_server, :oauth_nextcloud_base_url, "https://cloud.test")
  end

  defp clear_env do
    Enum.each(@env_keys, &Application.delete_env(:kaoiro_server, &1))
    Application.delete_env(:kaoiro_server, :oauth_github_client_id)
    Application.delete_env(:kaoiro_server, :oauth_github_client_secret)
  end
end
