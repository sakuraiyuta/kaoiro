defmodule KaoiroServer.AgentStatesTest do
  use ExUnit.Case, async: true

  alias KaoiroServer.AgentStates

  defp envelope(agent_id, extra \\ %{}) do
    Map.merge(%{"agent_id" => agent_id, "state" => "idle"}, extra)
  end

  test "新規 agent_id が上限を超えると拒否し、既知 agent_id の更新は通す" do
    store = start_supervised!({AgentStates, name: :agent_states_cap_test})

    for n <- 1..1000 do
      assert :ok = AgentStates.put(envelope("agent-#{n}"), server: store)
    end

    assert {:error, :too_many_agents} =
             AgentStates.put(envelope("agent-1001"), server: store)

    # Updates to an already-known agent_id still succeed at the cap.
    assert :ok = AgentStates.put(envelope("agent-1"), server: store)
    assert map_size(AgentStates.snapshot(store)) == 1000
  end

  test "known?/2 はマップを複製せずに存在を判定する" do
    store = start_supervised!({AgentStates, name: :agent_states_known_test})

    :ok = AgentStates.put(envelope("agent-k1"), server: store)

    assert AgentStates.known?("agent-k1", server: store)
    refute AgentStates.known?("agent-k2", server: store)
  end

  describe "disconnect/4" do
    setup do
      store = start_supervised!({AgentStates, name: :agent_states_disc_test})
      %{store: store}
    end

    test "owner が一致すれば disconnected を導出して保存する", %{store: store} do
      owner = self()

      env =
        envelope("agent-d1", %{
          "version" => "0",
          "persona" => %{"id" => "ao"},
          "seq" => 7,
          "ts" => "2026-06-11T00:00:00Z",
          "type" => "state_change",
          "payload" => %{"label" => "x"}
        })

      :ok = AgentStates.put(env, server: store, owner: owner)

      assert {:ok, derived} =
               AgentStates.disconnect("agent-d1", owner, "2026-06-11T00:01:00Z", server: store)

      assert derived["state"] == "disconnected"
      assert derived["type"] == "state_change"
      assert derived["ts"] == "2026-06-11T00:01:00Z"
      assert derived["persona"] == %{"id" => "ao"}
      # seq is the wrapper's series; server-derived envelopes drop it.
      refute Map.has_key?(derived, "seq")
      assert AgentStates.snapshot(store)["agent-d1"] == derived
    end

    test "owner 不一致 (再接続後の stale terminate) は noop", %{store: store} do
      stale_owner = spawn(fn -> :ok end)
      env = envelope("agent-d2", %{"state" => "thinking"})
      :ok = AgentStates.put(env, server: store, owner: self())

      assert :noop =
               AgentStates.disconnect("agent-d2", stale_owner, "2026-06-11T00:01:00Z",
                 server: store
               )

      assert AgentStates.snapshot(store)["agent-d2"]["state"] == "thinking"
    end

    test "未知 agent_id は noop", %{store: store} do
      assert :noop =
               AgentStates.disconnect("agent-none", self(), "2026-06-11T00:01:00Z", server: store)
    end
  end
end
