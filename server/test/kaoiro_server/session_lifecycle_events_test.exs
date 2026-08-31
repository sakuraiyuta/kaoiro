defmodule KaoiroServer.SessionLifecycleEventsTest do
  use ExUnit.Case, async: false

  import KaoiroServer.TestTeardown

  alias KaoiroServer.SessionLifecycleEvents

  setup do
    name = :"session_lifecycle_events_#{System.unique_integer([:positive])}"
    path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "#{name}.dets"])
    File.rm(path)
    {:ok, _pid} = SessionLifecycleEvents.start_link(name: name, path: path, cap: 3)

    on_exit(fn ->
      stop_quietly(name)
      File.rm(path)
    end)

    %{name: name, path: path}
  end

  test "append then list_for_agent returns newest first", %{name: name} do
    assert :ok =
             SessionLifecycleEvents.append(
               "a.1",
               "compacting",
               nil,
               "2026-08-31T00:00:01Z",
               name
             )

    assert :ok =
             SessionLifecycleEvents.append(
               "a.1",
               "compact_boundary",
               "request_compact",
               "2026-08-31T00:00:02Z",
               name
             )

    assert SessionLifecycleEvents.list_for_agent("a.1", name) == [
             %{
               kind: "compact_boundary",
               trigger: "request_compact",
               at: "2026-08-31T00:00:02Z"
             },
             %{kind: "compacting", trigger: nil, at: "2026-08-31T00:00:01Z"}
           ]
  end

  test "unknown agent returns an empty list", %{name: name} do
    assert SessionLifecycleEvents.list_for_agent("a.none", name) == []
  end

  test "each agent's timeline is independent", %{name: name} do
    SessionLifecycleEvents.append("a.1", "compacting", nil, "2026-08-31T00:00:01Z", name)
    SessionLifecycleEvents.append("a.2", "conversation_reset", nil, "2026-08-31T00:00:01Z", name)

    assert length(SessionLifecycleEvents.list_for_agent("a.1", name)) == 1
    assert length(SessionLifecycleEvents.list_for_agent("a.2", name)) == 1

    assert [%{kind: "compacting"}] = SessionLifecycleEvents.list_for_agent("a.1", name)
    assert [%{kind: "conversation_reset"}] = SessionLifecycleEvents.list_for_agent("a.2", name)
  end

  test "cap discards the oldest entries first (setup cap: 3)", %{name: name} do
    for i <- 1..5 do
      SessionLifecycleEvents.append(
        "a.cap",
        "compacting",
        nil,
        "2026-08-31T00:00:0#{i}Z",
        name
      )
    end

    ats = SessionLifecycleEvents.list_for_agent("a.cap", name) |> Enum.map(& &1.at)

    assert ats == [
             "2026-08-31T00:00:05Z",
             "2026-08-31T00:00:04Z",
             "2026-08-31T00:00:03Z"
           ]
  end

  test "restart retains the timeline (DETS persistence)", %{name: name, path: path} do
    SessionLifecycleEvents.append("a.restart", "compacting", nil, "2026-08-31T00:00:01Z", name)

    SessionLifecycleEvents.append(
      "a.restart",
      "compact_boundary",
      "sdk_auto",
      "2026-08-31T00:00:02Z",
      name
    )

    GenServer.stop(Process.whereis(name))
    {:ok, _pid} = SessionLifecycleEvents.start_link(name: name, path: path, cap: 3)

    assert SessionLifecycleEvents.list_for_agent("a.restart", name) == [
             %{kind: "compact_boundary", trigger: "sdk_auto", at: "2026-08-31T00:00:02Z"},
             %{kind: "compacting", trigger: nil, at: "2026-08-31T00:00:01Z"}
           ]
  end

  test "corrupt store file is recreated rather than crashing boot", %{name: name, path: path} do
    GenServer.stop(Process.whereis(name))
    File.write!(path, "not a dets file")

    assert {:ok, pid} = SessionLifecycleEvents.start_link(name: name, path: path, cap: 3)
    assert Process.alive?(pid)
    assert SessionLifecycleEvents.list_for_agent("a.any", name) == []
  end

  # ふじ Stage B round 1 must-fix B3 (2026-08-31): kind/trigger/at outside
  # the protocol.md vocabulary no-ops the WHOLE event rather than storing
  # a partially-repaired row.
  describe "valid_event?/3 (protocol.md vocabulary, must-fix B3)" do
    test "accepts every enumerated kind with no trigger" do
      for kind <- ~w(
            compacting compact_boundary compact_failed resume_reserved
            resume_fired threshold_notice conversation_reset disconnected
            reconnecting reconnected session_reset_started
            session_reset_completed
          ) do
        assert SessionLifecycleEvents.valid_event?(kind, nil, "2026-08-31T00:00:00Z"),
               "expected #{kind} to be valid with no trigger"
      end
    end

    test "accepts a trigger only on compact_boundary" do
      for trigger <- ~w(request_compact sdk_auto manual) do
        assert SessionLifecycleEvents.valid_event?(
                 "compact_boundary",
                 trigger,
                 "2026-08-31T00:00:00Z"
               )
      end
    end

    test "rejects an unknown kind" do
      refute SessionLifecycleEvents.valid_event?("bogus_kind", nil, "2026-08-31T00:00:00Z")
    end

    test "rejects a trigger on a kind other than compact_boundary" do
      refute SessionLifecycleEvents.valid_event?(
               "compacting",
               "request_compact",
               "2026-08-31T00:00:00Z"
             )
    end

    test "rejects an unknown trigger on compact_boundary" do
      refute SessionLifecycleEvents.valid_event?(
               "compact_boundary",
               "bogus_trigger",
               "2026-08-31T00:00:00Z"
             )
    end

    test "rejects an empty or non-ISO-8601 at" do
      refute SessionLifecycleEvents.valid_event?("compacting", nil, "")
      refute SessionLifecycleEvents.valid_event?("compacting", nil, "not-a-timestamp")
      refute SessionLifecycleEvents.valid_event?("compacting", nil, "2026-08-31")
    end

    test "rejects an oversized at" do
      oversized = String.duplicate("2", 41)
      refute SessionLifecycleEvents.valid_event?("compacting", nil, oversized)
    end
  end

  test "append no-ops (not stored) when kind/trigger/at fails validation", %{name: name} do
    SessionLifecycleEvents.append("a.invalid", "bogus_kind", nil, "2026-08-31T00:00:01Z", name)

    SessionLifecycleEvents.append(
      "a.invalid",
      "compacting",
      "request_compact",
      "2026-08-31T00:00:01Z",
      name
    )

    SessionLifecycleEvents.append("a.invalid", "compacting", nil, "not-a-timestamp", name)

    assert SessionLifecycleEvents.list_for_agent("a.invalid", name) == []
  end

  # ふじ Stage B round 2 must-fix B3-残り (2026-08-31): append/5's own
  # `is_binary(trigger)` guard made it CRASH (FunctionClauseError) on a
  # wrong-typed trigger instead of rejecting it via valid_event?/3 — so
  # even with the channel-side sanitize repair removed, a direct caller
  # passing a non-binary/non-nil trigger would still not get a clean
  # no-op. append/5 is now total over kind/trigger/at: no shape can crash
  # it, only valid_event?/3 decides accept/reject.
  test "append is total over trigger's type — a non-binary trigger no-ops rather than crashes",
       %{name: name} do
    assert :ok =
             SessionLifecycleEvents.append(
               "a.badtrigger",
               "compacting",
               42,
               "2026-08-31T00:00:01Z",
               name
             )

    assert :ok =
             SessionLifecycleEvents.append(
               "a.badtrigger",
               "compacting",
               %{},
               "2026-08-31T00:00:01Z",
               name
             )

    assert SessionLifecycleEvents.list_for_agent("a.badtrigger", name) == []
  end

  # must-fix B2: a dead/unregistered store must not crash or block either
  # call. `append/5`'s `cast_append/5` checks `store_alive?/1` itself and
  # logs rather than casting into the void (round 2 must-fix B2-残り);
  # `list_for_agent/2`'s `safe_call/3` catches the `exit` `GenServer.call`
  # raises for a non-alive name — plain `rescue` cannot catch this.
  test "append and list_for_agent return without raising when the store is not running" do
    dead_name = :"session_lifecycle_events_dead_#{System.unique_integer([:positive])}"

    assert :ok =
             SessionLifecycleEvents.append(
               "a.dead",
               "compacting",
               nil,
               "2026-08-31T00:00:01Z",
               dead_name
             )

    assert SessionLifecycleEvents.list_for_agent("a.dead", dead_name) == []
  end

  # must-fix B2, the DETS-write-failure half: a fault the store's own
  # `handle_cast` cannot cleanly return from (here, its table reference
  # replaced with one that was never opened — `:dets.insert` then raises
  # `ArgumentError` instead of returning `{:error, reason}`) must still
  # leave the CALLER unharmed. `:sys.replace_state/2` injects the fault
  # directly rather than via `:dets.close/1` from this test process: dets
  # tracks table users per opening process, so a close from a process
  # that never opened the table does not touch the real owner's (the
  # store GenServer's) reference count.
  #
  # `append/5` casts (round 2 must-fix B2-残り), so it returns before the
  # store has necessarily even looked at the message, let alone crashed on
  # it — proving the call itself doesn't raise is now trivial by
  # construction. `Process.monitor/1` + `assert_receive :DOWN` instead
  # waits for the crash this fault injection is supposed to cause, so the
  # test still exercises the write-failure path rather than only
  # `cast/2`'s unconditional non-blocking guarantee.
  test "append does not crash the caller when the store crashes mid-write", %{name: name} do
    # This test's own `start_link` (in `setup`) links the test process to
    # the store — trap_exit keeps THAT link's signal from killing the test
    # process itself.
    Process.flag(:trap_exit, true)
    pid = Process.whereis(name)
    ref = Process.monitor(pid)
    :sys.replace_state(pid, fn state -> %{state | table: :session_lifecycle_never_opened} end)

    ExUnit.CaptureLog.capture_log(fn ->
      assert :ok =
               SessionLifecycleEvents.append(
                 "a.write_fault",
                 "compacting",
                 nil,
                 "2026-08-31T00:00:01Z",
                 name
               )

      assert_receive {:DOWN, ^ref, :process, ^pid, _reason}, 1000
    end)

    refute Process.alive?(pid)
    assert Process.whereis(name) == nil
  end

  # ふじ Stage B round 2 must-fix B2-残り (2026-08-31): a bounded
  # `GenServer.call` — round 1's fix — still SYNCHRONOUSLY stalls the
  # caller for its full timeout against a store that is ALIVE but simply
  # has not gotten to the message yet (ふじ measured 5,010ms). Concretely,
  # `agents_channel.ex`'s agent-self session_reset flow appends
  # `session_reset_started` between its broadcast and the runner
  # `reset_session` instruction — a busy store must not delay that
  # instruction. `:sys.suspend/1` makes the target genuinely unresponsive
  # (it will not process ANY message, cast or call, until resumed) without
  # crashing or unregistering it, isolating "busy" from the already-pinned
  # "dead"/"crashing" cases above.
  test "append does not wait for a suspended (busy-but-alive) store", %{name: name} do
    pid = Process.whereis(name)
    :sys.suspend(pid)
    on_exit(fn -> if Process.alive?(pid), do: :sys.resume(pid) end)

    {elapsed_us, result} =
      :timer.tc(fn ->
        SessionLifecycleEvents.append(
          "a.suspended",
          "compacting",
          nil,
          "2026-08-31T00:00:01Z",
          name
        )
      end)

    :sys.resume(pid)

    assert result == :ok
    # GenServer.call's default timeout is 5,000ms; a genuinely
    # non-blocking cast returns in microseconds, so any threshold well
    # below that ceiling (here 200ms) distinguishes "didn't wait" from
    # "waited briefly" without being sensitive to CI scheduling noise.
    assert elapsed_us < 200_000, "append blocked for #{elapsed_us}us on a suspended store"

    # The cast queued while suspended and is processed on resume —
    # confirms this measured a real append, not merely a fast reject.
    assert [%{kind: "compacting"}] = SessionLifecycleEvents.list_for_agent("a.suspended", name)
  end

  describe "cap invariants (must-fix B6)" do
    test "start_link rejects a zero cap" do
      name = :"session_lifecycle_events_cap0_#{System.unique_integer([:positive])}"
      path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "#{name}.dets"])
      File.rm(path)

      assert_raise ArgumentError, ~r/positive integer/, fn ->
        SessionLifecycleEvents.start_link(name: name, path: path, cap: 0)
      end
    end

    test "start_link rejects a negative cap" do
      name = :"session_lifecycle_events_capneg_#{System.unique_integer([:positive])}"
      path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "#{name}.dets"])
      File.rm(path)

      assert_raise ArgumentError, ~r/positive integer/, fn ->
        SessionLifecycleEvents.start_link(name: name, path: path, cap: -1)
      end
    end

    test "a shrunk cap durably truncates on restart and does not resurrect on regrowth" do
      name = :"session_lifecycle_events_shrink_#{System.unique_integer([:positive])}"
      path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "#{name}.dets"])
      File.rm(path)

      {:ok, _pid} = SessionLifecycleEvents.start_link(name: name, path: path, cap: 10)

      for i <- 1..3 do
        SessionLifecycleEvents.append(
          "a.shrink",
          "compacting",
          nil,
          "2026-08-31T00:00:0#{i}Z",
          name
        )
      end

      assert length(SessionLifecycleEvents.list_for_agent("a.shrink", name)) == 3
      GenServer.stop(Process.whereis(name))

      # Restart with a shrunk cap (ふじ probe, 2026-08-31: previously
      # restarting at cap 1 still returned all 3 — load_events applied no
      # cap at all).
      {:ok, _pid} = SessionLifecycleEvents.start_link(name: name, path: path, cap: 1)

      assert [%{at: "2026-08-31T00:00:03Z"}] =
               SessionLifecycleEvents.list_for_agent("a.shrink", name)

      GenServer.stop(Process.whereis(name))

      # Regrowing the cap must NOT resurrect the two discarded entries —
      # they were durably truncated on disk at the shrink restart, not
      # merely hidden in memory.
      {:ok, _pid} = SessionLifecycleEvents.start_link(name: name, path: path, cap: 10)

      assert [%{at: "2026-08-31T00:00:03Z"}] =
               SessionLifecycleEvents.list_for_agent("a.shrink", name)

      on_exit(fn ->
        stop_quietly(name)
        File.rm(path)
      end)
    end
  end

  # must-fix B3 durable re-validation: a legacy/hand-edited row on disk
  # must not resurface through list_for_agent after a restart.
  test "an invalid row already on disk is dropped (not resurfaced) on restart", %{
    name: name,
    path: path
  } do
    SessionLifecycleEvents.append("a.legacy", "compacting", nil, "2026-08-31T00:00:01Z", name)
    GenServer.stop(Process.whereis(name))

    # Simulate a pre-schema / hand-edited row landing directly in the DETS
    # table (no public API writes an invalid row, so this reaches under
    # the module to plant one).
    {:ok, table} = :dets.open_file(name, file: String.to_charlist(path))

    :dets.insert(table, {
      "a.legacy",
      [
        %{kind: "compacting", trigger: nil, at: "2026-08-31T00:00:01Z"},
        %{kind: "bogus_kind", trigger: nil, at: "2026-08-31T00:00:00Z"}
      ]
    })

    :dets.sync(table)
    :dets.close(table)

    {:ok, _pid} = SessionLifecycleEvents.start_link(name: name, path: path, cap: 3)

    assert [%{kind: "compacting"}] = SessionLifecycleEvents.list_for_agent("a.legacy", name)
  end
end
