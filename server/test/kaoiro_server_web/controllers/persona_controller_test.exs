defmodule KaoiroServerWeb.PersonaControllerTest do
  # async: false — reads the :persistent_term cache that
  # PersonaAssetsTest mutates; async tests run concurrently with
  # async: false ones, so this must serialize with it.
  use KaoiroServerWeb.ConnCase, async: false

  describe "GET /api/personas" do
    setup %{conn: conn} do
      previous = Application.get_env(:kaoiro_server, :client_tokens)
      Application.put_env(:kaoiro_server, :client_tokens, "persona-test:operator")

      on_exit(fn ->
        if previous,
          do: Application.put_env(:kaoiro_server, :client_tokens, previous),
          else: Application.delete_env(:kaoiro_server, :client_tokens)
      end)

      {:ok, conn: init_test_session(conn, %{"client_token" => "persona-test"})}
    end

    test "マニフェスト JSON を返す", %{conn: conn} do
      conn = get(conn, "/api/personas")

      assert %{"version" => version, "personas" => personas} =
               json_response(conn, 200)

      assert version =~ ~r/^[0-9a-f]{16}$/

      assert Map.keys(personas) |> Enum.sort() ==
               ~w(anzu ao fuji hiiro hisui kogane kohaku kuroe moegi momo shirogane)

      assert %{"url" => "/personas/ao/idle.png?v=" <> _, "hash" => _} =
               personas["ao"]["states"]["idle"]

      # Pack schema additions (persona-pack-schema.md): name /
      # pack_version / description transcribed from manifest.json.
      assert personas["ao"]["name"] == "あお"

      for id <- ~w(ao fuji kuroe momo) do
        assert personas[id]["pack_version"] == "1.0.2"
      end

      assert personas["kohaku"]["name"] == "こはく"
      # Bumped to 1.1.1 by commit ada4357 (#265, 2026-08-21, persona pack
      # zip re-generation); this expectation was not updated with it and
      # has been failing on develop since.
      assert personas["kohaku"]["pack_version"] == "1.1.1"
    end

    # issue 864: anzu must deliver all eight expressions, fatigued included.
    # Every expected value is computed from the bundled ZIP itself: each
    # sprite's sha256, the URL version (its first 12 hex digits), the manifest
    # description, and the first line of the composed prompt. Both negative
    # controls (fatigued declared but not shipped, or shipped but not
    # declared) must fail here.
    test "anzu は fatigued を含む 8 表現を、ZIP の値どおりの URL と hash で届ける", %{conn: conn} do
      zip = Path.join(:code.priv_dir(:kaoiro_server), "persona-packs/anzu-1.0.0.zip")
      {:ok, entries} = :zip.unzip(String.to_charlist(zip), [:memory])
      files = Map.new(entries, fn {name, bin} -> {List.to_string(name), bin} end)
      manifest = Jason.decode!(Map.fetch!(files, "manifest.json"))

      %{"personas" => personas} = get(conn, "/api/personas") |> json_response(200)
      anzu = personas["anzu"]

      assert anzu["name"] == "あんず"
      assert anzu["pack_version"] == "1.0.0"
      assert manifest["version"] == "1.0.0"
      assert anzu["description"] == manifest["description"]
      assert anzu["description"] == "依頼を配達として扱う、宛先に厳しい宅配の見習い型ペルソナ"

      states = ~w(idle thinking tool_running waiting_input waiting_permission done error fatigued)
      assert Map.keys(anzu["states"]) |> Enum.sort() == Enum.sort(states)

      for state <- states do
        bin = Map.fetch!(files, "sprites/#{state}.png")
        digest = :crypto.hash(:sha256, bin) |> Base.encode16(case: :lower)
        version = String.slice(digest, 0, 12)
        info = anzu["states"][state]

        assert info["hash"] == "sha256:" <> digest

        assert info["url"] in [
                 "/personas/anzu/#{state}.png?v=#{version}",
                 "/personas/anzu/#{state}.png?v=#{version}&auth=1"
               ]

        served = get(conn, info["url"])

        assert response(served, 200)
        assert served.resp_body == bin
      end

      [first_line | _] =
        KaoiroServer.PersonaAssets.prompt("anzu") |> String.split("\n", parts: 2)

      assert first_line == "あなたは kaoiro のペルソナ「あんず」(persona.id = `anzu`) として応答する。"

      detail = get(conn, "/api/personas/anzu") |> json_response(200)
      assert detail["name"] == "あんず"
      assert detail["description"] == manifest["description"]
      assert detail["personality"] =~ "あたし"
      assert detail["personality"] =~ "依頼主さん"
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

    # issue #232 MF-1 round-2 must-fix (MF-R2-3, ふじ指摘): the previous
    # "失効した token" test above only proved a token NEVER in
    # `:client_tokens` gets 401 — that is the same shape as the
    # "匿名" test just above it (an unknown credential), not a proof
    # that `RequireOperatorPlug` re-validates on every request. This
    # reuses the SAME session (the SAME `conn`, carrying the SAME
    # cookie-derived credential) across two requests: 200 while the
    # token is still configured, then 401 after it is removed from
    # `:client_tokens` — without a new session, a new token, or any
    # other change than the config revoke itself.
    test "同じ session credential でも config から revoke されれば次 request で 401 (live revalidate)",
         %{conn: conn} do
      Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator")
      session_conn = init_test_session(conn, %{"client_token" => "tok-op"})

      first = get(session_conn, "/api/personas/fuji")
      assert first.status == 200

      Application.put_env(:kaoiro_server, :client_tokens, "")

      second = get(session_conn, "/api/personas/fuji")
      assert json_response(second, 401) == %{"error" => "unauthorized"}
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
    setup %{conn: conn} do
      previous = Application.get_env(:kaoiro_server, :client_tokens)
      Application.put_env(:kaoiro_server, :client_tokens, "persona-test:operator")

      on_exit(fn ->
        if previous,
          do: Application.put_env(:kaoiro_server, :client_tokens, previous),
          else: Application.delete_env(:kaoiro_server, :client_tokens)
      end)

      {:ok, conn: init_test_session(conn, %{"client_token" => "persona-test"})}
    end

    test "マニフェスト掲載のスプライトを PNG で返す", %{conn: conn} do
      conn = get(conn, "/personas/ao/idle.png")

      assert response(conn, 200)
      assert response_content_type(conn, :png) =~ "image/png"
      assert get_resp_header(conn, "cache-control") == ["private, no-store"]
      # Compare against the served bytes via PersonaAssets so the check
      # follows the pack extraction cache rather than a filesystem path
      # that the ingest model no longer exposes directly.
      {:ok, %{path: path}} =
        KaoiroServer.PersonaAssets.fetch_file("ao", "idle.png")

      assert conn.resp_body == File.read!(path)
    end

    test "manifest URLs remain private and non-storable", %{conn: conn} do
      %{"personas" => personas} =
        get(conn, "/api/personas") |> json_response(200)

      url = personas["ao"]["states"]["idle"]["url"]
      conn = get(conn, url)

      assert response(conn, 200)

      assert get_resp_header(conn, "cache-control") ==
               ["private, no-store"]
    end

    test "unrecognized versions remain private and non-storable", %{conn: conn} do
      conn = get(conn, "/personas/ao/idle.png?v=wronghash000")

      assert response(conn, 200)
      assert get_resp_header(conn, "cache-control") == ["private, no-store"]
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
