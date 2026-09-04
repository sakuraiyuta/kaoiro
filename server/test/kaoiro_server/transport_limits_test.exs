defmodule KaoiroServer.TransportLimitsTest do
  use ExUnit.Case, async: true

  alias KaoiroServer.TransportLimits

  test "push and reply measurements use the production Phoenix serializer" do
    payload = %{"entries" => [%{"value" => String.duplicate("x", 1_024)}]}

    assert TransportLimits.push_frame_bytes("agents:lobby", "directory", payload) > 1_024
    assert TransportLimits.reply_frame_bytes("wrapper:test", payload) > 1_024
    assert TransportLimits.push_frame_fits?("agents:lobby", "directory", payload)
    assert TransportLimits.reply_frame_fits?("wrapper:test", payload)
  end

  test "bounded projections reserve JSON punctuation as well as entry bytes" do
    assert TransportLimits.bounded_list(["aa", "bb"], 5) == ["aa"]
    assert TransportLimits.bounded_map([{"aa", 1}, {"bb", 2}], 6) == %{"aa" => 1}
  end
end
