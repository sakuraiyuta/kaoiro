defmodule KaoiroServerWeb.InterAgentQueueWaiterTest do
  use KaoiroServerWeb.ChannelCase, async: false

  import Phoenix.ChannelTest

  alias KaoiroServer.{AgentDirectory, DeliveryStates}
  alias KaoiroServer.TestTimeouts

  setup do
    Process.flag(:trap_exit, true)
    previous = Application.fetch_env!(:kaoiro_server, :inter_agent_queue)
    on_exit(fn -> Application.put_env(:kaoiro_server, :inter_agent_queue, previous) end)

    Application.put_env(
      :kaoiro_server,
      :inter_agent_queue,
      Keyword.put(previous, :route_accepted, true)
    )

    n = System.unique_integer([:positive])
    ids = %{waiting: "test.wait-a-#{n}", peer: "test.wait-b-#{n}", other: "test.wait-c-#{n}"}

    on_exit(fn ->
      Enum.each(Map.values(ids), fn id ->
        DeliveryStates.delete(id)
        AgentDirectory.delete(id)
      end)
    end)

    ids
  end

  defp queue_params(backlog_max_items \\ 10) do
    %{
      "inter_agent_queue" => "credit-v1",
      "inter_agent_queue_policy" => %{
        "batch_max_items" => 10,
        "backlog_max_items" => backlog_max_items,
        "backlog_max_bytes" => 524_288
      },
      "inter_agent_delivery_ack" => "dispatch-v1",
      "delivery_resync" => "skip-v1",
      "delivery_generation" => "generation"
    }
  end

  defp join_agent(id, params) do
    {:ok, reply, socket} =
      KaoiroServerWeb.WrapperSocket
      |> socket(nil, %{})
      |> subscribe_and_join(
        KaoiroServerWeb.WrapperChannel,
        "wrapper:" <> id,
        Map.put(params, "persona_id", "default")
      )

    ref =
      push(socket, "envelope", %{
        "version" => "0",
        "agent_id" => id,
        "persona" => %{"id" => "mio", "name" => "澪", "sprite_set" => "mio"},
        "ts" => "2026-10-04T00:00:00Z",
        "type" => "state_change",
        "state" => "idle",
        "payload" => %{},
        "ext" => %{}
      })

    assert_reply ref, :ok, _, TestTimeouts.durable_reply()
    {reply, socket}
  end

  defp message(from, to, cid, turn, opts \\ []) do
    %{
      "version" => "0",
      "agent_id" => from,
      "persona" => %{"id" => "mio", "name" => "澪", "sprite_set" => "mio"},
      "ts" => "2026-10-04T00:00:00Z",
      "type" => "inter_agent_message",
      "state" => "tool_running",
      "payload" => %{
        "to" => to,
        "conversation_id" => cid,
        "turn_number" => turn,
        "kind" => "query",
        "body" => Keyword.get(opts, :body, "question"),
        "meta" => %{"done" => false, "propose_next" => ""},
        "owner" => %{"kind" => "user", "id" => "operator"},
        "new_conversation" => turn == 1
      },
      "ext" => %{}
    }
  end

  defp registration(expires \\ 60_000),
    do: %{"token" => "secret-token", "call_token" => "call-1", "expires_in_ms" => expires}

  defp send_message(socket, envelope) do
    ref = push(socket, "envelope", envelope)
    assert_reply ref, status, reply, TestTimeouts.durable_reply()
    {status, reply}
  end

  defp control(socket, reply, op) do
    payload =
      Map.merge(
        %{
          "version" => "0",
          "queue_epoch" => reply["inter_agent_queue_epoch"],
          "incarnation" => reply["inter_agent_delivery_incarnation"],
          "generation" => "generation",
          "operation_id" => Integer.to_string(System.unique_integer([:positive]))
        },
        op
      )

    ref = push(socket, "delivery_queue_control", payload)
    assert_reply ref, status, response, TestTimeouts.durable_reply()
    {status, response}
  end

  test "a matched reply is offered at once as W, past a full queue", ids do
    {waiting_reply, waiting} = join_agent(ids.waiting, queue_params(1))
    {_reply, peer} = join_agent(ids.peer, queue_params())
    {_reply, other} = join_agent(ids.other, %{})

    # The waiting agent's queue is full with ordinary input.
    {:ok, _} = send_message(other, message(ids.other, ids.waiting, "cnv-fill", 1))

    ask =
      Map.put(
        message(ids.waiting, ids.peer, "cnv-wait", 1),
        "waiter_registration",
        registration()
      )

    assert {:ok, %{"waiter_registration_id" => registration_id}} = send_message(waiting, ask)

    # The private field never reaches the peer's queued copy.
    peer_state = :sys.get_state(DeliveryStates)

    refute Enum.any?(peer_state.bodies, fn {{id, _}, body} ->
             id == ids.peer and Map.has_key?(body, "waiter_registration")
           end)

    answer = message(ids.peer, ids.waiting, "cnv-wait", 2, body: "answer")
    assert {:ok, %{"queue_id" => queue_id}} = send_message(peer, answer)

    assert_push "delivery_batch", %{
      "kind" => "waiter",
      "registration_id" => ^registration_id,
      "items" => [%{"queue_id" => ^queue_id, "class" => "waiter"}]
    }

    refute Map.has_key?(
             :sys.get_state(DeliveryStates).entries[ids.waiting].queue.items[
               String.to_integer(queue_id)
             ],
             :credit_revision
           )

    assert %{waiter: 1, queued: 1} = DeliveryStates.queue_counts(ids.waiting)

    assert {:ok, %{"claimed" => true, "closed" => false}} =
             control(waiting, waiting_reply, %{
               "op" => "waiter_close",
               "registration_id" => registration_id
             })
  end

  test "input from another peer or after expiry does not match", ids do
    {_reply, waiting} = join_agent(ids.waiting, queue_params())
    {_reply, peer} = join_agent(ids.peer, queue_params())
    {_reply, other} = join_agent(ids.other, queue_params())

    ask =
      Map.put(
        message(ids.waiting, ids.peer, "cnv-match", 1),
        "waiter_registration",
        registration()
      )

    {:ok, _} = send_message(waiting, ask)

    {:ok, _} = send_message(other, message(ids.other, ids.waiting, "cnv-other", 1))
    refute_push "delivery_batch", %{"kind" => "waiter"}

    expiring =
      Map.put(
        message(ids.waiting, ids.other, "cnv-expire", 1),
        "waiter_registration",
        registration(1)
      )

    {:ok, _} = send_message(waiting, expiring)
    Process.sleep(5)
    {:ok, _} = send_message(other, message(ids.other, ids.waiting, "cnv-expire", 2))
    refute_push "delivery_batch", %{"kind" => "waiter"}
    assert %{waiter: 0, queued: 2} = DeliveryStates.queue_counts(ids.waiting)
    _ = peer
  end

  test "a refused send leaves no registration, and an unclaimed one closes", ids do
    {waiting_reply, waiting} = join_agent(ids.waiting, queue_params())
    {_reply, _peer} = join_agent(ids.peer, queue_params())

    refused =
      Map.put(
        message(ids.waiting, "test.nobody", "cnv-refused", 1),
        "waiter_registration",
        registration()
      )

    assert {:error, %{reason: "unknown_agent"}} = send_message(waiting, refused)
    assert :sys.get_state(DeliveryStates).queue_controls[ids.waiting].waiters == %{}

    ask =
      Map.put(
        message(ids.waiting, ids.peer, "cnv-close", 1),
        "waiter_registration",
        registration()
      )

    {:ok, %{"waiter_registration_id" => id}} = send_message(waiting, ask)

    assert {:ok, %{"closed" => true, "claimed" => false}} =
             control(waiting, waiting_reply, %{"op" => "waiter_close", "registration_id" => id})
  end

  test "a malformed registration refuses the send", ids do
    {_reply, waiting} = join_agent(ids.waiting, queue_params())
    {_reply, _peer} = join_agent(ids.peer, queue_params())

    bad =
      Map.put(
        message(ids.waiting, ids.peer, "cnv-bad", 1),
        "waiter_registration",
        registration(300_001)
      )

    assert {:error, %{reason: "invalid value: waiter_registration"}} = send_message(waiting, bad)
  end
end
