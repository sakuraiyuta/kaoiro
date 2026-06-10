defmodule KaoiroServerWeb.AgentsChannelTest do
  use KaoiroServerWeb.ChannelCase, async: false

  alias KaoiroServer.AgentStates

  test "join 後に現在のスナップショットが push される" do
    agent_id = "test.snapshot-1"

    envelope = %{
      "version" => "0",
      "agent_id" => agent_id,
      "ts" => "2026-06-11T00:00:00Z",
      "type" => "state_change",
      "state" => "waiting_input"
    }

    :ok = AgentStates.put(envelope)

    {:ok, _reply, _socket} =
      KaoiroServerWeb.ClientSocket
      |> socket(nil, %{})
      |> subscribe_and_join(KaoiroServerWeb.AgentsChannel, "agents:lobby")

    assert_push "snapshot", %{"agents" => agents}
    assert agents[agent_id] == envelope
  end
end
