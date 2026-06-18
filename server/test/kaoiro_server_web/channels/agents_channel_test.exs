defmodule KaoiroServerWeb.AgentsChannelTest do
  use KaoiroServerWeb.ChannelCase, async: false

  alias KaoiroServer.AgentStates

  defp put_agent(agent_id) do
    :ok =
      AgentStates.put(%{
        "version" => "0",
        "agent_id" => agent_id,
        "ts" => "2026-06-11T00:00:00Z",
        "type" => "state_change",
        "state" => "waiting_input"
      })
  end

  defp join_as(role) do
    {:ok, _reply, socket} =
      KaoiroServerWeb.ClientSocket
      |> socket(nil, %{role: role})
      |> subscribe_and_join(KaoiroServerWeb.AgentsChannel, "agents:lobby")

    socket
  end

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
    _socket = join_as(:viewer)

    assert_push "snapshot", %{"agents" => agents}
    assert agents[agent_id] == envelope
  end

  describe "instruction relay (3-2)" do
    test "operator の指示を wrapper topic へ relay する" do
      agent_id = "test.route-1"
      put_agent(agent_id)
      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:operator)

      ref =
        push(socket, "instruction", %{
          "agent_id" => agent_id,
          "text" => "テストを実行して"
        })

      assert_reply ref, :ok
      # agent_id addresses the topic only; the payload drops it.
      assert_broadcast "instruction", %{"text" => "テストを実行して"} = payload
      refute Map.has_key?(payload, "agent_id")
    end

    test "viewer の指示は forbidden", %{} do
      agent_id = "test.route-2"
      put_agent(agent_id)
      socket = join_as(:viewer)

      ref =
        push(socket, "instruction", %{"agent_id" => agent_id, "text" => "x"})

      assert_reply ref, :error, %{reason: "forbidden"}
    end

    test "未知 agent_id は unknown_agent" do
      socket = join_as(:operator)

      ref =
        push(socket, "instruction", %{
          "agent_id" => "test.nobody",
          "text" => "x"
        })

      assert_reply ref, :error, %{reason: "unknown_agent"}
    end

    test "text 欠落は missing key" do
      agent_id = "test.route-3"
      put_agent(agent_id)
      socket = join_as(:operator)

      ref = push(socket, "instruction", %{"agent_id" => agent_id})

      assert_reply ref, :error, %{reason: "missing key: text"}
    end

    test "text の型不正・サイズ超過は invalid value" do
      agent_id = "test.route-4"
      put_agent(agent_id)
      socket = join_as(:operator)

      ref = push(socket, "instruction", %{"agent_id" => agent_id, "text" => 1})
      assert_reply ref, :error, %{reason: "invalid value: text"}

      huge = String.duplicate("a", 65_537)

      ref =
        push(socket, "instruction", %{"agent_id" => agent_id, "text" => huge})

      assert_reply ref, :error, %{reason: "invalid value: text"}
    end

    test "追加キーの巨大 blob は relay サイズ上限で拒否される (issue #26)" do
      agent_id = "test.route-5"
      put_agent(agent_id)
      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:operator)

      # text は正常値。opaque な追加キーに blob を載せて集約サイズ上限を超す。
      ref =
        push(socket, "instruction", %{
          "agent_id" => agent_id,
          "text" => "go",
          "blob" => String.duplicate("a", 200_000)
        })

      assert_reply ref, :error, %{reason: "payload_too_large"}
      refute_broadcast "instruction", %{}
    end
  end

  describe "permission_decision relay (3-2)" do
    test "operator の決定を wrapper topic へ relay する" do
      agent_id = "test.perm-1"
      put_agent(agent_id)
      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:operator)

      ref =
        push(socket, "permission_decision", %{
          "agent_id" => agent_id,
          "request_id" => "req-1",
          "allow" => true
        })

      assert_reply ref, :ok

      assert_broadcast "permission_decision", %{
        "request_id" => "req-1",
        "allow" => true
      }
    end

    test "viewer の決定は forbidden" do
      agent_id = "test.perm-2"
      put_agent(agent_id)
      socket = join_as(:viewer)

      ref =
        push(socket, "permission_decision", %{
          "agent_id" => agent_id,
          "request_id" => "req-2",
          "allow" => false
        })

      assert_reply ref, :error, %{reason: "forbidden"}
    end

    test "request_id 欠落は missing key" do
      agent_id = "test.perm-3"
      put_agent(agent_id)
      socket = join_as(:operator)

      ref =
        push(socket, "permission_decision", %{
          "agent_id" => agent_id,
          "allow" => true
        })

      assert_reply ref, :error, %{reason: "missing key: request_id"}
    end

    test "allow が boolean でないものは境界で拒否される" do
      agent_id = "test.perm-4"
      put_agent(agent_id)
      socket = join_as(:operator)

      ref =
        push(socket, "permission_decision", %{
          "agent_id" => agent_id,
          "request_id" => "req-4",
          "allow" => "yes"
        })

      assert_reply ref, :error, %{reason: "invalid value: allow"}
    end

    test "追加キーの巨大 blob は relay サイズ上限で拒否される (issue #26)" do
      agent_id = "test.perm-5"
      put_agent(agent_id)
      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:operator)

      # Whitelisted keys are valid; the abuse is an opaque extra key.
      ref =
        push(socket, "permission_decision", %{
          "agent_id" => agent_id,
          "request_id" => "req-5",
          "allow" => true,
          "blob" => String.duplicate("a", 200_000)
        })

      assert_reply ref, :error, %{reason: "payload_too_large"}
      refute_broadcast "permission_decision", %{}
    end
  end

  describe "interrupt relay (#51)" do
    test "operator の interrupt を wrapper topic へ relay する" do
      agent_id = "test.interrupt-1"
      put_agent(agent_id)
      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:operator)

      ref = push(socket, "interrupt", %{"agent_id" => agent_id})

      assert_reply ref, :ok
      # agent_id addresses the topic only; the payload drops it.
      assert_broadcast "interrupt", payload
      refute Map.has_key?(payload, "agent_id")
    end

    test "viewer の interrupt は forbidden" do
      agent_id = "test.interrupt-2"
      put_agent(agent_id)
      socket = join_as(:viewer)

      ref = push(socket, "interrupt", %{"agent_id" => agent_id})
      assert_reply ref, :error, %{reason: "forbidden"}
    end

    test "未知 agent_id は unknown_agent" do
      socket = join_as(:operator)

      ref = push(socket, "interrupt", %{"agent_id" => "test.interrupt-none"})
      assert_reply ref, :error, %{reason: "unknown_agent"}
    end

    test "agent_id 欠落は missing_agent_id" do
      socket = join_as(:operator)

      ref = push(socket, "interrupt", %{})
      assert_reply ref, :error, %{reason: "missing_agent_id"}
    end

    test "追加キーの巨大 blob は relay サイズ上限で拒否される (issue #26)" do
      agent_id = "test.interrupt-4"
      put_agent(agent_id)
      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:operator)

      ref =
        push(socket, "interrupt", %{
          "agent_id" => agent_id,
          "blob" => String.duplicate("a", 200_000)
        })

      assert_reply ref, :error, %{reason: "payload_too_large"}
      refute_broadcast "interrupt", %{}
    end
  end

  describe "permission_request の input 秘匿 (threat-model)" do
    defp permission_envelope(agent_id) do
      %{
        "version" => "0",
        "agent_id" => agent_id,
        "ts" => "2026-06-11T00:00:00Z",
        "type" => "permission_request",
        "state" => "waiting_permission",
        "payload" => %{
          "request_id" => "req-s1",
          "tool_name" => "Bash",
          "input" => %{"command" => "cat .env"}
        }
      }
    end

    test "viewer への broadcast から input が落ちる" do
      agent_id = "test.sanitize-1"
      envelope = permission_envelope(agent_id)
      _socket = join_as(:viewer)

      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "envelope", envelope)

      assert_push "envelope", %{
        "type" => "permission_request",
        "payload" => payload
      }

      assert payload["request_id"] == "req-s1"
      refute Map.has_key?(payload, "input")
    end

    test "operator への broadcast は input を保つ" do
      agent_id = "test.sanitize-2"
      envelope = permission_envelope(agent_id)
      _socket = join_as(:operator)

      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "envelope", envelope)

      assert_push "envelope", %{"payload" => %{"input" => %{"command" => _}}}
    end

    test "viewer への snapshot からも input が落ちる" do
      agent_id = "test.sanitize-3"
      :ok = AgentStates.put(permission_envelope(agent_id))
      _socket = join_as(:viewer)

      assert_push "snapshot", %{"agents" => agents}
      refute Map.has_key?(agents[agent_id]["payload"], "input")
    end
  end

  describe "返答ログの operator 限定配信 (ADR-0012)" do
    defp log_envelope(agent_id, text) do
      %{
        "version" => "0",
        "agent_id" => agent_id,
        "ts" => "2026-06-11T00:00:00Z",
        "type" => "log",
        "state" => "thinking",
        "payload" => %{"kind" => "assistant", "text" => text}
      }
    end

    defp result_envelope(agent_id, text) do
      %{
        "version" => "0",
        "agent_id" => agent_id,
        "ts" => "2026-06-11T00:00:00Z",
        "type" => "result",
        "state" => "done",
        "payload" => %{"text" => text}
      }
    end

    test "operator は join 時に履歴 push を受ける" do
      agent_id = "test.hist-1"
      put_agent(agent_id)
      :ok = AgentStates.append_log(log_envelope(agent_id, "やります"))
      _socket = join_as(:operator)

      assert_push "snapshot", %{"agents" => _}
      assert_push "history", %{"agents" => agents}
      assert [%{"payload" => %{"text" => "やります"}}] = agents[agent_id]
    end

    test "viewer には履歴 push が来ない" do
      agent_id = "test.hist-2"
      put_agent(agent_id)
      :ok = AgentStates.append_log(log_envelope(agent_id, "secret"))
      _socket = join_as(:viewer)

      assert_push "snapshot", %{"agents" => _}
      refute_push "history", %{}
    end

    test "log の live broadcast は operator へ届く" do
      agent_id = "test.hist-3"
      put_agent(agent_id)
      _socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      KaoiroServerWeb.Endpoint.broadcast(
        "agents:lobby",
        "envelope",
        log_envelope(agent_id, "live")
      )

      assert_push "envelope", %{"type" => "log", "payload" => %{"text" => "live"}}
    end

    test "log の live broadcast は viewer には届かない" do
      agent_id = "test.hist-4"
      put_agent(agent_id)
      _socket = join_as(:viewer)
      assert_push "snapshot", %{"agents" => _}

      KaoiroServerWeb.Endpoint.broadcast(
        "agents:lobby",
        "envelope",
        log_envelope(agent_id, "live")
      )

      refute_push "envelope", %{"type" => "log"}
    end

    test "result の live broadcast は operator へ届く" do
      agent_id = "test.hist-5"
      put_agent(agent_id)
      _socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      KaoiroServerWeb.Endpoint.broadcast(
        "agents:lobby",
        "envelope",
        result_envelope(agent_id, "完了")
      )

      assert_push "envelope", %{"type" => "result", "payload" => %{"text" => "完了"}}
    end

    test "result の live broadcast は viewer には届かない" do
      agent_id = "test.hist-6"
      put_agent(agent_id)
      _socket = join_as(:viewer)
      assert_push "snapshot", %{"agents" => _}

      KaoiroServerWeb.Endpoint.broadcast(
        "agents:lobby",
        "envelope",
        result_envelope(agent_id, "完了")
      )

      refute_push "envelope", %{"type" => "result"}
    end
  end

  describe "clear_history (issue #48)" do
    defp state_with_session(agent_id, session_id) do
      %{
        "version" => "0",
        "agent_id" => agent_id,
        "ts" => "2026-06-11T00:00:00Z",
        "type" => "state_change",
        "state" => "thinking",
        "session_id" => session_id
      }
    end

    defp log_with_session(agent_id, text, session_id) do
      %{
        "version" => "0",
        "agent_id" => agent_id,
        "ts" => "2026-06-11T00:00:00Z",
        "type" => "log",
        "state" => "thinking",
        "session_id" => session_id,
        "payload" => %{"kind" => "assistant", "text" => text}
      }
    end

    test "operator の clear_history は過去セッションを消し history_cleared を broadcast" do
      agent_id = "test.clear-1"
      :ok = AgentStates.put(state_with_session(agent_id, "s2"))
      :ok = AgentStates.append_log(log_with_session(agent_id, "old", "s1"))
      :ok = AgentStates.append_log(log_with_session(agent_id, "cur", "s2"))
      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      ref = push(socket, "clear_history", %{"agent_id" => agent_id})

      assert_reply ref, :ok
      assert_broadcast "history_cleared", %{"agent_id" => ^agent_id, "session_id" => "s2"}
      # Only the current session's reply line survives server-side.
      assert [%{"payload" => %{"text" => "cur"}}] = AgentStates.histories()[agent_id]
    end

    test "viewer の clear_history は forbidden" do
      agent_id = "test.clear-2"
      :ok = AgentStates.put(state_with_session(agent_id, "s2"))
      socket = join_as(:viewer)
      assert_push "snapshot", %{"agents" => _}

      ref = push(socket, "clear_history", %{"agent_id" => agent_id})
      assert_reply ref, :error, %{reason: "forbidden"}
    end

    test "未知 agent_id は unknown_agent" do
      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      ref = push(socket, "clear_history", %{"agent_id" => "test.clear-none"})
      assert_reply ref, :error, %{reason: "unknown_agent"}
    end

    test "現在の session_id が無ければ no_current_session" do
      agent_id = "test.clear-3"
      # put_agent stores a state envelope WITHOUT session_id.
      put_agent(agent_id)
      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      ref = push(socket, "clear_history", %{"agent_id" => agent_id})
      assert_reply ref, :error, %{reason: "no_current_session"}
    end
  end
end
