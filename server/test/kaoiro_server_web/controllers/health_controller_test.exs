defmodule KaoiroServerWeb.HealthControllerTest do
  # async: false — mutates the :kaoiro_server, :build_revision app-env key
  # shared across the test suite.
  use KaoiroServerWeb.ConnCase, async: false

  setup do
    original = Application.get_env(:kaoiro_server, :build_revision)
    on_exit(fn -> restore_env(original) end)
    :ok
  end

  defp restore_env(nil), do: Application.delete_env(:kaoiro_server, :build_revision)
  defp restore_env(value), do: Application.put_env(:kaoiro_server, :build_revision, value)

  describe "GET /api/health" do
    test "status/protocol_version は常に返る", %{conn: conn} do
      conn = get(conn, "/api/health")

      assert %{"status" => "ok", "protocol_version" => "0"} = json_response(conn, 200)
    end

    # issue #228 (director's steer): unset を "unknown" 文字列へ fall back
    # させる — nil や欠落フィールドではなく、runner 側の build_revision
    # fallback 規約 (これも "unknown" 文字列) と揃える。
    test "build_revision 未設定なら unknown を返す", %{conn: conn} do
      Application.delete_env(:kaoiro_server, :build_revision)
      conn = get(conn, "/api/health")

      assert %{"build_revision" => "unknown"} = json_response(conn, 200)
    end

    test "build_revision 設定済みならその値をそのまま返す", %{conn: conn} do
      Application.put_env(
        :kaoiro_server,
        :build_revision,
        "0123456789abcdef0123456789abcdef01234567"
      )

      conn = get(conn, "/api/health")

      assert %{"build_revision" => "0123456789abcdef0123456789abcdef01234567"} =
               json_response(conn, 200)
    end
  end
end
