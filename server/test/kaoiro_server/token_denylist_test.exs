defmodule KaoiroServer.TokenDenylistTest do
  use ExUnit.Case, async: true

  import KaoiroServer.TestTeardown

  alias KaoiroServer.TokenDenylist

  setup do
    name = :"td_#{System.unique_integer([:positive])}"
    path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "#{name}.dets"])
    File.rm(path)
    {:ok, pid} = TokenDenylist.start_link(name: name, path: path)

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

  # M2 (ふじ #72 must-fix): fail-closed startup on store corruption.
  # Sibling stores auto-recreate empty on unreadable DETS files; here
  # that would silently drop every revoked agent_id and let it join
  # again. Test both (a) whole-file corruption and (b) malformed row.
  # In both cases start_link must return `{:error, ...}` (init fails),
  # and the DETS file must remain on disk for forensic inspection.
  test "corrupt file は fail-closed で start_link error 、file は forensic 用に保持" do
    name = :"td_corrupt_#{System.unique_integer([:positive])}"
    path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "#{name}.dets"])
    # Write non-DETS bytes so :dets.open_file rejects it.
    File.write!(path, "not a dets file")
    on_exit(fn -> File.rm(path) end)

    Process.flag(:trap_exit, true)

    assert {:error, {:token_denylist_open_failed, _reason, ^path}} =
             TokenDenylist.start_link(name: name, path: path)

    # forensic: file が silently 削除されていないこと。
    assert File.exists?(path)
    assert File.read!(path) == "not a dets file"
  end

  test "malformed row は fail-closed で load error に落ちる (silent drop 禁止)" do
    name = :"td_malformed_#{System.unique_integer([:positive])}"
    path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "#{name}.dets"])
    File.rm(path)

    # まず正常な DETS ファイルを作る (empty)。
    {:ok, pid} = TokenDenylist.start_link(name: name, path: path)
    GenServer.stop(pid)

    # DETS を再 open して schema drift を注入 (3-tuple、value shape 違反)。
    {:ok, ^name} = :dets.open_file(name, file: String.to_charlist(path))
    :ok = :dets.insert(name, {"corrupted", "should be", "2-tuple only"})
    :ok = :dets.close(name)

    on_exit(fn -> File.rm(path) end)
    Process.flag(:trap_exit, true)

    name2 = :"td_malformed_load_#{System.unique_integer([:positive])}"

    assert {:error, {:token_denylist_load_failed, _reason, ^path}} =
             TokenDenylist.start_link(name: name2, path: path)

    # forensic: 破損 row を含むファイルもそのまま残す。
    assert File.exists?(path)
  end
end
