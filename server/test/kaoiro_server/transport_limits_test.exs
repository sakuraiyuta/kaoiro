defmodule KaoiroServer.TransportLimitsTest do
  use ExUnit.Case, async: true

  alias KaoiroServer.TransportLimits
  alias Phoenix.Socket.{Message, Reply}
  alias Phoenix.Socket.V2.JSONSerializer

  defp production_push_frame_bytes(topic, event, payload) do
    message = %Message{
      topic: topic,
      event: event,
      payload: Map.put_new(payload, "version", "0"),
      join_ref: nil,
      ref: nil
    }

    {:socket_push, :text, encoded} = JSONSerializer.encode!(message)
    IO.iodata_length(encoded)
  end

  defp production_reply_frame_bytes(topic, response) do
    reply = %Reply{topic: topic, status: :ok, payload: response, join_ref: nil, ref: nil}

    {:socket_push, :text, encoded} = JSONSerializer.encode!(reply)
    IO.iodata_length(encoded)
  end

  test "push and reply measurements use the production Phoenix serializer" do
    payload = %{"entries" => [%{"value" => String.duplicate("x", 1_024)}]}

    assert TransportLimits.push_frame_bytes("agents:lobby", "directory", payload) ==
             production_push_frame_bytes("agents:lobby", "directory", payload)

    assert TransportLimits.reply_frame_bytes("wrapper:test", payload) ==
             production_reply_frame_bytes("wrapper:test", payload)

    assert TransportLimits.push_frame_fits?("agents:lobby", "directory", payload)
    assert TransportLimits.reply_frame_fits?("wrapper:test", payload)
  end

  test "bounded projections reserve JSON punctuation as well as entry bytes" do
    assert TransportLimits.bounded_list(["aa", "bb"], 5) == ["aa"]
    assert TransportLimits.bounded_map([{"aa", 1}, {"bb", 2}], 6) == %{"aa" => 1}
  end

  test "history fragment ledger equals the independently encoded production frame" do
    static = %{
      "agents" => %{},
      "clear_watermarks" => %{},
      "history_projection" => "per-pane-v1",
      "projection_epoch" => "epoch-1",
      "history_incomplete" => true
    }

    histories = %{
      "agent-a" => [%{"seq" => 1, "text" => "first"}, %{"seq" => 2, "text" => "second"}],
      "agent-b" => [%{"seq" => 3, "text" => "third"}]
    }

    watermarks = %{
      "display-a" => %{"cleared_at" => "2026-08-28T00:00:00Z"},
      "display-b" => %{"cleared_at" => "2026-08-28T00:00:01Z"}
    }

    base_frame_bytes = production_push_frame_bytes("agents:lobby", "history", static)
    budget = TransportLimits.push_payload_budget("agents:lobby", "history", static)

    {projected_histories, false, history_bytes} =
      TransportLimits.bounded_map_of_newest_suffixes(histories, budget)

    {projected_watermarks, false, watermark_bytes} =
      TransportLimits.bounded_map_with_ledger(watermarks, budget - history_bytes)

    payload =
      static
      |> Map.put("agents", projected_histories)
      |> Map.put("clear_watermarks", projected_watermarks)

    frame_bytes = production_push_frame_bytes("agents:lobby", "history", payload)

    assert frame_bytes == base_frame_bytes + history_bytes + watermark_bytes
    assert frame_bytes <= TransportLimits.max_frame_bytes() - 1_024
  end

  test "newest suffix ledger keeps later small panes after an oversized pane" do
    static = %{"agents" => %{}}
    small = %{"text" => "ok"}

    budget =
      production_push_frame_bytes("agents:lobby", "history", %{
        "agents" => %{"agent-b" => [small]}
      }) - production_push_frame_bytes("agents:lobby", "history", static)

    {projected, true, used} =
      TransportLimits.bounded_map_of_newest_suffixes(
        %{
          "agent-a" => [%{"text" => String.duplicate("x", 512)}],
          "agent-b" => [small]
        },
        budget
      )

    assert projected == %{"agent-b" => [small]}
    assert used == budget
  end
end
