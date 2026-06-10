defmodule KaoiroServerWeb.RootRedirectTest do
  use KaoiroServerWeb.ConnCase, async: true

  test "GET / は静的ダッシュボードへリダイレクトする", %{conn: conn} do
    conn = get(conn, "/")
    assert redirected_to(conn, 302) == "/index.html"
  end
end
