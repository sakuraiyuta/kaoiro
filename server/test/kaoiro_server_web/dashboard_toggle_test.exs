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

  test "serve_dashboard が false でも robots.txt は配信される", %{conn: conn} do
    Application.put_env(:kaoiro_server, :serve_dashboard, false)

    conn = get(conn, "/robots.txt")
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

  test "manifest.webmanifest が DashboardStatic 経由で配信され、トグルで遮断される", %{conn: conn} do
    fixture = Path.join([:code.priv_dir(:kaoiro_server), "static", "manifest.webmanifest"])
    prior_content = if File.exists?(fixture), do: File.read!(fixture), else: nil

    File.write!(fixture, "{\"name\": \"kaoiro\"}")

    on_exit(fn ->
      if prior_content != nil do
        File.write!(fixture, prior_content)
      else
        File.rm(fixture)
      end
    end)

    assert get(conn, "/manifest.webmanifest").status == 200

    Application.put_env(:kaoiro_server, :serve_dashboard, false)
    assert get(build_conn(), "/manifest.webmanifest").status == 404
  end

  test "icons ディレクトリが DashboardStatic 経由で配信され、トグルで遮断される", %{conn: conn} do
    fixture = Path.join([:code.priv_dir(:kaoiro_server), "static", "icons", "__gate_icon__.png"])
    File.mkdir_p!(Path.dirname(fixture))
    File.write!(fixture, "icon-png-data")
    on_exit(fn -> File.rm(fixture) end)

    assert get(conn, "/icons/__gate_icon__.png").status == 200

    Application.put_env(:kaoiro_server, :serve_dashboard, false)
    assert get(build_conn(), "/icons/__gate_icon__.png").status == 404
  end

  test "notification worker is gated and served with browser security headers", %{conn: conn} do
    fixture =
      Path.join([:code.priv_dir(:kaoiro_server), "static", "notification-worker", "sw.js"])

    prior = if File.exists?(fixture), do: File.read!(fixture), else: nil
    File.mkdir_p!(Path.dirname(fixture))
    File.write!(fixture, "")

    on_exit(fn ->
      if prior != nil, do: File.write!(fixture, prior), else: File.rm(fixture)
    end)

    response = get(conn, "/notification-worker/sw.js")
    assert response.status == 200
    assert response.resp_body == ""
    assert get_resp_header(response, "content-type") |> hd() =~ "javascript"
    assert get_resp_header(response, "x-content-type-options") == ["nosniff"]
    assert get_resp_header(response, "cache-control") == ["no-cache"]
    assert [_] = get_resp_header(response, "etag")
    assert get_resp_header(response, "content-security-policy") |> hd() =~ "script-src 'self'"

    Application.put_env(:kaoiro_server, :serve_dashboard, false)
    assert get(build_conn(), "/notification-worker/sw.js").status == 404
  end

  @immutable "public, max-age=31536000, immutable"

  test "found static files retain their cache policy across methods, queries and dashboard gating" do
    for {path, policy, dashboard?} <- [
          {"/assets/__cache_test__.js", @immutable, true},
          {"/assets/__cache_test__.css", @immutable, true},
          {"/assets/__cache_test__.wav", @immutable, true},
          {"/index.html", "no-cache", true},
          {"/notification-worker/sw.js", "no-cache", true},
          {"/icons/__cache_test__.png", "public", true},
          {"/manifest.webmanifest", "public", true},
          {"/favicon.ico", "public", false},
          {"/robots.txt", "public", false}
        ] do
      file = Path.join(:code.priv_dir(:kaoiro_server), "static" <> path)
      body = if dashboard?, do: "cache fixture", else: File.read!(file)
      if dashboard?, do: fixture(path, body)

      for query <- ["", "?ordinary=1", "?vsn=123"] do
        url = path <> query
        expected = if query == "?vsn=123" and policy == "public", do: @immutable, else: policy
        conn = get(build_conn(), url)
        assert response(conn, 200) == body
        assert get_resp_header(conn, "cache-control") == [expected]
        assert get_resp_header(conn, "vary") == ["Accept-Encoding"]
        head = head(build_conn(), url)
        assert head.status == 200
        assert get_resp_header(head, "cache-control") == [expected]

        if query == "?vsn=123" do
          assert get_resp_header(conn, "etag") == []
        else
          assert [etag] = get_resp_header(conn, "etag")
          cached = build_conn() |> put_req_header("if-none-match", etag) |> get(url)
          assert response(cached, 304) == ""
          assert get_resp_header(cached, "cache-control") == [expected]
          assert get_resp_header(cached, "etag") == [etag]
          assert get_resp_header(cached, "vary") == ["Accept-Encoding"]
        end

        Application.put_env(:kaoiro_server, :serve_dashboard, false)
        disabled = get(build_conn(), url)
        assert disabled.status == if(dashboard?, do: 404, else: 200)

        assert get_resp_header(disabled, "cache-control") ==
                 if(dashboard?, do: ["max-age=0, private, must-revalidate"], else: [expected])

        Application.put_env(:kaoiro_server, :serve_dashboard, true)
      end
    end
  end

  test "document redirects and query variants reach the revalidated index" do
    fixture("/index.html", "document")
    root = get(build_conn(), "/")
    assert redirected_to(root) == "/index.html"

    for path <- [redirected_to(root), "/index.html?device=1", "/index.html?auth_error=denied"] do
      conn = get(build_conn(), path)
      assert response(conn, 200) == "document"
      assert get_resp_header(conn, "cache-control") == ["no-cache"]
    end

    for path <- ["/missing-spa-route", "/assets/__missing_cache_asset__.js"] do
      conn = get(build_conn(), path)
      assert conn.status == 404
      assert get_resp_header(conn, "cache-control") == ["max-age=0, private, must-revalidate"]
    end

    baseline = get(build_conn(), "/api/health")
    Application.put_env(:kaoiro_server, :serve_dashboard, false)
    disabled = get(build_conn(), "/api/health")
    assert disabled.status == baseline.status

    assert get_resp_header(disabled, "cache-control") ==
             get_resp_header(baseline, "cache-control")
  end

  test "changed index content and mtime invalidate the previous ETag" do
    file = fixture("/index.html", "old bundle")
    before = get(build_conn(), "/index.html")
    assert [etag] = get_resp_header(before, "etag")
    modified = File.stat!(file, time: :posix).mtime
    File.write!(file, "new bundle")
    File.touch!(file, modified + 1)
    after_update = build_conn() |> put_req_header("if-none-match", etag) |> get("/index.html")
    assert response(after_update, 200) == "new bundle"
    assert get_resp_header(after_update, "cache-control") == ["no-cache"]
    refute get_resp_header(after_update, "etag") == [etag]
  end

  defp fixture(path, body) do
    file = Path.join([:code.priv_dir(:kaoiro_server), "static", String.trim_leading(path, "/")])
    prior = if File.exists?(file), do: {File.read!(file), File.stat!(file).mtime}
    File.mkdir_p!(Path.dirname(file))
    File.write!(file, body)

    on_exit(fn ->
      case prior do
        {content, mtime} ->
          File.write!(file, content)
          File.touch!(file, mtime)

        nil ->
          File.rm(file)
      end
    end)

    file
  end

  @tag :dashboard_build
  test "fresh dashboard build serves the empty notification worker", %{conn: conn} do
    response = get(conn, "/notification-worker/sw.js")
    assert response.status == 200
    assert response.resp_body == ""
    assert get_resp_header(response, "cache-control") == ["no-cache"]
  end

  @tag :dashboard_build
  test "fresh dashboard build の hashed asset を endpoint 経由で配信する", %{conn: conn} do
    static_root = Path.join(:code.priv_dir(:kaoiro_server), "static")
    index = File.read!(Path.join(static_root, "index.html"))
    assert get_resp_header(get(build_conn(), "/index.html"), "cache-control") == ["no-cache"]

    asset_path =
      Regex.run(~r/(?:src|href)="(\/assets\/[^\"]+-[A-Za-z0-9_-]{8,}\.(?:js|css))"/, index,
        capture: :all_but_first
      )
      |> List.first()

    assert asset_path
    expected = File.read!(Path.join(static_root, String.replace_prefix(asset_path, "/", "")))

    response = get(conn, asset_path)
    assert response.status == 200
    assert response.resp_body == expected
    assert get_resp_header(response, "cache-control") == [@immutable]
  end
end
