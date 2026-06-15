defmodule KaoiroServerWeb.SessionControllerTest do
  # Mutates :client_tokens; init_test_session seeds the session (ADR-0013).
  use KaoiroServerWeb.ConnCase, async: false

  setup do
    Application.delete_env(:kaoiro_server, :client_tokens)
    on_exit(fn -> Application.delete_env(:kaoiro_server, :client_tokens) end)
  end

  test "create: 有効な token(body)を session に交換する (204)", %{conn: conn} do
    Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator")

    conn = post(conn, "/session/new", %{token: "tok-op"})

    assert conn.status == 204
    assert get_session(conn, "client_token") == "tok-op"
  end

  test "create: 不正な token は 401 で session に入らない", %{conn: conn} do
    Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator")

    conn = post(conn, "/session/new", %{token: "wrong"})

    assert conn.status == 401
    assert get_session(conn, "client_token") == nil
  end

  test "create: token 無しは 400", %{conn: conn} do
    conn = post(conn, "/session/new", %{})
    assert conn.status == 400
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
             Phoenix.Token.verify(KaoiroServerWeb.Endpoint, "client_ws", ticket, max_age: 30)
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

  test "失効した token は 401 で session が破棄される", %{conn: conn} do
    Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator")

    conn =
      conn
      |> init_test_session(%{"client_token" => "revoked"})
      |> get("/session/refresh")

    assert conn.status == 401
    assert get_session(conn, "client_token") == nil
  end
end
