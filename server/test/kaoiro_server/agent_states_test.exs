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

  defp inter_agent_env(agent_id, to, body \\ "hello") do
    envelope(agent_id, %{
      "type" => "inter_agent_message",
      "payload" => %{"to" => to, "conversation_id" => "cnv-105", "body" => body}
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

  describe "connected?/2 (ADR-0024 D5)" do
    setup do
      %{store: start_supervised!({AgentStates, name: :agent_states_connected_test})}
    end

    test "生きた owner を持つ agent は connected?", %{store: store} do
      :ok = AgentStates.put(envelope("c.live"), owner: self(), server: store)
      assert AgentStates.connected?("c.live", server: store)
    end

    test "未知 agent は connected? false", %{store: store} do
      refute AgentStates.connected?("c.unknown", server: store)
    end

    test "owner 無し(server 由来など)は connected? false", %{store: store} do
      :ok = AgentStates.put(envelope("c.noowner"), server: store)
      refute AgentStates.connected?("c.noowner", server: store)
    end

    test "死んだ owner は connected? false で再接続を許す", %{store: store} do
      dead = spawn(fn -> :ok end)
      ref = Process.monitor(dead)
      assert_receive {:DOWN, ^ref, :process, ^dead, _}
      :ok = AgentStates.put(envelope("c.dead"), owner: dead, server: store)
      refute AgentStates.connected?("c.dead", server: store)
    end
  end

  describe "delete/1 (issue #14)" do
    setup do
      %{store: start_supervised!({AgentStates, name: :agent_states_delete_test})}
    end

    test "disconnected の agent を削除する", %{store: store} do
      :ok =
        AgentStates.put(envelope("a.del", %{"state" => "disconnected"}), server: store)

      assert :ok = AgentStates.delete("a.del", server: store)
      refute AgentStates.known?("a.del", server: store)
    end

    test "稼働中の agent は not_disconnected で拒否", %{store: store} do
      :ok = AgentStates.put(envelope("a.live", %{"state" => "thinking"}), server: store)
      assert {:error, :not_disconnected} = AgentStates.delete("a.live", server: store)
      assert AgentStates.known?("a.live", server: store)
    end

    test "未知 agent は unknown_agent", %{store: store} do
      assert {:error, :unknown_agent} = AgentStates.delete("a.none", server: store)
    end
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

    test "cap到達後も古いinter_agent_messageを保持する (#105)", %{store: store} do
      :ok = AgentStates.put(envelope("a"), server: store)
      :ok = AgentStates.append_log(inter_agent_env("a", "b", "ia-old"), server: store)
      for i <- 1..205, do: :ok = AgentStates.append_log(log_env("a", i), server: store)

      history = AgentStates.histories(store)["a"]
      assert length(history) == 201
      assert List.first(history)["payload"]["body"] == "ia-old"
      assert Enum.at(history, 1)["payload"]["text"] == "m6"
      assert List.last(history)["payload"]["text"] == "m205"

      # Internal storage remains newest-first, including the cap-exempt tail.
      raw = :sys.get_state(store)["a"].history
      assert hd(raw)["payload"]["text"] == "m205"
      assert List.last(raw)["payload"]["body"] == "ia-old"
    end

    test "logとIAが混在しても全IAとnewest-first順序を保つ (#105)", %{store: store} do
      :ok = AgentStates.put(envelope("a"), server: store)
      :ok = AgentStates.append_log(inter_agent_env("a", "b", "ia-1"), server: store)
      for i <- 1..100, do: :ok = AgentStates.append_log(log_env("a", i), server: store)
      :ok = AgentStates.append_log(inter_agent_env("a", "b", "ia-2"), server: store)
      for i <- 101..205, do: :ok = AgentStates.append_log(log_env("a", i), server: store)

      history = AgentStates.histories(store)["a"]
      assert length(history) == 201

      labels =
        Enum.map(history, fn env ->
          env["payload"]["body"] || env["payload"]["text"]
        end)

      assert labels ==
               ["ia-1"] ++
                 Enum.map(7..100, &"m#{&1}") ++
                 ["ia-2"] ++ Enum.map(101..205, &"m#{&1}")

      raw_labels =
        :sys.get_state(store)["a"].history
        |> Enum.map(fn env -> env["payload"]["body"] || env["payload"]["text"] end)

      assert raw_labels == Enum.reverse(labels)
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

  describe "clear_other_sessions/2 (issue #48)" do
    setup do
      store = start_supervised!({AgentStates, name: :agent_states_clear_test})
      %{store: store}
    end

    defp log_sid(agent_id, i, sid),
      do: Map.put(log_env(agent_id, i), "session_id", sid)

    test "現在のセッション以外(別 session_id / 無し)を落とし現在のみ残す", %{store: store} do
      # The latest state envelope's session_id defines "current" = s2.
      :ok =
        AgentStates.put(envelope("a", %{"state" => "thinking", "session_id" => "s2"}),
          server: store
        )

      :ok = AgentStates.append_log(log_sid("a", 1, "s1"), server: store)
      :ok = AgentStates.append_log(log_sid("a", 2, "s2"), server: store)
      # No session_id at all -> treated as "other" and dropped.
      :ok = AgentStates.append_log(log_env("a", 3), server: store)
      :ok = AgentStates.append_log(log_sid("a", 4, "s2"), server: store)

      assert {:ok, "s2"} = AgentStates.clear_other_sessions("a", server: store)

      texts = Enum.map(AgentStates.histories(store)["a"], & &1["payload"]["text"])
      assert texts == ["m2", "m4"]
    end

    test "現在の session_id が不明なら noop で履歴を残す", %{store: store} do
      :ok = AgentStates.put(envelope("a", %{"state" => "thinking"}), server: store)
      :ok = AgentStates.append_log(log_sid("a", 1, "s1"), server: store)

      assert :noop = AgentStates.clear_other_sessions("a", server: store)
      assert length(AgentStates.histories(store)["a"]) == 1
    end

    test "未知 agent_id は noop", %{store: store} do
      assert :noop = AgentStates.clear_other_sessions("ghost", server: store)
    end

    test "disconnected overlay 後も session_id を保持して消去できる", %{store: store} do
      owner = self()

      :ok =
        AgentStates.put(
          envelope("a", %{
            "version" => "0",
            "persona" => %{"id" => "ao"},
            "type" => "state_change",
            "state" => "thinking",
            "session_id" => "s2"
          }),
          server: store,
          owner: owner
        )

      :ok = AgentStates.append_log(log_sid("a", 1, "s1"), server: store)
      :ok = AgentStates.append_log(log_sid("a", 2, "s2"), server: store)

      assert {:ok, _} =
               AgentStates.disconnect("a", owner, "2026-06-16T00:00:00Z", server: store)

      # The disconnected overlay keeps session_id, so clear still works.
      assert AgentStates.snapshot(store)["a"]["session_id"] == "s2"
      assert {:ok, "s2"} = AgentStates.clear_other_sessions("a", server: store)
      assert [%{"payload" => %{"text" => "m2"}}] = AgentStates.histories(store)["a"]
    end
  end

  describe "reset_history/1 (issue #50, ADR-0014 phase-2)" do
    setup do
      store = start_supervised!({AgentStates, name: :agent_states_reset_test})
      %{store: store}
    end

    test "JSONLで再構築する履歴を消去し最新状態は残す", %{store: store} do
      :ok = AgentStates.put(envelope("a", %{"state" => "thinking"}), server: store)
      :ok = AgentStates.append_log(log_env("a", 1), server: store)
      :ok = AgentStates.append_log(log_env("a", 2), server: store)

      assert :ok = AgentStates.reset_history("a", server: store)

      # All reply lines gone, latest state untouched.
      refute Map.has_key?(AgentStates.histories(store), "a")
      assert AgentStates.snapshot(store)["a"]["state"] == "thinking"
    end

    test "JSONLで再構築不能な inter_agent_message は保持する (#105)", %{store: store} do
      :ok = AgentStates.put(envelope("a"), server: store)
      :ok = AgentStates.append_log(log_env("a", 1), server: store)
      :ok = AgentStates.append_log(inter_agent_env("a", "b"), server: store)

      assert :ok = AgentStates.reset_history("a", server: store)
      assert [%{"type" => "inter_agent_message"}] = AgentStates.histories(store)["a"]
    end

    test "未知 agent_id は noop", %{store: store} do
      assert :noop = AgentStates.reset_history("ghost", server: store)
    end
  end

  # phase-17 17-7 (ADR-0036 F3): session_boundary marker + pending-patch
  # 経路。SessionResets が confirm_connection で書き込む marker envelope
  # を history に載せる path と、Codex lazy采番用の to_session_id 後追い
  # patch。
  describe "session_boundary marker (17-7)" do
    setup do
      store =
        start_supervised!({AgentStates, name: :"boundary_#{System.unique_integer([:positive])}"})

      :ok = AgentStates.put(envelope("a", %{"state" => "idle"}), server: store)
      %{store: store}
    end

    defp boundary_marker(mode, request_id, to_session_id, previous_session_id \\ nil) do
      payload =
        %{
          "mode" => mode,
          "request_id" => request_id,
          "to_session_id" => to_session_id
        }
        |> then(fn p ->
          if is_binary(previous_session_id),
            do: Map.put(p, "previous_session_id", previous_session_id),
            else: p
        end)

      %{
        "agent_id" => "a",
        "type" => "session_boundary",
        "state" => "idle",
        "payload" => payload
      }
    end

    test "append_boundary: 既存 history 末尾に marker を追加、状態はそのまま", %{store: store} do
      :ok = AgentStates.append_log(log_env("a", 1), server: store)
      marker = boundary_marker("new", "rs_1", "sess-new", "sess-old")

      assert :ok = AgentStates.append_boundary("a", marker, server: store)

      history = AgentStates.histories(store)["a"]
      # Chronological (oldest first): log first, marker last.
      assert length(history) == 2
      assert Enum.at(history, 0)["type"] == "log"
      assert Enum.at(history, 1)["type"] == "session_boundary"
      # Latest state is untouched.
      assert AgentStates.snapshot(store)["a"]["state"] == "idle"
    end

    test "append_boundary: to_session_id=nil で pending patch stash", %{store: store} do
      marker = boundary_marker("new", "rs_lazy", nil, "sess-old")
      assert :ok = AgentStates.append_boundary("a", marker, server: store)

      # 続く envelope で patch が発火するかを確認: session_id 付き envelope
      # 相当の patch call で marker の to_session_id が確定する。
      assert :ok = AgentStates.patch_boundary_to_session_id("a", "sess-new", server: store)

      history = AgentStates.histories(store)["a"]
      [marker_env] = Enum.filter(history, &(&1["type"] == "session_boundary"))
      assert marker_env["payload"]["to_session_id"] == "sess-new"
    end

    test "append_boundary: to_session_id=binary は pending 無し、後続 patch は noop", %{
      store: store
    } do
      marker = boundary_marker("new", "rs_eager", "sess-x", "sess-old")
      assert :ok = AgentStates.append_boundary("a", marker, server: store)

      # 後続 patch call は stash が無いので :noop、marker は変わらない。
      assert :noop = AgentStates.patch_boundary_to_session_id("a", "sess-other", server: store)

      history = AgentStates.histories(store)["a"]
      [marker_env] = Enum.filter(history, &(&1["type"] == "session_boundary"))
      assert marker_env["payload"]["to_session_id"] == "sess-x"
    end

    test "clear_history_with_boundary: 全 history を消去し marker を唯一の line として残す", %{
      store: store
    } do
      :ok = AgentStates.append_log(log_env("a", 1), server: store)
      :ok = AgentStates.append_log(log_env("a", 2), server: store)
      marker = boundary_marker("clear", "rs_c", "sess-new", "sess-old")

      assert :ok = AgentStates.clear_history_with_boundary("a", marker, server: store)

      history = AgentStates.histories(store)["a"]
      assert length(history) == 1
      assert hd(history)["type"] == "session_boundary"
      assert hd(history)["payload"]["mode"] == "clear"
      # Latest state is untouched.
      assert AgentStates.snapshot(store)["a"]["state"] == "idle"
    end

    test "clear_history_with_boundary: to_session_id=nil で pending stash + 後続 patch で確定", %{
      store: store
    } do
      marker = boundary_marker("clear", "rs_cl", nil)
      assert :ok = AgentStates.clear_history_with_boundary("a", marker, server: store)

      assert :ok = AgentStates.patch_boundary_to_session_id("a", "sess-new", server: store)

      history = AgentStates.histories(store)["a"]
      [marker_env] = Enum.filter(history, &(&1["type"] == "session_boundary"))
      assert marker_env["payload"]["to_session_id"] == "sess-new"
    end

    test "patch: pending stash 無し (通常 restart 経路) では noop", %{store: store} do
      # No boundary marker written; simulate a normal envelope with session_id.
      assert :noop = AgentStates.patch_boundary_to_session_id("a", "sess-any", server: store)
    end

    test "put が pending stash を保持する (reset 中の他 state_change で消えない)", %{store: store} do
      marker = boundary_marker("new", "rs_p", nil)
      assert :ok = AgentStates.append_boundary("a", marker, server: store)

      # 途中で state_change (session_id 未確定) が届いても stash は残る
      :ok = AgentStates.put(envelope("a", %{"state" => "thinking"}), server: store)

      # 後続の session_id 付き envelope の patch でようやく確定する
      assert :ok = AgentStates.patch_boundary_to_session_id("a", "sess-final", server: store)

      history = AgentStates.histories(store)["a"]
      [marker_env] = Enum.filter(history, &(&1["type"] == "session_boundary"))
      assert marker_env["payload"]["to_session_id"] == "sess-final"
    end

    test "未知 agent の append_boundary / clear_history_with_boundary は noop", %{store: store} do
      marker = boundary_marker("new", "rs_x", "s")
      assert :noop = AgentStates.append_boundary("ghost", marker, server: store)
      assert :noop = AgentStates.clear_history_with_boundary("ghost", marker, server: store)
    end
  end
end
