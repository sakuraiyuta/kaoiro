defmodule KaoiroServer.AgentDirectoryTest do
  use ExUnit.Case, async: true

  alias KaoiroServer.AgentDirectory

  setup do
    # Isolated DETS file + table name per test so cases don't share state.
    name = :"ad_#{System.unique_integer([:positive])}"
    path = Path.join(System.tmp_dir!(), "#{name}.dets")
    File.rm(path)
    {:ok, pid} = AgentDirectory.start_link(name: name, path: path)

    on_exit(fn ->
      if Process.alive?(pid), do: GenServer.stop(pid)
      File.rm(path)
    end)

    %{server: name, path: path}
  end

  defp persona(id, name \\ nil) do
    %{"id" => id, "name" => name || id, "sprite_set" => id}
  end

  test "record してから get すると persona が返る (last_seen は nil)", %{server: server} do
    AgentDirectory.record("a.1", persona("ao"), server)
    assert AgentDirectory.get("a.1", server) == %{persona: persona("ao"), last_seen: nil}
  end

  test "未知 agent は nil", %{server: server} do
    assert AgentDirectory.get("a.none", server) == nil
  end

  test "再 record で最新 persona が勝つ", %{server: server} do
    AgentDirectory.record("a.2", persona("ao", "青"), server)
    AgentDirectory.record("a.2", persona("ao", "青(改)"), server)

    assert %{persona: %{"name" => "青(改)"}} = AgentDirectory.get("a.2", server)
  end

  test "touch で last_seen が更新される", %{server: server} do
    AgentDirectory.record("a.3", persona("ao"), server)
    assert %{last_seen: nil} = AgentDirectory.get("a.3", server)

    AgentDirectory.touch("a.3", server)
    # cast の完了を確認するため call を挟む
    _ = AgentDirectory.all(server)
    entry = AgentDirectory.get("a.3", server)
    assert is_integer(entry.last_seen)
  end

  test "touch は persona 未 record の agent を作らない", %{server: server} do
    AgentDirectory.touch("a.ghost", server)
    _ = AgentDirectory.all(server)
    assert AgentDirectory.get("a.ghost", server) == nil
  end

  test "同一 DETS ファイルからの再起動で persona が残る (last_seen は nil に戻る)", %{
    server: server,
    path: path
  } do
    AgentDirectory.record("a.4", persona("kuroe"), server)
    AgentDirectory.touch("a.4", server)
    _ = AgentDirectory.all(server)
    :ok = GenServer.stop(server)

    name2 = :"ad_restart_#{System.unique_integer([:positive])}"
    {:ok, _pid} = AgentDirectory.start_link(name: name2, path: path)

    # persona は復元、last_seen はプロセス再起動でリセット (memory-only)
    assert AgentDirectory.get("a.4", name2) == %{persona: persona("kuroe"), last_seen: nil}
    GenServer.stop(name2)
  end

  test "all は全 entry を返す", %{server: server} do
    AgentDirectory.record("a.5", persona("ao"), server)
    AgentDirectory.record("a.6", persona("momo"), server)
    all = AgentDirectory.all(server)
    assert all["a.5"] == %{persona: persona("ao"), last_seen: nil}
    assert all["a.6"] == %{persona: persona("momo"), last_seen: nil}
  end

  test "delete で entry が消え、再起動後も残らない", %{server: server, path: path} do
    AgentDirectory.record("a.7", persona("ao"), server)
    assert %{persona: _} = AgentDirectory.get("a.7", server)

    assert AgentDirectory.delete("a.7", server) == :ok
    assert AgentDirectory.get("a.7", server) == nil

    :ok = GenServer.stop(server)
    name2 = :"ad_delete_#{System.unique_integer([:positive])}"
    {:ok, _pid} = AgentDirectory.start_link(name: name2, path: path)
    assert AgentDirectory.get("a.7", name2) == nil
    GenServer.stop(name2)
  end

  test "delete は未知 agent でも :ok (冪等)", %{server: server} do
    assert AgentDirectory.delete("a.none", server) == :ok
  end
end
