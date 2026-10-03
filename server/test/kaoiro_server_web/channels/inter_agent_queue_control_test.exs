defmodule KaoiroServerWeb.InterAgentQueueControlTest do
  use KaoiroServerWeb.ChannelCase, async: false

  import Phoenix.ChannelTest
  import ExUnit.CaptureLog

  require Logger

  alias KaoiroServer.DeliveryStates
  alias KaoiroServer.TestTimeouts

  @policy %{"batch_max_items" => 10, "backlog_max_items" => 100, "backlog_max_bytes" => 524_288}

  setup do
    Process.flag(:trap_exit, true)
    id = "test.queue-control-#{System.unique_integer([:positive])}"
    on_exit(fn -> DeliveryStates.delete(id) end)
    %{id: id, counter: :counters.new(1, [])}
  end

  defp join_params(extra \\ %{}) do
    Map.merge(
      %{
        "persona_id" => "default",
        "inter_agent_queue" => "credit-v1",
        "inter_agent_queue_policy" => @policy,
        "inter_agent_delivery_ack" => "dispatch-v1",
        "delivery_resync" => "skip-v1",
        "delivery_generation" => "generation"
      },
      extra
    )
  end

  defp join_queue(id, params \\ join_params()) do
    {:ok, reply, socket} =
      KaoiroServerWeb.WrapperSocket
      |> socket(nil, %{})
      |> subscribe_and_join(KaoiroServerWeb.WrapperChannel, "wrapper:" <> id, params)

    {reply, socket}
  end

  defp fence(ctx, reply) do
    %{
      "version" => "0",
      "queue_epoch" => reply["inter_agent_queue_epoch"],
      "incarnation" => reply["inter_agent_delivery_incarnation"],
      "generation" => "generation",
      "operation_id" =>
        (
          :counters.add(ctx.counter, 1, 1)
          Integer.to_string(:counters.get(ctx.counter, 1))
        )
    }
  end

  defp control(socket, payload) do
    ref = push(socket, "delivery_queue_control", payload)
    assert_reply ref, status, response, TestTimeouts.durable_reply()
    {status, response}
  end

  defp enqueue(id, sender) do
    {:ok, token, _} = DeliveryStates.queue_reserve(id, :ordinary, 2, DeliveryStates)

    {:ok, queue_id} =
      DeliveryStates.queue_commit(
        id,
        token,
        %{sender: sender, conversation_id: "c", turn_number: 1, kind: "inform"},
        %{"type" => "inter_agent_message", "agent_id" => sender, "payload" => %{"body" => "hi"}}
      )

    Integer.to_string(queue_id)
  end

  test "credit, batch, begin_native and dispose round-trip on the wire", %{id: id} = ctx do
    {reply, socket} = join_queue(id)
    assert reply["inter_agent_queue_resume_required"] == false

    credit =
      Map.merge(fence(ctx, reply), %{
        "op" => "credit",
        "kind" => "root",
        "native_turn_token" => "t1"
      })

    assert {:ok, %{"op" => "credit", "credit_revision" => "1", "queue" => %{queued: 0}}} =
             control(socket, credit)

    queue_id = enqueue(id, "peer.a")

    assert_push "delivery_batch", %{
      "version" => "0",
      "kind" => "root",
      "lease_id" => lease_id,
      "items" => [
        %{"queue_id" => ^queue_id, "delivery_seq" => 1, "envelope" => %{"agent_id" => "peer.a"}}
      ]
    }

    begin =
      Map.merge(fence(ctx, reply), %{
        "op" => "begin_native",
        "lease_id" => lease_id,
        "queue_ids" => [queue_id],
        "native_turn_token" => "t1"
      })

    assert {:ok, %{"permitted_queue_ids" => [^queue_id]}} = control(socket, begin)

    dispose =
      Map.merge(fence(ctx, reply), %{
        "op" => "dispose",
        "lease_id" => lease_id,
        "items" => [
          %{"queue_id" => queue_id, "outcome" => "observed", "witness" => "prompt_hook"}
        ]
      })

    assert {:ok,
            %{"disposed" => [^queue_id], "resolved_ranges" => [[1, 1]], "returned_ranges" => []}} =
             control(socket, dispose)

    assert %{issued_seq: 1, acked_seq: 1} = DeliveryStates.get(id)
  end

  test "stale epoch, channel and a wrapper without the queue are refused", %{id: id} = ctx do
    {reply, socket} = join_queue(id)

    credit =
      Map.merge(fence(ctx, reply), %{
        "op" => "credit",
        "kind" => "root",
        "native_turn_token" => "t"
      })

    assert {:error, %{reason: "stale_queue_epoch"}} =
             control(socket, %{credit | "queue_epoch" => "old"})

    assert {:error, %{reason: "stale_channel"}} =
             control(socket, %{credit | "generation" => "other"})

    assert {:error, %{reason: "stale_channel"}} =
             control(socket, %{credit | "incarnation" => "other"})

    legacy = "#{id}-legacy"
    on_exit(fn -> DeliveryStates.delete(legacy) end)

    {legacy_reply, legacy_socket} =
      join_queue(legacy, Map.delete(join_params(), "inter_agent_queue"))

    assert {:error, %{reason: "invalid_queue_control", field: "op"}} =
             control(legacy_socket, Map.merge(fence(ctx, legacy_reply), credit))
  end

  test "malformed operations name the offending field", %{id: id} = ctx do
    {reply, socket} = join_queue(id)
    base = fence(ctx, reply)

    for {payload, field} <- [
          {%{
             "op" => "credit",
             "kind" => "early",
             "native_turn_token" => "t",
             "mechanism" => "push"
           }, "mechanism"},
          {%{"op" => "credit", "kind" => "other"}, "kind"},
          {%{
             "op" => "begin_native",
             "lease_id" => "01",
             "queue_ids" => ["1"],
             "native_turn_token" => "t"
           }, "lease_id"},
          {%{
             "op" => "return",
             "lease_id" => "1",
             "items" => [%{"queue_id" => "1", "reason" => "lost"}]
           }, "items"},
          {%{
             "op" => "dispose",
             "lease_id" => "1",
             "items" => [%{"queue_id" => "1", "outcome" => "observed"}]
           }, "items"},
          {%{"op" => "freeze", "reason" => "crash"}, "reason"},
          {%{"op" => "nope"}, "op"}
        ] do
      assert {:error, %{reason: "invalid_queue_control", field: ^field}} =
               control(socket, Map.merge(base, payload))
    end

    assert {:error, %{reason: "invalid_queue_control", field: "operation_id"}} =
             control(
               socket,
               Map.merge(base, %{"op" => "freeze", "reason" => "shutdown", "operation_id" => "x"})
             )
  end

  test "a same-generation rejoin holding a lease reports resume_required", %{id: id} = ctx do
    {reply, socket} = join_queue(id)

    credit =
      Map.merge(fence(ctx, reply), %{
        "op" => "credit",
        "kind" => "root",
        "native_turn_token" => "t"
      })

    {:ok, _} = control(socket, credit)
    enqueue(id, "peer.a")
    assert_push "delivery_batch", %{"lease_id" => _}

    :ok = close(socket)
    {again, _socket} = join_queue(id)
    assert again["inter_agent_queue_resume_required"] == true
  end

  test "a resync over an offered queue sequence reports it as returned, not skipped",
       %{id: id} = ctx do
    {reply, socket} = join_queue(id)

    credit =
      Map.merge(fence(ctx, reply), %{
        "op" => "credit",
        "kind" => "root",
        "native_turn_token" => "t"
      })

    {:ok, _} = control(socket, credit)
    enqueue(id, "peer.a")
    assert_push "delivery_batch", %{"items" => [%{"delivery_seq" => 1}]}

    ref =
      push(socket, "delivery_resync", %{
        "version" => "0",
        "generation" => "generation",
        "request_id" => "r1",
        "cutoff" => 1,
        "missing_ranges" => [[1, 1]]
      })

    assert_reply ref,
                 :ok,
                 %{
                   "skipped_ranges" => [],
                   "returned_ranges" => [[1, 1]],
                   "uncertain_ranges" => [],
                   "delivery" => %{lost_count: 0}
                 },
                 TestTimeouts.durable_reply()

    assert %{queued: 1, offered: 0} = DeliveryStates.queue_counts(id)
  end

  test "a return logs the queue id, sequence and full reason", %{id: id} = ctx do
    level = Logger.level()
    Logger.configure(level: :info)
    on_exit(fn -> Logger.configure(level: level) end)

    {reply, socket} = join_queue(id)

    credit =
      Map.merge(fence(ctx, reply), %{
        "op" => "credit",
        "kind" => "root",
        "native_turn_token" => "t"
      })

    {:ok, _} = control(socket, credit)
    queue_id = enqueue(id, "peer.a")
    assert_push "delivery_batch", %{"lease_id" => lease_id}

    returned =
      Map.merge(fence(ctx, reply), %{
        "op" => "return",
        "lease_id" => lease_id,
        "items" => [
          %{"queue_id" => queue_id, "reason" => "early_ineligible", "sub_reason" => "host_busy"}
        ]
      })

    log =
      capture_log(fn ->
        assert {:ok, %{"returned_ranges" => [[1, 1]]}} = control(socket, returned)
      end)

    assert log =~ "queue_id=#{queue_id} seq=1"
    assert log =~ "reason=early_ineligible:host_busy"
  end

  test "a stalled owner answers queue_unavailable; the same id applies once", %{id: id} = ctx do
    {reply, socket} = join_queue(id)

    credit =
      Map.merge(fence(ctx, reply), %{
        "op" => "credit",
        "kind" => "root",
        "native_turn_token" => "t"
      })

    {:ok, _} = control(socket, credit)
    queue_id = enqueue(id, "peer.a")
    assert_push "delivery_batch", %{"lease_id" => lease_id}

    returned =
      Map.merge(fence(ctx, reply), %{
        "op" => "return",
        "lease_id" => lease_id,
        "items" => [%{"queue_id" => queue_id, "reason" => "format_budget"}]
      })

    owner = Process.whereis(DeliveryStates)
    :ok = :sys.suspend(owner)

    try do
      ref = push(socket, "delivery_queue_control", returned)
      # The channel gives up after GenServer.call's default 5000 ms timeout.
      budget = 5_000 + TestTimeouts.durable_reply()
      assert_reply ref, :error, %{reason: "queue_unavailable"}, budget
    after
      :ok = :sys.resume(owner)
    end

    assert Process.alive?(socket.channel_pid)

    # The stall caught the channel's fence calls, so nothing was applied: the
    # same id applies the return once, and a new id finds the lease emptied.
    assert {:ok, %{"returned_ranges" => [[1, 1]]}} = control(socket, returned)

    assert {:error, %{reason: "unknown_lease"}} =
             control(socket, Map.merge(returned, %{"operation_id" => "99"}))

    assert %{queued: 1, offered: 0} = DeliveryStates.queue_counts(id)
  end

  test "a control call that times out at the owner applies later and replays", %{id: id} = ctx do
    {reply, socket} = join_queue(id)

    credit =
      Map.merge(fence(ctx, reply), %{
        "op" => "credit",
        "kind" => "root",
        "native_turn_token" => "t"
      })

    {:ok, _} = control(socket, credit)
    queue_id = enqueue(id, "peer.a")
    assert_push "delivery_batch", %{"lease_id" => lease_id}

    begin =
      Map.merge(fence(ctx, reply), %{
        "op" => "begin_native",
        "lease_id" => lease_id,
        "queue_ids" => [queue_id],
        "native_turn_token" => "t"
      })

    request = %{
      op: :begin_native,
      lease_id: String.to_integer(lease_id),
      queue_ids: [String.to_integer(queue_id)],
      token: "t"
    }

    owner = Process.whereis(DeliveryStates)
    :ok = :sys.suspend(owner)

    try do
      # The channel's own call, timed out after its fence checks passed.
      call =
        {:queue_control, id, "generation", socket.channel_pid, begin["operation_id"], request}

      assert {:timeout, _} = catch_exit(GenServer.call(owner, call, 100))
    after
      :ok = :sys.resume(owner)
    end

    assert %{native_pending: 1} = DeliveryStates.queue_counts(id)
    assert {:ok, %{"permitted_queue_ids" => [^queue_id]}} = control(socket, begin)

    assert {:error, %{reason: "unknown_queue_item"}} =
             control(socket, Map.merge(begin, %{"operation_id" => "99"}))
  end

  test "a dispose pushes the advanced acked_seq; an unused permit returns", %{id: id} = ctx do
    {reply, socket} = join_queue(id)

    credit =
      Map.merge(fence(ctx, reply), %{
        "op" => "credit",
        "kind" => "root",
        "native_turn_token" => "t"
      })

    first = enqueue(id, "peer.a")
    second = enqueue(id, "peer.a")
    {:ok, _} = control(socket, credit)
    assert_push "delivery_batch", %{"lease_id" => lease_id}

    begin =
      Map.merge(fence(ctx, reply), %{
        "op" => "begin_native",
        "lease_id" => lease_id,
        "queue_ids" => [first, second],
        "native_turn_token" => "t"
      })

    {:ok, _} = control(socket, begin)

    dispose =
      Map.merge(fence(ctx, reply), %{
        "op" => "dispose",
        "lease_id" => lease_id,
        "items" => [%{"queue_id" => first, "outcome" => "observed", "witness" => "prompt_hook"}]
      })

    {:ok, _} = control(socket, dispose)
    assert_push "delivery_status", %{acked_seq: 1, issued_seq: 2}

    unused =
      Map.merge(fence(ctx, reply), %{
        "op" => "return",
        "lease_id" => lease_id,
        "items" => [%{"queue_id" => second, "reason" => "permit_unused"}]
      })

    assert {:ok, %{"returned_ranges" => [[2, 2]]}} = control(socket, unused)
    assert_push "delivery_status", %{acked_seq: 2}
  end
end
