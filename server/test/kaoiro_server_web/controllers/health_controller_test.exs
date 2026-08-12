defmodule KaoiroServerWeb.HealthControllerTest do
  # async: false — mutates process-wide env vars (RELEASE_ROOT and, in the
  # MF-1 pin below, KAOIRO_BUILD_REVISION) shared across the OS process,
  # not per-test isolated.
  use KaoiroServerWeb.ConnCase, async: false

  setup do
    original_release_root = System.get_env("RELEASE_ROOT")
    original_stray_env = System.get_env("KAOIRO_BUILD_REVISION")

    on_exit(fn ->
      restore_env("RELEASE_ROOT", original_release_root)
      restore_env("KAOIRO_BUILD_REVISION", original_stray_env)
    end)

    :ok
  end

  defp restore_env(key, nil), do: System.delete_env(key)
  defp restore_env(key, value), do: System.put_env(key, value)

  defp tmp_release_root! do
    dir =
      Path.join(
        System.tmp_dir!(),
        "kaoiro-health-test-#{System.unique_integer([:positive])}"
      )

    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf!(dir) end)
    dir
  end

  defp write_build_info!(dir, content) do
    File.write!(Path.join(dir, "build-info.json"), content)
  end

  describe "GET /api/health" do
    test "status/protocol_version は常に返る", %{conn: conn} do
      System.delete_env("RELEASE_ROOT")
      conn = get(conn, "/api/health")

      assert %{"status" => "ok", "protocol_version" => "0"} = json_response(conn, 200)
    end

    # issue #228 (director's steer): RELEASE_ROOT 未設定 (bare
    # `mix phx.server` dev — Mix release の生成する bin/server ランチャの
    # みが export する) を "unknown"/false へ fall back させる — runner 側
    # の build_revision fallback 規約 (これも "unknown") と揃える。
    test "RELEASE_ROOT 未設定 (bare mix phx.server 相当) なら unknown/false を返す", %{
      conn: conn
    } do
      System.delete_env("RELEASE_ROOT")
      conn = get(conn, "/api/health")

      assert %{"build_revision" => "unknown", "build_dirty" => false} = json_response(conn, 200)
    end

    test "build-info.json が焼き込まれていればその値を返す", %{conn: conn} do
      dir = tmp_release_root!()

      write_build_info!(
        dir,
        ~s({"revision":"0123456789abcdef0123456789abcdef01234567","dirty":true})
      )

      System.put_env("RELEASE_ROOT", dir)
      conn = get(conn, "/api/health")

      assert %{
               "build_revision" => "0123456789abcdef0123456789abcdef01234567",
               "build_dirty" => true
             } = json_response(conn, 200)
    end

    # issue #228 round 2 MF-1 (ふじ 差し戻し): round 1 read
    # System.get_env("KAOIRO_BUILD_REVISION") directly, which a
    # `docker run -e` or docker-compose's `env_file: .env` could override
    # at container-RUN time — the exact "identity that can drift from the
    # running artifact" failure ADR-0053 already rejected for the runner
    # (a live `git rev-parse` at startup), just moved to env-at-runtime for
    # the server. This is the literal regression pin: a runtime env var
    # with a DIFFERENT value present must NOT change what /api/health
    # reports — only the build-time-baked file may.
    test "runtime env KAOIRO_BUILD_REVISION を設定しても file の値を上書きできない", %{
      conn: conn
    } do
      dir = tmp_release_root!()

      write_build_info!(
        dir,
        ~s({"revision":"0123456789abcdef0123456789abcdef01234567","dirty":false})
      )

      System.put_env("RELEASE_ROOT", dir)
      System.put_env("KAOIRO_BUILD_REVISION", "1111111111111111111111111111111111111111")
      conn = get(conn, "/api/health")

      assert %{"build_revision" => "0123456789abcdef0123456789abcdef01234567"} =
               json_response(conn, 200)
    end

    test "build-info.json が RELEASE_ROOT 配下に存在しなければ unknown/false", %{conn: conn} do
      dir = tmp_release_root!()
      System.put_env("RELEASE_ROOT", dir)
      conn = get(conn, "/api/health")

      assert %{"build_revision" => "unknown", "build_dirty" => false} = json_response(conn, 200)
    end

    test "壊れた JSON も unknown/false へ fail-soft する", %{conn: conn} do
      dir = tmp_release_root!()
      write_build_info!(dir, "{ not json")
      System.put_env("RELEASE_ROOT", dir)
      conn = get(conn, "/api/health")

      assert %{"build_revision" => "unknown", "build_dirty" => false} = json_response(conn, 200)
    end

    # issue #228 round 2 MF-3 (ふじ 差し戻し): 値域外の revision (40 桁 hex
    # でも "unknown" でもない) は型が string でも unknown へ degrade する。
    test "revision が値域外なら unknown/false へ fail-soft する", %{conn: conn} do
      dir = tmp_release_root!()
      write_build_info!(dir, ~s({"revision":"not-a-real-sha","dirty":false}))
      System.put_env("RELEASE_ROOT", dir)
      conn = get(conn, "/api/health")

      assert %{"build_revision" => "unknown", "build_dirty" => false} = json_response(conn, 200)
    end

    test "dirty が boolean でなければ unknown/false へ fail-soft する", %{conn: conn} do
      dir = tmp_release_root!()

      write_build_info!(
        dir,
        ~s({"revision":"0123456789abcdef0123456789abcdef01234567","dirty":"yes"})
      )

      System.put_env("RELEASE_ROOT", dir)
      conn = get(conn, "/api/health")

      assert %{"build_revision" => "unknown", "build_dirty" => false} = json_response(conn, 200)
    end
  end
end
