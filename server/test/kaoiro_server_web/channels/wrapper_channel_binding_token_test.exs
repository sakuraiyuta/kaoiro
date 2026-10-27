defmodule KaoiroServerWeb.WrapperChannelBindingTokenTest do
  @moduledoc """
  Issue #512: after a `DeliveryStates` restart the channel that holds the
  current binding keeps working, and a channel of the same agent and
  generation whose bind was superseded does not, whatever it sent since.
  """
  use KaoiroServerWeb.ChannelCase, async: false

  alias KaoiroServer.{AgentStates, DeliveryStates, TestTimeouts, WorkStore}

  @supervisor KaoiroServer.Supervisor
  @gen "same-wrapper-generation"

  defp join_wrapper(id) do
    {:ok, reply, socket} =
      KaoiroServerWeb.WrapperSocket
      |> socket(nil, %{})
      |> subscribe_and_join(KaoiroServerWeb.WrapperChannel, "wrapper:" <> id, %{
        "persona_id" => "default",
        "inter_agent_delivery_ack" => "dispatch-v1",
        "delivery_generation" => @gen,
        "delivery_resync" => "skip-v1",
        "inter_agent_delivery_modes" => %{
          "version" => "v1",
          "early" => "none",
          "yield" => "none",
          "stage_reports" => true
        }
      })

    {reply, socket}
  end

  defp envelope(id, state) do
    %{
      "version" => "0",
      "agent_id" => id,
      "persona" => %{"id" => "default", "name" => "Default", "sprite_set" => "default"},
      "ts" => "2026-10-27T00:00:00Z",
      "type" => "state_change",
      "state" => state,
      "payload" => %{},
      "ext" => %{}
    }
  end

  defp restart_ledger do
    assert :ok = Supervisor.terminate_child(@supervisor, DeliveryStates)
    assert {:ok, _} = Supervisor.restart_child(@supervisor, DeliveryStates)
  end

  defp issued(id, turn) do
    DeliveryStates.issue_synthetic(id, %{
      sender: "test.binding-token-sender",
      conversation_id: "binding-token-#{turn}",
      turn_number: turn,
      mode: "normal"
    })
  end

  defp ack(socket, seq),
    do: push(socket, "delivery_ack", %{"version" => "0", "delivery_seq" => seq})

  defp resync(socket, cutoff, ranges, reason \\ nil) do
    request = %{
      "version" => "0",
      "generation" => @gen,
      "request_id" => "r-#{System.unique_integer([:positive])}",
      "cutoff" => cutoff,
      "missing_ranges" => ranges
    }

    push(
      socket,
      "delivery_resync",
      if(reason, do: Map.put(request, "reason", reason), else: request)
    )
  end

  defp stage_report(id, seq, stage) do
    %{
      "version" => "0",
      "generation" => @gen,
      "incarnation" => DeliveryStates.incarnation(id),
      "delivery_seq" => seq,
      "stage" => stage,
      "at" => DateTime.utc_now() |> DateTime.to_iso8601(),
      "handoff" => "tool_result"
    }
  end

  # The measured counterexample: old joins, latest joins with the same
  # generation, latest sends idle, old sends a late envelope (AgentStates now
  # names old as owner), three sequences are issued, and the ledger restarts
  # with an empty owner map. Only the latest channel holds the entry's token.
  defp two_channels_after_restart(id) do
    on_exit(fn -> DeliveryStates.delete(id) end)
    {_, old} = join_wrapper(id)
    {_, latest} = join_wrapper(id)
    assert old.channel_pid != latest.channel_pid
    assert_reply push(latest, "envelope", envelope(id, "idle")), :ok
    seqs = for turn <- 1..3, do: issued(id, turn)
    assert_reply push(old, "envelope", envelope(id, "thinking")), :ok
    assert :sys.get_state(AgentStates).agents[id].owner == old.channel_pid
    restart_ledger()
    assert :sys.get_state(DeliveryStates).owners[id] == nil
    token = :sys.get_state(DeliveryStates).entries[id].binding_token
    assert token == latest.assigns.delivery_binding_token
    refute token == old.assigns.delivery_binding_token
    {old, latest, seqs}
  end

  defp assert_unchanged(id, before, fun) do
    losses = DeliveryStates.pending_losses()
    fun.()
    assert DeliveryStates.get(id) == before
    assert DeliveryStates.pending_losses() == losses
    assert :sys.get_state(DeliveryStates).owners[id] == nil
  end

  test "ack: the old channel first is rejected unchanged, the latest is accepted in the same call" do
    id = "test.binding-ack-old-first"
    {old, latest, [s1 | _]} = two_channels_after_restart(id)
    before = DeliveryStates.get(id)

    assert_unchanged(id, before, fn ->
      assert_reply ack(old, s1), :error, %{reason: "stale_delivery_owner"}
    end)

    assert_reply ack(latest, s1), :ok, %{"delivery" => %{acked_seq: ^s1}}
    assert_reply ack(old, s1), :error, %{reason: "stale_delivery_owner"}
    assert :sys.get_state(DeliveryStates).owners[id] == nil
  end

  test "ack: the latest channel first, then the old channel is still rejected" do
    id = "test.binding-ack-latest-first"
    {old, latest, [s1 | _]} = two_channels_after_restart(id)
    assert_reply ack(latest, s1), :ok, %{"delivery" => %{acked_seq: ^s1}}
    before = DeliveryStates.get(id)

    assert_unchanged(id, before, fn ->
      assert_reply ack(old, s1), :error, %{reason: "stale_delivery_owner"}
    end)

    restart_ledger()
    assert_reply ack(old, s1), :error, %{reason: "stale_delivery_owner"}
    assert_reply ack(latest, s1), :ok
  end

  test "ack: a token in the old channel's payload is ignored" do
    id = "test.binding-ack-payload-token"
    {old, latest, [s1 | _]} = two_channels_after_restart(id)
    before = DeliveryStates.get(id)
    smuggled = Base.encode64(latest.assigns.delivery_binding_token)

    assert_unchanged(id, before, fn ->
      assert_reply push(old, "delivery_ack", %{
                     "version" => "0",
                     "delivery_seq" => s1,
                     "binding_token" => smuggled,
                     "owner" => inspect(latest.channel_pid)
                   }),
                   :error,
                   %{reason: "stale_delivery_owner"}
    end)
  end

  test "resync and retire: the old channel is rejected, the latest retires" do
    id = "test.binding-resync"
    {old, latest, [s1, s2, s3]} = two_channels_after_restart(id)
    before = DeliveryStates.get(id)

    assert_unchanged(id, before, fn ->
      assert_reply resync(old, s3, [[s1, s1]]), :error, %{reason: "stale_delivery_owner"}

      assert_reply resync(old, s3, [[s2, s2]], "interrupted"), :error, %{
        reason: "stale_delivery_owner"
      }
    end)

    assert_reply resync(latest, s3, [[s1, s1]]), :ok, %{"delivery" => %{lost_count: 1}}

    assert_reply resync(latest, s3, [[s2, s2]], "interrupted"), :ok, %{
      "delivery" => %{lost_count: 2}
    }

    assert Enum.count(DeliveryStates.pending_losses(), &(&1.recipient == id)) == 2
  end

  test "stage report: the old channel is rejected, the latest records the stage" do
    id = "test.binding-stage"
    {old, latest, [s1 | _]} = two_channels_after_restart(id)
    before = DeliveryStates.get(id)
    report = stage_report(id, s1, "submitted")

    assert_unchanged(id, before, fn ->
      assert_reply push(old, "delivery_stage", report), :error, %{
        reason: "invalid_delivery_stage"
      }
    end)

    assert_reply push(latest, "delivery_stage", report), :ok
    assert DeliveryStates.get(id).acked_seq == before.acked_seq
    assert s1 in :sys.get_state(DeliveryStates).entries[id].resolved
    stages = :sys.get_state(DeliveryStates).stages
    assert stages[{id, DeliveryStates.incarnation(id)}][s1].last_stage == "submitted"
  end

  test "terminate: the old channel's intentional disconnect retires nothing, the latest's retires" do
    id = "test.binding-terminate"
    {old, latest, _seqs} = two_channels_after_restart(id)
    before = DeliveryStates.get(id)
    @endpoint.subscribe("agents:lobby")

    assert_reply push(old, "disconnect_intent", %{"version" => "0", "reason" => "crash"}), :ok
    Process.unlink(old.channel_pid)
    ref = Process.monitor(old.channel_pid)
    :ok = close(old)
    assert_receive {:DOWN, ^ref, :process, _, _}, TestTimeouts.out_of_band()
    assert DeliveryStates.get(id).lost_count == before.lost_count

    assert_reply push(latest, "envelope", envelope(id, "idle")), :ok
    assert_reply push(latest, "disconnect_intent", %{"version" => "0", "reason" => "crash"}), :ok
    Process.unlink(latest.channel_pid)
    :ok = close(latest)

    assert_broadcast "delivery_status", %{
      "agent_id" => ^id,
      "delivery" => %{acked_seq: 3, lost_count: 3}
    }
  end

  test "yield claim: the old channel gets stale_channel, the latest is granted" do
    id = "test.binding-yield-recipient"
    director = "test.binding-yield-director"
    cid = "binding-yield-#{System.unique_integer([:positive])}"
    {old, latest, _seqs} = two_channels_after_restart(id)
    incarnation = DeliveryStates.incarnation(id)
    director_principal = %{"kind" => "agent", "id" => director}
    recipient_principal = %{"kind" => "agent", "id" => id}

    op_id = fn ->
      "op_#{System.system_time(:millisecond)}_#{Base.url_encode64(:crypto.strong_rand_bytes(16), padding: false)}"
    end

    assert {:ok, %{work: nomination}} =
             WorkStore.apply(
               director_principal,
               %{"op" => "assign", "operation_id" => op_id.(), "title" => cid},
               %{recipient: id, conversation_id: cid, turn_number: 1, new_conversation?: true}
             )

    assert {:ok, %{work: active}} =
             WorkStore.apply(
               recipient_principal,
               %{
                 "op" => "accept_assignment",
                 "operation_id" => op_id.(),
                 "work_id" => nomination.work_id
               },
               %{recipient: director, conversation_id: cid, turn_number: 2}
             )

    assert {:ok, token} =
             WorkStore.admit_yield(
               director_principal,
               id,
               cid,
               3,
               active.work_id,
               active.authority_epoch
             )

    assert is_integer(
             DeliveryStates.issue_synthetic(id, %{
               sender: director,
               conversation_id: cid,
               turn_number: 3
             })
           )

    request = %{
      "version" => "0",
      "generation" => @gen,
      "incarnation" => incarnation,
      "yield_token" => token.yield_token,
      "conversation_id" => cid,
      "turn_number" => 3,
      "work_id" => active.work_id,
      "authority_epoch" => active.authority_epoch
    }

    assert_reply push(old, "yield_claim", request), :ok, %{granted: false, reason: :stale_channel}
    assert :sys.get_state(WorkStore).yield_tokens[token.yield_token].state == "unclaimed"
    assert_reply push(latest, "yield_claim", request), :ok, %{granted: true}
  end

  test "a row without a token rejects both channels until a rejoin" do
    id = "test.binding-legacy-row"
    on_exit(fn -> DeliveryStates.delete(id) end)
    {_, old} = join_wrapper(id)
    {_, latest} = join_wrapper(id)
    assert_reply push(latest, "envelope", envelope(id, "idle")), :ok
    s1 = issued(id, 1)
    path = :dets.info(DeliveryStates, :filename)
    assert :ok = Supervisor.terminate_child(@supervisor, DeliveryStates)
    {:ok, DeliveryStates} = :dets.open_file(DeliveryStates, file: path)
    [row] = :dets.lookup(DeliveryStates, id)
    :ok = :dets.insert(DeliveryStates, put_elem(row, 5, Map.delete(elem(row, 5), :binding_token)))
    :ok = :dets.sync(DeliveryStates)
    :ok = :dets.close(DeliveryStates)
    assert {:ok, _} = Supervisor.restart_child(@supervisor, DeliveryStates)
    refute Map.has_key?(:sys.get_state(DeliveryStates).entries[id], :binding_token)

    assert_reply ack(old, s1), :error, %{reason: "stale_delivery_owner"}
    assert_reply ack(latest, s1), :error, %{reason: "stale_delivery_owner"}

    for socket <- [latest, old] do
      Process.unlink(socket.channel_pid)
      ref = Process.monitor(socket.channel_pid)
      :ok = close(socket)
      assert_receive {:DOWN, ^ref, :process, _, _}, TestTimeouts.out_of_band()
    end

    {_, rejoined} = join_wrapper(id)
    assert_reply ack(rejoined, s1), :ok, %{"delivery" => %{acked_seq: ^s1}}
  end

  test "the token is not exposed by the join reply, get/1, all/0 or delivery_status" do
    id = "test.binding-exposure"
    on_exit(fn -> DeliveryStates.delete(id) end)
    {reply, socket} = join_wrapper(id)
    refute Map.has_key?(reply["delivery"], :binding_token)
    refute Map.has_key?(DeliveryStates.get(id), :binding_token)

    refute Enum.any?(DeliveryStates.all(), fn {_, status} ->
             Map.has_key?(status, :binding_token)
           end)

    @endpoint.subscribe("wrapper:" <> id)
    assert_reply push(socket, "envelope", envelope(id, "idle")), :ok
    s1 = issued(id, 1)

    assert_receive %Phoenix.Socket.Broadcast{
                     topic: "wrapper:" <> ^id,
                     event: "delivery_status",
                     payload: status
                   },
                   TestTimeouts.out_of_band()

    refute Map.has_key?(status, :binding_token)
    assert_reply ack(socket, s1), :ok, %{"delivery" => delivery}
    refute Map.has_key?(delivery, :binding_token)
  end
end
