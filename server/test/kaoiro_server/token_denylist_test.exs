defmodule KaoiroServer.TokenDenylistTest do
  use ExUnit.Case, async: true

  alias KaoiroServer.TokenDenylist

  setup do
    name = :"td_#{System.unique_integer([:positive])}"
    path = Path.join(System.tmp_dir!(), "#{name}.dets")
    File.rm(path)
    {:ok, pid} = TokenDenylist.start_link(name: name, path: path)

    on_exit(fn ->
      if Process.alive?(pid), do: GenServer.stop(pid)
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

  test "revoke してから revoked? が true を返す", %{server: server} do
    TokenDenylist.revoke("a.1", "2026-07-23T15:00:00Z", server)
    :ok = wait_until(fn -> TokenDenylist.revoked?("a.1", server) end)
    assert TokenDenylist.revoked?("a.1", server) == true
  end

  test "未 revoke agent は false", %{server: server} do
    assert TokenDenylist.revoked?("a.none", server) == false
  end

  test "revoke は ts なしでも成立 (delete_agent 経路の即席呼び出し)", %{server: server} do
    TokenDenylist.revoke("a.2", nil, server)
    :ok = wait_until(fn -> TokenDenylist.revoked?("a.2", server) end)
    assert TokenDenylist.revoked?("a.2", server) == true
    # all() の value は nil (audit ts なし)。
    _ = TokenDenylist.all(server)
    assert Map.get(TokenDenylist.all(server), "a.2") == nil
  end

  test "同一 DETS ファイルからの再起動で revoked 状態が残る (fail-closed)",
       %{server: server, path: path} do
    TokenDenylist.revoke("a.3", "2026-07-23T15:00:00Z", server)
    :ok = wait_until(fn -> TokenDenylist.revoked?("a.3", server) end)
    :ok = GenServer.stop(server)

    name2 = :"td_restart_#{System.unique_integer([:positive])}"
    {:ok, _pid} = TokenDenylist.start_link(name: name2, path: path)
    assert TokenDenylist.revoked?("a.3", name2) == true
    GenServer.stop(name2)
  end

  test "all は agent_id => audit_ts の全マップを返す", %{server: server} do
    TokenDenylist.revoke("a.4", "2026-07-23T15:00:00Z", server)
    TokenDenylist.revoke("a.5", "2026-07-23T15:01:00Z", server)
    :ok = wait_until(fn -> TokenDenylist.revoked?("a.5", server) end)
    all = TokenDenylist.all(server)
    assert all["a.4"] == "2026-07-23T15:00:00Z"
    assert all["a.5"] == "2026-07-23T15:01:00Z"
  end

  test "restore で revoked が解け、再起動後も残らない", %{server: server, path: path} do
    TokenDenylist.revoke("a.6", "2026-07-23T15:00:00Z", server)
    :ok = wait_until(fn -> TokenDenylist.revoked?("a.6", server) end)

    assert TokenDenylist.restore("a.6", server) == :ok
    assert TokenDenylist.revoked?("a.6", server) == false

    :ok = GenServer.stop(server)
    name2 = :"td_restore_#{System.unique_integer([:positive])}"
    {:ok, _pid} = TokenDenylist.start_link(name: name2, path: path)
    assert TokenDenylist.revoked?("a.6", name2) == false
    GenServer.stop(name2)
  end

  test "restore は未 revoke agent でも :ok (冪等)", %{server: server} do
    assert TokenDenylist.restore("a.none", server) == :ok
  end
end
