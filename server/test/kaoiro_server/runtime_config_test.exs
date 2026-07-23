defmodule KaoiroServer.RuntimeConfigTest do
  use ExUnit.Case, async: true

  @paths [
    clear_watermarks_path: "kaoiro_test_clear_watermarks_",
    session_starts_path: "kaoiro_test_session_starts_",
    ingress_order_path: "kaoiro_test_ingress_order_"
  ]

  test "test用のvisibility DETS pathはruntime configでnil上書きされない" do
    for {key, prefix} <- @paths do
      path = Application.fetch_env!(:kaoiro_server, key)

      assert is_binary(path)
      assert Path.basename(path) =~ prefix
      assert String.ends_with?(path, ".dets")
    end
  end
end
