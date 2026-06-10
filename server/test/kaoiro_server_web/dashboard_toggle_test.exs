defmodule KaoiroServerWeb.DashboardToggleTest do
  use KaoiroServerWeb.ConnCase, async: false

  setup do
    original = Application.get_env(:kaoiro_server, :serve_dashboard, true)
    on_exit(fn -> Application.put_env(:kaoiro_server, :serve_dashboard, original) end)
    :ok
  end

  test "serve_dashboard が false のとき / は 404 を返す", %{conn: conn} do
    Application.put_env(:kaoiro_server, :serve_dashboard, false)

    conn = get(conn, "/")
    assert response(conn, 404) =~ "dashboard disabled"
  end

  test "serve_dashboard が false でも favicon は配信される", %{conn: conn} do
    Application.put_env(:kaoiro_server, :serve_dashboard, false)

    conn = get(conn, "/favicon.ico")
    assert conn.status == 200
  end

  test "DashboardStatic がトグルで配信を遮断する", %{conn: conn} do
    # Build output is gitignored, so plant a fixture under the gated path.
    fixture = Path.join([:code.priv_dir(:kaoiro_server), "static", "assets", "__gate_test__.txt"])
    File.mkdir_p!(Path.dirname(fixture))
    File.write!(fixture, "gate")
    on_exit(fn -> File.rm(fixture) end)

    assert get(conn, "/assets/__gate_test__.txt").status == 200

    Application.put_env(:kaoiro_server, :serve_dashboard, false)

    # NoRouteError is rendered as 404 by the endpoint's render_errors.
    assert get(build_conn(), "/assets/__gate_test__.txt").status == 404
  end
end
