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
    SessionPointers.record("a.1", "sess-1", "/home/x", nil, server)

    assert SessionPointers.get("a.1", server) == %{
             session_id: "sess-1",
             cwd: "/home/x",
             engine: nil,
             snapshot: nil
           }
  end

  test "未知 agent は nil", %{server: server} do
    assert SessionPointers.get("a.none", server) == nil
  end

  test "再 record で最新 session_id が勝つ", %{server: server} do
    SessionPointers.record("a.2", "sess-1", "/home/x", nil, server)
    SessionPointers.record("a.2", "sess-2", "/home/x", nil, server)

    assert SessionPointers.get("a.2", server) == %{
             session_id: "sess-2",
             cwd: "/home/x",
             engine: nil,
             snapshot: nil
           }
  end

  test "cwd 省略時は nil", %{server: server} do
    SessionPointers.record("a.3", "sess-3", nil, nil, server)

    assert SessionPointers.get("a.3", server) == %{
             session_id: "sess-3",
             cwd: nil,
             engine: nil,
             snapshot: nil
           }
  end

  test "nil cwd は既知の cwd を上書きしない (#22)", %{server: server} do
    SessionPointers.record("a.cwd", "sess-1", "/home/x", nil, server)
    # A later session_id-bearing record without a cwd (e.g. result/log) must
    # keep the cwd that restore needs.
    SessionPointers.record("a.cwd", "sess-2", nil, nil, server)

    assert SessionPointers.get("a.cwd", server) == %{
             session_id: "sess-2",
             cwd: "/home/x",
             engine: nil,
             snapshot: nil
           }
  end

  test "cwd seed(session_id nil)後に実 session_id が付き cwd は残る (#22)", %{server: server} do
    # spawn-time seed: cwd known, session_id not yet.
    SessionPointers.record("a.seed", nil, "/home/y", nil, server)
    # wrapper later reports its session_id without a statusline cwd.
    SessionPointers.record("a.seed", "sess-real", nil, nil, server)

    assert SessionPointers.get("a.seed", server) == %{
             session_id: "sess-real",
             cwd: "/home/y",
             engine: nil,
             snapshot: nil
           }
  end

  test "同一 DETS ファイルからの再起動で値が残る", %{server: server, path: path} do
    SessionPointers.record("a.4", "sess-4", "/w", nil, server)

    assert SessionPointers.get("a.4", server) == %{
             session_id: "sess-4",
             cwd: "/w",
             engine: nil,
             snapshot: nil
           }

    :ok = GenServer.stop(server)

    name2 = :"sp_restart_#{System.unique_integer([:positive])}"
    {:ok, _pid} = SessionPointers.start_link(name: name2, path: path)

    assert SessionPointers.get("a.4", name2) == %{
             session_id: "sess-4",
             cwd: "/w",
             engine: nil,
             snapshot: nil
           }

    GenServer.stop(name2)
  end

  test "all は全ポインタを返す", %{server: server} do
    SessionPointers.record("a.5", "s5", nil, nil, server)
    SessionPointers.record("a.6", "s6", "/c", nil, server)
    all = SessionPointers.all(server)
    assert all["a.5"] == %{session_id: "s5", cwd: nil, engine: nil, snapshot: nil}
    assert all["a.6"] == %{session_id: "s6", cwd: "/c", engine: nil, snapshot: nil}
  end

  test "delete で pointer が消え、再起動後も残らない", %{server: server, path: path} do
    SessionPointers.record("a.7", "s7", "/z", nil, server)
    assert %{session_id: "s7"} = SessionPointers.get("a.7", server)

    assert SessionPointers.delete("a.7", server) == :ok
    assert SessionPointers.get("a.7", server) == nil

    :ok = GenServer.stop(server)
    name2 = :"sp_delete_#{System.unique_integer([:positive])}"
    {:ok, _pid} = SessionPointers.start_link(name: name2, path: path)
    assert SessionPointers.get("a.7", name2) == nil
    GenServer.stop(name2)
  end

  test "delete は未知 agent でも :ok (冪等)", %{server: server} do
    assert SessionPointers.delete("a.none", server) == :ok
  end

  # ADR-0014 F1 追補 (phase-15 D8): agent-scoped resolved snapshot.

  test "record_snapshot: 未知 agent は no-op (pointer は seed されない)", %{server: server} do
    SessionPointers.record_snapshot("a.snap.unknown", %{model: "x"}, server)
    assert SessionPointers.get("a.snap.unknown", server) == nil
  end

  test "record_snapshot: 既知 pointer の snapshot を set / 更新する", %{server: server} do
    SessionPointers.record("a.snap", "s", "/w", :codex, server)
    SessionPointers.record_snapshot("a.snap", %{model: "gpt-5.6-sol"}, server)

    assert SessionPointers.get("a.snap", server) == %{
             session_id: "s",
             cwd: "/w",
             engine: :codex,
             snapshot: %{model: "gpt-5.6-sol"}
           }

    SessionPointers.record_snapshot("a.snap", %{model: "gpt-5.6-terra"}, server)
    assert %{snapshot: %{model: "gpt-5.6-terra"}} = SessionPointers.get("a.snap", server)
  end

  test "snapshot は DETS 越しに永続する", %{server: server, path: path} do
    SessionPointers.record("a.snap.persist", "s", "/w", :claude_code, server)
    SessionPointers.record_snapshot("a.snap.persist", %{permission_mode: "plan"}, server)
    :ok = GenServer.stop(server)

    name2 = :"sp_snap_restart_#{System.unique_integer([:positive])}"
    {:ok, _pid} = SessionPointers.start_link(name: name2, path: path)

    assert SessionPointers.get("a.snap.persist", name2) == %{
             session_id: "s",
             cwd: "/w",
             engine: :claude_code,
             snapshot: %{permission_mode: "plan"}
           }

    GenServer.stop(name2)
  end

  test "record で session_id / cwd / engine を更新しても snapshot は保持される (nil = keep)", %{
    server: server
  } do
    SessionPointers.record("a.snap.keep", "s-old", "/w", :codex, server)
    SessionPointers.record_snapshot("a.snap.keep", %{sandbox: "workspace-write"}, server)

    # A later envelope updates session_id but omits snapshot: snapshot must
    # stay (agent-scoped semantics per ADR-0014 F1 追補; ADR-0036 F4/F2
    # rely on this for fresh-relaunch snapshot supply).
    SessionPointers.record("a.snap.keep", "s-new", nil, nil, server)

    assert SessionPointers.get("a.snap.keep", server) == %{
             session_id: "s-new",
             cwd: "/w",
             engine: :codex,
             snapshot: %{sandbox: "workspace-write"}
           }
  end

  test "delete は snapshot も破棄する (ADR-0030 D6 の 4-store purge と整合)", %{server: server} do
    SessionPointers.record("a.snap.del", "s", "/w", :codex, server)
    SessionPointers.record_snapshot("a.snap.del", %{model: "x"}, server)
    assert :ok = SessionPointers.delete("a.snap.del", server)
    assert SessionPointers.get("a.snap.del", server) == nil
  end
end
