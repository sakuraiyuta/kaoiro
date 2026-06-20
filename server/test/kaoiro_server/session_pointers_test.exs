defmodule KaoiroServer.SessionPointersTest do
  use ExUnit.Case, async: true

  alias KaoiroServer.SessionPointers

  setup do
    # Isolated DETS file + table name per test so cases don't share state.
    name = :"sp_#{System.unique_integer([:positive])}"
    path = Path.join(System.tmp_dir!(), "#{name}.dets")
    File.rm(path)
    {:ok, pid} = SessionPointers.start_link(name: name, path: path)

    on_exit(fn ->
      if Process.alive?(pid), do: GenServer.stop(pid)
      File.rm(path)
    end)

    %{server: name, path: path}
  end

  test "record してから get するとポインタが返る", %{server: server} do
    SessionPointers.record("a.1", "sess-1", "/home/x", server)
    assert SessionPointers.get("a.1", server) == %{session_id: "sess-1", cwd: "/home/x"}
  end

  test "未知 agent は nil", %{server: server} do
    assert SessionPointers.get("a.none", server) == nil
  end

  test "再 record で最新 session_id が勝つ", %{server: server} do
    SessionPointers.record("a.2", "sess-1", "/home/x", server)
    SessionPointers.record("a.2", "sess-2", "/home/x", server)
    assert SessionPointers.get("a.2", server) == %{session_id: "sess-2", cwd: "/home/x"}
  end

  test "cwd 省略時は nil", %{server: server} do
    SessionPointers.record("a.3", "sess-3", nil, server)
    assert SessionPointers.get("a.3", server) == %{session_id: "sess-3", cwd: nil}
  end

  test "同一 DETS ファイルからの再起動で値が残る", %{server: server, path: path} do
    SessionPointers.record("a.4", "sess-4", "/w", server)
    assert SessionPointers.get("a.4", server) == %{session_id: "sess-4", cwd: "/w"}
    :ok = GenServer.stop(server)

    name2 = :"sp_restart_#{System.unique_integer([:positive])}"
    {:ok, _pid} = SessionPointers.start_link(name: name2, path: path)
    assert SessionPointers.get("a.4", name2) == %{session_id: "sess-4", cwd: "/w"}
    GenServer.stop(name2)
  end

  test "all は全ポインタを返す", %{server: server} do
    SessionPointers.record("a.5", "s5", nil, server)
    SessionPointers.record("a.6", "s6", "/c", server)
    all = SessionPointers.all(server)
    assert all["a.5"] == %{session_id: "s5", cwd: nil}
    assert all["a.6"] == %{session_id: "s6", cwd: "/c"}
  end
end
