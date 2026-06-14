defmodule KaoiroServer.AgentStatesTest do
  use ExUnit.Case, async: true

  alias KaoiroServer.AgentStates

  defp envelope(agent_id, extra \\ %{}) do
    Map.merge(%{"agent_id" => agent_id, "state" => "idle"}, extra)
  end

  defp log_env(agent_id, i) do
    envelope(agent_id, %{
      "type" => "log",
      "payload" => %{"kind" => "assistant", "text" => "m#{i}"}
    })
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

    test "履歴を保持したまま disconnected を導出する", %{store: store} do
      owner = self()

      :ok =
        AgentStates.put(envelope("agent-dh", %{"state" => "thinking"}),
          server: store,
          owner: owner
        )

      :ok = AgentStates.append_log(log_env("agent-dh", 1), server: store)

      assert {:ok, _} =
               AgentStates.disconnect("agent-dh", owner, "2026-06-11T00:01:00Z", server: store)

      assert AgentStates.snapshot(store)["agent-dh"]["state"] == "disconnected"
      assert length(AgentStates.histories(store)["agent-dh"]) == 1
    end
  end

  describe "reply-log history" do
    setup do
      store = start_supervised!({AgentStates, name: :agent_states_hist_test})
      %{store: store}
    end

    test "append_log は履歴へ追加し最新状態は変えない", %{store: store} do
      :ok = AgentStates.put(envelope("a", %{"state" => "thinking"}), server: store)
      :ok = AgentStates.append_log(log_env("a", 1), server: store)
      :ok = AgentStates.append_log(log_env("a", 2), server: store)

      # Reply lines never move the latest state.
      assert AgentStates.snapshot(store)["a"]["state"] == "thinking"

      # History is chronological (oldest first).
      assert [%{"payload" => %{"text" => "m1"}}, %{"payload" => %{"text" => "m2"}}] =
               AgentStates.histories(store)["a"]
    end

    test "履歴は @max_history を超えると最古を落とす", %{store: store} do
      :ok = AgentStates.put(envelope("a"), server: store)
      for i <- 1..205, do: :ok = AgentStates.append_log(log_env("a", i), server: store)

      history = AgentStates.histories(store)["a"]
      assert length(history) == 200
      assert List.first(history)["payload"]["text"] == "m6"
      assert List.last(history)["payload"]["text"] == "m205"
    end

    test "put は履歴を保持し最新状態のみ更新", %{store: store} do
      :ok = AgentStates.put(envelope("a", %{"state" => "idle"}), server: store)
      :ok = AgentStates.append_log(log_env("a", 1), server: store)
      :ok = AgentStates.put(envelope("a", %{"state" => "thinking"}), server: store)

      assert AgentStates.snapshot(store)["a"]["state"] == "thinking"
      assert length(AgentStates.histories(store)["a"]) == 1
    end

    test "histories は空履歴の agent を省く", %{store: store} do
      :ok = AgentStates.put(envelope("a"), server: store)
      :ok = AgentStates.put(envelope("b"), server: store)
      :ok = AgentStates.append_log(log_env("a", 1), server: store)

      histories = AgentStates.histories(store)
      assert Map.has_key?(histories, "a")
      refute Map.has_key?(histories, "b")
    end

    test "append_log は未知 agent には noop", %{store: store} do
      assert :noop = AgentStates.append_log(log_env("ghost", 1), server: store)
    end
  end
end
