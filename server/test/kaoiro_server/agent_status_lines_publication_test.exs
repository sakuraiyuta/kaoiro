defmodule KaoiroServer.AgentStatusLinesPublicationTest do
  # The public ETS name must exist only for a complete view, so a restarted
  # child never shows a reader a half-built table (issue 482 design r9 section
  # 1), and a reader must follow the name across a restart (C2). Every case
  # here runs a real store on a real file with its own names and options from
  # the fixture; a case injects a hook only where it says so. The application's
  # own store, with no injected option, is covered by agent_status_lines_app_test.
  use ExUnit.Case, async: true

  alias KaoiroServer.AgentStatusLines
  alias KaoiroServer.StatusLinesFixture, as: Fixture
  alias KaoiroServer.TestTeardown
  alias KaoiroServer.TestTimeouts

  # A stopped store whose file holds `n` agents, ready to be started again.
  defp seeded(n) do
    ctx = Fixture.start_store()
    for i <- 1..n, do: {:ok, _} = AgentStatusLines.put("a.#{i}", "line #{i}", ctx.name)
    {:ok, heads} = AgentStatusLines.heads(ctx.table)
    Fixture.stop_store(ctx)
    {ctx, heads}
  end

  # Starts a store from a process that outlives the call, so a test can hold
  # `init/1` open without blocking itself.
  defp start_async(ctx, extra) do
    parent = self()

    holder =
      spawn(fn ->
        Process.flag(:trap_exit, true)
        send(parent, {:started, AgentStatusLines.start_link(Fixture.opts(ctx, extra))})

        receive do
          :stop -> :ok
        end
      end)

    on_exit(fn -> send(holder, :stop) end)
    holder
  end

  defp hold_table(name) do
    parent = self()

    pid =
      spawn(fn ->
        :ets.new(name, [:named_table, :public, :set])
        :ets.insert(name, {:foreign, 1})
        send(parent, {:held, name})

        receive do
          :stop -> :ok
        end
      end)

    assert_receive {:held, ^name}, TestTimeouts.store_step()
    on_exit(fn -> send(pid, :stop) end)
    pid
  end

  describe "phase C" do
    test "readers see an unavailable store, never a partial view, until the rename" do
      {ctx, heads} = seeded(4)
      parent = self()

      hook = fn point ->
        send(parent, {:phase_c, point, self()})

        receive do
          :continue -> :ok
        end
      end

      start_async(ctx, phase_c_hook: hook)

      for point <- [:after_create, :after_half_rows] do
        assert_receive {:phase_c, ^point, store}, TestTimeouts.store_step()

        assert :unavailable = AgentStatusLines.heads(ctx.table)
        assert :unavailable = AgentStatusLines.read_latest("a.1", ctx.table)
        assert :ets.whereis(ctx.table) == :undefined
        assert :ets.whereis(ctx.building) != :undefined

        send(store, :continue)
      end

      assert_receive {:started, {:ok, pid}}, TestTimeouts.store_step()
      on_exit(fn -> TestTeardown.stop_quietly(pid) end)

      assert {:ok, ^heads} = AgentStatusLines.heads(ctx.table)
      assert :ets.whereis(ctx.building) == :undefined
    end

    test "a raise after half the rows publishes nothing and leaves no table behind" do
      {ctx, _heads} = seeded(4)
      Process.flag(:trap_exit, true)

      hook = fn
        :after_half_rows -> raise "phase C failed"
        _point -> :ok
      end

      assert {:error, {%RuntimeError{message: "phase C failed"}, _stack}} =
               AgentStatusLines.start_link(Fixture.opts(ctx, phase_c_hook: hook))

      assert :unavailable = AgentStatusLines.heads(ctx.table)
      Fixture.eventually(fn -> :ets.whereis(ctx.building) == :undefined end)
      assert :ets.whereis(ctx.table) == :undefined
    end

    test "a foreign table under the temporary name stops init and is left alone" do
      {ctx, _heads} = seeded(2)
      foreign = hold_table(ctx.building)
      Process.flag(:trap_exit, true)

      assert {:error, {:badarg, _stack}} = AgentStatusLines.start_link(Fixture.opts(ctx))

      assert :ets.info(ctx.building, :owner) == foreign
      assert :ets.tab2list(ctx.building) == [foreign: 1]
      assert :ets.whereis(ctx.table) == :undefined
    end

    test "a foreign table under the public name stops init and is left alone" do
      {ctx, _heads} = seeded(2)
      foreign = hold_table(ctx.table)
      Process.flag(:trap_exit, true)

      assert {:error, {:badarg, _stack}} = AgentStatusLines.start_link(Fixture.opts(ctx))

      assert :ets.info(ctx.table, :owner) == foreign
      assert :ets.tab2list(ctx.table) == [foreign: 1]
      Fixture.eventually(fn -> :ets.whereis(ctx.building) == :undefined end)
    end
  end

  describe "a supervised child restarted with the fixture's names and options" do
    # The reader below is started against the old owner and kept alive through
    # the restart. A reader that held on to a table id, instead of resolving the
    # name on each call, would stay unavailable forever once the old owner is
    # gone, so it would never see the full view again. There are two readers of
    # the public table, `heads/1` (the join snapshot, the cards) and
    # `read_latest/2` (the announcer, the visibility check), and each is held
    # to it separately.
    for {reader, label} <- [heads: "heads/1", read_latest: "read_latest/2"] do
      test "a continuing #{label} reader sees unavailable or the full view, and converges" do
        {ctx, heads} = seeded(3)

        {read, full} = reader_for(unquote(reader), ctx, heads)

        {:ok, sup} =
          Supervisor.start_link(
            [%{id: :store, start: {AgentStatusLines, :start_link, [Fixture.opts(ctx)]}}],
            strategy: :one_for_one
          )

        on_exit(fn -> TestTeardown.stop_quietly(sup) end)

        reader = spawn_link(fn -> read_loop(read, full, %{}) end)
        assert_seen(reader, :full)

        :ok = Supervisor.terminate_child(sup, :store)
        assert_seen(reader, :unavailable)

        reset(reader)
        assert {:ok, _} = Fixture.restart_child(sup, :store, ctx.name)
        assert_seen(reader, :full)

        assert report(reader) |> Map.keys() |> Enum.all?(&(&1 in [:full, :unavailable]))
        assert read.() == full
      end
    end
  end

  describe "a failure after the rename" do
    # `endpoint_up?` is read in phase D, after the public name exists, so a raise
    # there fails `init/1` with the complete view already readable.
    test "readers saw the complete view while init was held, and nothing is served once it fails" do
      {ctx, heads} = seeded(3)
      parent = self()

      endpoint_up? = fn ->
        send(parent, {:phase_d, self()})

        receive do
          :continue -> raise "phase D failed"
        end
      end

      start_async(ctx, endpoint_up?: endpoint_up?)
      assert_receive {:phase_d, store}, TestTimeouts.store_step()

      assert {:ok, ^heads} = AgentStatusLines.heads(ctx.table)
      assert {:ok, heads["a.1"]} == AgentStatusLines.read_latest("a.1", ctx.table)
      assert :ets.whereis(ctx.building) == :undefined

      queued = Task.async(fn -> AgentStatusLines.settings(ctx.name) end)

      Fixture.eventually(fn ->
        Process.info(store, :message_queue_len) == {:message_queue_len, 1}
      end)

      send(store, :continue)

      assert_receive {:started, {:error, {%RuntimeError{message: "phase D failed"}, _stack}}},
                     TestTimeouts.store_step()

      assert :unavailable = Task.await(queued)
      Fixture.eventually(fn -> :ets.whereis(ctx.table) == :undefined end)
      assert :unavailable = AgentStatusLines.heads(ctx.table)
      assert :unavailable = AgentStatusLines.read_latest("a.1", ctx.table)
      assert {:error, :status_line_unavailable} = AgentStatusLines.latest("a.1", ctx.name)
      assert {:error, :status_line_unavailable} = AgentStatusLines.history("a.1", ctx.name)
    end
  end

  describe "an owner that dies during a call" do
    for {reason, label} <- [shutdown: "is shut down", kill: "is killed"] do
      test "every queued owner call returns unavailable when the owner #{label}" do
        Process.flag(:trap_exit, true)

        ctx = Fixture.start_store(sync_fun: Fixture.blocking_sync(self()))
        writer = Task.async(fn -> AgentStatusLines.put("a.one", "new", ctx.name) end)
        assert_receive {:sync_blocked, _sync}, TestTimeouts.store_step()

        queued = [
          Task.async(fn -> AgentStatusLines.settings(ctx.name) end),
          Task.async(fn -> AgentStatusLines.latest("a.one", ctx.name) end),
          Task.async(fn -> AgentStatusLines.history("a.one", ctx.name) end),
          Task.async(fn -> AgentStatusLines.purge("a.one", ctx.name) end)
        ]

        Fixture.eventually(fn ->
          Process.info(ctx.pid, :message_queue_len) == {:message_queue_len, 4}
        end)

        Process.exit(ctx.pid, unquote(reason))

        assert [:unavailable, unavailable, unavailable, unavailable] =
                 Enum.map(queued, &Task.await/1)

        assert unavailable == {:error, :status_line_unavailable}
        assert {:error, :status_line_unavailable} = Task.await(writer)
      end
    end
  end

  # One call of a reader of the public table, and what it returns for a
  # complete view.
  defp reader_for(:heads, ctx, heads),
    do: {fn -> AgentStatusLines.heads(ctx.table) end, {:ok, heads}}

  defp reader_for(:read_latest, ctx, heads),
    do: {fn -> AgentStatusLines.read_latest("a.1", ctx.table) end, {:ok, heads["a.1"]}}

  defp read_loop(read, expected, seen) do
    receive do
      {:report, from} ->
        send(from, {:seen, seen})
        read_loop(read, expected, seen)

      :reset ->
        read_loop(read, expected, %{})
    after
      0 ->
        outcome =
          case read.() do
            ^expected -> :full
            :unavailable -> :unavailable
            other -> {:bad, other}
          end

        read_loop(read, expected, Map.update(seen, outcome, 1, &(&1 + 1)))
    end
  end

  defp report(reader) do
    send(reader, {:report, self()})
    assert_receive {:seen, seen}, TestTimeouts.store_step()
    seen
  end

  defp reset(reader), do: send(reader, :reset)

  defp assert_seen(reader, outcome) do
    Fixture.eventually(fn -> Map.has_key?(report(reader), outcome) end)
  end
end
