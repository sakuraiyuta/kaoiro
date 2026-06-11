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
end
