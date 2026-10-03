defmodule KaoiroServerWeb.InterAgentQueueJoinTest do
  use KaoiroServerWeb.ChannelCase, async: false

  import Phoenix.ChannelTest

  alias KaoiroServer.AgentStates
  alias KaoiroServer.DeliveryStates

  @policy %{"batch_max_items" => 10, "backlog_max_items" => 100, "backlog_max_bytes" => 524_288}

  setup do
    Process.flag(:trap_exit, true)
    id = "test.queue-join-#{System.unique_integer([:positive])}"
    on_exit(fn -> DeliveryStates.delete(id) end)
    %{id: id}
  end

  defp params(overrides \\ %{}) do
    Map.merge(
      %{
        "persona_id" => "default",
        "inter_agent_queue" => "credit-v1",
        "inter_agent_queue_policy" => @policy,
        "inter_agent_delivery_ack" => "dispatch-v1",
        "delivery_resync" => "skip-v1",
        "delivery_generation" => "generation"
      },
      overrides
    )
  end

  defp join_queue(id, params) do
    KaoiroServerWeb.WrapperSocket
    |> socket(nil, %{})
    |> subscribe_and_join(KaoiroServerWeb.WrapperChannel, "wrapper:" <> id, params)
  end

  test "a valid declaration is bound and echoed", %{id: id} do
    {:ok, reply, socket} =
      join_queue(
        id,
        params(%{"inter_agent_inline_recovery" => "v1", "inter_agent_reply_basis" => "v1"})
      )

    assert reply["inter_agent_queue"] == "credit-v1"
    assert reply["inter_agent_queue_policy"] == @policy
    assert reply["inter_agent_queue_epoch"] == DeliveryStates.queue_epoch()
    assert reply["inter_agent_queue_resume_required"] == false
    assert reply["inter_agent_inline_recovery"] == "v1"
    assert socket.assigns.inter_agent_queue.policy.backlog_max_items == 100
  end

  test "a wrapper without the queue gets no queue echo", %{id: id} do
    {:ok, reply, _socket} = join_queue(id, Map.delete(params(), "inter_agent_queue"))
    refute Map.has_key?(reply, "inter_agent_queue")
    refute Map.has_key?(reply, "inter_agent_queue_epoch")
  end

  test "inline recovery is echoed only when declared", %{id: id} do
    {:ok, reply, _socket} = join_queue(id, params())
    refute Map.has_key?(reply, "inter_agent_inline_recovery")
  end

  test "a missing prerequisite refuses the join before anything is bound", %{id: id} do
    assert {:error, %{reason: "queue_capability_required", missing: ["delivery_resync"]}} =
             join_queue(id, Map.delete(params(), "delivery_resync"))

    refute AgentStates.connected?(id)
    assert DeliveryStates.get(id) == nil
  end

  test "M at the server ceiling is accepted and one byte above is refused", %{id: id} do
    ceiling = KaoiroServer.InterAgentQueuePolicy.backlog_max_bytes_ceiling()

    assert {:error,
            %{
              reason: "invalid_queue_policy",
              field: "backlog_max_bytes",
              detail: "above_ceiling",
              limit: ^ceiling
            }} =
             join_queue(
               id,
               params(%{
                 "inter_agent_queue_policy" => %{@policy | "backlog_max_bytes" => ceiling + 1}
               })
             )

    refute AgentStates.connected?(id)
    assert DeliveryStates.get(id) == nil

    assert {:ok, _reply, _socket} =
             join_queue(
               id,
               params(%{
                 "inter_agent_queue_policy" => %{@policy | "backlog_max_bytes" => ceiling}
               })
             )
  end

  test "a lowered ceiling refuses the next same-generation rejoin", %{id: id} do
    {:ok, _reply, socket} = join_queue(id, params())
    :ok = close(socket)

    previous = Application.fetch_env!(:kaoiro_server, :inter_agent_queue)
    on_exit(fn -> Application.put_env(:kaoiro_server, :inter_agent_queue, previous) end)

    Application.put_env(:kaoiro_server, :inter_agent_queue, backlog_max_bytes_ceiling: 524_287)

    assert {:error, %{detail: "above_ceiling", limit: 524_287}} = join_queue(id, params())
  end

  test "a same-generation rejoin with another tuple is refused", %{id: id} do
    {:ok, _reply, socket} = join_queue(id, params())
    :ok = close(socket)
    before = DeliveryStates.get(id)

    assert {:error,
            %{
              reason: "invalid_queue_policy",
              field: "inter_agent_queue_policy",
              detail: "generation_mismatch"
            }} =
             join_queue(
               id,
               params(%{"inter_agent_queue_policy" => %{@policy | "batch_max_items" => 5}})
             )

    refute AgentStates.connected?(id)
    assert DeliveryStates.get(id) == before

    assert {:ok, _reply, _socket} = join_queue(id, params())
  end

  test "a new generation may declare a new tuple", %{id: id} do
    {:ok, _reply, socket} = join_queue(id, params())
    :ok = close(socket)
    lower = %{@policy | "backlog_max_items" => 1}

    assert {:ok, reply, _socket} =
             join_queue(
               id,
               params(%{"delivery_generation" => "next", "inter_agent_queue_policy" => lower})
             )

    assert reply["inter_agent_queue_policy"] == lower
  end
end
