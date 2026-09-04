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
end
