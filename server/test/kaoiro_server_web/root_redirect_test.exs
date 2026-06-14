defmodule KaoiroServerWeb.RootRedirectTest do
  use KaoiroServerWeb.ConnCase, async: true

  test "GET / は静的ダッシュボードへリダイレクトする", %{conn: conn} do
    conn = get(conn, "/")
    assert redirected_to(conn, 302) == "/index.html"
  end

  test "クエリ文字列を保持する (?token= が消えない)", %{conn: conn} do
    conn = get(conn, "/?token=abc123")
    assert redirected_to(conn, 302) == "/index.html?token=abc123"
  end
end
