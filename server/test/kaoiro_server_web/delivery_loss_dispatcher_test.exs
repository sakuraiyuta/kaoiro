defmodule KaoiroServerWeb.DeliveryLossDispatcherTest do
  use KaoiroServerWeb.ChannelCase, async: false

  import ExUnit.CaptureLog

  alias KaoiroServer.{AgentStates, ConversationStates, DeliveryStates, IngressOrder}
  alias KaoiroServerWeb.DeliveryLossDispatcher

  @supervisor KaoiroServer.Supervisor

  defp envelope(agent_id, state) do
    %{
      "version" => "0",
      "agent_id" => agent_id,
      "persona" => %{"id" => "mio", "name" => "澪", "sprite_set" => "mio"},
      "ts" => "2026-06-11T00:00:00Z",
      "type" => "state_change",
      "state" => state,
      "payload" => %{},
      "ext" => %{}
    }
  end

  defp join_wrapper(agent_id, params \\ %{}) do
    {:ok, _reply, socket} =
      KaoiroServerWeb.WrapperSocket
      |> socket(nil, %{})
      |> subscribe_and_join(
        KaoiroServerWeb.WrapperChannel,
        "wrapper:" <> agent_id,
        Map.put(params, "persona_id", "default")
      )

    socket
  end

  defp seed_known(agent_id) do
    socket = join_wrapper(agent_id)
    assert_reply push(socket, "envelope", envelope(agent_id, "idle")), :ok
    socket
  end

  # A resync recipient holding one real loss intent: a peer's synthetic
  # `disconnected` notice (seq 1) retired by the recipient's resync. The
  # dispatcher's next tick regenerates it as a reachability notice.
  defp recipient_with_loss(to_id) do
    on_exit(fn -> DeliveryStates.delete(to_id) end)

    recipient =
      join_wrapper(to_id, %{
        "inter_agent_delivery_ack" => "dispatch-v1",
        "delivery_generation" => "generation",
        "delivery_resync" => "skip-v1"
      })

    assert_reply push(recipient, "envelope", envelope(to_id, "idle")), :ok
    subject = to_id <> "-peer"
    subject_socket = seed_known(subject)
    cid = "loss-#{System.unique_integer([:positive])}"
    assert :ok = ConversationStates.record_message(cid, subject, to_id, "hello", 1, false, true)
    Process.unlink(subject_socket.channel_pid)
    :ok = close(subject_socket)
    assert %{issued_seq: 1} = DeliveryStates.get(to_id)
    seed_known(subject)
    @endpoint.subscribe("wrapper:" <> to_id)

    request = %{
      "version" => "0",
      "generation" => "generation",
      "request_id" => "loss-1",
      "cutoff" => 1,
      "missing_ranges" => [[1, 1]]
    }

    assert_reply push(recipient, "delivery_resync", request), :ok
    assert pending?(to_id)
    recipient
  end

  defp pending?(to_id),
    do: Enum.any?(DeliveryStates.pending_losses(), &(&1.recipient == to_id))

  defp assert_recovery_notice(to_id) do
    topic = "wrapper:" <> to_id

    assert_receive %Phoenix.Socket.Broadcast{
                     topic: ^topic,
                     event: "envelope",
                     payload: %{"payload" => %{"loss_id" => _}}
                   },
                   1_500

    refute pending?(to_id)
  end

  defp dispatcher do
    pid = Process.whereis(DeliveryLossDispatcher)
    assert is_pid(pid)
    pid
  end

  defp stop_store(store) do
    assert :ok = Supervisor.terminate_child(@supervisor, store)
  end

  defp start_store(store) do
    assert {:ok, _pid} = Supervisor.restart_child(@supervisor, store)
  end

  describe "a tick that finds a store restarting" do
    test "flush skips while DeliveryStates is absent and delivers once it is back" do
      to_id = "test.dispatcher-ledger-absent"
      _recipient = recipient_with_loss(to_id)
      pid = dispatcher()
      ref = Process.monitor(pid)

      stop_store(DeliveryStates)
      assert {:skipped, DeliveryStates} = DeliveryLossDispatcher.flush()
      refute_receive {:DOWN, ^ref, :process, ^pid, _}, 100
      assert Process.whereis(DeliveryLossDispatcher) == pid

      start_store(DeliveryStates)
      assert pending?(to_id)
      assert :ok = DeliveryLossDispatcher.flush()
      assert_recovery_notice(to_id)
    end

    test "the dispatcher's own timer skips while AgentStates is absent and the re-armed tick delivers" do
      to_id = "test.dispatcher-agents-absent"
      recipient = recipient_with_loss(to_id)
      pid = dispatcher()
      ref = Process.monitor(pid)

      stop_store(AgentStates)
      # Observe the pending timer's own `:flush` landing on the absent store.
      # No manual flush is sent in this test, so the second `:flush` below can
      # only come from the timer the skipped tick re-armed.
      :erlang.trace(pid, true, [:receive])
      on_exit(fn -> if Process.alive?(pid), do: :erlang.trace(pid, false, [:receive]) end)
      assert_receive {:trace, ^pid, :receive, :flush}, 1_500
      # The tick finished before this call is served.
      :sys.get_state(pid)
      assert pending?(to_id)
      refute_receive {:DOWN, ^ref, :process, ^pid, _}, 0
      assert Process.whereis(DeliveryLossDispatcher) == pid

      start_store(AgentStates)
      assert_reply push(recipient, "envelope", envelope(to_id, "idle")), :ok
      assert_receive {:trace, ^pid, :receive, :flush}, 1_500
      # The notice is broadcast before the loss is completed; wait for the
      # re-armed tick to finish before reading the ledger.
      :sys.get_state(pid)
      assert_recovery_notice(to_id)
    end

    test "flush skips while IngressOrder is absent and delivers once it is back" do
      to_id = "test.dispatcher-ingress-absent"
      _recipient = recipient_with_loss(to_id)
      pid = dispatcher()
      ref = Process.monitor(pid)

      stop_store(IngressOrder)
      assert {:skipped, IngressOrder} = DeliveryLossDispatcher.flush()
      refute_receive {:DOWN, ^ref, :process, ^pid, _}, 100
      assert pending?(to_id)

      start_store(IngressOrder)
      assert :ok = DeliveryLossDispatcher.flush()
      assert_recovery_notice(to_id)
    end
  end

  describe "tolerate_store_restart/1" do
    test "skips only a noproc call to a listed store" do
      stop_store(AgentStates)
      on_exit(fn -> Supervisor.restart_child(@supervisor, AgentStates) end)

      assert {:noproc, {GenServer, :call, [AgentStates, {:connected?, "x"}, 5000]}} =
               catch_exit(AgentStates.connected?("x"))

      assert {:skipped, AgentStates} =
               DeliveryLossDispatcher.tolerate_store_restart(fn ->
                 AgentStates.connected?("x")
               end)
    end

    test "propagates a noproc call to a name outside the list unchanged" do
      assert {:noproc, {GenServer, :call, [:kohaku_no_such_name, :x, 5000]}} =
               catch_exit(
                 DeliveryLossDispatcher.tolerate_store_restart(fn ->
                   GenServer.call(:kohaku_no_such_name, :x)
                 end)
               )
    end

    test "propagates a non-call exit and an exception unchanged" do
      assert :boom =
               catch_exit(DeliveryLossDispatcher.tolerate_store_restart(fn -> exit(:boom) end))

      assert_raise ArgumentError, fn ->
        DeliveryLossDispatcher.tolerate_store_restart(fn -> raise ArgumentError end)
      end
    end

    test "a store call timeout still terminates the dispatcher" do
      to_id = "test.dispatcher-agents-timeout"
      _recipient = recipient_with_loss(to_id)
      pid = dispatcher()
      ref = Process.monitor(pid)

      :ok = :sys.suspend(AgentStates)
      on_exit(fn -> if Process.whereis(AgentStates), do: :sys.resume(AgentStates) end)

      # A longer outer timeout than the inner 5 s call, so the dispatcher's own
      # exit is what reaches the caller.
      capture_log(fn ->
        assert {{:timeout, {GenServer, :call, [AgentStates, {:connected?, ^to_id}, 5000]}}, _} =
                 catch_exit(GenServer.call(DeliveryLossDispatcher, :flush, 8_000))

        assert_receive {:DOWN, ^ref, :process, ^pid,
                        {:timeout, {GenServer, :call, [AgentStates, {:connected?, ^to_id}, 5000]}}},
                       1_000
      end)

      :ok = :sys.resume(AgentStates)

      KaoiroServer.StatusLinesFixture.eventually(fn ->
        is_pid(Process.whereis(DeliveryLossDispatcher))
      end)

      assert Process.whereis(DeliveryLossDispatcher) != pid
    end
  end
end
