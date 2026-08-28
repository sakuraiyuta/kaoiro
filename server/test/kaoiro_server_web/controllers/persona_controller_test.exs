defmodule KaoiroServerWeb.PersonaControllerTest do
  # async: false — reads the :persistent_term cache that
  # PersonaAssetsTest mutates; async tests run concurrently with
  # async: false ones, so this must serialize with it.
  use KaoiroServerWeb.ConnCase, async: false

  describe "GET /api/personas" do
    test "マニフェスト JSON を返す", %{conn: conn} do
      conn = get(conn, "/api/personas")

      assert %{"version" => version, "personas" => personas} =
               json_response(conn, 200)

      assert version =~ ~r/^[0-9a-f]{16}$/
      assert Map.keys(personas) |> Enum.sort() == ~w(ao fuji kohaku kuroe momo)

      assert %{"url" => "/personas/ao/idle.png?v=" <> _, "hash" => _} =
               personas["ao"]["states"]["idle"]

      # Pack schema additions (persona-pack-schema.md): name /
      # pack_version / description transcribed from manifest.json.
      assert personas["ao"]["name"] == "あお"

      for id <- ~w(ao fuji kuroe momo) do
        assert personas[id]["pack_version"] == "1.0.2"
      end

      assert personas["kohaku"]["name"] == "こはく"
      # Bumped to 1.1.1 by commit ada4357 (#276, 2026-08-21, persona pack
      # zip re-generation); this expectation was not updated with it and
      # has been failing on develop since.
      assert personas["kohaku"]["pack_version"] == "1.1.1"
    end
  end

  # issue #232 MF-1: personality.md is a system prompt that may carry
  # proprietary operating instructions for a custom pack (director
  # decision) — operator/admin only, viewer disclosure deferred to a
  # separate future decision (ADR-0021 fail-closed default). The 4 auth
  # paths below (anonymous / viewer / operator+admin / revoked) pin that
  # boundary directly; ふじ's round-1 negative probe demonstrated the
  # pre-fix endpoint returning 200 to an anonymous request.
  describe "GET /api/personas/:id (issue #232, operator/admin 限定)" do
    setup do
      original = Application.get_env(:kaoiro_server, :client_tokens)

      on_exit(fn ->
        if original do
          Application.put_env(:kaoiro_server, :client_tokens, original)
        else
          Application.delete_env(:kaoiro_server, :client_tokens)
        end
      end)

      :ok
    end

    test "operator は pack の全メタデータと personality.md 全文を得る", %{conn: conn} do
      Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator")

      conn =
        conn
        |> init_test_session(%{"client_token" => "tok-op"})
        |> get("/api/personas/fuji")

      assert %{
               "id" => "fuji",
               "name" => "ふじ",
               "sprite_set" => "fuji",
               "version" => "1.0.2",
               "license" => "CC0-1.0",
               "min_kaoiro_version" => "0.1.0",
               "states" => states,
               "description" => _,
               "author" => _,
               "personality" => personality
             } = json_response(conn, 200)

      assert is_list(states)
      assert is_binary(personality) and personality != ""
    end

    test "admin は 200 を得る", %{conn: conn} do
      Application.put_env(:kaoiro_server, :client_tokens, "tok-admin:admin")

      conn =
        conn
        |> init_test_session(%{"client_token" => "tok-admin"})
        |> get("/api/personas/fuji")

      assert conn.status == 200
    end

    test "viewer は 403", %{conn: conn} do
      Application.put_env(:kaoiro_server, :client_tokens, "tok-view:viewer")

      conn =
        conn
        |> init_test_session(%{"client_token" => "tok-view"})
        |> get("/api/personas/fuji")

      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end

    test "匿名 (session に credential 無し) は 401", %{conn: conn} do
      Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator")

      conn = conn |> init_test_session(%{}) |> get("/api/personas/fuji")

      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "失効した (client_tokens から外れた) token は 401", %{conn: conn} do
      Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator")

      conn =
        conn
        |> init_test_session(%{"client_token" => "revoked-token"})
        |> get("/api/personas/fuji")

      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "未知の id は operator でも 404", %{conn: conn} do
      Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator")

      conn =
        conn
        |> init_test_session(%{"client_token" => "tok-op"})
        |> get("/api/personas/nope")

      assert json_response(conn, 404) == %{"error" => "not_found"}
    end

    test "予約済み default は pack を持たないため operator でも 404", %{conn: conn} do
      Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator")

      conn =
        conn
        |> init_test_session(%{"client_token" => "tok-op"})
        |> get("/api/personas/default")

      assert json_response(conn, 404) == %{"error" => "not_found"}
    end
  end

  describe "GET /personas/:sprite_set/:file" do
    test "マニフェスト掲載のスプライトを PNG で返す", %{conn: conn} do
      conn = get(conn, "/personas/ao/idle.png")

      assert response(conn, 200)
      assert response_content_type(conn, :png) =~ "image/png"
      assert get_resp_header(conn, "cache-control") == ["no-cache"]
      # Compare against the served bytes via PersonaAssets so the check
      # follows the pack extraction cache rather than a filesystem path
      # that the ingest model no longer exposes directly.
      {:ok, %{path: path}} =
        KaoiroServer.PersonaAssets.fetch_file("ao", "idle.png")

      assert conn.resp_body == File.read!(path)
    end

    test "マニフェスト発行の v は不変キャッシュを許可する", %{conn: conn} do
      %{"personas" => personas} =
        get(conn, "/api/personas") |> json_response(200)

      url = personas["ao"]["states"]["idle"]["url"]
      conn = get(conn, url)

      assert response(conn, 200)

      assert get_resp_header(conn, "cache-control") ==
               ["public, max-age=31536000, immutable"]
    end

    test "不正な v は no-cache に落ちる", %{conn: conn} do
      conn = get(conn, "/personas/ao/idle.png?v=wronghash000")

      assert response(conn, 200)
      assert get_resp_header(conn, "cache-control") == ["no-cache"]
    end

    test "未知のファイルは 404", %{conn: conn} do
      conn = get(conn, "/personas/ao/nope.png")
      assert json_response(conn, 404) == %{"error" => "not_found"}
    end

    test "パストラバーサルは 404", %{conn: conn} do
      conn = get(conn, "/personas/..%2F..%2Fconfig/config.exs")
      assert conn.status == 404
    end
  end
end
