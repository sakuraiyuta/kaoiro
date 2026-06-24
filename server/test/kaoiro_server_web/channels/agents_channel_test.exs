defmodule KaoiroServerWeb.AgentsChannelTest do
  use KaoiroServerWeb.ChannelCase, async: false

  import ExUnit.CaptureLog

  alias KaoiroServer.AgentStates
  alias KaoiroServer.HostRegistry
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
            :invalid_host_id
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
end
