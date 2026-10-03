defmodule KaoiroServer.AgentStatusLinesTest do
  use ExUnit.Case, async: true

  import ExUnit.CaptureLog

  alias KaoiroServer.AgentStatusLines
  alias KaoiroServer.StatusLinesFixture, as: Fixture

  setup do
    ctx = Fixture.start_store(broadcast: Fixture.forward_broadcast(self()))
    %{ctx: ctx}
  end

  defp put(ctx, id, text), do: AgentStatusLines.put(id, text, ctx.name)
  defp latest(ctx, id), do: AgentStatusLines.read_latest(id, ctx.table)
  defp history(ctx, id), do: AgentStatusLines.history(id, ctx.name)

  describe "an empty store" do
    test "has no line, no history and the fallback retention", %{ctx: ctx} do
      assert {:ok, nil} = latest(ctx, "a.one")
      assert {:ok, %{}} = AgentStatusLines.heads(ctx.table)
      assert {:ok, []} = history(ctx, "a.one")
      assert {:ok, nil} = AgentStatusLines.latest("a.one", ctx.name)

      assert {:ok, %{retention: 20, source: :default, min: 1, max: 100}} =
               AgentStatusLines.settings(ctx.name)
    end
  end

  describe "put" do
    test "stores the line, publishes its head and broadcasts it", %{ctx: ctx} do
      assert {:ok, %{status: :set, seq: 1, bytes: 11, truncated: false, updated_at: at}} =
               put(ctx, "a.one", "# Reviewing")

      assert {:ok, %{entry: %{seq: 1, text: "# Reviewing", updated_at: ^at}} = row} =
               latest(ctx, "a.one")

      assert row.head == "# Reviewing"
      assert row.truncated == false
      assert row.bytes == 11

      assert_receive {:broadcast, "status_line",
                      %{
                        "agent_id" => "a.one",
                        "seq" => 1,
                        "head" => "# Reviewing",
                        "truncated" => false,
                        "bytes" => 11,
                        "updated_at" => ^at
                      }}
    end

    test "a long line keeps its full text in history and only the head in the row", %{ctx: ctx} do
      text = String.duplicate("あ", 1_000)

      assert {:ok, %{status: :set, bytes: 3_000, truncated: true}} = put(ctx, "a.one", text)

      assert {:ok, %{head: head, truncated: true, bytes: 3_000}} = latest(ctx, "a.one")
      assert byte_size(head) == 510
      assert String.starts_with?(text, head)

      assert {:ok, [%{text: ^text}]} = history(ctx, "a.one")
      assert {:ok, %{entry: %{text: ^text}}} = AgentStatusLines.latest("a.one", ctx.name)
    end

    test "numbers entries per agent and lists them newest first", %{ctx: ctx} do
      for text <- ["one", "two", "three"], do: put(ctx, "a.one", text)
      put(ctx, "a.two", "other")

      assert {:ok, [%{seq: 3, text: "three"}, %{seq: 2, text: "two"}, %{seq: 1, text: "one"}]} =
               history(ctx, "a.one")

      assert {:ok, [%{seq: 1, text: "other"}]} = history(ctx, "a.two")
    end

    test "rejects invalid input and leaves the previous line standing", %{ctx: ctx} do
      put(ctx, "a.one", "kept")
      assert_receive {:broadcast, "status_line", _}

      assert {:error, :invalid_status_line} = put(ctx, "a.one", 42)
      assert {:error, :invalid_status_line} = put(ctx, "a.one", <<0xFF>>)
      assert {:error, :status_line_invalid_characters} = put(ctx, "a.one", "bad\e")

      assert {:error, {:status_line_too_large, 16_385}} =
               put(ctx, "a.one", String.duplicate("a", 16_385))

      assert {:ok, %{entry: %{seq: 1, text: "kept"}}} = latest(ctx, "a.one")
      assert {:ok, [%{seq: 1}]} = history(ctx, "a.one")
      refute_receive {:broadcast, _, _}
    end

    # The commit stands once the sync returned; a subscriber that cannot be
    # reached must not turn it into a failure or latch the store.
    test "a broadcast that raises, throws or exits never undoes the commit" do
      failing = [
        fn _event, _payload -> raise "subscriber failed" end,
        fn _event, _payload -> throw(:subscriber_failed) end,
        fn _event, _payload -> exit(:subscriber_failed) end
      ]

      capture_log(fn ->
        for broadcast <- failing do
          isolated = Fixture.start_store(broadcast: broadcast)

          assert {:ok, %{seq: 1}} = put(isolated, "a.one", "kept")
          assert {:ok, %{entry: %{text: "kept"}}} = latest(isolated, "a.one")
          assert {:ok, [%{text: "kept"}]} = history(isolated, "a.one")
          assert {:ok, %{seq: 2}} = put(isolated, "a.one", "still writable")
        end
      end)
    end

    test "a text is stored trimmed and with LF line endings", %{ctx: ctx} do
      put(ctx, "a.one", "  first\r\nsecond \n")

      assert {:ok, [%{text: "first\nsecond"}]} = history(ctx, "a.one")
    end
  end

  describe "clear" do
    test "is an entry with no text and publishes an empty head", %{ctx: ctx} do
      put(ctx, "a.one", "working")
      assert_receive {:broadcast, "status_line", _}

      assert {:ok, %{status: :clear, seq: 2, updated_at: at}} = put(ctx, "a.one", "  \n ")

      assert {:ok, %{entry: %{seq: 2, text: nil}, head: "", truncated: false, bytes: 0}} =
               latest(ctx, "a.one")

      assert {:ok, [%{seq: 2, text: nil}, %{seq: 1, text: "working"}]} = history(ctx, "a.one")

      assert_receive {:broadcast, "status_line",
                      %{"agent_id" => "a.one", "seq" => 2, "cleared" => true, "updated_at" => ^at}}
    end
  end

  describe "retention" do
    test "the change log keeps only the newest entries", %{ctx: ctx} do
      assert {:ok, _} = AgentStatusLines.set_retention(3, ctx.name)
      for n <- 1..5, do: put(ctx, "a.one", "text #{n}")

      assert {:ok, [%{seq: 5}, %{seq: 4}, %{seq: 3}]} = history(ctx, "a.one")
    end

    test "lowering it prunes every agent at once and never touches the latest", %{ctx: ctx} do
      for n <- 1..8, do: put(ctx, "a.one", "one #{n}")
      for n <- 1..2, do: put(ctx, "a.two", "two #{n}")
      before = AgentStatusLines.heads(ctx.table)
      flush_broadcasts()

      assert {:ok, %{retention: 5, source: :stored}} = AgentStatusLines.set_retention(5, ctx.name)

      assert {:ok, [%{seq: 8}, %{seq: 7}, %{seq: 6}, %{seq: 5}, %{seq: 4}]} =
               history(ctx, "a.one")

      assert {:ok, [%{seq: 2}, %{seq: 1}]} = history(ctx, "a.two")
      assert AgentStatusLines.heads(ctx.table) == before

      assert_receive {:broadcast, "status_line_settings",
                      %{"retention" => 5, "source" => "stored", "min" => 1, "max" => 100}}

      assert Fixture.disk(ctx.path).agents["a.one"] |> length() == 5
    end

    test "raising it does not bring pruned entries back", %{ctx: ctx} do
      for n <- 1..6, do: put(ctx, "a.one", "text #{n}")
      assert {:ok, _} = AgentStatusLines.set_retention(2, ctx.name)
      assert {:ok, _} = AgentStatusLines.set_retention(10, ctx.name)

      assert {:ok, [%{seq: 6}, %{seq: 5}]} = history(ctx, "a.one")
    end

    test "rejects a pick outside 1..100 and keeps the previous one", %{ctx: ctx} do
      assert {:ok, _} = AgentStatusLines.set_retention(7, ctx.name)

      for bad <- [0, -1, 101, 7.0, "7", nil, :seven, [7]] do
        assert {:error, :invalid_status_line_retention} =
                 AgentStatusLines.set_retention(bad, ctx.name),
               "expected #{inspect(bad)} to be rejected"
      end

      assert {:ok, %{retention: 7, source: :stored}} = AgentStatusLines.settings(ctx.name)
      assert {:ok, _} = AgentStatusLines.set_retention(1, ctx.name)
      assert {:ok, _} = AgentStatusLines.set_retention(100, ctx.name)
    end

    test "the fallback names its source until a pick is stored" do
      ctx = Fixture.start_store(fallback: %{retention: 7, source: :env})

      assert {:ok, %{retention: 7, source: :env}} = AgentStatusLines.settings(ctx.name)
      assert {:ok, %{retention: 4, source: :stored}} = AgentStatusLines.set_retention(4, ctx.name)
    end
  end

  describe "updated_at" do
    test "has fixed microsecond precision and strictly increases when the clock steps back" do
      {:ok, clock} =
        Agent.start_link(fn -> [~U[2026-10-03 12:00:00Z], ~U[2026-10-03 11:59:55Z]] end)

      next = fn ->
        Agent.get_and_update(clock, fn [t | rest] ->
          {t, rest ++ [DateTime.add(t, -1, :second)]}
        end)
      end

      ctx = Fixture.start_store(clock: next)

      assert {:ok, %{updated_at: first}} = put(ctx, "a.one", "one")
      assert {:ok, %{updated_at: second}} = put(ctx, "a.one", "two")
      assert {:ok, %{updated_at: third}} = put(ctx, "a.one", "three")

      assert first == "2026-10-03T12:00:00.000000Z"
      assert second == "2026-10-03T12:00:00.000001Z"
      assert third == "2026-10-03T12:00:00.000002Z"
    end

    test "follows the clock when it is ahead of the previous entry" do
      {:ok, clock} =
        Agent.start_link(fn -> [~U[2026-10-03 12:00:00Z], ~U[2026-10-03 12:30:00.5Z]] end)

      next = fn -> Agent.get_and_update(clock, fn [t | rest] -> {t, rest ++ [t]} end) end
      ctx = Fixture.start_store(clock: next)

      put(ctx, "a.one", "one")
      assert {:ok, %{updated_at: "2026-10-03T12:30:00.500000Z"}} = put(ctx, "a.one", "two")
    end
  end

  describe "purge" do
    test "drops the record and the published row", %{ctx: ctx} do
      put(ctx, "a.one", "one")
      put(ctx, "a.two", "two")

      assert :ok = AgentStatusLines.purge("a.one", ctx.name)

      assert {:ok, nil} = latest(ctx, "a.one")
      assert {:ok, []} = history(ctx, "a.one")
      assert {:ok, %{entry: %{text: "two"}}} = latest(ctx, "a.two")
      refute Map.has_key?(Fixture.disk(ctx.path).agents, "a.one")
    end

    test "an unknown agent is not an error and a new line restarts at seq 1", %{ctx: ctx} do
      assert :ok = AgentStatusLines.purge("a.never", ctx.name)

      put(ctx, "a.one", "one")
      put(ctx, "a.one", "two")
      assert :ok = AgentStatusLines.purge("a.one", ctx.name)
      assert {:ok, %{seq: 1}} = put(ctx, "a.one", "again")
    end
  end

  describe "restart" do
    test "reloads lines, settings and the sequence from disk", %{ctx: ctx} do
      put(ctx, "a.one", "one")
      put(ctx, "a.one", "two")
      put(ctx, "a.two", "other")
      assert {:ok, _} = AgentStatusLines.set_retention(9, ctx.name)
      {:ok, heads} = AgentStatusLines.heads(ctx.table)

      Fixture.stop_store(ctx)
      assert :unavailable = AgentStatusLines.heads(ctx.table)

      again = Fixture.start_store(path: ctx.path, fallback: %{retention: 20, source: :default})

      assert {:ok, ^heads} = AgentStatusLines.heads(again.table)
      assert {:ok, %{retention: 9, source: :stored}} = AgentStatusLines.settings(again.name)
      assert {:ok, %{seq: 3}} = AgentStatusLines.put("a.one", "three", again.name)
    end

    test "drops records that are not a status line and says so", %{ctx: ctx} do
      Fixture.stop_store(ctx)

      Fixture.seed(ctx.path, [
        {:retention, 0},
        {{:agent, "a.good"}, [Fixture.entry(2, "second"), Fixture.entry(1, "first")]},
        {{:agent, "a.cleared"}, [Fixture.entry(2, nil), Fixture.entry(1, "first")]},
        {{:agent, "a.empty"}, []},
        {{:agent, "a.shape"}, [%{seq: 1, text: "x"}]},
        {{:agent, "a.order"}, [Fixture.entry(1, "old"), Fixture.entry(2, "new")]},
        {{:agent, "a.big"}, [Fixture.entry(1, String.duplicate("a", 16_385))]},
        {{:agent, "a.binary"}, [Fixture.entry(1, <<0xFF>>)]},
        {{:agent, "a.stamp"}, [Fixture.entry(1, "x", "yesterday")]},
        {{:agent, 7}, [Fixture.entry(1, "x")]},
        {:stray, "value"}
      ])

      log =
        capture_log(fn ->
          again =
            Fixture.start_store(path: ctx.path, fallback: %{retention: 20, source: :default})

          send(self(), {:again, again})
        end)

      assert_received {:again, again}
      assert log =~ "discarding invalid record"

      {:ok, heads} = AgentStatusLines.heads(again.table)
      assert Map.keys(heads) |> Enum.sort() == ["a.cleared", "a.good"]
      assert heads["a.good"].entry.text == "second"
      assert heads["a.cleared"].entry.text == nil
      assert heads["a.cleared"].head == ""

      assert {:ok, %{retention: 20, source: :default}} = AgentStatusLines.settings(again.name)

      disk = Fixture.disk(again.path)
      assert Map.keys(disk.agents) |> Enum.sort() == ["a.cleared", "a.good"]
      assert disk.retention == nil
      assert disk.other == []
    end

    test "prunes to the stored retention on load and syncs the prune", %{ctx: ctx} do
      Fixture.stop_store(ctx)

      entries = for seq <- 6..1//-1, do: Fixture.entry(seq, "text #{seq}")
      Fixture.seed(ctx.path, [{:retention, 3}, {{:agent, "a.one"}, entries}])

      again = Fixture.start_store(path: ctx.path, fallback: %{retention: 20, source: :default})

      assert {:ok, [%{seq: 6}, %{seq: 5}, %{seq: 4}]} =
               AgentStatusLines.history("a.one", again.name)

      assert {:ok, %{retention: 3, source: :stored}} = AgentStatusLines.settings(again.name)
      assert Fixture.disk(again.path).agents["a.one"] |> Enum.map(& &1.seq) == [6, 5, 4]
    end

    test "the file is readable by its owner only", %{ctx: ctx} do
      assert Bitwise.band(File.stat!(ctx.path).mode, 0o077) == 0
    end
  end

  test "a fallback outside 1..100 refuses to start" do
    Process.flag(:trap_exit, true)
    ctx = Fixture.names()

    assert {:error, {:invalid_fallback_retention, 0}} =
             AgentStatusLines.start_link(
               Fixture.opts(ctx, fallback: %{retention: 0, source: :env})
             )

    File.rm(ctx.path)
  end

  defp flush_broadcasts do
    receive do
      {:broadcast, _, _} -> flush_broadcasts()
    after
      0 -> :ok
    end
  end
end
