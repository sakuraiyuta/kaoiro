defmodule KaoiroServer.AgentStatusLinesDurabilityTest do
  # Why a copy and not a restart: closing a DETS table on a clean shutdown
  # flushes it, so a restart test cannot see a missing `:dets.sync/1`. The file
  # is therefore read through a COPY taken after the reply while the store is
  # still running, the way the issue 504 probes do. A copy taken before the
  # sync is not a committed snapshot, so no case here takes one.
  use ExUnit.Case, async: true

  alias KaoiroServer.AgentStatusLines
  alias KaoiroServer.StatusLinesFixture, as: Fixture
  alias KaoiroServer.TestTimeouts

  describe "the file is current when the reply arrives" do
    setup do
      %{ctx: Fixture.start_store()}
    end

    test "after put", %{ctx: ctx} do
      assert {:ok, _} = AgentStatusLines.put("a.one", "on disk", ctx.name)

      assert %{agents: %{"a.one" => [%{seq: 1, text: "on disk"}]}} = Fixture.disk(ctx.path)
    end

    test "after clear", %{ctx: ctx} do
      AgentStatusLines.put("a.one", "working", ctx.name)
      assert {:ok, %{status: :clear}} = AgentStatusLines.put("a.one", " ", ctx.name)

      assert %{agents: %{"a.one" => [%{seq: 2, text: nil}, %{seq: 1, text: "working"}]}} =
               Fixture.disk(ctx.path)
    end

    test "after a retention change", %{ctx: ctx} do
      for n <- 1..6, do: AgentStatusLines.put("a.one", "text #{n}", ctx.name)
      assert {:ok, _} = AgentStatusLines.set_retention(2, ctx.name)

      disk = Fixture.disk(ctx.path)
      assert disk.retention == 2
      assert Enum.map(disk.agents["a.one"], & &1.seq) == [6, 5]
    end

    test "after purge", %{ctx: ctx} do
      AgentStatusLines.put("a.one", "one", ctx.name)
      AgentStatusLines.put("a.two", "two", ctx.name)
      assert :ok = AgentStatusLines.purge("a.one", ctx.name)

      assert Map.keys(Fixture.disk(ctx.path).agents) == ["a.two"]
    end
  end

  describe "while the sync is blocked" do
    setup do
      ctx =
        Fixture.start_store(
          sync_fun: Fixture.blocking_sync(self()),
          broadcast: Fixture.forward_broadcast(self())
        )

      %{ctx: ctx}
    end

    test "nothing is published, broadcast or readable until it returns :ok", %{ctx: ctx} do
      writer = Task.async(fn -> AgentStatusLines.put("a.one", "new", ctx.name) end)
      assert_receive {:sync_blocked, sync_pid}, TestTimeouts.store_step()

      # Frequent readers answer at once, with the old state.
      assert {:ok, nil} = AgentStatusLines.read_latest("a.one", ctx.table)
      assert {:ok, %{}} = AgentStatusLines.heads(ctx.table)
      refute_received {:broadcast, _, _}

      # History is ordered behind the write in flight.
      reader = Task.async(fn -> AgentStatusLines.history("a.one", ctx.name) end)
      assert Task.yield(reader, 50) == nil

      send(sync_pid, :release_sync)

      assert {:ok, %{status: :set, seq: 1}} = Task.await(writer)
      assert {:ok, [%{seq: 1, text: "new"}]} = Task.await(reader)
      assert {:ok, %{entry: %{text: "new"}}} = AgentStatusLines.read_latest("a.one", ctx.table)

      assert_receive {:broadcast, "status_line", %{"agent_id" => "a.one", "seq" => 1}},
                     TestTimeouts.store_step()
    end
  end
end
