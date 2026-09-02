defmodule KaoiroServer.PermissionModesTest do
  use ExUnit.Case, async: true

  import KaoiroServer.TestTeardown

  alias KaoiroServer.PermissionModes

  setup do
    # Isolated DETS file + table name per test so cases don't share state.
    name = :"pm_#{System.unique_integer([:positive])}"
    path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "#{name}.dets"])
    File.rm(path)
    {:ok, pid} = PermissionModes.start_link(name: name, path: path)

    on_exit(fn ->
      # #169 / #171: ExUnit のリンク死と stop が競合して teardown だけが
      # 落ちる。良性の exit だけ吸収する (KaoiroServer.TestTeardown)。
      stop_quietly(pid)

      File.rm(path)
    end)

    %{server: name, path: path}
  end

  defp wait_until(predicate, attempts \\ 50) do
    cond do
      predicate.() -> :ok
      attempts <= 0 -> :timeout
      true -> Process.sleep(5) && wait_until(predicate, attempts - 1)
    end
  end

  test "record してから get するとモードが返る", %{server: server} do
    PermissionModes.record("a.1", "plan", server)
    :ok = wait_until(fn -> PermissionModes.get("a.1", server) == "plan" end)
    assert PermissionModes.get("a.1", server) == "plan"
  end

  test "未知 agent は nil", %{server: server} do
    assert PermissionModes.get("a.none", server) == nil
  end

  test "再 record で最新の pick が勝つ", %{server: server} do
    PermissionModes.record("a.2", "default", server)
    PermissionModes.record("a.2", "acceptEdits", server)
    :ok = wait_until(fn -> PermissionModes.get("a.2", server) == "acceptEdits" end)
    assert PermissionModes.get("a.2", server) == "acceptEdits"
  end

  test "同一 DETS ファイルからの再起動で値が残る", %{server: server, path: path} do
    PermissionModes.record("a.3", "auto", server)
    :ok = wait_until(fn -> PermissionModes.get("a.3", server) == "auto" end)
    :ok = GenServer.stop(server)

    name2 = :"pm_restart_#{System.unique_integer([:positive])}"
    {:ok, _pid} = PermissionModes.start_link(name: name2, path: path)
    assert PermissionModes.get("a.3", name2) == "auto"
    GenServer.stop(name2)
  end

  test "all は全モード辞書を返す", %{server: server} do
    PermissionModes.record("a.4", "plan", server)
    PermissionModes.record("a.5", "auto", server)
    :ok = wait_until(fn -> PermissionModes.get("a.5", server) == "auto" end)
    all = PermissionModes.all(server)
    assert all["a.4"] == "plan"
    assert all["a.5"] == "auto"
  end

  test "delete でモードが消え、再起動後も残らない", %{server: server, path: path} do
    PermissionModes.record("a.6", "plan", server)
    :ok = wait_until(fn -> PermissionModes.get("a.6", server) == "plan" end)

    assert PermissionModes.delete("a.6", server) == :ok
    assert PermissionModes.get("a.6", server) == nil

    :ok = GenServer.stop(server)
    name2 = :"pm_delete_#{System.unique_integer([:positive])}"
    {:ok, _pid} = PermissionModes.start_link(name: name2, path: path)
    assert PermissionModes.get("a.6", name2) == nil
    GenServer.stop(name2)
  end

  test "delete は未知 agent でも :ok (冪等)", %{server: server} do
    assert PermissionModes.delete("a.none", server) == :ok
  end
end
