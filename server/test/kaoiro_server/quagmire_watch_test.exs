defmodule KaoiroServer.QuagmireWatchTest do
  # Review-quagmire detection (issue #273). Every test drives `sweep/1`
  # synchronously and injects both stores plus the wallclock, so nothing here
  # waits on the sweep timer or on real time passing.
  use ExUnit.Case, async: false

  import KaoiroServer.TestTeardown

  alias KaoiroServer.ConversationStates
  alias KaoiroServer.DeliveryStates
  alias KaoiroServer.QuagmireWatch

  @settings %{
    rally_turns: 4,
    rally_window_ms: 100_000,
    stall_ms: 30_000,
    sweep_interval_ms: 60_000
  }

  setup do
    unique = System.unique_integer([:positive])
    conversations = :"qw_cs_#{unique}"
    deliveries = :"qw_ds_#{unique}"
    watch = :"qw_#{unique}"
    path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "#{deliveries}.dets"])
    File.rm(path)

    original_inter_agent = Application.get_env(:kaoiro_server, :inter_agent)
    original_quagmire = Application.get_env(:kaoiro_server, :quagmire)
    Application.put_env(:kaoiro_server, :inter_agent, tombstone_ttl_ms: 100_000)
    {:ok, clock} = Agent.start_link(fn -> 0 end)

    {:ok, _} =
      ConversationStates.start_link(name: conversations, clock: fn -> Agent.get(clock, & &1) end)

    {:ok, _} = DeliveryStates.start_link(name: deliveries, path: path)
    {:ok, notices} = Agent.start_link(fn -> [] end)

    on_exit(fn ->
      restore_env(:inter_agent, original_inter_agent)
      restore_env(:quagmire, original_quagmire)
      stop_quietly(conversations)
      stop_quietly(deliveries)
      File.rm(path)
    end)

    %{
      conversations: conversations,
      deliveries: deliveries,
      watch: watch,
      notices: notices,
      clock: clock,
      path: path,
      original_inter_agent: original_inter_agent
    }
  end

  # Restores the value the key HAD, rather than deleting it: config.exs ships
  # both keys, so a delete would leave every later test in the run reading the
  # module fallbacks instead of the shipped configuration.
  defp restore_env(key, nil), do: Application.delete_env(:kaoiro_server, key)
  defp restore_env(key, value), do: Application.put_env(:kaoiro_server, key, value)

  defp start_watch(ctx, opts \\ []) do
    {:ok, _} =
      QuagmireWatch.start_link(
        name: ctx.watch,
        settings: Keyword.get(opts, :settings, @settings),
        conversations: ctx.conversations,
        deliveries: ctx.deliveries,
        now_wall: Keyword.get(opts, :now_wall, fn -> ~U[2026-09-05 12:00:00Z] end),
        on_notice: fn payload -> Agent.update(ctx.notices, &[payload | &1]) end
      )

    on_exit(fn -> stop_quietly(ctx.watch) end)
    ctx.watch
  end

  defp notices(ctx), do: ctx.notices |> Agent.get(& &1) |> Enum.reverse()

  defp exchange(ctx, cid, turns) do
    Enum.each(1..turns, fn turn ->
      {from, to} = if rem(turn, 2) == 1, do: {"a", "b"}, else: {"b", "a"}

      ConversationStates.record_message(
        cid,
        from,
        to,
        "x",
        turn,
        false,
        turn == 1,
        ctx.conversations
      )
    end)
  end

  # pending_since is DeliveryStates' own DateTime.utc_now() and cannot be
  # injected, so the test clock is derived FROM it. That also makes the
  # threshold measure the ledger's real timestamp rather than a replica.
  defp now_wall_after(ctx, agent_id, offset_ms) do
    %{pending_since: pending} = DeliveryStates.get(agent_id, ctx.deliveries)
    {:ok, since, _offset} = DateTime.from_iso8601(pending)
    fn -> DateTime.add(since, offset_ms, :millisecond) end
  end

  # Same derivation, for a test that has to move the clock more than once:
  # each generation opens a pending_since of its own.
  defp set_wall_after(ctx, wall, agent_id, offset_ms) do
    Agent.update(wall, fn _ -> now_wall_after(ctx, agent_id, offset_ms).() end)
  end

  defp exchange_and_close(ctx, cid, turns) do
    exchange(ctx, cid, turns)
    ConversationStates.close_by_operator(cid, ctx.conversations)
  end

  describe "rally" do
    test "stays silent one turn below the threshold", ctx do
      watch = start_watch(ctx)
      exchange(ctx, "c1", 3)

      assert :ok = QuagmireWatch.sweep(watch)
      assert notices(ctx) == []
    end

    test "notifies once on crossing and does not repeat while it stays over", ctx do
      watch = start_watch(ctx)
      exchange(ctx, "c1", 4)

      assert :ok = QuagmireWatch.sweep(watch)

      assert [
               %{
                 "kind" => "rally",
                 "participants" => ["a", "b"],
                 "turns" => 4,
                 "conversations" => 1,
                 "threshold" => 4
               }
             ] = notices(ctx)

      exchange(ctx, "c1", 5)
      assert :ok = QuagmireWatch.sweep(watch)
      assert length(notices(ctx)) == 1
    end

    test "counts a rally that spans conversations", ctx do
      # The reason this is a pair aggregate rather than a per-conversation
      # count: max_turns closes a conversation and the peers move to a fresh
      # id, so neither entry alone reaches the threshold.
      watch = start_watch(ctx)
      exchange(ctx, "c1", 2)
      exchange(ctx, "c2", 2)

      assert :ok = QuagmireWatch.sweep(watch)

      assert [%{"kind" => "rally", "turns" => 4, "conversations" => 2}] = notices(ctx)
    end

    test "can fire again after the pair drops back below the threshold", ctx do
      watch = start_watch(ctx)
      exchange_and_close(ctx, "c1", 4)
      assert :ok = QuagmireWatch.sweep(watch)
      assert length(notices(ctx)) == 1

      # The tombstone ages out of the window, so the pair contributes nothing
      # and the edge-trigger memory clears with it.
      Agent.update(ctx.clock, &(&1 + 100_001))
      assert :ok = QuagmireWatch.sweep(watch)
      assert length(notices(ctx)) == 1

      exchange_and_close(ctx, "c2", 4)
      assert :ok = QuagmireWatch.sweep(watch)
      assert length(notices(ctx)) == 2
    end
  end

  describe "stall" do
    test "notifies on an unacknowledged gap older than the threshold", ctx do
      DeliveryStates.bind("momo", "gen-a", ctx.deliveries)
      DeliveryStates.issue("momo", ctx.deliveries)
      watch = start_watch(ctx, now_wall: now_wall_after(ctx, "momo", 30_001))

      assert :ok = QuagmireWatch.sweep(watch)

      assert [
               %{
                 "kind" => "stall",
                 "agent_id" => "momo",
                 "undelivered" => 1,
                 "threshold_ms" => 30_000
               }
             ] = notices(ctx)
    end

    test "stays silent while the gap is younger than the threshold", ctx do
      DeliveryStates.bind("momo", "gen-a", ctx.deliveries)
      DeliveryStates.issue("momo", ctx.deliveries)
      watch = start_watch(ctx, now_wall: now_wall_after(ctx, "momo", 29_999))

      assert :ok = QuagmireWatch.sweep(watch)
      assert notices(ctx) == []
    end

    test "stays silent at exactly the threshold", ctx do
      # "older than stall_ms" (spec, Stall): equality is not older. Pinned
      # alongside the two neighbours so the comparison cannot drift by one
      # millisecond in either direction unnoticed.
      DeliveryStates.bind("momo", "gen-a", ctx.deliveries)
      DeliveryStates.issue("momo", ctx.deliveries)
      watch = start_watch(ctx, now_wall: now_wall_after(ctx, "momo", 30_000))

      assert :ok = QuagmireWatch.sweep(watch)
      assert notices(ctx) == []
    end

    test "stays silent when every issued delivery is acknowledged", ctx do
      watch = start_watch(ctx, now_wall: fn -> ~U[2099-01-01 00:00:00Z] end)

      DeliveryStates.bind("momo", "gen-a", ctx.deliveries)
      seq = DeliveryStates.issue("momo", ctx.deliveries)
      DeliveryStates.ack("momo", seq, ctx.deliveries)

      assert :ok = QuagmireWatch.sweep(watch)
      assert notices(ctx) == []
    end

    test "does not report a gap a new wrapper generation abandoned", ctx do
      # DeliveryStates is a watermark ledger: a replacement process moves
      # acked to issued rather than carrying the gap. The detector cannot see
      # past that, and must not leave a notice stuck on the old gap either.
      watch = start_watch(ctx, now_wall: fn -> ~U[2099-01-01 00:00:00Z] end)

      DeliveryStates.bind("momo", "gen-a", ctx.deliveries)
      DeliveryStates.issue("momo", ctx.deliveries)
      DeliveryStates.bind("momo", "gen-b", ctx.deliveries)

      assert :ok = QuagmireWatch.sweep(watch)
      assert notices(ctx) == []
    end

    test "reports the next generation's stall after the first was abandoned", ctx do
      # The edge-trigger set is REBUILT from the current over-threshold set
      # each sweep. Accumulating it instead would silence the agent for good
      # after its first stall, which no operator action could undo.
      DeliveryStates.bind("momo", "gen-a", ctx.deliveries)
      DeliveryStates.issue("momo", ctx.deliveries)
      {:ok, wall} = Agent.start_link(fn -> ~U[2026-09-05 12:00:00Z] end)
      watch = start_watch(ctx, now_wall: fn -> Agent.get(wall, & &1) end)

      set_wall_after(ctx, wall, "momo", 30_001)
      assert :ok = QuagmireWatch.sweep(watch)
      assert [%{"kind" => "stall", "agent_id" => "momo"}] = notices(ctx)

      # A replacement wrapper moves acked to issued, so the condition falls
      # back below and the memory has to clear with it.
      DeliveryStates.bind("momo", "gen-b", ctx.deliveries)
      assert :ok = QuagmireWatch.sweep(watch)
      assert length(notices(ctx)) == 1

      DeliveryStates.issue("momo", ctx.deliveries)
      set_wall_after(ctx, wall, "momo", 30_001)
      assert :ok = QuagmireWatch.sweep(watch)
      assert length(notices(ctx)) == 2
    end
  end

  describe "settings" do
    test "refuses to boot when the rally window outreaches tombstone retention", ctx do
      # Beyond tombstone_ttl_ms the closed conversations are simply gone, so
      # a longer window under-reports instead of reaching further back.
      Process.flag(:trap_exit, true)

      assert {:error, {%ArgumentError{message: message}, _stack}} =
               QuagmireWatch.start_link(
                 name: :"#{ctx.watch}_bad",
                 settings: %{@settings | rally_window_ms: 100_001},
                 conversations: ctx.conversations,
                 deliveries: ctx.deliveries
               )

      assert message =~ "rally_window_ms"
    end

    test "refuses a non-integer rally_window_ms before it reaches pair_rally", ctx do
      # It is handed to ConversationStates.pair_rally/2, whose is_integer
      # guard raises in the CALLER: the sweep would crash-restart every tick
      # and every operator list_conversations would take the channel down.
      Process.flag(:trap_exit, true)

      assert {:error, {%ArgumentError{message: message}, _stack}} =
               QuagmireWatch.start_link(
                 name: :"#{ctx.watch}_float",
                 settings: %{@settings | rally_window_ms: 8.64e7},
                 conversations: ctx.conversations,
                 deliveries: ctx.deliveries
               )

      assert message =~ "rally_window_ms must be a positive integer"
    end

    test "skips a tick instead of crashing when a store is unavailable", ctx do
      # A crash would empty the edge-trigger memory, so every standing
      # condition would be re-announced on the next sweep.
      watch = start_watch(ctx)
      exchange(ctx, "c1", 4)
      assert :ok = QuagmireWatch.sweep(watch)
      assert length(notices(ctx)) == 1

      stop_quietly(ctx.conversations)
      send(watch, :sweep)
      assert %{} = :sys.get_state(watch)
      assert Process.alive?(Process.whereis(watch))
      assert length(notices(ctx)) == 1
    end

    test "a later store's failure does not re-announce the earlier detector", ctx do
      # The rally notice is emitted BEFORE DeliveryStates is read. Rolling the
      # whole sweep back on that read's exit throws away the edge-trigger
      # memory the emit just earned, so every tick re-announces the same
      # rally -- a condition the failing store has nothing to do with.
      watch = start_watch(ctx)
      exchange(ctx, "c1", 4)
      stop_quietly(ctx.deliveries)

      send(watch, :sweep)
      assert %{} = :sys.get_state(watch)
      send(watch, :sweep)
      assert %{} = :sys.get_state(watch)

      assert length(notices(ctx)) == 1
    end

    test "exposes the running thresholds so the channel cannot disagree", ctx do
      watch = start_watch(ctx)

      assert %{rally_turns: 4, rally_window_ms: 100_000, stall_ms: 30_000} =
               QuagmireWatch.settings(watch)
    end

    test "configured_settings reads config without entering the process", ctx do
      # The channel annotates list_conversations through this: an advisory
      # detector's liveness must not be able to take down that RPC.
      Application.put_env(:kaoiro_server, :quagmire,
        rally_turns: 7,
        rally_window_ms: 100_000
      )

      watch = start_watch(ctx)
      stop_quietly(ctx.watch)
      refute Process.whereis(watch)

      assert %{rally_turns: 7} = QuagmireWatch.configured_settings()
    end

    test "the shipped configuration and the module fallbacks agree", ctx do
      # Nothing injected: this is what a deployment runs. stall_ms must clear
      # the wrapper's 30-minute turn watchdog on BOTH paths -- a recipient
      # that is merely mid-turn cannot acknowledge, and reporting that as a
      # stall is the false positive the threshold was raised to avoid.
      restore_env(:inter_agent, ctx.original_inter_agent)

      assert %{
               rally_turns: 16,
               rally_window_ms: 86_400_000,
               stall_ms: 3_600_000,
               sweep_interval_ms: 60_000
             } = QuagmireWatch.configured_settings()

      Application.delete_env(:kaoiro_server, :quagmire)

      assert %{
               rally_turns: 16,
               rally_window_ms: 86_400_000,
               stall_ms: 3_600_000,
               sweep_interval_ms: 60_000
             } = QuagmireWatch.configured_settings()
    end
  end
end
