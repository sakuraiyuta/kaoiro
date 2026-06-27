defmodule KaoiroServerWeb.AgentsChannelTest do
  use KaoiroServerWeb.ChannelCase, async: false

  import ExUnit.CaptureLog

  alias KaoiroServer.AgentStates
  alias KaoiroServer.HostRegistry
  alias KaoiroServer.SessionPointers
  alias KaoiroServerWeb.AgentsChannel

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

  @mio %{"id" => "mio", "name" => "澪", "sprite_set" => "mio"}

  defp register_host(host_id, opts \\ []) do
    :ok =
      HostRegistry.register(
        host_id,
        %{
          personas: Keyword.get(opts, :personas, [@mio]),
          cwd_allowlist: Keyword.get(opts, :cwd_allowlist, ["/home/user/proj"])
        },
        self()
      )
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

  describe "set_model / set_effort relay (#54)" do
    test "operator の set_model を wrapper topic へ relay する" do
      agent_id = "test.setmodel-1"
      put_agent(agent_id)
      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:operator)

      ref = push(socket, "set_model", %{"agent_id" => agent_id, "model" => "opus[1m]"})

      assert_reply ref, :ok
      assert_broadcast "set_model", payload
      assert payload["model"] == "opus[1m]"
      refute Map.has_key?(payload, "agent_id")
    end

    test "operator の set_effort を wrapper topic へ relay する" do
      agent_id = "test.seteffort-1"
      put_agent(agent_id)
      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:operator)

      ref = push(socket, "set_effort", %{"agent_id" => agent_id, "effort" => "max"})

      assert_reply ref, :ok
      assert_broadcast "set_effort", payload
      assert payload["effort"] == "max"
      refute Map.has_key?(payload, "agent_id")
    end

    test "viewer の set_model / set_effort は forbidden" do
      agent_id = "test.setmodel-2"
      put_agent(agent_id)
      socket = join_as(:viewer)

      ref = push(socket, "set_model", %{"agent_id" => agent_id, "model" => "opus"})
      assert_reply ref, :error, %{reason: "forbidden"}

      ref = push(socket, "set_effort", %{"agent_id" => agent_id, "effort" => "high"})
      assert_reply ref, :error, %{reason: "forbidden"}
    end

    test "model 欠落は missing key、effort 非文字列は invalid value" do
      agent_id = "test.setmodel-3"
      put_agent(agent_id)
      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:operator)

      ref = push(socket, "set_model", %{"agent_id" => agent_id})
      assert_reply ref, :error, %{reason: "missing key: model"}

      ref = push(socket, "set_effort", %{"agent_id" => agent_id, "effort" => 5})
      assert_reply ref, :error, %{reason: "invalid value: effort"}

      refute_broadcast "set_model", %{}
      refute_broadcast "set_effort", %{}
    end

    test "未知 agent_id は unknown_agent" do
      socket = join_as(:operator)

      ref = push(socket, "set_model", %{"agent_id" => "test.setmodel-none", "model" => "opus"})
      assert_reply ref, :error, %{reason: "unknown_agent"}
    end
  end

  describe "delete_agent (issue #14)" do
    defp put_disconnected(agent_id) do
      :ok =
        AgentStates.put(%{
          "version" => "0",
          "agent_id" => agent_id,
          "ts" => "2026-06-11T00:00:00Z",
          "type" => "state_change",
          "state" => "disconnected"
        })
    end

    test "operator は disconnected agent を削除し agent_deleted を broadcast" do
      agent_id = "test.del-1"
      put_disconnected(agent_id)
      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      ref = push(socket, "delete_agent", %{"agent_id" => agent_id})

      assert_reply ref, :ok
      assert_broadcast "agent_deleted", %{"agent_id" => ^agent_id}
      refute AgentStates.known?(agent_id)
    end

    test "稼働中 agent の削除は not_disconnected で拒否" do
      agent_id = "test.del-2"
      put_agent(agent_id)
      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      ref = push(socket, "delete_agent", %{"agent_id" => agent_id})

      assert_reply ref, :error, %{reason: "not_disconnected"}
      assert AgentStates.known?(agent_id)
    end

    test "viewer の削除は forbidden" do
      agent_id = "test.del-3"
      put_disconnected(agent_id)
      socket = join_as(:viewer)
      assert_push "snapshot", %{"agents" => _}

      ref = push(socket, "delete_agent", %{"agent_id" => agent_id})
      assert_reply ref, :error, %{reason: "forbidden"}
    end

    test "未知 agent は unknown_agent" do
      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      ref = push(socket, "delete_agent", %{"agent_id" => "test.del-none"})
      assert_reply ref, :error, %{reason: "unknown_agent"}
    end
  end

  describe "safe_reason allow-list (issue #62)" do
    test "既知の atom reason はそのまま文字列化される" do
      for r <- [
            :forbidden,
            :unknown_agent,
            :not_disconnected,
            :noop,
            :payload_too_large,
            :missing_agent_id,
            :invalid_agent_id,
            :already_running,
            :missing_host_id,
            :invalid_host_id,
            :unknown_host,
            :unknown_persona,
            :invalid_persona,
            :cwd_not_allowed,
            :invalid_cwd,
            :invalid_name,
            :no_session,
            :unknown_upload
          ] do
        assert AgentsChannel.safe_reason(r) == to_string(r)
      end
    end

    test "key 検証タプルは安定した client 文字列になる" do
      assert AgentsChannel.safe_reason({:missing_key, "text"}) == "missing key: text"

      assert AgentsChannel.safe_reason({:invalid_value, "allow"}) ==
               "invalid value: allow"
    end

    test "未知の reason は internal_error に置換され元の reason はログに残る" do
      log =
        capture_log(fn ->
          assert AgentsChannel.safe_reason({:internal, "/etc/secret-path"}) ==
                   "internal_error"

          assert AgentsChannel.safe_reason(:db_connection_refused) ==
                   "internal_error"
        end)

      # The internal detail is kept server-side (log) but never returned.
      assert log =~ "/etc/secret-path"
      assert log =~ "db_connection_refused"
    end
  end

  describe "agent_id 文字種ガード (issue #61)" do
    test "不正な文字種の agent_id は invalid_agent_id で拒否される (known? より前)" do
      socket = join_as(:operator)

      ref = push(socket, "interrupt", %{"agent_id" => "bad*id"})
      assert_reply ref, :error, %{reason: "invalid_agent_id"}
    end
  end

  describe "permission_request の viewer 完全除去 (ADR-0021, #46)" do
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

    test "viewer への broadcast は合成 state_change に置換される (request_id/tool_name/input 全て除去)" do
      agent_id = "test.sanitize-1"
      envelope = permission_envelope(agent_id)
      _socket = join_as(:viewer)

      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "envelope", envelope)

      assert_push "envelope", pushed
      assert pushed["type"] == "state_change"
      assert pushed["state"] == "waiting_permission"
      assert pushed["payload"] == %{}
      refute Map.has_key?(pushed, "ext")
    end

    test "operator への broadcast は input を保つ" do
      agent_id = "test.sanitize-2"
      envelope = permission_envelope(agent_id)
      _socket = join_as(:operator)

      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "envelope", envelope)

      assert_push "envelope", %{
        "type" => "permission_request",
        "payload" => %{"input" => %{"command" => _}}
      }
    end

    test "viewer への snapshot も合成 state_change に置換される (grid 整合維持)" do
      agent_id = "test.sanitize-3"
      :ok = AgentStates.put(permission_envelope(agent_id))
      _socket = join_as(:viewer)

      assert_push "snapshot", %{"agents" => agents}
      entry = agents[agent_id]
      assert entry["type"] == "state_change"
      assert entry["state"] == "waiting_permission"
      assert entry["payload"] == %{}
      refute Map.has_key?(entry, "ext")
    end
  end

  describe "history_reset の operator 限定配信 (issue #50, ADR-0021)" do
    test "operator は history_reset を受け取る" do
      agent_id = "test.reset-op"
      _socket = join_as(:operator)

      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "history_reset", %{
        "agent_id" => agent_id
      })

      assert_push "history_reset", %{"agent_id" => ^agent_id}
    end

    test "viewer には history_reset を配信しない (fail-closed)" do
      _socket = join_as(:viewer)

      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "history_reset", %{
        "agent_id" => "test.reset-vw"
      })

      refute_push "history_reset", %{}
    end
  end

  describe "state_change の ext 秘匿 (issue #46)" do
    defp state_with_ext(agent_id) do
      %{
        "version" => "0",
        "agent_id" => agent_id,
        "ts" => "2026-06-11T00:00:00Z",
        "type" => "state_change",
        "state" => "thinking",
        "ext" => %{
          "cwd" => "/home/user/secret-project",
          "model" => "opus",
          "context" => %{"used_percentage" => 42}
        }
      }
    end

    test "viewer への broadcast から ext が落ちる" do
      agent_id = "test.ext-1"
      _socket = join_as(:viewer)

      KaoiroServerWeb.Endpoint.broadcast(
        "agents:lobby",
        "envelope",
        state_with_ext(agent_id)
      )

      assert_push "envelope", pushed
      assert pushed["type"] == "state_change"
      refute Map.has_key?(pushed, "ext")
    end

    test "operator への broadcast は ext を保つ" do
      agent_id = "test.ext-2"
      _socket = join_as(:operator)

      KaoiroServerWeb.Endpoint.broadcast(
        "agents:lobby",
        "envelope",
        state_with_ext(agent_id)
      )

      assert_push "envelope", pushed
      assert pushed["ext"]["cwd"] == "/home/user/secret-project"
    end

    test "viewer への snapshot からも ext が落ちる" do
      agent_id = "test.ext-3"
      :ok = AgentStates.put(state_with_ext(agent_id))
      _socket = join_as(:viewer)

      assert_push "snapshot", %{"agents" => agents}
      refute Map.has_key?(agents[agent_id], "ext")
    end

    test "viewer の permission_request からも ext が落ち state_change に置換される" do
      agent_id = "test.ext-4"
      _socket = join_as(:viewer)

      envelope = %{
        "version" => "0",
        "agent_id" => agent_id,
        "ts" => "2026-06-11T00:00:00Z",
        "type" => "permission_request",
        "state" => "waiting_permission",
        "ext" => %{"cwd" => "/home/user/secret-project"},
        "payload" => %{
          "request_id" => "req-e",
          "tool_name" => "Bash",
          "input" => %{"command" => "cat .env"}
        }
      }

      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "envelope", envelope)

      assert_push "envelope", pushed
      assert pushed["type"] == "state_change"
      assert pushed["payload"] == %{}
      refute Map.has_key?(pushed, "ext")
    end
  end

  describe "pending_permission ext のリロード復元 (ADR-0022, #59)" do
    defp state_with_pending(agent_id, request_id) do
      %{
        "version" => "0",
        "agent_id" => agent_id,
        "ts" => "2026-06-11T00:00:00Z",
        "type" => "state_change",
        "state" => "waiting_permission",
        "payload" => %{},
        "ext" => %{
          "pending_permission" => %{
            "request_id" => request_id,
            "tool_name" => "Bash",
            "input" => %{"command" => "ls"},
            "ts" => "2026-06-11T00:00:00Z"
          }
        }
      }
    end

    test "operator の snapshot で ext.pending_permission がそのまま復元される" do
      agent_id = "test.pending-1"
      :ok = AgentStates.put(state_with_pending(agent_id, "req-A"))
      _socket = join_as(:operator)

      assert_push "snapshot", %{"agents" => agents}
      entry = agents[agent_id]
      assert entry["type"] == "state_change"
      assert entry["state"] == "waiting_permission"
      assert get_in(entry, ["ext", "pending_permission", "request_id"]) == "req-A"

      assert get_in(entry, ["ext", "pending_permission", "input"]) == %{
               "command" => "ls"
             }
    end

    test "viewer の snapshot からは ext.pending_permission が除去される (ADR-0021 経由)" do
      agent_id = "test.pending-2"
      :ok = AgentStates.put(state_with_pending(agent_id, "req-B"))
      _socket = join_as(:viewer)

      assert_push "snapshot", %{"agents" => agents}
      entry = agents[agent_id]
      assert entry["type"] == "state_change"
      assert entry["state"] == "waiting_permission"
      refute Map.has_key?(entry, "ext")
    end

    test "operator の live broadcast でも ext.pending_permission がそのまま届く" do
      agent_id = "test.pending-3"
      _socket = join_as(:operator)

      KaoiroServerWeb.Endpoint.broadcast(
        "agents:lobby",
        "envelope",
        state_with_pending(agent_id, "req-C")
      )

      assert_push "envelope", pushed
      assert get_in(pushed, ["ext", "pending_permission", "request_id"]) == "req-C"
    end
  end

  describe "allow-list 方式の fail-closed 動作 (ADR-0021)" do
    test "viewer は未知の envelope type を受け取らない (fail-closed)" do
      agent_id = "test.future-1"
      _socket = join_as(:viewer)

      future_envelope = %{
        "version" => "0",
        "agent_id" => agent_id,
        "ts" => "2026-06-11T00:00:00Z",
        # A hypothetical future type not yet listed in the viewer allow-list.
        "type" => "task",
        "state" => "thinking",
        "payload" => %{"task_id" => "t1", "summary" => "secret-summary"}
      }

      KaoiroServerWeb.Endpoint.broadcast(
        "agents:lobby",
        "envelope",
        future_envelope
      )

      refute_push "envelope", %{}
    end

    test "operator は未知 type の envelope を素通しで受け取る" do
      agent_id = "test.future-2"
      _socket = join_as(:operator)

      future_envelope = %{
        "version" => "0",
        "agent_id" => agent_id,
        "ts" => "2026-06-11T00:00:00Z",
        "type" => "task",
        "state" => "thinking",
        "payload" => %{"task_id" => "t1"}
      }

      KaoiroServerWeb.Endpoint.broadcast(
        "agents:lobby",
        "envelope",
        future_envelope
      )

      assert_push "envelope", pushed
      assert pushed["type"] == "task"
    end

    test "viewer snapshot は未知 type の agent をスキップする" do
      agent_id = "test.future-3"

      :ok =
        AgentStates.put(%{
          "version" => "0",
          "agent_id" => agent_id,
          "ts" => "2026-06-11T00:00:00Z",
          "type" => "task",
          "state" => "thinking",
          "payload" => %{}
        })

      _socket = join_as(:viewer)

      assert_push "snapshot", %{"agents" => agents}
      refute Map.has_key?(agents, agent_id)
    end

    test "history_cleared は viewer に届かない / operator には届く" do
      agent_id = "test.hc-1"
      put_agent(agent_id)
      _viewer = join_as(:viewer)
      assert_push "snapshot", %{"agents" => _}

      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "history_cleared", %{
        "agent_id" => agent_id,
        "session_id" => "s1"
      })

      refute_push "history_cleared", %{}
    end

    test "history_cleared は operator に届く" do
      agent_id = "test.hc-2"
      put_agent(agent_id)
      _operator = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "history_cleared", %{
        "agent_id" => agent_id,
        "session_id" => "s1"
      })

      assert_push "history_cleared", %{"agent_id" => ^agent_id}
    end

    test "agent_deleted は viewer にも届く (grid 整合のため)" do
      agent_id = "test.ad-1"
      put_agent(agent_id)
      _viewer = join_as(:viewer)
      assert_push "snapshot", %{"agents" => _}

      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "agent_deleted", %{
        "agent_id" => agent_id
      })

      assert_push "agent_deleted", %{"agent_id" => ^agent_id}
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

  describe "host lifecycle relay (ADR-0023, issue #67)" do
    test "operator の spawn: server が agent_id 採番・persona 解決・token 注入し runner topic へ送る" do
      host_id = "lab-pc-1"
      register_host(host_id)
      @endpoint.subscribe("runner:" <> host_id)
      socket = join_as(:operator)

      ref =
        push(socket, "spawn", %{
          "host_id" => host_id,
          "persona" => "mio",
          "cwd" => "/home/user/proj"
        })

      # The allocated agent_id comes back in the reply for UI correlation.
      assert_reply ref, :ok, %{"agent_id" => agent_id}
      assert String.starts_with?(agent_id, host_id <> ".")

      # host_id addresses the topic only and is not in the payload; the server
      # resolves the persona id to the full object and mints the token.
      assert_broadcast "spawn", payload
      refute Map.has_key?(payload, "host_id")
      assert payload["agent_id"] == agent_id
      assert payload["persona"] == @mio
      assert payload["cwd"] == "/home/user/proj"
      assert is_binary(payload["token"])
      # server_url is supplied by the runner, not the server (案A, ADR-0024).
      refute Map.has_key?(payload, "server_url")
    end

    test "operator の spawn: cwd を SessionPointers に seed する(復帰用、#22)" do
      host_id = "lab-pc-1s"
      register_host(host_id, cwd_allowlist: ["/home/user/seed"])
      @endpoint.subscribe("runner:" <> host_id)
      socket = join_as(:operator)

      ref =
        push(socket, "spawn", %{
          "host_id" => host_id,
          "persona" => "mio",
          "cwd" => "/home/user/seed"
        })

      assert_reply ref, :ok, %{"agent_id" => agent_id}
      # The cast is enqueued before the reply, so the pointer is set by now.
      assert SessionPointers.get(agent_id) == %{session_id: nil, cwd: "/home/user/seed"}
    end

    test "operator の spawn: initial_prompt を payload に載せる" do
      host_id = "lab-pc-1b"
      register_host(host_id)
      @endpoint.subscribe("runner:" <> host_id)
      socket = join_as(:operator)

      ref =
        push(socket, "spawn", %{
          "host_id" => host_id,
          "persona" => "mio",
          "cwd" => "/home/user/proj",
          "initial_prompt" => "最初の指示"
        })

      assert_reply ref, :ok
      assert_broadcast "spawn", %{"initial_prompt" => "最初の指示"}
    end

    test "operator の spawn: 任意 name が persona.name を上書きする (#22)" do
      host_id = "lab-pc-1c"
      register_host(host_id)
      @endpoint.subscribe("runner:" <> host_id)
      socket = join_as(:operator)

      ref =
        push(socket, "spawn", %{
          "host_id" => host_id,
          "persona" => "mio",
          "cwd" => "/home/user/proj",
          "name" => "  レビュー担当  "
        })

      assert_reply ref, :ok
      # name は trim され persona.name のみ上書き; id/sprite_set は不変。
      assert_broadcast "spawn", %{"persona" => persona}
      assert persona == %{"id" => "mio", "name" => "レビュー担当", "sprite_set" => "mio"}
    end

    test "operator の spawn: name 未指定/空白は persona 既定名のまま" do
      host_id = "lab-pc-1d"
      register_host(host_id)
      @endpoint.subscribe("runner:" <> host_id)
      socket = join_as(:operator)

      ref =
        push(socket, "spawn", %{
          "host_id" => host_id,
          "persona" => "mio",
          "cwd" => "/home/user/proj",
          "name" => "   "
        })

      assert_reply ref, :ok
      assert_broadcast "spawn", payload
      assert payload["persona"] == @mio
    end

    test "operator の spawn: 長すぎ/制御文字の name は invalid_name" do
      host_id = "lab-pc-1e"
      register_host(host_id)
      @endpoint.subscribe("runner:" <> host_id)
      socket = join_as(:operator)

      for bad <- [String.duplicate("あ", 65), "改行\nあり"] do
        ref =
          push(socket, "spawn", %{
            "host_id" => host_id,
            "persona" => "mio",
            "cwd" => "/home/user/proj",
            "name" => bad
          })

        assert_reply ref, :error, %{reason: "invalid_name"}
      end

      refute_broadcast "spawn", %{}
    end

    test "operator の stop / restart / enumerate_sessions を runner topic へ relay する" do
      host_id = "lab-pc-2"
      @endpoint.subscribe("runner:" <> host_id)
      socket = join_as(:operator)

      for {event, extra} <- [
            {"stop", %{"agent_id" => "lab-pc-2.a"}},
            {"restart", %{"agent_id" => "lab-pc-2.a"}},
            {"enumerate_sessions", %{"agent_id" => "lab-pc-2.a", "cwd" => "/home/user/p"}}
          ] do
        ref = push(socket, event, Map.put(extra, "host_id", host_id))
        assert_reply ref, :ok
        assert_broadcast ^event, payload
        refute Map.has_key?(payload, "host_id")
      end
    end

    test "viewer の spawn / stop / restart / enumerate_sessions は forbidden" do
      host_id = "lab-pc-3"
      socket = join_as(:viewer)

      for event <- ["spawn", "stop", "restart", "enumerate_sessions"] do
        ref = push(socket, event, %{"host_id" => host_id, "agent_id" => "x"})
        assert_reply ref, :error, %{reason: "forbidden"}
      end
    end

    test "host_id 欠落は missing_host_id" do
      socket = join_as(:operator)

      ref = push(socket, "stop", %{"agent_id" => "x"})
      assert_reply ref, :error, %{reason: "missing_host_id"}
    end

    test "不正な文字種の host_id は invalid_host_id" do
      socket = join_as(:operator)

      ref = push(socket, "stop", %{"host_id" => "bad*host", "agent_id" => "x"})
      assert_reply ref, :error, %{reason: "invalid_host_id"}
    end

    test "未登録 host への spawn は unknown_host" do
      socket = join_as(:operator)

      ref =
        push(socket, "spawn", %{
          "host_id" => "no-such-host",
          "persona" => "mio",
          "cwd" => "/home/user/proj"
        })

      assert_reply ref, :error, %{reason: "unknown_host"}
    end

    test "host が申告していない persona は unknown_persona" do
      host_id = "lab-pc-4"
      register_host(host_id)
      socket = join_as(:operator)

      ref =
        push(socket, "spawn", %{
          "host_id" => host_id,
          "persona" => "ghost",
          "cwd" => "/home/user/proj"
        })

      assert_reply ref, :error, %{reason: "unknown_persona"}
    end

    test "予約 default ペルソナは host 未宣言でも spawn できる (#35)" do
      host_id = "lab-pc-default"
      # host は default を申告していない (register_host の既定は [@mio] のみ)
      register_host(host_id)
      @endpoint.subscribe("runner:" <> host_id)
      socket = join_as(:operator)

      ref =
        push(socket, "spawn", %{
          "host_id" => host_id,
          "persona" => "default",
          "cwd" => "/home/user/proj"
        })

      assert_reply ref, :ok, %{"agent_id" => _}
      assert_broadcast "spawn", payload

      assert payload["persona"] == %{
               "id" => "default",
               "name" => "デフォルト",
               "sprite_set" => "default"
             }
    end

    test "allow-list 外の cwd は cwd_not_allowed (T1)" do
      host_id = "lab-pc-5"
      register_host(host_id, cwd_allowlist: ["/home/user/proj"])
      @endpoint.subscribe("runner:" <> host_id)
      socket = join_as(:operator)

      ref =
        push(socket, "spawn", %{
          "host_id" => host_id,
          "persona" => "mio",
          "cwd" => "/etc"
        })

      assert_reply ref, :error, %{reason: "cwd_not_allowed"}
      refute_broadcast "spawn", %{}
    end
  end

  describe "restore (#22, ADR-0014 復帰)" do
    defp disconnect_with_session(agent_id, session_id) do
      :ok =
        AgentStates.put(%{
          "version" => "0",
          "agent_id" => agent_id,
          "persona" => @mio,
          "ts" => "2026-06-11T00:00:00Z",
          "type" => "state_change",
          "state" => "disconnected",
          "session_id" => session_id
        })
    end

    test "operator の restore: 同一 agent_id を resume 付きで runner へ再 spawn" do
      host_id = "lab-pc-1"
      agent_id = "lab-pc-1.rev1"
      disconnect_with_session(agent_id, "sess-rev-1")
      :ok = SessionPointers.record(agent_id, "sess-rev-1", "/home/user/proj")
      # Flush the async cast before the handler reads the pointer.
      SessionPointers.get(agent_id)
      @endpoint.subscribe("runner:" <> host_id)
      socket = join_as(:operator)

      ref = push(socket, "restore", %{"agent_id" => agent_id})

      assert_reply ref, :ok
      assert_broadcast "spawn", payload
      # Same agent_id (revive in place), resume the recorded session under cwd,
      # keep the last persona, fresh token.
      assert payload["agent_id"] == agent_id
      assert payload["resume_session_id"] == "sess-rev-1"
      assert payload["cwd"] == "/home/user/proj"
      assert payload["persona"] == @mio
      assert is_binary(payload["token"])
    end

    test "session pointer が無ければ no_session" do
      agent_id = "lab-pc-1.rev2"
      disconnect_with_session(agent_id, "sess-rev-2")
      socket = join_as(:operator)

      ref = push(socket, "restore", %{"agent_id" => agent_id})

      assert_reply ref, :error, %{reason: "no_session"}
    end

    test "未知 agent の restore は unknown_agent" do
      socket = join_as(:operator)

      ref = push(socket, "restore", %{"agent_id" => "lab-pc-1.ghost"})

      assert_reply ref, :error, %{reason: "unknown_agent"}
    end

    test "稼働中 agent の restore は not_disconnected で拒否(D5、サーバ早期拒否)" do
      agent_id = "lab-pc-1.live-rev"
      # waiting_input = 稼働中(切断ではない)。
      put_agent(agent_id)
      :ok = SessionPointers.record(agent_id, "sess-live", "/home/user/proj")
      SessionPointers.get(agent_id)
      @endpoint.subscribe("runner:lab-pc-1")
      socket = join_as(:operator)

      ref = push(socket, "restore", %{"agent_id" => agent_id})

      assert_reply ref, :error, %{reason: "not_disconnected"}
      refute_broadcast "spawn", %{}
    end

    test "viewer の restore は forbidden" do
      socket = join_as(:viewer)

      ref = push(socket, "restore", %{"agent_id" => "lab-pc-1.rev3"})

      assert_reply ref, :error, %{reason: "forbidden"}
    end
  end

  describe "host/runner イベントの operator 限定配信 (ADR-0023, ADR-0021)" do
    test "join 時 operator は hosts push を受け、viewer は受けない" do
      host_id = "lab-pc-hosts"

      :ok =
        KaoiroServer.HostRegistry.register(
          host_id,
          %{personas: [%{"id" => "mio"}], cwd_allowlist: ["/home/user/p"]},
          self()
        )

      _operator = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}
      assert_push "hosts", %{"hosts" => hosts}
      assert Map.has_key?(hosts, host_id)
    end

    test "viewer は join 時に hosts push を受けない" do
      _viewer = join_as(:viewer)
      assert_push "snapshot", %{"agents" => _}
      refute_push "hosts", %{}
    end

    test "runner_sessions / spawn_result / hosts の live broadcast は operator に届く" do
      _operator = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      for event <- ["runner_sessions", "spawn_result", "hosts"] do
        KaoiroServerWeb.Endpoint.broadcast("agents:lobby", event, %{"host_id" => "h"})
        assert_push ^event, %{"host_id" => "h"}
      end
    end

    test "runner_sessions / spawn_result / hosts は viewer には届かない (fail-closed)" do
      _viewer = join_as(:viewer)
      assert_push "snapshot", %{"agents" => _}

      for event <- ["runner_sessions", "spawn_result", "hosts"] do
        KaoiroServerWeb.Endpoint.broadcast("agents:lobby", event, %{"host_id" => "h"})
        refute_push ^event, %{}
      end
    end
  end

  describe "ファイルアップロード wire (ADR-0025)" do
    defp build_chunk_payload(upload_id, chunk_index, bytes) do
      id_bytes = upload_id
      id_len = byte_size(id_bytes)
      <<id_len::big-32, id_bytes::binary, chunk_index::big-32, bytes::binary>>
    end

    test "operator の attach_open は wrapper topic へ relay + agent_id 剥がす" do
      agent_id = "test.upload-1"
      put_agent(agent_id)
      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:operator)

      ref =
        push(socket, "attach_open", %{
          "agent_id" => agent_id,
          "upload_id" => "u1",
          "filename" => "a.png",
          "mime" => "image/png",
          "size" => 100,
          "chunks" => 1
        })

      assert_reply ref, :ok

      assert_broadcast "attach_open", payload
      refute Map.has_key?(payload, "agent_id")
      assert payload["upload_id"] == "u1"
      assert payload["mime"] == "image/png"
    end

    test "attach_open は viewer から forbidden" do
      agent_id = "test.upload-2"
      put_agent(agent_id)
      socket = join_as(:viewer)

      ref =
        push(socket, "attach_open", %{
          "agent_id" => agent_id,
          "upload_id" => "u1",
          "filename" => "a.png",
          "mime" => "image/png",
          "size" => 1,
          "chunks" => 1
        })

      assert_reply ref, :error, %{reason: "forbidden"}
    end

    test "attach_open の必須キー欠落は invalid_value" do
      agent_id = "test.upload-3"
      put_agent(agent_id)
      socket = join_as(:operator)

      ref = push(socket, "attach_open", %{"agent_id" => agent_id, "upload_id" => "u1"})
      assert_reply ref, :error, %{reason: reason}
      assert reason =~ "missing key"
    end

    test "attach_close は upload_id を relay + route 引かれていない場合 unknown_upload" do
      agent_id = "test.upload-4"
      put_agent(agent_id)
      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:operator)

      # No prior attach_open -> route table empty -> unknown_upload
      ref = push(socket, "attach_close", %{"agent_id" => agent_id, "upload_id" => "unknown"})
      assert_reply ref, :error, %{reason: "unknown_upload"}
    end

    test "attach_open 登録後の attach_close は relay 成功" do
      agent_id = "test.upload-5"
      put_agent(agent_id)
      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:operator)

      open_ref =
        push(socket, "attach_open", %{
          "agent_id" => agent_id,
          "upload_id" => "u5",
          "filename" => "a.png",
          "mime" => "image/png",
          "size" => 3,
          "chunks" => 1
        })

      assert_reply open_ref, :ok
      assert_broadcast "attach_open", _

      close_ref = push(socket, "attach_close", %{"agent_id" => agent_id, "upload_id" => "u5"})
      assert_reply close_ref, :ok
      assert_broadcast "attach_close", %{"upload_id" => "u5"} = close_payload
      refute Map.has_key?(close_payload, "agent_id")
    end

    test "attach_close は payload.agent_id ではなくルートテーブルが指す wrapper へ配信" do
      # 攻撃シナリオ: A に attach_open したあと、 close の payload.agent_id を B に
      # 差し替えて送る。 ルートテーブル(A)を真とすべきで B に配信されてはならない。
      agent_a = "test.upload-a"
      agent_b = "test.upload-b"
      put_agent(agent_a)
      put_agent(agent_b)
      @endpoint.subscribe("wrapper:" <> agent_a)
      @endpoint.subscribe("wrapper:" <> agent_b)
      socket = join_as(:operator)

      open_ref =
        push(socket, "attach_open", %{
          "agent_id" => agent_a,
          "upload_id" => "uX",
          "filename" => "x.png",
          "mime" => "image/png",
          "size" => 1,
          "chunks" => 1
        })

      assert_reply open_ref, :ok
      assert_broadcast "attach_open", _

      close_ref =
        push(socket, "attach_close", %{"agent_id" => agent_b, "upload_id" => "uX"})

      assert_reply close_ref, :ok
      # ルートが A なので A 側に届くべき(B 側には出ない)。
      assert_received %Phoenix.Socket.Broadcast{
        topic: topic,
        event: "attach_close",
        payload: %{"upload_id" => "uX"}
      }

      assert topic == "wrapper:" <> agent_a

      refute_received %Phoenix.Socket.Broadcast{
        topic: "wrapper:" <> ^agent_b,
        event: "attach_close"
      }
    end

    test "binary attach_chunk は upload_id ルックアップで relay (operator 経由)" do
      agent_id = "test.upload-6"
      put_agent(agent_id)
      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:operator)

      open_ref =
        push(socket, "attach_open", %{
          "agent_id" => agent_id,
          "upload_id" => "u6",
          "filename" => "a.png",
          "mime" => "image/png",
          "size" => 4,
          "chunks" => 1
        })

      assert_reply open_ref, :ok
      assert_broadcast "attach_open", _

      data = build_chunk_payload("u6", 0, <<1, 2, 3, 4>>)

      # Phoenix.ChannelTest.push goes through dispatch; for binary the
      # payload arrives at handle_in as `{:binary, data}` after V2
      # serializer decoding. ChannelTest bypasses the serializer, so we
      # construct the tuple shape directly.
      push(socket, "attach_chunk", {:binary, data})

      assert_broadcast "attach_chunk", {:binary, ^data}
    end

    test "binary attach_chunk の upload_id が未登録ならドロップ (broadcast 無し)" do
      agent_id = "test.upload-7"
      put_agent(agent_id)
      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:operator)

      data = build_chunk_payload("unregistered", 0, <<9>>)
      push(socket, "attach_chunk", {:binary, data})

      refute_broadcast "attach_chunk", _
    end

    test "viewer の binary attach_chunk はドロップ" do
      agent_id = "test.upload-8"
      put_agent(agent_id)
      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:viewer)

      data = build_chunk_payload("u8", 0, <<1>>)
      push(socket, "attach_chunk", {:binary, data})

      refute_broadcast "attach_chunk", _
    end

    test "malformed binary frame (header truncated) はドロップ" do
      agent_id = "test.upload-9"
      put_agent(agent_id)
      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:operator)

      # 100 byte upload_id を宣言しつつ 4 byte しか送らない
      push(socket, "attach_chunk", {:binary, <<100::big-32>>})

      refute_broadcast "attach_chunk", _
    end
  end
end
