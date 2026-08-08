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
        assert personas[id]["pack_version"] == "1.0.1"
      end

      assert personas["kohaku"]["name"] == "こはく"
      assert personas["kohaku"]["pack_version"] == "1.0.0"
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
