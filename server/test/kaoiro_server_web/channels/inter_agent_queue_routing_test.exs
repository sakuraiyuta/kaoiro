defmodule KaoiroServerWeb.InterAgentQueueRoutingTest do
  use KaoiroServerWeb.ChannelCase, async: false

  import Phoenix.ChannelTest

  alias KaoiroServer.{AgentDirectory, ConversationStates, DeliveryStates}
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
    sender = "test.route-sender-#{n}"
    recipient = "test.route-recipient-#{n}"

    on_exit(fn ->
      Enum.each([sender, recipient], fn id ->
        DeliveryStates.delete(id)
        AgentDirectory.delete(id)
      end)
    end)

    %{sender: sender, recipient: recipient, configured: previous}
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

    ref = push(socket, "envelope", state(id))
    assert_reply ref, :ok, _, TestTimeouts.durable_reply()
    {reply, socket}
  end

  defp queue_params(backlog_max_items) do
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

  defp state(id) do
    %{
      "version" => "0",
      "agent_id" => id,
      "persona" => %{"id" => "mio", "name" => "澪", "sprite_set" => "mio"},
      "ts" => "2026-10-04T00:00:00Z",
      "type" => "state_change",
      "state" => "idle",
      "payload" => %{},
      "ext" => %{}
    }
  end

  defp message(from, to, cid, body \\ "hello") do
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
        "turn_number" => 1,
        "kind" => "inform",
        "body" => body,
        "meta" => %{"done" => false, "propose_next" => ""},
        "owner" => %{"kind" => "user", "id" => "operator"},
        "new_conversation" => true
      },
      "ext" => %{}
    }
  end

  defp send_message(socket, envelope) do
    ref = push(socket, "envelope", envelope)
    assert_reply ref, status, reply, TestTimeouts.durable_reply()
    {status, reply}
  end

  test "accepted input is queued, not pushed, and reaches the recipient through credit", ctx do
    {recipient_reply, recipient} = join_agent(ctx.recipient, queue_params(10))
    {_reply, sender} = join_agent(ctx.sender, %{})

    assert {:ok,
            %{
              "queue_id" => queue_id,
              "ingress_stamp" => stamp,
              "delivery" => %{"advisory" => %{"unresolved_count" => 1}}
            }} =
             send_message(sender, message(ctx.sender, ctx.recipient, "cnv-route-1", "héllo"))

    refute_push "envelope", %{"type" => "inter_agent_message"}
    assert %{queued: 1, charged_bytes: 6} = DeliveryStates.queue_counts(ctx.recipient)

    credit = %{
      "version" => "0",
      "queue_epoch" => recipient_reply["inter_agent_queue_epoch"],
      "incarnation" => recipient_reply["inter_agent_delivery_incarnation"],
      "generation" => "generation",
      "operation_id" => "1",
      "op" => "credit",
      "kind" => "root",
      "native_turn_token" => "t1"
    }

    ref = push(recipient, "delivery_queue_control", credit)
    assert_reply ref, :ok, _, TestTimeouts.durable_reply()

    assert_push "delivery_batch", %{
      "items" => [
        %{
          "queue_id" => ^queue_id,
          "delivery_seq" => 1,
          "envelope" => %{"ingress_stamp" => ^stamp, "payload" => %{"body" => "héllo"}}
        }
      ]
    }
  end

  test "a saturated recipient refuses before the conversation is recorded", ctx do
    {_reply, _recipient} = join_agent(ctx.recipient, queue_params(1))
    {_reply, sender} = join_agent(ctx.sender, %{})

    assert {:ok, %{"queue_id" => _}} =
             send_message(sender, message(ctx.sender, ctx.recipient, "cnv-route-a"))

    assert {:error, %{reason: "receiver_overloaded", from: from, message: message}} =
             send_message(sender, message(ctx.sender, ctx.recipient, "cnv-route-b"))

    assert from == ctx.recipient
    assert message =~ "do not resend"
    assert ConversationStates.get("cnv-route-b") == nil

    # Neither reservation outlives the refusal.
    state = :sys.get_state(DeliveryStates)
    refute Enum.any?(state.reservations, fn {_, r} -> r.agent_id == ctx.recipient end)
    refute Enum.any?(state.queue_reservations, fn {_, r} -> r.agent_id == ctx.recipient end)
    assert %{queued: 1} = DeliveryStates.queue_counts(ctx.recipient)
  end

  test "routing is off by default and then accepted input keeps the direct push", ctx do
    assert Keyword.get(ctx.configured, :route_accepted) == false
    Application.put_env(:kaoiro_server, :inter_agent_queue, ctx.configured)

    {_reply, _recipient} = join_agent(ctx.recipient, queue_params(10))
    {_reply, sender} = join_agent(ctx.sender, %{})

    assert {:ok, reply} =
             send_message(sender, message(ctx.sender, ctx.recipient, "cnv-route-off"))

    refute Map.has_key?(reply, "queue_id")
    assert_push "envelope", %{"type" => "inter_agent_message", "delivery_seq" => 1}
    assert %{queued: 0} = DeliveryStates.queue_counts(ctx.recipient)
  end

  test "a stale-basis reply carries the sender's queued input from that peer", ctx do
    params =
      queue_params(10)
      |> Map.merge(%{"inter_agent_reply_basis" => "v1", "inter_agent_inline_recovery" => "v1"})

    {_reply, recipient} = join_agent(ctx.recipient, params)
    {_reply, sender} = join_agent(ctx.sender, %{})

    assert {:ok, %{"queue_id" => queue_id}} =
             send_message(sender, message(ctx.sender, ctx.recipient, "cnv-recover", "first"))

    stale =
      ctx.recipient
      |> message(ctx.sender, "cnv-recover", "answer")
      |> update_in(["payload"], fn payload ->
        Map.merge(payload, %{"turn_number" => 2, "in_reply_to" => 0, "new_conversation" => false})
      end)

    assert {:error,
            %{
              reason: "stale_reply_basis",
              queue_recovery: %{
                "lease_id" => _,
                "items" => [
                  %{
                    "queue_id" => ^queue_id,
                    "delivery_seq" => 1,
                    "envelope" => %{"payload" => %{"body" => "first"}}
                  }
                ]
              }
            }} = send_message(recipient, stale)

    assert %{queued: 0, offered: 1} = DeliveryStates.queue_counts(ctx.recipient)
  end

  test "without inline recovery the stale-basis reply carries nothing", ctx do
    params = Map.put(queue_params(10), "inter_agent_reply_basis", "v1")
    {_reply, recipient} = join_agent(ctx.recipient, params)
    {_reply, sender} = join_agent(ctx.sender, %{})
    {:ok, _} = send_message(sender, message(ctx.sender, ctx.recipient, "cnv-no-recover"))

    stale =
      ctx.recipient
      |> message(ctx.sender, "cnv-no-recover", "answer")
      |> update_in(["payload"], fn payload ->
        Map.merge(payload, %{"turn_number" => 2, "in_reply_to" => 0, "new_conversation" => false})
      end)

    assert {:error, %{reason: "stale_reply_basis"} = details} = send_message(recipient, stale)
    refute Map.has_key?(details, :queue_recovery)
    assert %{queued: 1} = DeliveryStates.queue_counts(ctx.recipient)
  end

  describe "server notices" do
    alias KaoiroServer.InterAgentQueue
    alias KaoiroServerWeb.SynthEnvelope

    defp notice(to, cid) do
      SynthEnvelope.build(
        %{
          "to" => to,
          "conversation_id" => cid,
          "turn_number" => 0,
          "kind" => "inform",
          "body" => "peer is reconnecting",
          "meta" => %{"done" => false, "propose_next" => ""},
          "owner" => %{"kind" => "user", "id" => "system"}
        },
        "2026-10-04T00:00:00Z"
      )
    end

    test "a notice is queued, not pushed, and reaches the recipient through credit", ctx do
      {reply, recipient} = join_agent(ctx.recipient, queue_params(10))

      assert :ok =
               SynthEnvelope.deliver(ctx.recipient, notice(ctx.recipient, "cnv-notice"), %{
                 synthetic: true,
                 kind: "reconnecting",
                 conversation_id: "cnv-notice",
                 subject: "peer"
               })

      refute_push "envelope", %{"agent_id" => "server"}
      assert %{queued: 1} = DeliveryStates.queue_counts(ctx.recipient)

      [item] = Map.values(:sys.get_state(DeliveryStates).entries[ctx.recipient].queue.items)
      assert %{sender: "server", descriptor: %{synthetic: true, kind: "reconnecting"}} = item

      credit = %{
        "version" => "0",
        "queue_epoch" => reply["inter_agent_queue_epoch"],
        "incarnation" => reply["inter_agent_delivery_incarnation"],
        "generation" => "generation",
        "operation_id" => "1",
        "op" => "credit",
        "kind" => "root",
        "native_turn_token" => "t"
      }

      ref = push(recipient, "delivery_queue_control", credit)
      assert_reply ref, :ok, _, TestTimeouts.durable_reply()
      assert_push "delivery_batch", %{"items" => [%{"envelope" => %{"agent_id" => "server"}}]}
    end

    test "a saturated queue refuses a notice past the control allowance", ctx do
      {_reply, _recipient} = join_agent(ctx.recipient, queue_params(1))
      descriptor = %{synthetic: true, kind: "reconnecting", conversation_id: "c", subject: "p"}

      results =
        for n <- 1..(1 + InterAgentQueue.control_allowance() + 1) do
          SynthEnvelope.deliver(ctx.recipient, notice(ctx.recipient, "c#{n}"), descriptor)
        end

      assert List.last(results) == {:error, :receiver_overloaded}
      assert Enum.count(results, &(&1 == :ok)) == 1 + InterAgentQueue.control_allowance()
      assert %{control: 16} = DeliveryStates.queue_counts(ctx.recipient)
    end

    test "a loss notice the sender's queue refuses stays pending", ctx do
      {_reply, sender} = join_agent(ctx.sender, queue_params(1))
      {_reply, _recipient} = join_agent(ctx.recipient, queue_params(10))
      descriptor = %{synthetic: true, kind: "reconnecting", conversation_id: "c", subject: "p"}

      # The sender's own queue is saturated, control allowance included.
      for n <- 1..(1 + InterAgentQueue.control_allowance()) do
        :ok = SynthEnvelope.deliver(ctx.sender, notice(ctx.sender, "f#{n}"), descriptor)
      end

      {:ok, _} = send_message(sender, message(ctx.sender, ctx.recipient, "cnv-lost"))
      :ok = DeliveryStates.delete(ctx.recipient)

      assert [%{recipient: recipient, reason: "delivery_lost"} = loss] =
               Enum.filter(DeliveryStates.pending_losses(), &(&1.recipient == ctx.recipient))

      assert recipient == ctx.recipient
      KaoiroServerWeb.DeliveryLossDispatcher.flush()
      assert loss in DeliveryStates.pending_losses()
    end

    test "an unknown outcome tells the sender delivery may have happened, once", ctx do
      {reply, recipient} = join_agent(ctx.recipient, queue_params(10))
      {_reply, sender} = join_agent(ctx.sender, %{})

      {:ok, %{"queue_id" => queue_id}} =
        send_message(sender, message(ctx.sender, ctx.recipient, "cnv-unknown"))

      fence = %{
        "version" => "0",
        "queue_epoch" => reply["inter_agent_queue_epoch"],
        "incarnation" => reply["inter_agent_delivery_incarnation"],
        "generation" => "generation"
      }

      control = fn id, op ->
        ref =
          push(
            recipient,
            "delivery_queue_control",
            Map.merge(fence, Map.put(op, "operation_id", id))
          )

        assert_reply ref, :ok, response, TestTimeouts.durable_reply()
        response
      end

      control.("1", %{"op" => "credit", "kind" => "root", "native_turn_token" => "t"})
      assert_push "delivery_batch", %{"lease_id" => lease_id}

      control.("2", %{
        "op" => "begin_native",
        "lease_id" => lease_id,
        "queue_ids" => [queue_id],
        "native_turn_token" => "t"
      })

      control.("3", %{
        "op" => "dispose",
        "lease_id" => lease_id,
        "items" => [%{"queue_id" => queue_id, "outcome" => "unknown", "reason" => "host_crashed"}]
      })

      assert [%{reason: "host_crashed"}] =
               Enum.filter(
                 DeliveryStates.pending_queue_uncertain(),
                 &(&1.recipient == ctx.recipient)
               )

      KaoiroServerWeb.DeliveryLossDispatcher.flush()

      assert_push "envelope", %{
        "agent_id" => "server",
        "payload" => %{
          "to" => to,
          "error" => %{"code" => "delivery_uncertain", "peer" => peer, "reason" => "host_crashed"}
        }
      }

      assert {to, peer} == {ctx.sender, ctx.recipient}

      assert Enum.filter(
               DeliveryStates.pending_queue_uncertain(),
               &(&1.recipient == ctx.recipient)
             ) == []

      KaoiroServerWeb.DeliveryLossDispatcher.flush()
      refute_push "envelope", %{"payload" => %{"error" => %{"code" => "delivery_uncertain"}}}
    end
  end
end
