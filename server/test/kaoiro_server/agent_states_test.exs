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

  test "wire projection は実運用上限で切り、pending を通常 entry より優先する" do
    ordinary =
      Map.new(1..200, fn n ->
        id = "agent-#{String.pad_leading(Integer.to_string(n), 3, "0")}"
        {id, envelope(id)}
      end)

    pending =
      envelope("z-pending", %{
        "ext" => %{"pending_question" => %{"request_id" => "q-1", "questions" => []}}
      })

    {projection, incomplete?} =
      AgentStates.wire_projection(Map.put(ordinary, "z-pending", pending))

    assert incomplete?
    assert map_size(projection) == 200
    assert projection["z-pending"] == pending
    refute Map.has_key?(projection, "agent-200")
  end

  test "wire projection は oversized display payload を落として frame を維持する" do
    oversized =
      envelope("agent-large", %{"payload" => %{"text" => String.duplicate("x", 8_000_000)}})

    {projection, incomplete?} = AgentStates.wire_projection(%{"agent-large" => oversized})

    assert incomplete?
    assert projection["agent-large"]["agent_id"] == "agent-large"
    refute Map.has_key?(projection["agent-large"], "payload")
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

    # ADR-0051 D6 reverses the #105 cap exemption: IA no longer rides the
    # transcript list at all, so the list caps like any other and the
    # "IA survives past the cap" behaviour is gone by construction.
    test "IA は history に入らず、history は cap で切られる (ADR-0051 D6)", %{store: store} do
      :ok = AgentStates.put(envelope("a"), server: store)
      :ok = AgentStates.upsert_ia("a", {1, 0}, inter_agent_env("a", "b", "ia-old"), server: store)
      for i <- 1..205, do: :ok = AgentStates.append_log(log_env("a", i), server: store)

      history = AgentStates.histories(store)["a"]
      assert length(history) == 200
      assert List.first(history)["payload"]["text"] == "m6"
      assert List.last(history)["payload"]["text"] == "m205"
      refute Enum.any?(history, &(&1["type"] == "inter_agent_message"))

      # The IA is intact — it lives in the per-pane projection, which the
      # channel merges with the transcript and caps once, at the end.
      assert [{{1, 0}, %{"payload" => %{"body" => "ia-old"}}}] =
               AgentStates.ia_projection(store)["a"]

      # Internal transcript storage remains newest-first.
      raw = :sys.get_state(store).agents["a"].history
      assert hd(raw)["payload"]["text"] == "m205"
      assert List.last(raw)["payload"]["text"] == "m6"
    end

    test "per-pane IA は ingress stamp 順に返り、同一 stamp は冪等 upsert", %{store: store} do
      :ok = AgentStates.put(envelope("a"), server: store)
      :ok = AgentStates.upsert_ia("a", {2, 0}, inter_agent_env("a", "b", "ia-2"), server: store)
      :ok = AgentStates.upsert_ia("a", {1, 0}, inter_agent_env("a", "b", "ia-1"), server: store)
      # A replay retry of the same message lands on the same key.
      :ok = AgentStates.upsert_ia("a", {1, 0}, inter_agent_env("a", "b", "ia-1"), server: store)

      assert [{{1, 0}, first}, {{2, 0}, second}] = AgentStates.ia_projection(store)["a"]
      assert first["payload"]["body"] == "ia-1"
      assert second["payload"]["body"] == "ia-2"
    end

    test "per-pane IA は 200 件で newest 側を残して cap される", %{store: store} do
      :ok = AgentStates.put(envelope("a"), server: store)

      for i <- 1..205 do
        :ok =
          AgentStates.upsert_ia("a", {i, 0}, inter_agent_env("a", "b", "ia-#{i}"), server: store)
      end

      entries = AgentStates.ia_projection(store)["a"]
      assert length(entries) == 200
      assert {{6, 0}, _} = List.first(entries)
      assert {{205, 0}, _} = List.last(entries)
    end

    test "未知 pane への upsert_ia は noop", %{store: store} do
      assert :noop =
               AgentStates.upsert_ia("ghost", {1, 0}, inter_agent_env("a", "b"), server: store)
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

    test "CAS clear は watermark fsync 前の session 遷移を検知して history を変えない", %{
      store: store
    } do
      :ok =
        AgentStates.put(envelope("a", %{"state" => "thinking", "session_id" => "s-current"}),
          server: store
        )

      :ok = AgentStates.append_log(log_sid("a", 1, "s-old"), server: store)
      :ok = AgentStates.append_log(log_sid("a", 2, "s-current"), server: store)

      # The channel reads this sid, then a new wrapper state races in before
      # the CAS clear. It must not prune with the stale sid.
      assert {:ok, "s-current"} = AgentStates.current_session_id("a", server: store)

      :ok =
        AgentStates.put(envelope("a", %{"state" => "thinking", "session_id" => "s-raced"}),
          server: store
        )

      assert :noop = AgentStates.clear_other_sessions("a", "s-current", server: store)

      texts = Enum.map(AgentStates.histories(store)["a"], & &1["payload"]["text"])
      assert texts == ["m1", "m2"]
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

    # ADR-0051 D3-3 reverses the #105 retention: the wrapper's sidecar
    # re-projects IA through `replay_ia` inside the same replay window, so
    # anything kept here would be a duplicate of what is about to arrive.
    test "IA pane も含めて表示投影を全消去する (ADR-0051 D3-3)", %{store: store} do
      :ok = AgentStates.put(envelope("a"), server: store)
      :ok = AgentStates.append_log(log_env("a", 1), server: store)
      :ok = AgentStates.upsert_ia("a", {1, 0}, inter_agent_env("a", "b"), server: store)

      assert :ok = AgentStates.reset_history("a", server: store)
      refute Map.has_key?(AgentStates.histories(store), "a")
      refute Map.has_key?(AgentStates.ia_projection(store), "a")
      # Latest state survives — only the display projection is dropped.
      assert AgentStates.snapshot(store)["a"]["state"] == "idle"
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

  # ADR-0051 D2 / D4. The failure-matrix cases the plan marks [test] and
  # that live at this layer: (b) the replay_id/owner CAS, (c) no wasted
  # replay on an ordinary reconnect, plus the resume invalidation that is
  # (c)'s counterpart.
  describe "hydration state と projection epoch (ADR-0051 D2/D4)" do
    setup do
      store =
        start_supervised!(
          {AgentStates, name: :"agent_states_hydration_#{:erlang.unique_integer([:positive])}"}
        )

      {:ok, store: store}
    end

    test "boot 直後は unhydrated: 最初の join で replay を要求する", %{store: store} do
      assert {:required, replay_id} = AgentStates.hydration_verdict("a", self(), server: store)
      assert is_binary(replay_id) and replay_id != ""
    end

    test "(c) complete 後の再接続では replay を要求しない", %{store: store} do
      {:required, replay_id} = AgentStates.hydration_verdict("a", self(), server: store)
      assert :ok = AgentStates.complete_hydration("a", replay_id, self(), server: store)

      # Ordinary reconnect: a new channel pid, same live server.
      reconnect = spawn(fn -> :ok end)
      assert :not_required = AgentStates.hydration_verdict("a", reconnect, server: store)
    end

    test "(b) CAS: replay_id 不一致 / owner 不一致の complete は stale", %{store: store} do
      {:required, replay_id} = AgentStates.hydration_verdict("a", self(), server: store)
      other = spawn(fn -> :ok end)

      assert :stale = AgentStates.complete_hydration("a", "hydr-bogus", self(), server: store)
      assert :stale = AgentStates.complete_hydration("a", replay_id, other, server: store)
      assert :ok = AgentStates.complete_hydration("a", replay_id, self(), server: store)
    end

    test "(b) 古い attempt の complete は新しい attempt を hydrated にしない", %{store: store} do
      old_owner = spawn(fn -> :ok end)
      {:required, old_id} = AgentStates.hydration_verdict("a", old_owner, server: store)
      # The old connection dropped mid-replay; the next join re-requests.
      assert :ok = AgentStates.release_hydration("a", old_owner, server: store)
      {:required, new_id} = AgentStates.hydration_verdict("a", self(), server: store)
      assert new_id != old_id

      assert :stale = AgentStates.complete_hydration("a", old_id, old_owner, server: store)
      # The live attempt is still in flight, so `replay_ia` still accepts it.
      assert AgentStates.hydration_in_flight?("a", new_id, self(), server: store)
      refute AgentStates.hydration_in_flight?("a", old_id, old_owner, server: store)
    end

    test "(a) in_flight のまま切断すると unhydrated に戻り再要求される", %{store: store} do
      {:required, first} = AgentStates.hydration_verdict("a", self(), server: store)
      assert :ok = AgentStates.release_hydration("a", self(), server: store)

      assert {:required, second} = AgentStates.hydration_verdict("a", self(), server: store)
      assert second != first
    end

    test "stale terminate は新 connection の attempt を巻き戻さない", %{store: store} do
      stale_owner = spawn(fn -> :ok end)
      {:required, _} = AgentStates.hydration_verdict("a", stale_owner, server: store)
      {:required, live_id} = AgentStates.hydration_verdict("a", self(), server: store)

      assert :ok = AgentStates.release_hydration("a", stale_owner, server: store)
      assert AgentStates.hydration_in_flight?("a", live_id, self(), server: store)
    end

    test "hydrated な agent の切断は hydrated のまま (同一 session の継続)", %{store: store} do
      {:required, replay_id} = AgentStates.hydration_verdict("a", self(), server: store)
      :ok = AgentStates.complete_hydration("a", replay_id, self(), server: store)

      assert :ok = AgentStates.release_hydration("a", self(), server: store)
      assert :not_required = AgentStates.hydration_verdict("a", self(), server: store)
    end

    test "invalidate_hydration で hydrated が unhydrated へ戻る (resume 分岐)", %{store: store} do
      {:required, replay_id} = AgentStates.hydration_verdict("a", self(), server: store)
      :ok = AgentStates.complete_hydration("a", replay_id, self(), server: store)
      assert :not_required = AgentStates.hydration_verdict("a", self(), server: store)

      assert :ok = AgentStates.invalidate_hydration("a", server: store)
      assert {:required, _} = AgentStates.hydration_verdict("a", self(), server: store)
    end

    test "delete で hydration record も落ちる", %{store: store} do
      :ok = AgentStates.put(envelope("a", %{"state" => "disconnected"}), server: store)
      {:required, replay_id} = AgentStates.hydration_verdict("a", self(), server: store)
      :ok = AgentStates.complete_hydration("a", replay_id, self(), server: store)

      assert :ok = AgentStates.delete("a", server: store)
      assert {:required, _} = AgentStates.hydration_verdict("a", self(), server: store)
    end

    test "tracker が cap でも replay は要求する (記録だけ落ちる)", %{store: store} do
      # 記録できないときに :not_required を返すと「投影は無事」という嘘に
      # なり、timeline が永久に空のままになる。要求はして、CAS が外れる
      # ぶん次の join でまた要求されるほうが安全。
      full = Map.new(1..1000, fn n -> {"cap-#{n}", :hydrated} end)
      :sys.replace_state(store, fn state -> %{state | hydration: full} end)

      assert {:required, replay_id} = AgentStates.hydration_verdict("a", self(), server: store)
      refute AgentStates.hydration_in_flight?("a", replay_id, self(), server: store)
      assert :stale = AgentStates.complete_hydration("a", replay_id, self(), server: store)
    end

    test "epoch は boot ごとに変わり、同一 boot では安定する", %{store: store} do
      epoch = AgentStates.projection_epoch(store)
      assert is_binary(epoch) and epoch != ""
      assert AgentStates.projection_epoch(store) == epoch

      other =
        start_supervised!(
          Supervisor.child_spec({AgentStates, name: :agent_states_epoch_second}, id: :second)
        )

      assert AgentStates.projection_epoch(other) != epoch
    end
  end
end
