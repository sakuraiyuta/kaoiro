defmodule KaoiroServerWeb.AgentsChannelTest do
  use KaoiroServerWeb.ChannelCase, async: false

  import ExUnit.CaptureLog

  alias KaoiroServer.AgentDirectory
  alias KaoiroServer.AgentStates
  alias KaoiroServer.HostRegistry
  alias KaoiroServer.InterAgentHistory
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

  # Matches the bundled ao pack (persona-packs/ao/manifest.json); tests
  # rely on PersonaAssets ingesting the reference packs from
  # server/priv/persona-packs/ (ADR-0029). Custom-name test overrides
  # this via `apply_custom_name` on the spawn path.
  @ao %{"id" => "ao", "name" => "あお", "sprite_set" => "ao"}

  defp register_host(host_id, opts \\ []) do
    :ok =
      HostRegistry.register(
        host_id,
        %{
          policy: Keyword.get(opts, :policy, :accept_all),
          cwd_allowlist: Keyword.get(opts, :cwd_allowlist, ["/home/user/proj"]),
          capabilities: Keyword.get(opts, :capabilities, ["claude-code", "codex"])
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

  describe "question_response relay (ADR-0027)" do
    test "operator の回答を wrapper topic へ relay する" do
      agent_id = "test.q-1"
      put_agent(agent_id)
      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:operator)

      ref =
        push(socket, "question_response", %{
          "agent_id" => agent_id,
          "request_id" => "q-1",
          "answers" => %{"どれ?" => "A"}
        })

      assert_reply ref, :ok

      assert_broadcast "question_response", %{
        "request_id" => "q-1",
        "answers" => %{"どれ?" => "A"}
      }
    end

    test "viewer の回答は forbidden" do
      agent_id = "test.q-2"
      put_agent(agent_id)
      socket = join_as(:viewer)

      ref =
        push(socket, "question_response", %{
          "agent_id" => agent_id,
          "request_id" => "q-2",
          "answers" => %{}
        })

      assert_reply ref, :error, %{reason: "forbidden"}
    end

    test "request_id 欠落は missing key" do
      agent_id = "test.q-3"
      put_agent(agent_id)
      socket = join_as(:operator)

      ref =
        push(socket, "question_response", %{
          "agent_id" => agent_id,
          "answers" => %{}
        })

      assert_reply ref, :error, %{reason: "missing key: request_id"}
    end

    test "answers が map でないものは境界で拒否される" do
      agent_id = "test.q-4"
      put_agent(agent_id)
      socket = join_as(:operator)

      ref =
        push(socket, "question_response", %{
          "agent_id" => agent_id,
          "request_id" => "q-4",
          "answers" => "wrong"
        })

      assert_reply ref, :error, %{reason: "invalid value: answers"}
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

  describe "refresh_engine_catalog relay (Option E, ADR-0039)" do
    test "operator の refresh_engine_catalog を runner topic へ relay + host_id 剥がす" do
      host_id = "lab-pc-refreshcatalog"
      @endpoint.subscribe("runner:" <> host_id)
      socket = join_as(:operator)

      ref =
        push(socket, "refresh_engine_catalog", %{
          "host_id" => host_id,
          "engine" => "claude-code",
          "request_id" => "req-cat-1",
          "force" => true
        })

      assert_reply ref, :ok
      assert_broadcast "refresh_engine_catalog", payload
      refute Map.has_key?(payload, "host_id")
      assert payload["engine"] == "claude-code"
      assert payload["request_id"] == "req-cat-1"
      assert payload["force"] == true
    end

    test "viewer の refresh_engine_catalog は forbidden" do
      socket = join_as(:viewer)

      ref =
        push(socket, "refresh_engine_catalog", %{
          "host_id" => "lab-pc-refreshcatalog-2",
          "engine" => "claude-code",
          "request_id" => "req-cat-2"
        })

      assert_reply ref, :error, %{reason: "forbidden"}
    end

    test "host_id 欠落は missing_host_id で拒否" do
      socket = join_as(:operator)

      ref =
        push(socket, "refresh_engine_catalog", %{
          "engine" => "claude-code",
          "request_id" => "req-cat-3"
        })

      assert_reply ref, :error, %{reason: reason}
      assert reason in ["missing_host_id", "invalid_host_id"]
    end
  end

  describe "refresh_models relay (ADR-0037 F6, phase-18-5)" do
    test "operator の refresh_models を wrapper topic へ relay する" do
      agent_id = "test.refreshmodels-1"
      put_agent(agent_id)
      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:operator)

      ref = push(socket, "refresh_models", %{"agent_id" => agent_id})

      assert_reply ref, :ok
      assert_broadcast "refresh_models", payload
      refute Map.has_key?(payload, "agent_id")
    end

    test "viewer の refresh_models は forbidden" do
      agent_id = "test.refreshmodels-2"
      put_agent(agent_id)
      socket = join_as(:viewer)

      ref = push(socket, "refresh_models", %{"agent_id" => agent_id})
      assert_reply ref, :error, %{reason: "forbidden"}
    end

    test "未知 agent_id は unknown_agent" do
      socket = join_as(:operator)

      ref = push(socket, "refresh_models", %{"agent_id" => "test.refreshmodels-none"})
      assert_reply ref, :error, %{reason: "unknown_agent"}
    end

    test "refresh_models payload の request_id は wrapper topic へそのまま relay される (ADR-0039 F9 v2)" do
      agent_id = "test.refreshmodels-rid"
      put_agent(agent_id)
      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:operator)

      ref =
        push(socket, "refresh_models", %{
          "agent_id" => agent_id,
          "request_id" => "req-refresh-abc"
        })

      assert_reply ref, :ok
      assert_broadcast "refresh_models", payload
      assert payload["request_id"] == "req-refresh-abc"
      refute Map.has_key?(payload, "agent_id")
    end
  end

  describe "set_permission_mode relay (#58)" do
    # Poll for a fire-and-forget cast result rather than a fixed sleep, matching
    # permission_modes_test.exs / wrapper_channel_test.exs (loaded CI hosts can
    # take >20 ms to drain a GenServer cast, so a fixed sleep is flaky).
    defp wait_until(predicate, attempts \\ 50) do
      cond do
        predicate.() -> :ok
        attempts <= 0 -> :timeout
        true -> Process.sleep(5) && wait_until(predicate, attempts - 1)
      end
    end

    test "operator の set_permission_mode を wrapper topic へ relay し永続化する" do
      agent_id = "test.setperm-1"
      put_agent(agent_id)
      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:operator)

      ref = push(socket, "set_permission_mode", %{"agent_id" => agent_id, "mode" => "plan"})

      assert_reply ref, :ok
      assert_broadcast "set_permission_mode", payload
      assert payload["mode"] == "plan"
      refute Map.has_key?(payload, "agent_id")

      :ok = wait_until(fn -> KaoiroServer.PermissionModes.get(agent_id) == "plan" end)
      assert KaoiroServer.PermissionModes.get(agent_id) == "plan"
    end

    test "viewer の set_permission_mode は forbidden" do
      agent_id = "test.setperm-2"
      put_agent(agent_id)
      socket = join_as(:viewer)

      ref = push(socket, "set_permission_mode", %{"agent_id" => agent_id, "mode" => "auto"})
      assert_reply ref, :error, %{reason: "forbidden"}
    end

    test "未知の mode は invalid value で broadcast されず永続化もされない" do
      agent_id = "test.setperm-3"
      put_agent(agent_id)
      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:operator)

      ref = push(socket, "set_permission_mode", %{"agent_id" => agent_id, "mode" => "yolo"})
      assert_reply ref, :error, %{reason: "invalid value: mode"}

      refute_broadcast "set_permission_mode", %{}
      # The validation rejects before the cast is enqueued, so polling here
      # is overkill — but match the success-path style for symmetry.
      assert KaoiroServer.PermissionModes.get(agent_id) == nil
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

    test "operator は disconnected agent を削除し durable IA を含む全 store を purge する" do
      agent_id = "test.del-1"
      put_disconnected(agent_id)
      AgentDirectory.record(agent_id, @ao)
      SessionPointers.record(agent_id, "sess-del-1", "/home/user/proj")
      KaoiroServer.PermissionModes.record(agent_id, "plan")
      :ok = InterAgentHistory.append(durable_inter_agent_envelope(agent_id, "test.del-peer", 1))
      :ok = InterAgentHistory.append(durable_inter_agent_envelope("test.del-peer", agent_id, 2))
      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      ref = push(socket, "delete_agent", %{"agent_id" => agent_id})

      assert_reply ref, :ok
      assert_broadcast "agent_deleted", %{"agent_id" => ^agent_id}
      refute AgentStates.known?(agent_id)
      assert AgentDirectory.get(agent_id) == nil
      assert SessionPointers.get(agent_id) == nil
      # PermissionModes.record は cast なので poll
      _ = KaoiroServer.PermissionModes.all()
      assert KaoiroServer.PermissionModes.get(agent_id) == nil
      assert InterAgentHistory.list_for(agent_id) == []
      assert InterAgentHistory.list_for("test.del-peer") == []
    end

    test "AgentStates 不在の directory-only entry も削除できる (ADR-0030 D6)" do
      # server 再起動起因のケース: 台帳と pointer だけ残っており live entry は無い。
      # 「復元できない agent」を operator が明示削除する経路。
      agent_id = "test.del-directory-only"
      AgentDirectory.record(agent_id, @ao)
      SessionPointers.record(agent_id, "sess-del-do", "/home/user/proj")
      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      ref = push(socket, "delete_agent", %{"agent_id" => agent_id})

      assert_reply ref, :ok
      assert_broadcast "agent_deleted", %{"agent_id" => ^agent_id}
      assert AgentDirectory.get(agent_id) == nil
      assert SessionPointers.get(agent_id) == nil
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
            :unknown_upload,
            # phase-17 chunk β (17-4) additions — session-reset control
            # vocabulary. Direct allow-list test guards against a silent
            # removal from @safe_reasons, complementing the integration
            # tests below that assert the client-facing string form.
            :agent_busy,
            :unsupported_session_reset,
            :session_reset_pending,
            :reserved_session_command,
            :invalid_mode
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

  describe "question_request の viewer 完全除去 (ADR-0027)" do
    defp question_envelope(agent_id) do
      %{
        "version" => "0",
        "agent_id" => agent_id,
        "ts" => "2026-07-03T00:00:00Z",
        "type" => "question_request",
        "state" => "waiting_question",
        "payload" => %{
          "request_id" => "q-s1",
          "questions" => [
            %{
              "question" => "どれ?",
              "header" => "選択",
              "multiSelect" => false,
              "options" => [
                %{"label" => "A", "description" => "a"},
                %{"label" => "B", "description" => "b"}
              ]
            }
          ]
        }
      }
    end

    test "viewer への broadcast は合成 state_change に置換される (questions 除去)" do
      agent_id = "test.q-sanitize-1"
      envelope = question_envelope(agent_id)
      _socket = join_as(:viewer)

      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "envelope", envelope)

      assert_push "envelope", pushed
      assert pushed["type"] == "state_change"
      assert pushed["state"] == "waiting_question"
      assert pushed["payload"] == %{}
      refute Map.has_key?(pushed, "ext")
    end

    test "operator への broadcast は questions を保つ" do
      agent_id = "test.q-sanitize-2"
      envelope = question_envelope(agent_id)
      _socket = join_as(:operator)

      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "envelope", envelope)

      assert_push "envelope", %{
        "type" => "question_request",
        "payload" => %{"questions" => [_ | _]}
      }
    end

    test "viewer への snapshot も合成 state_change に置換される" do
      agent_id = "test.q-sanitize-3"
      :ok = AgentStates.put(question_envelope(agent_id))
      _socket = join_as(:viewer)

      assert_push "snapshot", %{"agents" => agents}
      entry = agents[agent_id]
      assert entry["type"] == "state_change"
      assert entry["state"] == "waiting_question"
      assert entry["payload"] == %{}
      refute Map.has_key?(entry, "ext")
    end
  end

  # phase-17 17-7 (ADR-0036 F3): session_boundary marker envelope の
  # viewer sanitize。operator は full payload (mode / request_id /
  # previous_session_id / to_session_id / persona)、viewer は mode /
  # state / ts / persona のみ (session ID 群は viewer に露出しない)。
  describe "session_boundary の viewer 情報境界 (ADR-0036 F3, 17-7)" do
    defp boundary_envelope(agent_id, mode) do
      %{
        "version" => "0",
        "agent_id" => agent_id,
        "persona" => @ao,
        "ts" => "2026-07-12T18:00:00Z",
        "type" => "session_boundary",
        "state" => "idle",
        "payload" => %{
          "mode" => mode,
          "request_id" => "rs_boundary_1",
          "previous_session_id" => "sess-old-xyz",
          "to_session_id" => "sess-new-abc"
        },
        "ext" => %{}
      }
    end

    test "operator は marker envelope を full payload で受信する (must-3)" do
      envelope = boundary_envelope("test.bd-op", "new")
      _socket = join_as(:operator)

      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "envelope", envelope)

      assert_push "envelope",
                  %{
                    "type" => "session_boundary",
                    "payload" => %{
                      "mode" => "new",
                      "request_id" => "rs_boundary_1",
                      "previous_session_id" => "sess-old-xyz",
                      "to_session_id" => "sess-new-abc"
                    }
                  }
    end

    test "viewer は marker envelope を safe payload のみ受信する (session ID 群 drop)" do
      envelope = boundary_envelope("test.bd-vw", "clear")
      _socket = join_as(:viewer)

      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "envelope", envelope)

      assert_push "envelope", pushed
      # 境界の存在 (mode) は viewer にも表示、ID 群は drop、ext も削除。
      assert pushed["type"] == "session_boundary"
      assert pushed["state"] == "idle"
      assert pushed["payload"] == %{"mode" => "clear"}
      refute Map.has_key?(pushed, "ext")
      refute Map.has_key?(pushed["payload"], "request_id")
      refute Map.has_key?(pushed["payload"], "previous_session_id")
      refute Map.has_key?(pushed["payload"], "to_session_id")
    end
  end

  describe "inter_agent_message の viewer 完全除去 (protocol-inter-agent, phase-8)" do
    defp inter_agent_envelope(agent_id, to_id) do
      %{
        "version" => "0",
        "agent_id" => agent_id,
        "ts" => "2026-06-29T00:00:00Z",
        "type" => "inter_agent_message",
        "state" => "tool_running",
        "payload" => %{
          "to" => to_id,
          "conversation_id" => "cnv-acl-1",
          "turn_number" => 1,
          "kind" => "propose",
          "body" => "ベンチ結果から CSV 出力で合意したい",
          "meta" => %{"done" => false, "propose_next" => ""},
          "owner" => %{"kind" => "user", "id" => "operator"}
        },
        "ext" => %{}
      }
    end

    test "viewer には inter_agent_message を配信しない (fail-closed drop)" do
      envelope = inter_agent_envelope("test.iam-vw-from", "test.iam-vw-to")
      _socket = join_as(:viewer)

      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "envelope", envelope)

      refute_push "envelope", %{}
    end

    test "operator には inter_agent_message を payload ごと配信する" do
      envelope = inter_agent_envelope("test.iam-op-from", "test.iam-op-to")
      _socket = join_as(:operator)

      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "envelope", envelope)

      assert_push "envelope",
                  %{
                    "type" => "inter_agent_message",
                    "payload" => %{
                      "kind" => "propose",
                      "body" => "ベンチ結果から CSV 出力で合意したい"
                    }
                  }
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

  # ADR-0039 F9 v2 = 藤 review turn-13 追加指示 (must-fix 3): allow-list の
  # fail-closed 経路で暗黙 covered な前提を、refresh_models_result について
  # 明示 pin する。operator へは payload ごと配送、viewer へは drop される。
  describe "refresh_models_result の operator 限定配信 (ADR-0039 F9 v2)" do
    defp refresh_result_envelope(agent_id) do
      %{
        "version" => "0",
        "agent_id" => agent_id,
        "ts" => "2026-07-15T00:00:00Z",
        "type" => "refresh_models_result",
        "state" => "waiting_input",
        "payload" => %{
          "request_id" => "req-refresh-vw-1",
          "ok" => true,
          "models_count" => 3
        },
        "ext" => %{}
      }
    end

    test "operator は refresh_models_result を payload ごと受信する" do
      agent_id = "test.refresh-result-op"
      envelope = refresh_result_envelope(agent_id)
      _socket = join_as(:operator)

      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "envelope", envelope)

      assert_push "envelope",
                  %{
                    "type" => "refresh_models_result",
                    "payload" => %{
                      "request_id" => "req-refresh-vw-1",
                      "ok" => true,
                      "models_count" => 3
                    }
                  }
    end

    test "viewer には refresh_models_result を配信しない (fail-closed drop)" do
      # sanitize_envelope_for(:viewer, _envelope) → :drop に落ちる allow-list
      # の fail-closed 経路を明示 pin。type を追加した将来の作者が :viewer
      # 節を書き忘れても、そのままでは pending マップの request_id が漏れる
      # ことは無い、という契約を回帰チェックとして残す。
      agent_id = "test.refresh-result-vw"
      envelope = refresh_result_envelope(agent_id)
      _socket = join_as(:viewer)

      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "envelope", envelope)

      refute_push "envelope", %{"type" => "refresh_models_result"}
      # snapshot も汚さないことは wrapper_channel_test の store no-op test
      # で pin 済み (ADR-0039 F9 v2 must-fix 1)。ここでは配信面のみ扱う。
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
    defp durable_inter_agent_envelope(agent_id, to, turn) do
      %{
        "version" => "0",
        "agent_id" => agent_id,
        "persona" => @ao,
        "ts" => "2026-07-13T00:00:00Z",
        "seq" => turn,
        "type" => "inter_agent_message",
        "state" => "tool_running",
        "payload" => %{
          "to" => to,
          "conversation_id" => "cid-durable-#{agent_id}",
          "turn_number" => turn,
          "kind" => "inform",
          "body" => "durable"
        },
        "ext" => %{}
      }
    end

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

    test "AgentStates が空でも durable IA を join history に復元する (#105)" do
      agent_id = "test.hist-durable"
      env = durable_inter_agent_envelope(agent_id, "test.hist-peer", 1)
      :ok = InterAgentHistory.append(env)
      on_exit(fn -> InterAgentHistory.delete_agent(agent_id) end)

      refute Map.has_key?(AgentStates.histories(), agent_id)
      _socket = join_as(:operator)

      assert_push "snapshot", %{"agents" => _}
      assert_push "history", %{"agents" => agents}
      assert agents[agent_id] == [env]
    end

    test "volatile IA と durable IA は join history で重複しない (#105)" do
      agent_id = "test.hist-dedupe"
      env = durable_inter_agent_envelope(agent_id, "test.hist-peer", 1)
      put_agent(agent_id)
      :ok = AgentStates.append_log(env)
      :ok = InterAgentHistory.append(env)
      on_exit(fn -> InterAgentHistory.delete_agent(agent_id) end)

      _socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}
      assert_push "history", %{"agents" => agents}
      assert agents[agent_id] == [env]
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
          "persona" => "ao",
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
      assert payload["persona"] == @ao
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
          "persona" => "ao",
          "cwd" => "/home/user/seed"
        })

      assert_reply ref, :ok, %{"agent_id" => agent_id}
      # The cast is enqueued before the reply, so the pointer is set by now.
      assert SessionPointers.get(agent_id) ==
               %{session_id: nil, cwd: "/home/user/seed", engine: "claude-code", snapshot: nil}
    end

    test "operator の spawn: engine/model/sandbox を検証して payload に中継する (ADR-0032)" do
      host_id = "lab-pc-1e"
      register_host(host_id, cwd_allowlist: ["/home/user/proj"])
      @endpoint.subscribe("runner:" <> host_id)
      socket = join_as(:operator)

      ref =
        push(socket, "spawn", %{
          "host_id" => host_id,
          "persona" => "ao",
          "cwd" => "/home/user/proj",
          "engine" => "codex",
          "model" => "gpt-5.6-sol",
          "effort" => "low",
          "sandbox" => "read-only",
          "network_access" => true
        })

      assert_reply ref, :ok, %{"agent_id" => agent_id}
      assert_broadcast "spawn", payload
      assert payload["engine"] == "codex"
      assert payload["model"] == "gpt-5.6-sol"
      assert payload["effort"] == "low"
      assert payload["sandbox"] == "read-only"
      assert payload["network_access"] == true
      # engine が SessionPointers に残る (restore が同 engine で再起動するため)
      assert SessionPointers.get(agent_id).engine == "codex"
    end

    test "operator の spawn: permission_mode を relay + PermissionModes に永続 (phase-15 15-12)" do
      host_id = "lab-pc-1e-pm"
      register_host(host_id, cwd_allowlist: ["/home/user/proj"])
      @endpoint.subscribe("runner:" <> host_id)
      socket = join_as(:operator)

      ref =
        push(socket, "spawn", %{
          "host_id" => host_id,
          "persona" => "ao",
          "cwd" => "/home/user/proj",
          "engine" => "claude-code",
          "permission_mode" => "plan"
        })

      assert_reply ref, :ok, %{"agent_id" => agent_id}
      assert_broadcast "spawn", payload
      assert payload["permission_mode"] == "plan"
      # Priority "explicit spawn wins over store": the spawn-time pick is
      # recorded so the after_join push reinforces (not overwrites) it.
      :ok = wait_until(fn -> KaoiroServer.PermissionModes.get(agent_id) == "plan" end)
      assert KaoiroServer.PermissionModes.get(agent_id) == "plan"
    end

    test "operator の spawn: 未知 permission_mode は payload に載せず 永続もしない" do
      host_id = "lab-pc-1e-pm-invalid"
      register_host(host_id, cwd_allowlist: ["/home/user/proj"])
      @endpoint.subscribe("runner:" <> host_id)
      socket = join_as(:operator)

      ref =
        push(socket, "spawn", %{
          "host_id" => host_id,
          "persona" => "ao",
          "cwd" => "/home/user/proj",
          "permission_mode" => "yolo"
        })

      assert_reply ref, :ok, %{"agent_id" => agent_id}
      assert_broadcast "spawn", payload
      refute Map.has_key?(payload, "permission_mode")
      _ = KaoiroServer.PermissionModes.all()
      assert KaoiroServer.PermissionModes.get(agent_id) == nil
    end

    test "operator の spawn: host が宣言しない engine は engine_not_supported" do
      host_id = "lab-pc-1f"
      register_host(host_id, capabilities: ["claude-code"])
      socket = join_as(:operator)

      ref =
        push(socket, "spawn", %{
          "host_id" => host_id,
          "persona" => "ao",
          "cwd" => "/home/user/proj",
          "engine" => "codex"
        })

      assert_reply ref, :error, %{reason: "engine_not_supported"}
    end

    test "operator の spawn: 未知 engine 値は invalid_engine" do
      host_id = "lab-pc-1g"
      register_host(host_id)
      socket = join_as(:operator)

      ref =
        push(socket, "spawn", %{
          "host_id" => host_id,
          "persona" => "ao",
          "cwd" => "/home/user/proj",
          "engine" => "gemini"
        })

      assert_reply ref, :error, %{reason: "invalid_engine"}
    end

    test "operator の spawn: initial_prompt を payload に載せる" do
      host_id = "lab-pc-1b"
      register_host(host_id)
      @endpoint.subscribe("runner:" <> host_id)
      socket = join_as(:operator)

      ref =
        push(socket, "spawn", %{
          "host_id" => host_id,
          "persona" => "ao",
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
          "persona" => "ao",
          "cwd" => "/home/user/proj",
          "name" => "  レビュー担当  "
        })

      assert_reply ref, :ok
      # name は trim され persona.name のみ上書き; id/sprite_set は不変。
      assert_broadcast "spawn", %{"persona" => persona}
      assert persona == %{"id" => "ao", "name" => "レビュー担当", "sprite_set" => "ao"}
    end

    test "operator の spawn: name 未指定/空白は persona 既定名のまま" do
      host_id = "lab-pc-1d"
      register_host(host_id)
      @endpoint.subscribe("runner:" <> host_id)
      socket = join_as(:operator)

      ref =
        push(socket, "spawn", %{
          "host_id" => host_id,
          "persona" => "ao",
          "cwd" => "/home/user/proj",
          "name" => "   "
        })

      assert_reply ref, :ok
      assert_broadcast "spawn", payload
      assert payload["persona"] == @ao
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
            "persona" => "ao",
            "cwd" => "/home/user/proj",
            "name" => bad
          })

        assert_reply ref, :error, %{reason: "invalid_name"}
      end

      refute_broadcast "spawn", %{}
    end

    test "operator の stop / restart / enumerate_sessions を runner topic へ relay する" do
      host_id = "lab-pc-2"
      register_host(host_id)
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
          "persona" => "ao",
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

    test "予約 default ペルソナは accept-all host で spawn できる (#35, ADR-0031)" do
      host_id = "lab-pc-default"
      # register_host の既定 policy は :accept_all、default は PersonaAssets
      # の pool に必ず含まれる (ADR-0031 F2)。
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
          "persona" => "ao",
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
          "persona" => @ao,
          "ts" => "2026-06-11T00:00:00Z",
          "type" => "state_change",
          "state" => "disconnected",
          "session_id" => session_id
        })

      # In real production the spawn path always records the identity
      # (ADR-0030 D2). Mirror that here so restore's agent_persona/1 can
      # find the persona via AgentDirectory even when AgentStates would.
      :ok = AgentDirectory.record(agent_id, @ao)
      # Flush the async cast before the handler reads the ledger.
      _ = AgentDirectory.get(agent_id)
    end

    test "operator の restore: 同一 agent_id を resume 付きで runner へ再 spawn" do
      host_id = "lab-pc-1"
      agent_id = "lab-pc-1.rev1"
      register_host(host_id)
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
      assert payload["persona"] == @ao
      assert is_binary(payload["token"])
    end

    test "operator の restore: host が pointer の engine を宣言しなければ engine_not_supported" do
      host_id = "lab-pc-restore-capability"
      agent_id = host_id <> ".rev"
      register_host(host_id, capabilities: ["claude-code"])
      disconnect_with_session(agent_id, "sess-codex")
      :ok = SessionPointers.record(agent_id, "sess-codex", "/home/user/proj", "codex")
      _ = SessionPointers.get(agent_id)
      @endpoint.subscribe("runner:" <> host_id)
      socket = join_as(:operator)

      ref = push(socket, "restore", %{"agent_id" => agent_id})

      assert_reply ref, :error, %{reason: "engine_not_supported"}
      refute_broadcast "spawn", %{}
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

    test "session_id nil pointer + snapshot → resume_session_id なし apply_resume_snapshot=true で fresh-restore (phase-25 25-3)" do
      host_id = "lab-pc-1"
      agent_id = "lab-pc-1.fresh-restore"
      register_host(host_id)
      disconnect_with_session(agent_id, "sess-was-detached")
      # /clear 相当: pointer に cwd/engine/snapshot は残るが session_id は nil。
      :ok = SessionPointers.record(agent_id, nil, "/home/user/proj", "claude-code")

      :ok =
        SessionPointers.record_snapshot(agent_id, %{
          "model" => "claude-opus-4-7",
          "model_source" => "launch",
          "permission_mode" => "bypassPermissions"
        })

      _ = SessionPointers.get(agent_id)
      @endpoint.subscribe("runner:" <> host_id)
      socket = join_as(:operator)

      ref = push(socket, "restore", %{"agent_id" => agent_id})

      assert_reply ref, :ok
      assert_broadcast "spawn", payload
      assert payload["agent_id"] == agent_id
      assert payload["cwd"] == "/home/user/proj"
      assert payload["apply_resume_snapshot"] == true
      refute Map.has_key?(payload, "resume_session_id")

      assert payload["resume_snapshot"] == %{
               "model" => "claude-opus-4-7",
               "model_source" => "launch",
               "permission_mode" => "bypassPermissions"
             }
    end

    test "session_id nil pointer + snapshot なしでも fresh-restore は成立 (runner 側で engine default に降格、phase-25 fail-soft)" do
      host_id = "lab-pc-1"
      agent_id = "lab-pc-1.fresh-restore-nosnap"
      register_host(host_id)
      disconnect_with_session(agent_id, "sess-was-detached")
      :ok = SessionPointers.record(agent_id, nil, "/home/user/proj", "claude-code")
      _ = SessionPointers.get(agent_id)
      @endpoint.subscribe("runner:" <> host_id)
      socket = join_as(:operator)

      ref = push(socket, "restore", %{"agent_id" => agent_id})

      assert_reply ref, :ok
      assert_broadcast "spawn", payload
      assert payload["apply_resume_snapshot"] == true
      refute Map.has_key?(payload, "resume_session_id")
      refute Map.has_key?(payload, "resume_snapshot")
    end

    test "pointer 完全不在は依然として no_session (phase-25 では緩めない)" do
      agent_id = "lab-pc-1.no-pointer-at-all"
      disconnect_with_session(agent_id, "sess-any")
      socket = join_as(:operator)

      ref = push(socket, "restore", %{"agent_id" => agent_id})

      assert_reply ref, :error, %{reason: "no_session"}
    end

    test "cwd 欠落 pointer は no_session 維持 (fresh-restore に cwd は必須)" do
      agent_id = "lab-pc-1.no-cwd"
      disconnect_with_session(agent_id, "sess-nocwd")
      # SessionPointers.record は cwd=nil でも merge で既存の cwd を残す
      # 仕様なので、cwd 未 seed のまま session_id を nil にした状態を作る。
      :ok = SessionPointers.record(agent_id, nil, nil, "claude-code")
      _ = SessionPointers.get(agent_id)
      socket = join_as(:operator)

      ref = push(socket, "restore", %{"agent_id" => agent_id})

      assert_reply ref, :error, %{reason: "no_session"}
    end

    test "resume_disconnected は pointer.session_id が nil でも operator 指定 sid で通る (phase-25 25-4)" do
      host_id = "lab-pc-1"
      agent_id = "lab-pc-1.dc-swap-null-ptr"
      register_host(host_id)

      :ok =
        AgentStates.put(%{
          "version" => "0",
          "agent_id" => agent_id,
          "persona" => @ao,
          "ts" => "2026-06-11T00:00:00Z",
          "type" => "state_change",
          "state" => "disconnected"
        })

      :ok = AgentDirectory.record(agent_id, @ao)
      _ = AgentDirectory.get(agent_id)
      # session_id は nil、cwd/engine のみ持つ pointer。
      :ok = SessionPointers.record(agent_id, nil, "/home/user/proj", "claude-code")
      _ = SessionPointers.get(agent_id)
      @endpoint.subscribe("runner:" <> host_id)
      socket = join_as(:operator)

      ref =
        push(socket, "resume_session", %{
          "agent_id" => agent_id,
          "session_id" => "operator-picked-sess"
        })

      assert_reply ref, :ok
      assert_broadcast "spawn", payload
      # operator の明示 session pick を尊重、apply_resume_snapshot は付かない。
      assert payload["resume_session_id"] == "operator-picked-sess"
      assert payload["cwd"] == "/home/user/proj"
      refute Map.has_key?(payload, "apply_resume_snapshot")
    end

    test "AgentStates 空でも AgentDirectory と SessionPointers から restore が成立 (ADR-0030、#41 goal)" do
      # サーバ再起動シミュレーション: AgentStates は空、ただし AgentDirectory
      # の persona と SessionPointers の pointer は DETS で残っている状態。
      host_id = "lab-pc-1"
      agent_id = "lab-pc-1.after-restart"
      register_host(host_id)

      :ok = AgentDirectory.record(agent_id, @ao)
      # Flush the async cast so the fetch guard reads the recorded entry.
      _ = AgentDirectory.get(agent_id)
      :ok = SessionPointers.record(agent_id, "sess-after-restart", "/home/user/proj")
      _ = SessionPointers.get(agent_id)

      # AgentStates は敢えて put しない — 再起動直後の空状態を再現。
      refute AgentStates.snapshot()[agent_id]

      @endpoint.subscribe("runner:" <> host_id)
      socket = join_as(:operator)

      ref = push(socket, "restore", %{"agent_id" => agent_id})

      assert_reply ref, :ok
      assert_broadcast "spawn", payload
      assert payload["agent_id"] == agent_id
      assert payload["persona"] == @ao
      assert payload["resume_session_id"] == "sess-after-restart"
      assert payload["cwd"] == "/home/user/proj"
    end
  end

  describe "resume_session (ADR-0014 resume-swap)" do
    test "稼働中 agent の resume_session は runner へ switch_session を中継" do
      host_id = "lab-pc-1"
      agent_id = "lab-pc-1.live-swap"
      put_agent(agent_id)
      @endpoint.subscribe("runner:" <> host_id)
      socket = join_as(:operator)

      ref =
        push(socket, "resume_session", %{
          "agent_id" => agent_id,
          "session_id" => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        })

      assert_reply ref, :ok
      assert_broadcast "switch_session", payload
      assert payload["agent_id"] == agent_id
      assert payload["resume_session_id"] == "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
      refute_broadcast "spawn", %{}
    end

    test "切断済み agent の resume_session は restore と同経路で spawn を中継" do
      host_id = "lab-pc-1"
      agent_id = "lab-pc-1.dc-swap"
      register_host(host_id)

      :ok =
        AgentStates.put(%{
          "version" => "0",
          "agent_id" => agent_id,
          "persona" => @ao,
          "ts" => "2026-06-11T00:00:00Z",
          "type" => "state_change",
          "state" => "disconnected",
          "session_id" => "old-sess"
        })

      :ok = SessionPointers.record(agent_id, "old-sess", "/home/user/proj")
      SessionPointers.get(agent_id)
      :ok = AgentDirectory.record(agent_id, @ao)
      _ = AgentDirectory.get(agent_id)
      @endpoint.subscribe("runner:" <> host_id)
      socket = join_as(:operator)

      ref =
        push(socket, "resume_session", %{
          "agent_id" => agent_id,
          "session_id" => "new-sess-1"
        })

      assert_reply ref, :ok
      assert_broadcast "spawn", payload
      # payload の session_id を使う(SessionPointers の値ではなく)
      assert payload["resume_session_id"] == "new-sess-1"
      # cwd は SessionPointers を引き継ぐ
      assert payload["cwd"] == "/home/user/proj"
      assert payload["agent_id"] == agent_id
      refute_broadcast "switch_session", %{}
    end

    test "切断済み agent の resume_session: host が pointer の engine を宣言しなければ engine_not_supported" do
      host_id = "lab-pc-resume-capability"
      agent_id = host_id <> ".dc"
      register_host(host_id, capabilities: ["claude-code"])

      :ok =
        AgentStates.put(%{
          "version" => "0",
          "agent_id" => agent_id,
          "persona" => @ao,
          "ts" => "2026-06-11T00:00:00Z",
          "type" => "state_change",
          "state" => "disconnected",
          "session_id" => "old-sess"
        })

      :ok = SessionPointers.record(agent_id, "old-sess", "/home/user/proj", "codex")
      _ = SessionPointers.get(agent_id)
      :ok = AgentDirectory.record(agent_id, @ao)
      _ = AgentDirectory.get(agent_id)
      @endpoint.subscribe("runner:" <> host_id)
      socket = join_as(:operator)

      ref =
        push(socket, "resume_session", %{
          "agent_id" => agent_id,
          "session_id" => "new-sess"
        })

      assert_reply ref, :error, %{reason: "engine_not_supported"}
      refute_broadcast "spawn", %{}
    end

    test "切断済みで session pointer に cwd が無ければ no_session" do
      agent_id = "lab-pc-1.dc-no-cwd"

      :ok =
        AgentStates.put(%{
          "version" => "0",
          "agent_id" => agent_id,
          "persona" => @ao,
          "ts" => "2026-06-11T00:00:00Z",
          "type" => "state_change",
          "state" => "disconnected"
        })

      # In real flow, spawn also seeds AgentDirectory (ADR-0030 D2).
      :ok = AgentDirectory.record(agent_id, @ao)
      _ = AgentDirectory.get(agent_id)

      socket = join_as(:operator)

      ref =
        push(socket, "resume_session", %{
          "agent_id" => agent_id,
          "session_id" => "new-sess-1"
        })

      assert_reply ref, :error, %{reason: "no_session"}
    end

    test "session_id 欠落は missing_session_id" do
      agent_id = "lab-pc-1.swap-missing"
      put_agent(agent_id)
      socket = join_as(:operator)

      ref = push(socket, "resume_session", %{"agent_id" => agent_id})

      assert_reply ref, :error, %{reason: "missing_session_id"}
    end

    test "session_id charset 違反は invalid_session_id" do
      agent_id = "lab-pc-1.swap-bad"
      put_agent(agent_id)
      socket = join_as(:operator)

      ref =
        push(socket, "resume_session", %{
          "agent_id" => agent_id,
          "session_id" => "../evil"
        })

      assert_reply ref, :error, %{reason: "invalid_session_id"}
    end

    test "未知 agent の resume_session は unknown_agent" do
      socket = join_as(:operator)

      ref =
        push(socket, "resume_session", %{
          "agent_id" => "lab-pc-1.ghost",
          "session_id" => "some-sess"
        })

      assert_reply ref, :error, %{reason: "unknown_agent"}
    end

    test "viewer の resume_session は forbidden" do
      agent_id = "lab-pc-1.viewer-swap"
      put_agent(agent_id)
      socket = join_as(:viewer)

      ref =
        push(socket, "resume_session", %{
          "agent_id" => agent_id,
          "session_id" => "some-sess"
        })

      assert_reply ref, :error, %{reason: "forbidden"}
    end
  end

  describe "enumerate_sessions cwd 補完 (詳細画面)" do
    test "cwd 省略 + agent_id 指定は SessionPointers から cwd を補完して runner へ中継" do
      host_id = "lab-pc-enum"
      agent_id = "lab-pc-enum.a"
      register_host(host_id)
      put_agent(agent_id)
      :ok = SessionPointers.record(agent_id, nil, "/home/user/proj")
      SessionPointers.get(agent_id)
      @endpoint.subscribe("runner:" <> host_id)
      socket = join_as(:operator)

      ref =
        push(socket, "enumerate_sessions", %{
          "host_id" => host_id,
          "agent_id" => agent_id
        })

      assert_reply ref, :ok
      assert_broadcast "enumerate_sessions", payload
      assert payload["cwd"] == "/home/user/proj"
      assert payload["agent_id"] == agent_id
      refute Map.has_key?(payload, "host_id")
    end

    test "cwd 明示指定は補完せずそのまま中継 (LaunchDialog 経路)" do
      host_id = "lab-pc-enum2"
      register_host(host_id)
      @endpoint.subscribe("runner:" <> host_id)
      socket = join_as(:operator)

      ref =
        push(socket, "enumerate_sessions", %{
          "host_id" => host_id,
          "cwd" => "/home/user/proj"
        })

      assert_reply ref, :ok
      assert_broadcast "enumerate_sessions", payload
      assert payload["cwd"] == "/home/user/proj"
    end

    test "client 指定 engine を host が宣言しなければ engine_not_supported" do
      host_id = "lab-pc-enum-capability"
      register_host(host_id, capabilities: ["claude-code"])
      @endpoint.subscribe("runner:" <> host_id)
      socket = join_as(:operator)

      ref =
        push(socket, "enumerate_sessions", %{
          "host_id" => host_id,
          "cwd" => "/home/user/proj",
          "engine" => "codex"
        })

      assert_reply ref, :error, %{reason: "engine_not_supported"}
      refute_broadcast "enumerate_sessions", %{}
    end

    test "SessionPointers に cwd 記録が無ければ no_session" do
      host_id = "lab-pc-enum3"
      agent_id = "lab-pc-enum3.a"
      register_host(host_id)
      put_agent(agent_id)
      socket = join_as(:operator)

      ref =
        push(socket, "enumerate_sessions", %{
          "host_id" => host_id,
          "agent_id" => agent_id
        })

      assert_reply ref, :error, %{reason: "no_session"}
    end

    test "cwd も agent_id も無ければ invalid_cwd" do
      host_id = "lab-pc-enum4"
      register_host(host_id)
      socket = join_as(:operator)

      ref = push(socket, "enumerate_sessions", %{"host_id" => host_id})

      assert_reply ref, :error, %{reason: "invalid_cwd"}
    end
  end

  describe "host/runner イベントの operator 限定配信 (ADR-0023, ADR-0021)" do
    test "join 時 operator は hosts push を受け、viewer は受けない" do
      host_id = "lab-pc-hosts"

      :ok =
        KaoiroServer.HostRegistry.register(
          host_id,
          %{policy: :accept_all, cwd_allowlist: ["/home/user/p"]},
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

    test "join 時 operator は directory push を受ける (ADR-0030 D4)" do
      agent_id = "lab-pc-1.dir-push"
      :ok = AgentDirectory.record(agent_id, @ao)
      _ = AgentDirectory.get(agent_id)

      _operator = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}
      assert_push "directory", %{"entries" => entries}
      assert %{persona: @ao} = entries[agent_id]
    end

    test "viewer は join 時に directory push を受けない (operator 限定、ADR-0030 D10)" do
      _viewer = join_as(:viewer)
      assert_push "snapshot", %{"agents" => _}
      refute_push "directory", %{}
    end

    test "runner_sessions / spawn_result / hosts の live broadcast は operator に届く" do
      _operator = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      for event <- ["runner_sessions", "spawn_result", "hosts", "catalog_result"] do
        KaoiroServerWeb.Endpoint.broadcast("agents:lobby", event, %{"host_id" => "h"})
        assert_push ^event, %{"host_id" => "h"}
      end
    end

    test "runner_sessions / spawn_result / hosts は viewer には届かない (fail-closed)" do
      _viewer = join_as(:viewer)
      assert_push "snapshot", %{"agents" => _}

      for event <- ["runner_sessions", "spawn_result", "hosts", "catalog_result"] do
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

  # phase-17 chunk β (17-4): session_reset control (ADR-0036 F1/F6/F7).
  describe "session_reset control (ADR-0036 F1/F6/F7, phase-17 17-4)" do
    defp put_agent_with_caps(agent_id, opts \\ []) do
      state = Keyword.get(opts, :state, "idle")
      supports_reset = Keyword.get(opts, :supports_session_reset, true)
      modes = Keyword.get(opts, :session_reset_modes, ["new", "clear"])
      sid = Keyword.get(opts, :session_id, "sess-prev")

      caps =
        %{
          "supports_attachments" => true,
          "supports_user_input_dialog" => true
        }
        |> maybe_put_caps_field("supports_session_reset", supports_reset)
        |> maybe_put_caps_field("session_reset_modes", modes)

      envelope =
        %{
          "version" => "0",
          "agent_id" => agent_id,
          "ts" => "2026-07-12T00:00:00Z",
          "type" => "state_change",
          "state" => state,
          "ext" => %{"session_capabilities" => caps}
        }
        |> maybe_put_session_id(sid)

      :ok = AgentStates.put(envelope)

      # SessionResets 上に残った lock を per-agent で clean up (別 test の残留対策)。
      _ = KaoiroServer.SessionResets.delete(agent_id)
      :ok
    end

    defp maybe_put_caps_field(caps, _key, :absent), do: caps
    defp maybe_put_caps_field(caps, key, value), do: Map.put(caps, key, value)

    defp maybe_put_session_id(envelope, nil), do: envelope
    defp maybe_put_session_id(envelope, sid), do: Map.put(envelope, "session_id", sid)

    test "operator + capability=true + idle は started broadcast + runner へ reset_session push (previous_session_id 込み)" do
      agent_id = "sess-reset.happy"
      put_agent_with_caps(agent_id)
      @endpoint.subscribe("runner:sess-reset")
      socket = join_as(:operator)

      ref = push(socket, "session_reset", %{"agent_id" => agent_id, "mode" => "new"})

      assert_reply ref, :ok

      assert_broadcast "session_reset_started",
                       %{
                         "agent_id" => ^agent_id,
                         "mode" => "new",
                         "previous_session_id" => "sess-prev",
                         "request_id" => request_id
                       }

      assert String.starts_with?(request_id, "rs_")

      # phase-17 17-5 must-1: reset_session payload には detach 前の
      # session_id (AgentStates snapshot 由来) を previous_session_id で
      # 載せる。runner の rollback branch がこの値を使う。
      assert_broadcast "reset_session",
                       %{
                         "agent_id" => ^agent_id,
                         "mode" => "new",
                         "request_id" => ^request_id,
                         "version" => "0",
                         "previous_session_id" => "sess-prev"
                       }
    end

    test "envelope に session_id が無ければ reset_session payload に previous_session_id を載せない" do
      agent_id = "sess-reset.no-prev"
      put_agent_with_caps(agent_id, session_id: nil)
      @endpoint.subscribe("runner:sess-reset")
      socket = join_as(:operator)

      ref = push(socket, "session_reset", %{"agent_id" => agent_id, "mode" => "new"})
      assert_reply ref, :ok

      assert_broadcast "reset_session", %{"agent_id" => ^agent_id} = payload
      refute Map.has_key?(payload, "previous_session_id")
    end

    # ADR-0014 F1 追補 (resume-privilege-restoration, 藤 D2 / phase-21+):
    # the reset broadcast must relay the current SessionPointers.snapshot
    # so the runner's applyResumeSnapshot can reapply the last-effective
    # privilege axes to the fresh wrapper (Codex sandbox / network_access、
    # Claude permission_mode). Absent snapshot = no key on the wire.
    test "reset_session payload に SessionPointers.snapshot を resume_snapshot として同梱" do
      agent_id = "sess-reset.snap"
      put_agent_with_caps(agent_id)
      # SessionPointers を seed し snapshot も設定。record が pointer を
      # 作らないと record_snapshot は no-op になる (agent 未登録)。
      :ok = SessionPointers.record(agent_id, "sess-prev", "/w", :claude_code)

      :ok =
        SessionPointers.record_snapshot(agent_id, %{
          "sandbox" => "danger-full-access",
          "network_access" => true,
          "permission_mode" => "bypassPermissions"
        })

      @endpoint.subscribe("runner:sess-reset")
      socket = join_as(:operator)

      ref = push(socket, "session_reset", %{"agent_id" => agent_id, "mode" => "new"})
      assert_reply ref, :ok

      assert_broadcast "reset_session",
                       %{
                         "agent_id" => ^agent_id,
                         "resume_snapshot" => %{
                           "sandbox" => "danger-full-access",
                           "network_access" => true,
                           "permission_mode" => "bypassPermissions"
                         }
                       }
    end

    test "SessionPointers に snapshot が無い agent の reset_session に resume_snapshot は載らない" do
      # AgentId host_id_from/1 は最後の `.<rand>` を落とすので、host_id を
      # `sess-reset` に揃えるため rand は 1 セグメントで書く。
      agent_id = "sess-reset.snapabsent"
      put_agent_with_caps(agent_id)
      # pointer は seed するが snapshot は set しない。
      :ok = SessionPointers.record(agent_id, "sess-prev", "/w", :claude_code)

      @endpoint.subscribe("runner:sess-reset")
      socket = join_as(:operator)

      ref = push(socket, "session_reset", %{"agent_id" => agent_id, "mode" => "new"})
      assert_reply ref, :ok

      assert_broadcast "reset_session", %{"agent_id" => ^agent_id} = payload
      refute Map.has_key?(payload, "resume_snapshot")
    end

    test "viewer は forbidden" do
      agent_id = "sess-reset.viewer"
      put_agent_with_caps(agent_id)
      socket = join_as(:viewer)

      ref = push(socket, "session_reset", %{"agent_id" => agent_id, "mode" => "new"})
      assert_reply ref, :error, %{reason: "forbidden"}
    end

    test "未知 agent は unknown_agent" do
      socket = join_as(:operator)

      ref =
        push(socket, "session_reset", %{"agent_id" => "sess-reset.none", "mode" => "new"})

      assert_reply ref, :error, %{reason: "unknown_agent"}
    end

    test "invalid mode は invalid_mode" do
      agent_id = "sess-reset.bad-mode"
      put_agent_with_caps(agent_id)
      socket = join_as(:operator)

      ref =
        push(socket, "session_reset", %{"agent_id" => agent_id, "mode" => "restart"})

      assert_reply ref, :error, %{reason: "invalid_mode"}
    end

    test "capability 未 stamp (旧 wrapper) は unsupported_session_reset" do
      agent_id = "sess-reset.no-cap"
      put_agent_with_caps(agent_id, supports_session_reset: :absent, session_reset_modes: :absent)
      socket = join_as(:operator)

      ref = push(socket, "session_reset", %{"agent_id" => agent_id, "mode" => "new"})
      assert_reply ref, :error, %{reason: "unsupported_session_reset"}
    end

    test "supports_session_reset=false は unsupported_session_reset" do
      agent_id = "sess-reset.false"
      put_agent_with_caps(agent_id, supports_session_reset: false, session_reset_modes: :absent)
      socket = join_as(:operator)

      ref = push(socket, "session_reset", %{"agent_id" => agent_id, "mode" => "new"})
      assert_reply ref, :error, %{reason: "unsupported_session_reset"}
    end

    test "supports=true + modes に mode 非対応は unsupported_session_reset" do
      agent_id = "sess-reset.mode-off"
      put_agent_with_caps(agent_id, session_reset_modes: ["new"])
      socket = join_as(:operator)

      ref = push(socket, "session_reset", %{"agent_id" => agent_id, "mode" => "clear"})
      assert_reply ref, :error, %{reason: "unsupported_session_reset"}
    end

    test "supports=true + 空 modes は unsupported_session_reset (fail-closed)" do
      agent_id = "sess-reset.empty-modes"
      put_agent_with_caps(agent_id, session_reset_modes: [])
      socket = join_as(:operator)

      ref = push(socket, "session_reset", %{"agent_id" => agent_id, "mode" => "new"})
      assert_reply ref, :error, %{reason: "unsupported_session_reset"}
    end

    test "busy 状態 (thinking) は agent_busy" do
      agent_id = "sess-reset.busy"
      put_agent_with_caps(agent_id, state: "thinking")
      socket = join_as(:operator)

      ref = push(socket, "session_reset", %{"agent_id" => agent_id, "mode" => "new"})
      assert_reply ref, :error, %{reason: "agent_busy"}
    end

    test "既存 pending 中の重複 reset は session_reset_pending" do
      agent_id = "sess-reset.dup"
      put_agent_with_caps(agent_id)
      socket = join_as(:operator)

      ref1 = push(socket, "session_reset", %{"agent_id" => agent_id, "mode" => "new"})
      assert_reply ref1, :ok

      ref2 = push(socket, "session_reset", %{"agent_id" => agent_id, "mode" => "clear"})
      assert_reply ref2, :error, %{reason: "session_reset_pending"}
    end

    test "viewer には session_reset_started が push されない (ADR-0021 fail-closed)" do
      # ADR-0036 F7 broadcast は previous_session_id / to_session_id を
      # 含むため ADR-0021 の allow-list で operator-only。viewer socket
      # は handle_out の role gate で drop され push されない。
      _viewer = join_as(:viewer)

      KaoiroServerWeb.Endpoint.broadcast(
        "agents:lobby",
        "session_reset_started",
        %{
          "request_id" => "rs_gate_st",
          "agent_id" => "gate.st.a",
          "mode" => "new",
          "previous_session_id" => "sess-leak"
        }
      )

      refute_push "session_reset_started", _payload
    end

    test "viewer には session_reset_completed が push されない" do
      _viewer = join_as(:viewer)

      KaoiroServerWeb.Endpoint.broadcast(
        "agents:lobby",
        "session_reset_completed",
        %{
          "request_id" => "rs_gate_ok",
          "agent_id" => "gate.ok.a",
          "mode" => "new",
          "previous_session_id" => "sess-old",
          "to_session_id" => "sess-new"
        }
      )

      refute_push "session_reset_completed", _payload
    end

    test "viewer には session_reset_failed も push されない" do
      _viewer = join_as(:viewer)

      KaoiroServerWeb.Endpoint.broadcast(
        "agents:lobby",
        "session_reset_failed",
        %{
          "request_id" => "rs_gate_ng",
          "agent_id" => "gate.ng.a",
          "mode" => "new",
          "reason" => "spawn_failed"
        }
      )

      refute_push "session_reset_failed", _payload
    end

    test "operator には session_reset_started / _completed / _failed が push される" do
      _operator = join_as(:operator)

      # 3 種を順に発火して operator socket が全て受信することを確認
      # (handle_out の allow-list 内で operator が対象になる pattern)。
      KaoiroServerWeb.Endpoint.broadcast(
        "agents:lobby",
        "session_reset_started",
        %{"request_id" => "op_st", "agent_id" => "op.st.a", "mode" => "new"}
      )

      assert_push "session_reset_started", %{"request_id" => "op_st"}

      KaoiroServerWeb.Endpoint.broadcast(
        "agents:lobby",
        "session_reset_completed",
        %{
          "request_id" => "op_ok",
          "agent_id" => "op.ok.a",
          "mode" => "new",
          "to_session_id" => "sess-new"
        }
      )

      assert_push "session_reset_completed", %{"request_id" => "op_ok"}

      KaoiroServerWeb.Endpoint.broadcast(
        "agents:lobby",
        "session_reset_failed",
        %{
          "request_id" => "op_ng",
          "agent_id" => "op.ng.a",
          "mode" => "new",
          "reason" => "timeout"
        }
      )

      assert_push "session_reset_failed", %{"request_id" => "op_ng"}
    end
  end

  describe "reserved_session_command reject (ADR-0036 F1, phase-17 17-4)" do
    test "exact /new は reserved_session_command で reject" do
      agent_id = "resv.new"
      put_agent(agent_id)
      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:operator)

      ref = push(socket, "instruction", %{"agent_id" => agent_id, "text" => "/new"})

      assert_reply ref, :error, %{reason: "reserved_session_command"}
      refute_broadcast "instruction", _
    end

    test "exact /clear は reserved_session_command で reject" do
      agent_id = "resv.clear"
      put_agent(agent_id)
      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:operator)

      ref = push(socket, "instruction", %{"agent_id" => agent_id, "text" => "/clear"})

      assert_reply ref, :error, %{reason: "reserved_session_command"}
      refute_broadcast "instruction", _
    end

    test "前後の空白付き /new (trim 一致) も reject" do
      agent_id = "resv.trim"
      put_agent(agent_id)
      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:operator)

      ref = push(socket, "instruction", %{"agent_id" => agent_id, "text" => "  /new\n"})

      assert_reply ref, :error, %{reason: "reserved_session_command"}
      refute_broadcast "instruction", _
    end

    test "引数付き /new hello は通常 instruction として relay (通過)" do
      agent_id = "resv.args"
      put_agent(agent_id)
      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:operator)

      ref = push(socket, "instruction", %{"agent_id" => agent_id, "text" => "/new hello"})

      assert_reply ref, :ok
      assert_broadcast "instruction", %{"text" => "/new hello"}
    end

    test "/new + attachment 付きは通常 instruction として relay (通過)" do
      agent_id = "resv.attach"
      put_agent(agent_id)
      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:operator)

      ref =
        push(socket, "instruction", %{
          "agent_id" => agent_id,
          "text" => "/new",
          "attachment_ids" => ["u1"]
        })

      assert_reply ref, :ok
      assert_broadcast "instruction", %{"text" => "/new"}
    end
  end

  describe "reset-pending 中の instruction / model / effort / permission ガード (ADR-0036 F6, phase-17 17-4)" do
    defp acquire_reset_lock(agent_id) do
      # capability + idle + session_id を持つ envelope で put して直接 lock を握らせる。
      # AgentStates 上の state と session_id を SessionResets へ渡す形。
      :ok =
        AgentStates.put(%{
          "version" => "0",
          "agent_id" => agent_id,
          "ts" => "2026-07-12T00:00:00Z",
          "type" => "state_change",
          "state" => "idle",
          "session_id" => "sess-prev",
          "ext" => %{
            "session_capabilities" => %{
              "supports_attachments" => true,
              "supports_user_input_dialog" => true,
              "supports_session_reset" => true,
              "session_reset_modes" => ["new", "clear"]
            }
          }
        })

      {:ok, _rid, _prev} =
        KaoiroServer.SessionResets.check_and_acquire(
          agent_id,
          "new",
          "idle",
          "sess-prev"
        )

      :ok
    end

    test "pending 中の instruction は session_reset_pending で reject" do
      agent_id = "gp.instr"
      acquire_reset_lock(agent_id)
      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:operator)

      ref = push(socket, "instruction", %{"agent_id" => agent_id, "text" => "hi"})

      assert_reply ref, :error, %{reason: "session_reset_pending"}
      refute_broadcast "instruction", _

      # cleanup for next test
      _ = KaoiroServer.SessionResets.delete(agent_id)
    end

    test "pending 中の set_model は session_reset_pending で reject" do
      agent_id = "gp.model"
      acquire_reset_lock(agent_id)
      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:operator)

      ref = push(socket, "set_model", %{"agent_id" => agent_id, "model" => "m"})

      assert_reply ref, :error, %{reason: "session_reset_pending"}
      refute_broadcast "set_model", _

      _ = KaoiroServer.SessionResets.delete(agent_id)
    end

    test "pending 中の refresh_models は session_reset_pending で reject" do
      agent_id = "gp.refresh"
      acquire_reset_lock(agent_id)
      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:operator)

      ref = push(socket, "refresh_models", %{"agent_id" => agent_id})

      assert_reply ref, :error, %{reason: "session_reset_pending"}
      refute_broadcast "refresh_models", _

      _ = KaoiroServer.SessionResets.delete(agent_id)
    end

    test "pending 中の resume_session (switch_session 経路) は session_reset_pending で reject (17-11: 15-8 Finding 2 同型穴の phase-17 版)" do
      # ADR-0036 F2 (2026-07-12 ε 追補): reset の pending lock 中に
      # resume_session が素通りすると kill 中の agent に別 session_id
      # への retarget が発火して race で fresh 経路と衝突する。session
      # lifecycle は SessionResets の pending lock で単一制御。
      agent_id = "gp.resume"
      acquire_reset_lock(agent_id)
      @endpoint.subscribe("runner:gp")
      socket = join_as(:operator)

      ref =
        push(socket, "resume_session", %{
          "agent_id" => agent_id,
          "session_id" => "11111111-2222-3333-4444-555555555555"
        })

      assert_reply ref, :error, %{reason: "session_reset_pending"}
      refute_broadcast "switch_session", _

      _ = KaoiroServer.SessionResets.delete(agent_id)
    end

    test "pending 中の set_effort は session_reset_pending で reject" do
      agent_id = "gp.effort"
      acquire_reset_lock(agent_id)
      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:operator)

      ref = push(socket, "set_effort", %{"agent_id" => agent_id, "effort" => "max"})

      assert_reply ref, :error, %{reason: "session_reset_pending"}
      refute_broadcast "set_effort", _

      _ = KaoiroServer.SessionResets.delete(agent_id)
    end

    test "pending 中の set_permission_mode は session_reset_pending で reject" do
      agent_id = "gp.perm"
      acquire_reset_lock(agent_id)
      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:operator)

      ref =
        push(socket, "set_permission_mode", %{"agent_id" => agent_id, "mode" => "plan"})

      assert_reply ref, :error, %{reason: "session_reset_pending"}
      refute_broadcast "set_permission_mode", _

      _ = KaoiroServer.SessionResets.delete(agent_id)
    end
  end
end
