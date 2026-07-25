defmodule KaoiroServer.RuntimeConfigTest do
  use ExUnit.Case, async: true

  # issue #120 横断: 全 DETS path 系 config が (a) test.exs で per-run 名で
  # 設定され、(b) runtime.exs の env 上書きで nil に潰されないこと。
  # 元々検証されていた visibility 3 key に加え、issue #120 で「env 存在時のみ
  # 上書き」に統一した session_pointers / agent_directory / permission_modes /
  # inter_agent_history を追加。
  @paths [
    clear_watermarks_path: "kaoiro_test_clear_watermarks_",
    session_starts_path: "kaoiro_test_session_starts_",
    ingress_order_path: "kaoiro_test_ingress_order_",
    session_pointers_path: "kaoiro_test_session_pointers_",
    agent_directory_path: "kaoiro_test_agent_directory_",
    permission_modes_path: "kaoiro_test_permission_modes_",
    inter_agent_history_path: "kaoiro_test_inter_agent_history_"
  ]

  test "test用のDETS pathはruntime configでnil上書きされない" do
    for {key, prefix} <- @paths do
      path = Application.fetch_env!(:kaoiro_server, key)

      assert is_binary(path)
      assert Path.basename(path) =~ prefix
      assert String.ends_with?(path, ".dets")
    end
  end
end
