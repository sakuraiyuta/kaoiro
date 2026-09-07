defmodule KaoiroServer.AgentAcceptanceTest do
  use ExUnit.Case, async: true

  alias KaoiroServer.AgentAcceptance

  # These tests run against the REAL global Registry/DynamicSupervisor
  # (application.ex) — there is no per-test isolation seam here, unlike
  # PermissionSettings/SessionLifecycleEvents' own DETS-backed stores,
  # because a worker is scoped by agent_id alone. A unique agent_id per
  # test (matching the convention every OTHER channel test already uses
  # for PermissionSettings/SessionResets/Users) is enough isolation: two
  # tests never share a worker unless they share an agent_id.
  defp unique_agent_id(prefix), do: "#{prefix}-#{System.unique_integer([:positive])}"

  test "runs the closure and returns its result" do
    agent_id = unique_agent_id("aa.basic")
    assert AgentAcceptance.run(agent_id, :set_permission, fn -> {:ok, 42} end) == {:ok, 42}
  end

  test "two run/3 calls for the SAME agent_id still serialize" do
    agent_id = unique_agent_id("aa.same")
    order = :ets.new(:order, [:public])
    parent = self()

    task1 =
      Task.async(fn ->
        AgentAcceptance.run(agent_id, :set_permission, fn ->
          :ets.insert(order, {1, :start})
          Process.sleep(30)
          :ets.insert(order, {1, :finish})
          send(parent, :task1_done)
          :ok
        end)
      end)

    # Give task1 time to actually enter its closure before task2 queues.
    Process.sleep(10)

    task2 =
      Task.async(fn ->
        AgentAcceptance.run(agent_id, :session_reset, fn -> :ets.insert(order, {2, :start}) end)
      end)

    assert Task.await(task1) == :ok
    assert Task.await(task2) == true
    assert_received :task1_done
    # task2's closure could only run after task1's finished (both entries
    # for key 1 exist by the time task2 recorded anything at all).
    assert :ets.lookup(order, 1) == [{1, :finish}]
  end

  # issue #305 M7, director round-2 correction: AgentAcceptance serializes
  # PER agent_id, not globally — a blocked/slow closure for one agent
  # must never delay an unrelated agent's commit. Proven directly (two
  # genuinely concurrent processes), not via suspend/resume timing
  # tricks: if serialization were still global, agent B's call would
  # queue behind agent A's 1s sleep and this would take >= 1s too.
  test "a blocked commit for one agent does not block a different agent's commit" do
    agent_a = unique_agent_id("aa.blocked-a")
    agent_b = unique_agent_id("aa.blocked-b")

    task_a =
      Task.async(fn ->
        AgentAcceptance.run(agent_a, :set_permission, fn ->
          Process.sleep(1_000)
          :a_done
        end)
      end)

    # Let agent A's closure actually start before racing agent B.
    Process.sleep(100)

    {microseconds, result_b} =
      :timer.tc(fn -> AgentAcceptance.run(agent_b, :session_reset, fn -> :b_done end) end)

    assert result_b == :b_done
    # Comfortably under A's 1s sleep — B never queued behind it.
    assert microseconds < 500_000

    assert Task.await(task_a, 2_000) == :a_done
  end

  # code-review-assessment finding (issue #305 M7, round 1): an inner
  # exit (e.g. a nested GenServer.call timing out under real contention)
  # must degrade to an error reply for that ONE caller, not crash that
  # agent's worker in a way that also breaks a LATER call for the same
  # agent_id (a fresh worker must be started transparently).
  test "an unavailable worker returns the command's closed transient reason" do
    agent_id = unique_agent_id("aa.exits")

    assert AgentAcceptance.run(agent_id, :set_permission, fn -> exit(:boom) end) ==
             {:error, :persistence_failed}

    assert AgentAcceptance.run(agent_id, :session_reset, fn -> exit(:boom) end) ==
             {:error, :timeout}

    assert AgentAcceptance.run(agent_id, :session_reset_request, fn -> exit(:boom) end) ==
             {:error, :agent_busy}

    assert AgentAcceptance.run(agent_id, :set_permission, fn -> :still_working end) ==
             :still_working
  end

  test "requires a closed command tag and exports no raw run/2 path" do
    agent_id = unique_agent_id("aa.closed-command")

    refute function_exported?(AgentAcceptance, :run, 2)

    assert_raise FunctionClauseError, fn ->
      apply(AgentAcceptance, :run, [agent_id, :future_command, fn -> :ok end])
    end
  end

  # code-review-assessment finding (issue #305 round 1): without a
  # teardown hook, the worker/Registry-entry count grows without bound
  # over a long-running server's lifetime under ordinary agent churn —
  # `agents_channel.ex`'s `delete_agent` purge path must reclaim it.
  test "delete/1 terminates the worker; delete of an unknown agent_id is a no-op" do
    agent_id = unique_agent_id("aa.delete")
    assert AgentAcceptance.run(agent_id, :set_permission, fn -> :ok end) == :ok
    assert [{pid, _}] = Registry.lookup(KaoiroServer.AgentAcceptance.Registry, agent_id)
    assert Process.alive?(pid)

    assert AgentAcceptance.delete(agent_id) == :ok
    refute Process.alive?(pid)
    assert Registry.lookup(KaoiroServer.AgentAcceptance.Registry, agent_id) == []

    # A respawn under the same agent_id gets a fresh worker transparently.
    assert AgentAcceptance.run(agent_id, :session_reset, fn -> :ok end) == :ok
    assert [{new_pid, _}] = Registry.lookup(KaoiroServer.AgentAcceptance.Registry, agent_id)
    assert new_pid != pid

    # Idempotent: deleting an agent_id with no worker at all is a no-op.
    assert AgentAcceptance.delete(unique_agent_id("aa.never-existed")) == :ok
  end

  # クロエ round 3 should-fix (N-1P): @registry_removal_attempts's 100-try
  # bound was unpinned — removing it left every existing test in this file
  # green. Suspending the Registry's own PID partition process makes
  # `Registry.lookup/2` inside `await_registry_removal/2` itself never
  # return, so the bounded retry (not the DOWN wait before it) is what
  # this measures: without the bound, `delete/1` would hang forever here
  # instead of logging and returning `:ok`.
  test "delete/1 stops waiting when the Registry entry never clears" do
    agent_id = unique_agent_id("aa.registry-stuck")
    assert AgentAcceptance.run(agent_id, :set_permission, fn -> :ok end) == :ok
    partition = Process.whereis(KaoiroServer.AgentAcceptance.Registry.PIDPartition0)
    :ok = :sys.suspend(partition)

    try do
      log =
        ExUnit.CaptureLog.capture_log(fn ->
          task = Task.async(fn -> AgentAcceptance.delete(agent_id) end)
          assert Task.yield(task, 2_000) == {:ok, :ok}
        end)

      assert log =~ "Registry entry did not clear"
    after
      :sys.resume(partition)
    end
  end
end
