defmodule KaoiroServer.SessionResetsTest do
  use ExUnit.Case, async: false

  alias KaoiroServer.SessionPointers
  alias KaoiroServer.SessionResets

  setup do
    # Isolated GenServer instance per test. SessionResets uses no DETS,
    # but SessionPointers.detach_session (invoked from resolve/6 on ok=true)
    # still writes DETS; run it on an isolated table too so the callback
    # cannot bleed between tests.
    resets_name = :"sr_#{System.unique_integer([:positive])}"
    pointers_name = :"sp_for_sr_#{System.unique_integer([:positive])}"
    pointers_path = Path.join(System.tmp_dir!(), "#{pointers_name}.dets")
    File.rm(pointers_path)

    {:ok, sp_pid} =
      SessionPointers.start_link(name: pointers_name, path: pointers_path)

    {:ok, sr_pid} = SessionResets.start_link(name: resets_name)

    on_exit(fn ->
      if Process.alive?(sr_pid), do: GenServer.stop(sr_pid)
      if Process.alive?(sp_pid), do: GenServer.stop(sp_pid)
      File.rm(pointers_path)
    end)

    %{resets: resets_name, pointers: pointers_name}
  end

  describe "check_and_acquire/5 (F6 の TOCTOU 芯)" do
    test "idle 状態で lock を獲得、request_id と previous_session_id を返す", %{resets: sr} do
      assert {:ok, request_id, "sess-A"} =
               SessionResets.check_and_acquire("a.1", "new", "idle", "sess-A", sr)

      assert String.starts_with?(request_id, "rs_")
      assert SessionResets.pending?("a.1", sr)
    end

    test "waiting_input も受理", %{resets: sr} do
      assert {:ok, _, nil} =
               SessionResets.check_and_acquire("a.2", "clear", "waiting_input", nil, sr)
    end

    test "thinking など busy 状態は agent_busy で reject", %{resets: sr} do
      assert {:error, :agent_busy} =
               SessionResets.check_and_acquire("a.3", "new", "thinking", "sess", sr)

      assert {:error, :agent_busy} =
               SessionResets.check_and_acquire(
                 "a.3",
                 "new",
                 "waiting_permission",
                 "sess",
                 sr
               )

      refute SessionResets.pending?("a.3", sr)
    end

    test "既存 lock 有りでは session_reset_pending で reject (double reset ガード)", %{resets: sr} do
      assert {:ok, _, _} =
               SessionResets.check_and_acquire("a.4", "new", "idle", "sess", sr)

      assert {:error, :session_reset_pending} =
               SessionResets.check_and_acquire("a.4", "new", "idle", "sess", sr)

      assert {:error, :session_reset_pending} =
               SessionResets.check_and_acquire("a.4", "clear", "idle", "sess", sr)
    end

    test "guard_instruction 直後の check_and_acquire は agent_busy (async state-report lag 保護)",
         %{resets: sr} do
      # SessionResets の serial handle_call で連続実行される 2 call は
      # dispatch_cooldown_ms (2000ms) より遥かに短い間隔で発火するので、
      # AgentStates が idle と報告していても reset は refused される。
      assert :ok = SessionResets.guard_instruction("a.lag", sr)

      assert {:error, :agent_busy} =
               SessionResets.check_and_acquire("a.lag", "new", "idle", "sess", sr)

      refute SessionResets.pending?("a.lag", sr)
    end

    test "mode 引数は closed vocab 外だと FunctionClauseError", %{resets: sr} do
      assert_raise FunctionClauseError, fn ->
        SessionResets.check_and_acquire("a.5", "reset", "idle", "sess", sr)
      end
    end
  end

  describe "guard_instruction/1" do
    test "lock 無し時は :ok を返し last_dispatch を stamp する", %{resets: sr} do
      assert :ok = SessionResets.guard_instruction("a.g1", sr)

      # 2 度目の guard も lock 無しなら :ok (自身の cooldown は自身を
      # blocking しない — cooldown は check_and_acquire 側のガードのみ)。
      assert :ok = SessionResets.guard_instruction("a.g1", sr)
    end

    test "既存 lock 有り時は session_reset_pending で reject", %{resets: sr} do
      assert {:ok, _, _} =
               SessionResets.check_and_acquire("a.g2", "new", "idle", "sess", sr)

      assert {:error, :session_reset_pending} =
               SessionResets.guard_instruction("a.g2", sr)
    end
  end

  describe "resolve/6" do
    test "ok=true は :awaiting_connect に移行 (broadcast はまだ、lock は保持)",
         %{resets: sr, pointers: sp} do
      # ADR-0036 F2 の two-phase completion: runner の ok=true は spawn 成功
      # の中間報告で、fresh wrapper の channel join まで completed broadcast を
      # 抑える (join 前に wrapper が死ぬと詐称になる)。
      SessionPointers.record("a.res.ok", "sess-old", "/w", :codex, sp)

      assert {:ok, request_id, _} =
               SessionResets.check_and_acquire("a.res.ok", "new", "idle", "sess-old", sr)

      :ok = SessionResets.resolve("a.res.ok", request_id, true, nil, "sess-new", sr)

      _ = :sys.get_state(sr)
      # lock は保持されたまま (:awaiting_connect フェーズ)
      assert SessionResets.pending?("a.res.ok", sr)
    end

    test "confirm_connection で :awaiting_connect の lock を release + broadcast",
         %{resets: sr, pointers: sp} do
      SessionPointers.record("a.res.confirm", "sess-old", "/w", :codex, sp)

      assert {:ok, request_id, _} =
               SessionResets.check_and_acquire(
                 "a.res.confirm",
                 "new",
                 "idle",
                 "sess-old",
                 sr
               )

      :ok = SessionResets.resolve("a.res.confirm", request_id, true, nil, "sess-new", sr)
      _ = :sys.get_state(sr)
      assert SessionResets.pending?("a.res.confirm", sr)

      :ok = SessionResets.confirm_connection("a.res.confirm", nil, sr)
      refute SessionResets.pending?("a.res.confirm", sr)
    end

    test "confirm_connection は :spawning フェーズでは no-op (runner ok 未受信)",
         %{resets: sr} do
      assert {:ok, _rid, _} =
               SessionResets.check_and_acquire("a.res.early", "new", "idle", "sess", sr)

      # runner の ok=true が来る前の join (通常は起こらないが fail-safe)。
      # lock は :spawning のまま維持、broadcast も発火しない。
      :ok = SessionResets.confirm_connection("a.res.early", nil, sr)
      assert SessionResets.pending?("a.res.early", sr)
    end

    test "confirm_connection は pending 無し (通常 restart) では no-op",
         %{resets: sr} do
      assert :ok = SessionResets.confirm_connection("a.restart.norm", nil, sr)
      refute SessionResets.pending?("a.restart.norm", sr)
    end

    test "ok=false で lock を release、SessionPointers は変更しない", %{resets: sr} do
      assert {:ok, request_id, _} =
               SessionResets.check_and_acquire("a.res.fail", "new", "idle", "sess", sr)

      :ok =
        SessionResets.resolve(
          "a.res.fail",
          request_id,
          false,
          "spawn_failed",
          nil,
          sr
        )

      _ = :sys.get_state(sr)
      refute SessionResets.pending?("a.res.fail", sr)
    end

    test "stale request_id は silent drop (ADR-0036 F7)", %{resets: sr} do
      assert {:ok, _real_rid, _} =
               SessionResets.check_and_acquire("a.res.stale", "new", "idle", "sess", sr)

      # 別の request_id で resolve → lock は生き残る、broadcast も発火しない。
      :ok =
        SessionResets.resolve(
          "a.res.stale",
          "rs_ghost",
          true,
          nil,
          "sess-new",
          sr
        )

      _ = :sys.get_state(sr)
      assert SessionResets.pending?("a.res.stale", sr)
    end

    test "未 pending の agent は silent drop", %{resets: sr} do
      :ok = SessionResets.resolve("a.res.none", "rs_x", true, nil, nil, sr)
      _ = :sys.get_state(sr)
      refute SessionResets.pending?("a.res.none", sr)
    end
  end

  describe "delete/1" do
    test "lock と last_dispatch を purge、timer_ref を cancel", %{resets: sr} do
      assert {:ok, _rid, _} =
               SessionResets.check_and_acquire("a.del", "new", "idle", "sess", sr)

      assert :ok = SessionResets.guard_instruction("a.del.g", sr)

      assert :ok = SessionResets.delete("a.del", sr)
      assert :ok = SessionResets.delete("a.del.g", sr)

      refute SessionResets.pending?("a.del", sr)
      # cleanup 後の check_and_acquire は再度成立する (cooldown もリセット済み)。
      assert {:ok, _, _} =
               SessionResets.check_and_acquire("a.del.g", "new", "idle", "sess", sr)
    end

    test "未知 agent の delete は :ok の no-op", %{resets: sr} do
      assert :ok = SessionResets.delete("a.del.unknown", sr)
    end
  end
end
