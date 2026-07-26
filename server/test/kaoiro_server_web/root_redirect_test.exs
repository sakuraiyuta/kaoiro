defmodule KaoiroServerWeb.RootRedirectTest do
  # Mutates :client_tokens for the token-exchange path (ADR-0013).
  use KaoiroServerWeb.ConnCase, async: false

  setup do
    Application.delete_env(:kaoiro_server, :client_tokens)
    on_exit(fn -> Application.delete_env(:kaoiro_server, :client_tokens) end)
  end

  test "GET / は静的ダッシュボードへリダイレクトする", %{conn: conn} do
    conn = get(conn, "/")
    assert redirected_to(conn, 302) == "/index.html"
  end

  test "有効な ?token= は session に交換され URL から消える (ADR-0013)", %{conn: conn} do
    Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator")

    conn = get(conn, "/?token=tok-op")
    assert redirected_to(conn, 302) == "/index.html"
    assert get_session(conn, "client_token") == "tok-op"
  end

  test "不正な ?token= は session に入らず URL からも消える", %{conn: conn} do
    Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator")

    conn = get(conn, "/?token=wrong")
    assert redirected_to(conn, 302) == "/index.html"
    assert get_session(conn, "client_token") == nil
  end

  test "?token= は確立済みの OAuth identity を置き換えない (login CSRF 防止)", %{conn: conn} do
    # `/` は他サイトからも誘導できる素のナビゲーションで、SameSite=Lax でも
    # cookie は付く。ここで token を受け入れると、共有トークンを持つ相手が
    # OAuth ログイン済み operator の session を差し替えられる (ADR-0042)。
    Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator")
    identity = %{provider: "nextcloud", uid: "ao"}

    conn =
      conn
      |> init_test_session(%{"oauth_identity" => identity})
      |> get("/?token=tok-op")

    assert redirected_to(conn, 302) == "/index.html"
    assert get_session(conn, "client_token") == nil
    assert get_session(conn, "oauth_identity") == identity
  end
end
