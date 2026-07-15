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

  test "record_snapshot: 既知 pointer の snapshot を set / 更新する (canonical string key へ normalize、藤 R1)",
       %{server: server} do
    SessionPointers.record("a.snap", "s", "/w", :codex, server)
    SessionPointers.record_snapshot("a.snap", %{model: "gpt-5.6-sol"}, server)

    assert SessionPointers.get("a.snap", server) == %{
             session_id: "s",
             cwd: "/w",
             engine: :codex,
             snapshot: %{"model" => "gpt-5.6-sol"}
           }

    SessionPointers.record_snapshot("a.snap", %{model: "gpt-5.6-terra"}, server)

    assert %{snapshot: %{"model" => "gpt-5.6-terra"}} =
             SessionPointers.get("a.snap", server)
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
             snapshot: %{"permission_mode" => "plan"}
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
             snapshot: %{"sandbox" => "workspace-write"}
           }
  end

  test "delete は snapshot も破棄する (ADR-0030 D6 の 4-store purge と整合)", %{server: server} do
    SessionPointers.record("a.snap.del", "s", "/w", :codex, server)
    SessionPointers.record_snapshot("a.snap.del", %{model: "x"}, server)
    assert :ok = SessionPointers.delete("a.snap.del", server)
    assert SessionPointers.get("a.snap.del", server) == nil
  end

  # ADR-0036 F4 (phase-17 17-3): detach_session — session_id を明示 nil、
  # cwd/engine/snapshot は保持。record の merge semantics (nil = keep) では
  # 実現できない専用 sync operation。

  test "detach_session: 既存 pointer の session_id を nil に、他 field を保持", %{server: server} do
    SessionPointers.record("a.det", "s-old", "/w", :codex, server)
    SessionPointers.record_snapshot("a.det", %{model: "x"}, server)

    assert SessionPointers.detach_session("a.det", server) == :ok

    assert SessionPointers.get("a.det", server) == %{
             session_id: nil,
             cwd: "/w",
             engine: :codex,
             snapshot: %{"model" => "x"}
           }
  end

  test "detach_session: 未知 agent は :ok の no-op (冪等)", %{server: server} do
    assert SessionPointers.detach_session("a.det.unknown", server) == :ok
    assert SessionPointers.get("a.det.unknown", server) == nil
  end

  test "detach_session: 既に session_id=nil の pointer は :ok の no-op", %{server: server} do
    SessionPointers.record("a.det.nil", nil, "/w", :claude_code, server)

    assert SessionPointers.get("a.det.nil", server) == %{
             session_id: nil,
             cwd: "/w",
             engine: :claude_code,
             snapshot: nil
           }

    assert SessionPointers.detach_session("a.det.nil", server) == :ok

    assert SessionPointers.get("a.det.nil", server) == %{
             session_id: nil,
             cwd: "/w",
             engine: :claude_code,
             snapshot: nil
           }
  end

  test "detach_session 後の record で新 session_id が最新 pointer になる", %{server: server} do
    SessionPointers.record("a.det.reattach", "s-old", "/w", :codex, server)
    assert SessionPointers.detach_session("a.det.reattach", server) == :ok

    # Fresh relaunch reports its new session_id via the normal record path.
    SessionPointers.record("a.det.reattach", "s-new", nil, nil, server)

    assert SessionPointers.get("a.det.reattach", server) == %{
             session_id: "s-new",
             cwd: "/w",
             engine: :codex,
             snapshot: nil
           }
  end

  test "detach_session は DETS 越しに永続する", %{server: server, path: path} do
    SessionPointers.record("a.det.persist", "s", "/w", :claude_code, server)
    SessionPointers.record_snapshot("a.det.persist", %{permission_mode: "plan"}, server)
    assert SessionPointers.detach_session("a.det.persist", server) == :ok

    :ok = GenServer.stop(server)

    name2 = :"sp_detach_restart_#{System.unique_integer([:positive])}"
    {:ok, _pid} = SessionPointers.start_link(name: name2, path: path)

    assert SessionPointers.get("a.det.persist", name2) == %{
             session_id: nil,
             cwd: "/w",
             engine: :claude_code,
             snapshot: %{"permission_mode" => "plan"}
           }

    GenServer.stop(name2)
  end

  # ADR-0014 F1 追補 (resume-privilege-restoration, 藤 D2):
  # write-side snapshot validation. Sanitize is expected to drop
  # unknown / malformed fields with a warn and keep the rest, so a
  # compromised wrapper cannot land invalid enum values via record_snapshot.
  describe "record_snapshot: field-level sanitize (藤 D2)" do
    test "全 7 known field が enum / boolean guard を通過して保持される", %{server: server} do
      SessionPointers.record("a.sanitize.full", "s", "/w", nil, server)

      SessionPointers.record_snapshot(
        "a.sanitize.full",
        %{
          "model" => "gpt-5",
          "model_source" => "config",
          "effort" => "high",
          "effort_source" => "launch",
          "permission_mode" => "bypassPermissions",
          "sandbox" => "danger-full-access",
          "network_access" => true
        },
        server
      )

      assert %{
               snapshot: %{
                 "model" => "gpt-5",
                 "model_source" => "config",
                 "effort" => "high",
                 "effort_source" => "launch",
                 "permission_mode" => "bypassPermissions",
                 "sandbox" => "danger-full-access",
                 "network_access" => true
               }
             } = SessionPointers.get("a.sanitize.full", server)
    end

    test "malformed sandbox enum は drop、他 field は保持", %{server: server} do
      SessionPointers.record("a.sanitize.bad_sandbox", "s", "/w", nil, server)

      SessionPointers.record_snapshot(
        "a.sanitize.bad_sandbox",
        %{"sandbox" => "hacked", "permission_mode" => "plan"},
        server
      )

      assert %{snapshot: snap} =
               SessionPointers.get("a.sanitize.bad_sandbox", server)

      refute Map.has_key?(snap, "sandbox")
      assert snap["permission_mode"] == "plan"
    end

    test "malformed permission_mode enum は drop", %{server: server} do
      SessionPointers.record("a.sanitize.bad_pmode", "s", "/w", nil, server)

      SessionPointers.record_snapshot(
        "a.sanitize.bad_pmode",
        %{"permission_mode" => "GodMode"},
        server
      )

      assert %{snapshot: snap} =
               SessionPointers.get("a.sanitize.bad_pmode", server)

      refute Map.has_key?(snap, "permission_mode")
    end

    test "network_access 非 boolean は drop", %{server: server} do
      SessionPointers.record("a.sanitize.bad_net", "s", "/w", nil, server)

      SessionPointers.record_snapshot(
        "a.sanitize.bad_net",
        %{"network_access" => 1},
        server
      )

      assert %{snapshot: snap} =
               SessionPointers.get("a.sanitize.bad_net", server)

      refute Map.has_key?(snap, "network_access")
    end

    test "network_access=false explicit は保持される (truthy 判定禁止 pin)",
         %{server: server} do
      SessionPointers.record("a.sanitize.false_net", "s", "/w", nil, server)

      SessionPointers.record_snapshot(
        "a.sanitize.false_net",
        %{"network_access" => false, "sandbox" => "workspace-write"},
        server
      )

      assert %{snapshot: %{"network_access" => false}} =
               SessionPointers.get("a.sanitize.false_net", server)
    end

    test "unknown field は drop、known は保持", %{server: server} do
      SessionPointers.record("a.sanitize.unknown", "s", "/w", nil, server)

      SessionPointers.record_snapshot(
        "a.sanitize.unknown",
        %{"model" => "gpt-5", "foo" => "bar", "danger" => true},
        server
      )

      assert %{snapshot: snap} =
               SessionPointers.get("a.sanitize.unknown", server)

      assert snap == %{"model" => "gpt-5"}
    end

    test "非 map snapshot は no-op (defensive drop)", %{server: server} do
      SessionPointers.record("a.sanitize.nonmap", "s", "/w", nil, server)

      SessionPointers.record_snapshot("a.sanitize.nonmap", "not-a-map", server)

      # Existing snapshot (nil) preserved; no crash, no cast rejected loudly.
      assert %{snapshot: nil} =
               SessionPointers.get("a.sanitize.nonmap", server)
    end

    test "atom-keyed snapshot も同じ sanitize を通り canonical string key に normalize される (藤 R1)",
         %{server: server} do
      SessionPointers.record("a.sanitize.atom", "s", "/w", nil, server)

      SessionPointers.record_snapshot(
        "a.sanitize.atom",
        %{sandbox: "danger-full-access", network_access: true},
        server
      )

      # Canonical string key で保存される (JSON relay の勝者不定回避、藤 R1)。
      assert %{
               snapshot: %{
                 "sandbox" => "danger-full-access",
                 "network_access" => true
               }
             } = SessionPointers.get("a.sanitize.atom", server)
    end

    # 藤 R1 pin: atom / string key の同一 field 重複時の priority、
    # validity 交差ケース。Phoenix JSON relay が atom+string を潰す前に、
    # sanitize 側で deterministic に正規化する。
    test "同一 field を atom と string 両方で持つ (同値) → string canonical で 1 件",
         %{server: server} do
      SessionPointers.record("a.sanitize.dup_same", "s", "/w", nil, server)

      # Mixed atom/string map リテラルは string => value をキーワード
      # (atom-kv) より前に置く必要がある (Elixir 構文)。
      SessionPointers.record_snapshot(
        "a.sanitize.dup_same",
        %{"sandbox" => "workspace-write", sandbox: "workspace-write"},
        server
      )

      assert %{snapshot: snap} =
               SessionPointers.get("a.sanitize.dup_same", server)

      assert snap == %{"sandbox" => "workspace-write"}
    end

    test "同一 field を atom と string で異なる値 → string 優先 (canonical wire) で warn",
         %{server: server} do
      SessionPointers.record("a.sanitize.dup_diff", "s", "/w", nil, server)

      # 藤 R1: 判り易く「string=danger-full-access, atom=workspace-write」で
      # string が勝つことを pin する (string が canonical、逆で採ると
      # JSON relay と食い違う)。
      SessionPointers.record_snapshot(
        "a.sanitize.dup_diff",
        %{"sandbox" => "danger-full-access", sandbox: "workspace-write"},
        server
      )

      assert %{snapshot: %{"sandbox" => "danger-full-access"}} =
               SessionPointers.get("a.sanitize.dup_diff", server)
    end

    test "invalid string + valid atom → string 優先 (invalid) で field drop (deterministic pin, 藤 R1)",
         %{server: server} do
      SessionPointers.record("a.sanitize.dup_bad_str", "s", "/w", nil, server)

      SessionPointers.record_snapshot(
        "a.sanitize.dup_bad_str",
        %{"sandbox" => "hacked", sandbox: "workspace-write"},
        server
      )

      # string が勝つが値が invalid → field 全体 drop (atom fallback しない、
      # priority は unconditional に string、藤 R1 pin)。
      assert %{snapshot: snap} =
               SessionPointers.get("a.sanitize.dup_bad_str", server)

      refute Map.has_key?(snap, "sandbox")
    end

    test "valid string + invalid atom → string 側 valid を採用",
         %{server: server} do
      SessionPointers.record("a.sanitize.dup_bad_atom", "s", "/w", nil, server)

      SessionPointers.record_snapshot(
        "a.sanitize.dup_bad_atom",
        %{"sandbox" => "danger-full-access", sandbox: "hacked"},
        server
      )

      assert %{snapshot: %{"sandbox" => "danger-full-access"}} =
               SessionPointers.get("a.sanitize.dup_bad_atom", server)
    end
  end
end
