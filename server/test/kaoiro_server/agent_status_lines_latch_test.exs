defmodule KaoiroServer.AgentStatusLinesLatchTest do
  # A write that fails, or raises, or exits, must leave the store fail-closed:
  # nothing published, history and further writes refused, the last committed
  # rows still served. There is no live recovery; a restarted child reads the
  # disk (issue 482 design r6 section 2.3, r8 section 3).
  use ExUnit.Case, async: true

  import ExUnit.CaptureLog

  alias KaoiroServer.AgentStatusLines
  alias KaoiroServer.StatusLinesFixture, as: Fixture

  # A bogus DETS name makes the store's own DETS call raise `ArgumentError`:
  # this is the "a DETS step raises" case, which a failing `:sync_fun` does not
  # reach.
  @failures [
    {"sync returns an error", {:error, :enospc}},
    {"sync raises", :raise},
    {"sync exits", :exit},
    {"a DETS step raises", :dets_raises}
  ]

  @operations [
    put: "put at full retention",
    clear: "clear",
    retention: "retention 20 to 5",
    purge: "purge"
  ]

  setup do
    {flag, sync} = Fixture.switchable_sync()
    ctx = Fixture.start_store(sync_fun: sync, broadcast: Fixture.forward_broadcast(self()))
    AgentStatusLines.set_retention(5, ctx.name)

    for agent <- ["a.one", "a.two"], n <- 1..5 do
      {:ok, _} = AgentStatusLines.put(agent, "#{agent} text #{n}", ctx.name)
    end

    flush()
    {:ok, committed} = AgentStatusLines.heads(ctx.table)
    %{ctx: ctx, flag: flag, committed: committed}
  end

  for {op, label} <- @operations, {kind, failure} <- @failures do
    test "#{label}: #{kind} latches the store and publishes nothing",
         %{ctx: ctx, flag: flag, committed: committed} do
      fail(ctx, flag, unquote(Macro.escape(failure)))

      log = capture_log(fn -> send(self(), {:reply, run(unquote(op), ctx)}) end)
      assert_received {:reply, reply}

      assert reply == {:error, :status_line_unavailable}
      refute log =~ "a.one text"

      # The disk is healthy again, yet the store stays fail-closed: only a
      # restart of the child may lift it. Without this the injected failure
      # would keep refusing every write and hide a missing dirty gate.
      Fixture.set_sync(flag, :real)

      # Nothing was published or announced.
      assert {:ok, ^committed} = AgentStatusLines.heads(ctx.table)
      refute_received {:broadcast, _, _}

      # The store is fail-closed, but the last committed lines are still served.
      assert {:error, :status_line_unavailable} = AgentStatusLines.history("a.one", ctx.name)
      assert {:error, :status_line_unavailable} = AgentStatusLines.latest("a.one", ctx.name)
      assert {:error, :status_line_unavailable} = AgentStatusLines.put("a.one", "x", ctx.name)
      assert {:error, :status_line_unavailable} = AgentStatusLines.purge("a.two", ctx.name)
      assert {:error, :status_line_unavailable} = AgentStatusLines.set_retention(3, ctx.name)

      assert {:ok, %{entry: %{text: "a.one text 5"}}} =
               AgentStatusLines.read_latest("a.one", ctx.table)

      # Settings are not lines: the committed retention is still reported.
      assert {:ok, %{retention: 5}} = AgentStatusLines.settings(ctx.name)
    end
  end

  test "the log names the operation and the agent and never the text", %{ctx: ctx, flag: flag} do
    Fixture.set_sync(flag, {:error, :enospc})

    log = capture_log(fn -> AgentStatusLines.put("a.one", "secret words", ctx.name) end)

    assert log =~ "put failed for a.one"
    assert log =~ "enospc"
    refute log =~ "secret words"
  end

  test "a restarted child reads the disk, publishes what is there and writes again", %{
    ctx: ctx,
    flag: flag
  } do
    Fixture.set_sync(flag, {:error, :enospc})

    capture_log(fn -> AgentStatusLines.put("a.one", "candidate", ctx.name) end)
    assert {:error, :status_line_unavailable} = AgentStatusLines.history("a.one", ctx.name)

    # The failed write reached the DETS buffer, and now the disk is reachable
    # again: the new process cannot tell, so it publishes whatever is on disk.
    Fixture.stop_store(ctx)
    again = Fixture.start_store(path: ctx.path, fallback: %{retention: 20, source: :default})

    on_disk = Fixture.disk(again.path).agents["a.one"]
    assert {:ok, %{entry: latest}} = AgentStatusLines.read_latest("a.one", again.table)
    assert latest == hd(on_disk)

    assert {:ok, %{seq: seq}} = AgentStatusLines.put("a.one", "after", again.name)
    assert seq == latest.seq + 1
    assert {:ok, [%{text: "after"} | _]} = AgentStatusLines.history("a.one", again.name)
  end

  defp fail(ctx, flag, :dets_raises) do
    :sys.replace_state(ctx.pid, fn state -> %{state | name: :asl_no_such_table} end)
    Fixture.set_sync(flag, :real)
  end

  defp fail(_ctx, flag, mode), do: Fixture.set_sync(flag, mode)

  defp run(:put, ctx), do: AgentStatusLines.put("a.one", "candidate", ctx.name)
  defp run(:clear, ctx), do: AgentStatusLines.put("a.one", "", ctx.name)
  defp run(:retention, ctx), do: AgentStatusLines.set_retention(2, ctx.name)
  defp run(:purge, ctx), do: AgentStatusLines.purge("a.one", ctx.name)

  defp flush do
    receive do
      {:broadcast, _, _} -> flush()
    after
      0 -> :ok
    end
  end
end
