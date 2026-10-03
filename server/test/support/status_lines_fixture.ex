defmodule KaoiroServer.StatusLinesFixture do
  @moduledoc """
  Helpers for tests of `KaoiroServer.AgentStatusLines`. Test-only —
  `test/support` is compiled in `:test` alone.

  An isolated store gets its own process, DETS, ETS and temporary-ETS names and
  its own file, so cases do not share state and none of them touches the
  application's singleton. Atoms are created per store; the test suite starts a
  bounded number of them.
  """

  import ExUnit.Callbacks, only: [on_exit: 1]

  alias KaoiroServer.{AgentStatusLines, TestTeardown, TokenDenylist}

  @fallback %{retention: 20, source: :default}

  @doc "Fresh names and a file path for one store."
  def names do
    n = System.unique_integer([:positive])

    %{
      name: :"asl_#{n}",
      table: :"asl_ets_#{n}",
      building: :"asl_build_#{n}",
      path: Path.join([System.tmp_dir!(), "kaoiro_test_dets", "asl_#{n}.dets"])
    }
  end

  @doc """
  Starts an isolated store linked to the test and stops it at teardown. Pass
  `:path` (plus the names from a previous store) to reopen an existing file;
  otherwise the file starts empty.
  """
  def start_store(overrides \\ []) do
    ctx = Map.merge(names(), Map.new(Keyword.take(overrides, [:name, :table, :building, :path])))
    if not Keyword.has_key?(overrides, :path), do: File.rm(ctx.path)
    ctx = Map.put_new(ctx, :denylist, Keyword.get_lazy(overrides, :denylist, &start_denylist/0))
    {:ok, pid} = AgentStatusLines.start_link(opts(ctx, overrides))

    on_exit(fn ->
      TestTeardown.stop_quietly(pid)
      File.rm(ctx.path)
    end)

    Map.put(ctx, :pid, pid)
  end

  @doc """
  An isolated `TokenDenylist` holding `ids`, stopped at teardown. Every store
  reads one at start, so a test never depends on the application's own.
  """
  def start_denylist(ids \\ []) do
    n = System.unique_integer([:positive])
    name = :"asl_denylist_#{n}"
    path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "asl_denylist_#{n}.dets"])
    File.rm(path)
    {:ok, pid} = TokenDenylist.start_link(name: name, path: path)

    on_exit(fn ->
      TestTeardown.stop_quietly(pid)
      File.rm(path)
    end)

    Enum.each(ids, &(:ok = TokenDenylist.revoke(&1, nil, name)))
    name
  end

  @doc "The `start_link` options for `ctx`, with `overrides` on top."
  def opts(ctx, overrides \\ []) do
    base = [
      name: ctx.name,
      table: ctx.table,
      building: ctx.building,
      path: ctx.path,
      fallback: @fallback,
      denylist: Map.get_lazy(ctx, :denylist, &start_denylist/0),
      # The test node's Endpoint is always up; an isolated store behaves like a
      # first boot unless a test says otherwise.
      endpoint_up?: fn -> false end
    ]

    Keyword.merge(base, Keyword.drop(overrides, [:name, :table, :building]))
  end

  @doc "Stops the store and waits until DETS has released its table."
  def stop_store(%{pid: pid, name: name}) do
    TestTeardown.stop_quietly(pid)
    wait_dets_closed(name)
  end

  @doc """
  DETS releases a table when its owner's exit is processed, which is
  asynchronous. Waits for that, within a bounded number of polls, so a restart
  that follows is not refused for a reason unrelated to the test.
  """
  def wait_dets_closed(name, polls \\ 500) do
    cond do
      :dets.info(name) == :undefined ->
        :ok

      polls == 0 ->
        raise "DETS table #{inspect(name)} was not released"

      true ->
        Process.sleep(2)
        wait_dets_closed(name, polls - 1)
    end
  end

  @doc """
  Polls `fun` until it returns a truthy value, for effects that reach this
  process through another one (a table disappearing with its owner, a mailbox
  filling). Raises after a bounded number of polls instead of waiting forever.
  """
  def eventually(fun, polls \\ 1_000) do
    cond do
      fun.() ->
        :ok

      polls == 0 ->
        raise "condition not reached"

      true ->
        Process.sleep(2)
        eventually(fun, polls - 1)
    end
  end

  @doc """
  Restarts a stopped supervised child once DETS has released the table. A child
  that is already running (a restore in `on_exit` after a test that never
  stopped it) is left alone. Any other error is returned so the caller fails on
  it.
  """
  def restart_child(supervisor, child_id, dets_name) do
    if running?(supervisor, child_id) do
      {:ok, :running}
    else
      wait_dets_closed(dets_name)
      Supervisor.restart_child(supervisor, child_id)
    end
  end

  defp running?(supervisor, child_id) do
    Enum.any?(Supervisor.which_children(supervisor), fn
      {^child_id, pid, _type, _modules} -> is_pid(pid)
      _other -> false
    end)
  end

  @doc """
  What is on disk right now, read from a COPY of the file opened under another
  name. Call it only after a reply, with nothing else writing: a pre-sync copy
  is not a committed snapshot, and a second handle on the live file would make
  DETS repair it under its owner.
  """
  def disk(path) do
    copy = "#{path}.probe-#{System.unique_integer([:positive])}"
    :ok = File.cp(path, copy)
    probe = :"asl_probe_#{System.unique_integer([:positive])}"
    {:ok, ^probe} = :dets.open_file(probe, file: String.to_charlist(copy))
    records = :dets.match_object(probe, :_)
    :dets.close(probe)
    File.rm(copy)

    Enum.reduce(records, %{retention: nil, agents: %{}, other: []}, fn
      {:retention, n}, acc -> %{acc | retention: n}
      {{:agent, id}, entries}, acc -> put_in(acc.agents[id], entries)
      other, acc -> %{acc | other: [other | acc.other]}
    end)
  end

  @doc """
  Writes records straight into a DETS file with no store running, for tests that
  seed a file the way an older or damaged deployment would have left it.
  """
  def seed(path, records) do
    File.mkdir_p!(Path.dirname(path))
    probe = :"asl_seed_#{System.unique_integer([:positive])}"
    {:ok, ^probe} = :dets.open_file(probe, file: String.to_charlist(path), type: :set)
    Enum.each(records, &(:ok = :dets.insert(probe, &1)))
    :ok = :dets.close(probe)
  end

  @doc "An entry as the store keeps it."
  def entry(seq, text, updated_at \\ nil) do
    %{seq: seq, text: text, updated_at: updated_at || stamp(seq)}
  end

  @doc "A stable, increasing `updated_at` for seeded entries."
  def stamp(seq) do
    base = ~U[2026-10-01 00:00:00.000000Z]
    base |> DateTime.add(seq, :second) |> DateTime.to_iso8601()
  end

  @doc """
  A `:sync_fun` whose behaviour the test switches. Modes: `:real`,
  `{:error, term}`, `:raise`, `:exit`.
  """
  def switchable_sync do
    {:ok, flag} = Agent.start_link(fn -> :real end)

    fun = fn table ->
      case Agent.get(flag, & &1) do
        :real -> :dets.sync(table)
        {:error, _} = error -> error
        :raise -> raise "injected sync failure"
        :exit -> exit(:injected_sync_exit)
      end
    end

    {flag, fun}
  end

  def set_sync(flag, mode), do: Agent.update(flag, fn _ -> mode end)

  @doc """
  A `:sync_fun` that announces itself and blocks until the test releases it.
  The first call is the start-up sync every start makes, and it passes
  through.
  """
  def blocking_sync(test_pid) do
    fn table ->
      if Process.get(:asl_start_sync_done) do
        send(test_pid, {:sync_blocked, self()})

        receive do
          :release_sync -> :dets.sync(table)
        end
      else
        Process.put(:asl_start_sync_done, true)
        :dets.sync(table)
      end
    end
  end

  @doc "A `:sync_fun` that reports each call to the test, then syncs for real."
  def counting_sync(test_pid) do
    fn table ->
      send(test_pid, {:sync_called, table})
      :dets.sync(table)
    end
  end

  @doc """
  Puts the application's own store back to "no stored retention pick". A test
  that stored one would otherwise change the starting state of every later
  module; the store offers no client path to unset it, so the record and the
  owner's copy are reset directly.
  """
  def reset_app_retention(name \\ AgentStatusLines, default \\ 20) do
    :ok = :dets.delete(name, :retention)
    :ok = :dets.sync(name)
    :sys.replace_state(name, fn state -> %{state | retention: default, source: :default} end)
    :ok
  end

  @doc "A `:broadcast` that forwards every event to the test process."
  def forward_broadcast(test_pid) do
    fn event, payload -> send(test_pid, {:broadcast, event, payload}) end
  end
end
