defmodule KaoiroServer.AgentStatesTest do
  use ExUnit.Case, async: true

  alias KaoiroServer.AgentStates

  defp envelope(agent_id) do
    %{"agent_id" => agent_id, "state" => "idle"}
  end

  test "新規 agent_id が上限を超えると拒否し、既知 agent_id の更新は通す" do
    store = start_supervised!({AgentStates, name: :agent_states_cap_test})

    for n <- 1..1000 do
      assert :ok = AgentStates.put(store, envelope("agent-#{n}"))
    end

    assert {:error, :too_many_agents} =
             AgentStates.put(store, envelope("agent-1001"))

    # Updates to an already-known agent_id still succeed at the cap.
    assert :ok = AgentStates.put(store, envelope("agent-1"))
    assert map_size(AgentStates.snapshot(store)) == 1000
  end
end
