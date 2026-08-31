defmodule KaoiroServerWeb.AgentsChannelTest do
  use KaoiroServerWeb.ChannelCase, async: false

  import ExUnit.CaptureLog
  import KaoiroServer.TestTeardown

  alias KaoiroServer.AgentDirectory
  alias KaoiroServer.AgentStates
  alias KaoiroServer.ClearWatermarks
  alias KaoiroServer.ConversationStates
  alias KaoiroServer.DeliveryStates
  alias KaoiroServer.HostRegistry
  alias KaoiroServer.PlannedDisconnects
  alias KaoiroServer.SessionLifecycleEvents
  alias KaoiroServer.SessionPointers
  alias KaoiroServer.TaskStates
  alias KaoiroServer.TokenDenylist
  alias KaoiroServer.TransportLimits
  alias KaoiroServerWeb.AgentsChannel
  alias KaoiroServerWeb.PeerConnectivity

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

  # issue #266: `assert_reply` for a SUCCESSFUL `delete_agent` (not an
  # early-rejected one — `not_disconnected`/`forbidden`/`unknown_agent`
  # return before any of this) waits on a reply that only follows FOUR
  # independent, directly-executed fsync-gated DETS writes (TokenDenylist
  # + ClearWatermarks + SessionStarts + DeliveryStates, each `GenServer.call`
  # + `:dets.sync/1` before its own reply -- see `purge_agent_records` in
  # agents_channel.ex). Measured directly (instrumented timing, reverted
  # before commit): under a 2-core CPU restriction (approximating a shared
  # CI runner) this chain alone took 30-40ms, no other single test failure
  # observed in 17 repeated runs at the exact CI-captured seed/max_cases.
  # ExUnit's default `assert_receive_timeout` (100ms, unconfigured in this
  # project) leaves little headroom against that baseline once a shared
  # runner's real disk I/O degrades further -- this is the OSS-release-wave
  # flaky capture from issue #266 (GitHub Actions run 33306440623, seed
  # 225358). Not a race to fix -- delete_agent's real, measured cost against
  # a timeout that assumed it would be fast.
  @purge_reply_timeout 500

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

  # The operator gate re-resolves the role from the credential (#158), so
  # a test socket carries the same three assigns ClientSocket.connect/3
  # stamps: role snapshot, credential, and the credential-derived id the
  # force-disconnect broadcast targets.
  setup do
    Application.put_env(
      :kaoiro_server,
      :client_tokens,
      "tok-operator:operator,tok-viewer:viewer,tok-admin:admin"
    )

    on_exit(fn -> Application.delete_env(:kaoiro_server, :client_tokens) end)
  end

  defp join_as(role) do
    {:ok, _reply, socket} =
      KaoiroServerWeb.ClientSocket
      |> socket(nil, client_assigns(role))
      |> subscribe_and_join(KaoiroServerWeb.AgentsChannel, "agents:lobby")

    socket
  end

  defp encoded_frame_bytes(message) do
    {:socket_push, :text, encoded} = Phoenix.Socket.V2.JSONSerializer.encode!(message)
    IO.iodata_length(encoded)
  end

  defp client_assigns(role) do
    token = "tok-#{role}"
    fingerprint = KaoiroServer.Auth.socket_id(token)

    # ClientSocket.connect/3 と同じく raw token ではなく fingerprint を
    # 持つ (ふじ must-fix A)。
    %{
      role: role,
      credential: {:token_fingerprint, fingerprint},
      socket_id: fingerprint
    }
  end

  defp wait_until_clear_workflow(predicate, attempts \\ 50) do
    cond do
      predicate.() -> :ok
      attempts <= 0 -> :timeout
      true -> Process.sleep(5) && wait_until_clear_workflow(predicate, attempts - 1)
    end
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

  test "wire projection の省略は join snapshot で snapshot_incomplete として観測できる" do
    owner = self()

    agent_ids =
      for n <- 1..201 do
        "test.snapshot-incomplete-#{String.pad_leading(Integer.to_string(n), 3, "0")}"
      end

    on_exit(fn ->
      Enum.each(agent_ids, fn agent_id ->
        case AgentStates.disconnect(agent_id, owner, "2026-08-28T00:00:00Z") do
          {:ok, _} -> AgentStates.delete(agent_id)
          :noop -> :ok
        end
      end)
    end)

    for agent_id <- agent_ids do
      :ok =
        AgentStates.put(
          %{
            "version" => "0",
            "agent_id" => agent_id,
            "ts" => "2026-08-28T00:00:00Z",
            "type" => "state_change",
            "state" => "waiting_input"
          },
          owner: owner
        )
    end

    _socket = join_as(:operator)

    assert_push "snapshot", %{"agents" => agents, "snapshot_incomplete" => true}
    assert map_size(agents) == 200
  end

  test "join の3 snapshot frame は各 store を上限まで満たしても production serializer の bound 内に収まる" do
    owner = self()

    agent_ids =
      for n <- 1..TransportLimits.wire_projection_agents() do
        "test.snapshot-frame-#{String.pad_leading(Integer.to_string(n), 3, "0")}"
      end

    task_agent_id = hd(agent_ids)

    on_exit(fn ->
      Enum.each(agent_ids, fn agent_id ->
        TaskStates.discard_for_agent(agent_id)
        DeliveryStates.delete(agent_id)

        case AgentStates.disconnect(agent_id, owner, "2026-08-28T00:00:00Z") do
          {:ok, _} -> AgentStates.delete(agent_id)
          :noop -> :ok
        end
      end)
    end)

    for agent_id <- agent_ids do
      assert :ok =
               AgentStates.put(
                 %{
                   "version" => "0",
                   "agent_id" => agent_id,
                   "ts" => "2026-08-28T00:00:00Z",
                   "type" => "state_change",
                   "state" => "waiting_input",
                   "payload" => %{"text" => String.duplicate("a", 4_000)}
                 },
                 owner: owner
               )

      assert %{issued_seq: 0} =
               DeliveryStates.bind(agent_id, "snapshot-bound-generation-#{agent_id}")
    end

    task_base = %{
      "version" => "0",
      "agent_id" => task_agent_id,
      "ts" => "2026-08-28T00:00:00Z",
      "type" => "task",
      "state" => "idle",
      "payload" => %{
        "kind" => "started",
        "agent_id" => task_agent_id,
        "task_id" => "near-frame-bound",
        "task_type" => "local_agent",
        "status" => "running",
        "summary" => ""
      }
    }

    task_target_bytes = TaskStates.snapshot_byte_budget() - 4_096

    task =
      put_in(
        task_base,
        ["payload", "summary"],
        String.duplicate("t", task_target_bytes - byte_size(Jason.encode!(task_base)))
      )

    assert :ok = TaskStates.put(task)

    _socket = join_as(:operator)

    for event <- ~w(snapshot task_snapshot delivery_snapshot) do
      assert_receive %Phoenix.Socket.Message{event: ^event} = message
      assert encoded_frame_bytes(message) <= TransportLimits.max_frame_bytes()
    end
  end

  test "delivery snapshot の省略は incomplete marker で観測できる" do
    agent_ids =
      for n <- 1..(TransportLimits.wire_projection_agents() + 1) do
        "test.delivery-snapshot-incomplete-#{String.pad_leading(Integer.to_string(n), 3, "0")}"
      end

    on_exit(fn -> Enum.each(agent_ids, &DeliveryStates.delete/1) end)

    for agent_id <- agent_ids do
      assert %{issued_seq: 0} =
               DeliveryStates.bind(agent_id, "delivery-snapshot-generation-#{agent_id}")
    end

    _socket = join_as(:operator)

    assert_push "delivery_snapshot", %{
      "deliveries" => deliveries,
      "snapshot_incomplete" => true
    }

    assert map_size(deliveries) == TransportLimits.wire_projection_agents()
  end

  test "delivery_status の live 診断は operator にだけ届く" do
    _operator_socket = join_as(:operator)
    assert_push "snapshot", %{"agents" => _}

    _viewer_socket = join_as(:viewer)
    assert_push "snapshot", %{"agents" => _}

    KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "delivery_status", %{
      "agent_id" => "test.delivery-operator-only",
      "delivery" => %{
        "issued_seq" => 3,
        "acked_seq" => 2,
        "pending_since" => "2026-08-17T00:00:00Z"
      }
    })

    assert_push "delivery_status", %{
      "agent_id" => "test.delivery-operator-only",
      "delivery" => %{"issued_seq" => 3}
    }

    refute_push "delivery_status", %{}
  end

  # connect 時の role は snapshot にすぎない (#158)。許可リスト/トークン
  # 側の降格が、接続しっぱなしの socket に効くことを pin する。
  describe "operator gate の role 再解決 (#158)" do
    test "降格した operator の操作は forbidden になり socket が切られる" do
      agent_id = "test.demote-1"
      put_agent(agent_id)
      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}
      @endpoint.subscribe(KaoiroServer.Auth.socket_id("tok-operator"))

      # 稼働中に role を落とす (許可リスト行の編集に相当)。
      Application.put_env(:kaoiro_server, :client_tokens, "tok-operator:viewer")

      ref =
        push(socket, "instruction", %{"agent_id" => agent_id, "text" => "x"})

      assert_reply ref, :error, %{reason: "forbidden"}

      # handle_out の operator 限定 fan-out は snapshot を見続けるので、
      # 判定不一致を検知した時点で張り直させる。
      assert_receive %Phoenix.Socket.Broadcast{event: "disconnect"}
    end

    test "credential ごと無効化された socket も forbidden + 切断" do
      agent_id = "test.demote-2"
      put_agent(agent_id)
      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}
      @endpoint.subscribe(KaoiroServer.Auth.socket_id("tok-operator"))

      Application.put_env(:kaoiro_server, :client_tokens, "tok-other:operator")

      ref =
        push(socket, "instruction", %{"agent_id" => agent_id, "text" => "x"})

      assert_reply ref, :error, %{reason: "forbidden"}
      assert_receive %Phoenix.Socket.Broadcast{event: "disconnect"}
    end

    test "role が変わっていなければ切断しない" do
      agent_id = "test.demote-3"
      put_agent(agent_id)
      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}
      @endpoint.subscribe(KaoiroServer.Auth.socket_id("tok-operator"))

      ref =
        push(socket, "instruction", %{"agent_id" => agent_id, "text" => "x"})

      assert_reply ref, :ok
      refute_receive %Phoenix.Socket.Broadcast{event: "disconnect"}, 50
    end

    test "昇格も張り直しの対象 (fan-out を新しい role で組み直す)" do
      agent_id = "test.demote-4"
      put_agent(agent_id)
      socket = join_as(:viewer)
      assert_push "snapshot", %{"agents" => _}
      @endpoint.subscribe(KaoiroServer.Auth.socket_id("tok-viewer"))

      Application.put_env(:kaoiro_server, :client_tokens, "tok-viewer:operator")

      ref =
        push(socket, "instruction", %{"agent_id" => agent_id, "text" => "x"})

      assert_reply ref, :ok
      assert_receive %Phoenix.Socket.Broadcast{event: "disconnect"}
    end

    test "OAuth 許可リストの降格が稼働中 socket に効く (ADR-0042)" do
      agent_id = "test.demote-oauth"
      put_agent(agent_id)

      on_exit(fn ->
        Application.delete_env(:kaoiro_server, :oauth_allowlist_path)
      end)

      KaoiroServer.OAuthAllowlistFixture.put_allowlist("github:ao:operator\n")
      socket_id = KaoiroServer.Auth.oauth_socket_id("github", "ao")

      {:ok, _reply, socket} =
        KaoiroServerWeb.ClientSocket
        |> socket(nil, %{
          role: :operator,
          credential: {:oauth, %{provider: "github", uid: "ao"}},
          socket_id: socket_id
        })
        |> subscribe_and_join(KaoiroServerWeb.AgentsChannel, "agents:lobby")

      assert_push "snapshot", %{"agents" => _}
      @endpoint.subscribe(socket_id)

      KaoiroServer.OAuthAllowlistFixture.put_allowlist("github:ao:viewer\n")

      ref =
        push(socket, "instruction", %{"agent_id" => agent_id, "text" => "x"})

      assert_reply ref, :error, %{reason: "forbidden"}
      assert_receive %Phoenix.Socket.Broadcast{event: "disconnect"}
    end

    # issue #170 must-fix 2 (ふじ): connect と join の間で許可リストが
    # 変わった socket は、一度も operator 操作をしなくても join 時点で
    # 弾かれる。OAuthAllowlistWatcher の disconnect は connect 直後の
    # transport-subscribe race を取りこぼしうるので(watcher の
    # checkpoint はそのまま新しい内容へ進んでしまい、同じ diff は二度と
    # 出ない)、join/3 自体の再検証が最後の砦になる。
    test "stale operator snapshot を持つ socket は join 前再検証で拒否され、operator payload を一切 push しない" do
      on_exit(fn -> Application.delete_env(:kaoiro_server, :oauth_allowlist_path) end)

      KaoiroServer.OAuthAllowlistFixture.put_allowlist("github:ao:operator\n")
      socket_id = KaoiroServer.Auth.oauth_socket_id("github", "ao")
      @endpoint.subscribe(socket_id)

      # connect/3 が :operator を解決した後、join より前に降格が起きた
      # 状況を模す(connect を経由しないテスト構築なので、assigns に
      # そのまま古い snapshot を持たせて join する)。
      KaoiroServer.OAuthAllowlistFixture.put_allowlist("github:ao:viewer\n")

      result =
        KaoiroServerWeb.ClientSocket
        |> socket(nil, %{
          role: :operator,
          credential: {:oauth, %{provider: "github", uid: "ao"}},
          socket_id: socket_id
        })
        |> subscribe_and_join(KaoiroServerWeb.AgentsChannel, "agents:lobby")

      assert {:error, %{reason: "forbidden"}} = result
      assert_receive %Phoenix.Socket.Broadcast{event: "disconnect"}
      refute_push "snapshot", %{"agents" => _}
      refute_push "history", %{}
    end

    test "role が変わっていない socket は通常どおり join できる" do
      _socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}
      assert_push "history", %{}
    end
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
      assert payload["version"] == "0"
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
      AgentDirectory.record(agent_id, @ao["id"], @ao["name"])
      SessionPointers.record(agent_id, "sess-del-1", "/home/user/proj")
      KaoiroServer.PermissionModes.record(agent_id, "plan")

      :ok =
        ClearWatermarks.record(
          agent_id,
          {System.system_time(:microsecond), System.unique_integer([:positive, :monotonic])},
          "2026-07-23T10:00:00Z"
        )

      _ = seed_ia(durable_inter_agent_envelope(agent_id, "test.del-peer", 1))
      # seed_ia seeds a live entry for each pane; delete_agent only accepts
      # a disconnected one, so restore the state this test is about.
      put_disconnected(agent_id)
      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      ref = push(socket, "delete_agent", %{"agent_id" => agent_id})

      assert_reply ref, :ok, %{}, @purge_reply_timeout
      assert_broadcast "agent_deleted", %{"agent_id" => ^agent_id}
      refute AgentStates.known?(agent_id)
      assert AgentDirectory.get(agent_id) == nil
      assert SessionPointers.get(agent_id) == nil
      # PermissionModes.record は cast なので poll
      _ = KaoiroServer.PermissionModes.all()
      assert KaoiroServer.PermissionModes.get(agent_id) == nil
      # issue #109: ClearWatermarks も一緒に purge される (agent が消えた後に
      # 同名 agent_id で再 spawn されても過去の hide-past filter を引きずらない)。
      _ = ClearWatermarks.all()
      assert ClearWatermarks.get(agent_id) == nil
      # issue #72: delete_agent は auto-revoke で TokenDenylist に永続投入
      # される。restore は明示 UI からのみ (delete_agent 経路では戻さない)、
      # なので同名 agent_id での token 復活は起こらない。
      on_exit(fn -> TokenDenylist.restore(agent_id) end)
      _ = TokenDenylist.all()
      assert TokenDenylist.revoked?(agent_id) == true
      # ADR-0051 D3-5: there is no IA ledger left to purge. The deleted
      # agent's own pane went with its AgentStates entry; the peer keeps
      # its own copy, which is that peer's display to show.
      refute Map.has_key?(AgentStates.ia_projection(), agent_id)
      assert [{_stamp, _ia}] = AgentStates.ia_projection()["test.del-peer"]
    end

    test "AgentStates 不在の directory-only entry も削除できる (ADR-0030 D6)" do
      # server 再起動起因のケース: 台帳と pointer だけ残っており live entry は無い。
      # 「復元できない agent」を operator が明示削除する経路。
      agent_id = "test.del-directory-only"
      AgentDirectory.record(agent_id, @ao["id"], @ao["name"])
      SessionPointers.record(agent_id, "sess-del-do", "/home/user/proj")
      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      ref = push(socket, "delete_agent", %{"agent_id" => agent_id})

      assert_reply ref, :ok, %{}, @purge_reply_timeout
      assert_broadcast "agent_deleted", %{"agent_id" => ^agent_id}
      assert AgentDirectory.get(agent_id) == nil
      assert SessionPointers.get(agent_id) == nil
    end

    test "delete_agent は active intent の bounce-only target を terminal disconnected で閉じる" do
      agent_id = "test.del-planned"
      peer_id = "test.del-planned-peer"
      cid = "cnv-del-planned-bounce"
      put_disconnected(agent_id)
      on_exit(fn -> TokenDenylist.restore(agent_id) end)
      assert :ok = PlannedDisconnects.begin(agent_id, "transition-delete", :restart)
      assert {:tracked, _} = PlannedDisconnects.track_bounce(agent_id, cid, peer_id)
      @endpoint.subscribe("wrapper:" <> peer_id)
      socket = join_as(:operator)

      ref = push(socket, "delete_agent", %{"agent_id" => agent_id})
      assert_reply ref, :ok, %{}, @purge_reply_timeout

      assert_received %Phoenix.Socket.Broadcast{
        topic: "wrapper:" <> ^peer_id,
        payload: %{
          "payload" => %{
            "conversation_id" => ^cid,
            "error" => %{"code" => "disconnected"}
          }
        }
      }

      assert_broadcast "agent_deleted", %{"agent_id" => ^agent_id}
      refute PlannedDisconnects.active?(agent_id)
    end

    test "delete_agent は planned bounce と ordinary conversation を各一度 terminal 通知する" do
      agent_id = "test.del-planned-union"
      bounce_peer_id = "test.del-planned-union-bounce"
      ordinary_peer_id = "test.del-planned-union-ordinary"
      bounce_cid = "cnv-del-planned-union-bounce"
      ordinary_cid = "cnv-del-planned-union-ordinary"

      assert :ok =
               ConversationStates.record_message(
                 bounce_cid,
                 agent_id,
                 bounce_peer_id,
                 "bounce",
                 1,
                 false,
                 true
               )

      assert :ok =
               ConversationStates.record_message(
                 ordinary_cid,
                 agent_id,
                 ordinary_peer_id,
                 "ordinary",
                 1,
                 false,
                 true
               )

      assert :ok = PlannedDisconnects.begin(agent_id, "transition-delete-union", :restart)

      assert {:tracked, _} =
               PlannedDisconnects.track_bounce(agent_id, bounce_cid, bounce_peer_id)

      @endpoint.subscribe("wrapper:" <> bounce_peer_id)
      @endpoint.subscribe("wrapper:" <> ordinary_peer_id)
      assert :disconnected = PeerConnectivity.delete(agent_id)

      for {peer_id, cid} <-
            [{bounce_peer_id, bounce_cid}, {ordinary_peer_id, ordinary_cid}] do
        assert_received %Phoenix.Socket.Broadcast{
          topic: "wrapper:" <> ^peer_id,
          payload: %{
            "payload" => %{
              "conversation_id" => ^cid,
              "error" => %{"code" => "disconnected"}
            }
          }
        }

        refute_received %Phoenix.Socket.Broadcast{
          topic: "wrapper:" <> ^peer_id,
          payload: %{"payload" => %{"conversation_id" => ^cid}}
        }
      end

      assert {[], 0} = ConversationStates.claim_unreachable_targets(agent_id, 50)
    end

    test "delete_agent の tracked 50 件は ordinary terminal claim の枠を残さない" do
      agent_id = "test.del-planned-cap-full"
      ordinary_peer_id = "test.del-planned-cap-full-ordinary"
      ordinary_cid = "cnv-del-planned-cap-full-ordinary"

      assert :ok =
               ConversationStates.record_message(
                 ordinary_cid,
                 agent_id,
                 ordinary_peer_id,
                 "ordinary",
                 1,
                 false,
                 true
               )

      assert :ok = PlannedDisconnects.begin(agent_id, "transition-delete-cap-full", :restart)

      for n <- 1..50 do
        assert {:tracked, _} =
                 PlannedDisconnects.track_bounce(
                   agent_id,
                   "cnv-del-planned-cap-full-bounce-#{n}",
                   "test.del-planned-cap-full-bounce-#{n}"
                 )
      end

      @endpoint.subscribe("wrapper:" <> ordinary_peer_id)
      assert :disconnected = PeerConnectivity.delete(agent_id)

      refute_received %Phoenix.Socket.Broadcast{
        topic: "wrapper:" <> ^ordinary_peer_id,
        payload: %{"payload" => %{"conversation_id" => ^ordinary_cid}}
      }

      assert {[{^ordinary_cid, [^ordinary_peer_id]}], 0} =
               ConversationStates.claim_unreachable_targets(agent_id, 50)
    end

    test "delete_agent の tracked n 件は ordinary 50-n 件だけ claim する" do
      agent_id = "test.del-planned-cap-remainder"

      assert :ok = PlannedDisconnects.begin(agent_id, "transition-delete-cap-remainder", :restart)

      for n <- 1..2 do
        assert {:tracked, _} =
                 PlannedDisconnects.track_bounce(
                   agent_id,
                   "cnv-del-planned-cap-remainder-bounce-#{n}",
                   "test.del-planned-cap-remainder-bounce-#{n}"
                 )
      end

      for n <- 1..50 do
        assert :ok =
                 ConversationStates.record_message(
                   "cnv-del-planned-cap-remainder-ordinary-#{n}",
                   agent_id,
                   "test.del-planned-cap-remainder-ordinary-#{n}",
                   "ordinary",
                   1,
                   false,
                   true
                 )
      end

      assert :disconnected = PeerConnectivity.delete(agent_id)

      assert {remaining, 0} = ConversationStates.claim_unreachable_targets(agent_id, 50)
      assert length(remaining) == 2
    end

    test "delete_agent の残 cap は peer 数でなく tracked conversation 数から引く" do
      agent_id = "test.del-planned-cap-three-party"
      first_peer_id = "test.del-planned-cap-three-party-first"
      second_peer_id = "test.del-planned-cap-three-party-second"
      tracked_cid = "cnv-del-planned-cap-three-party-tracked"

      assert :ok =
               PlannedDisconnects.begin(agent_id, "transition-delete-cap-three-party", :restart)

      for peer_id <- [first_peer_id, second_peer_id] do
        assert {:tracked, _} = PlannedDisconnects.track_bounce(agent_id, tracked_cid, peer_id)
      end

      for n <- 1..50 do
        assert :ok =
                 ConversationStates.record_message(
                   "cnv-del-planned-cap-three-party-ordinary-#{n}",
                   agent_id,
                   "test.del-planned-cap-three-party-ordinary-#{n}",
                   "ordinary",
                   1,
                   false,
                   true
                 )
      end

      assert :disconnected = PeerConnectivity.delete(agent_id)

      assert {remaining, 0} = ConversationStates.claim_unreachable_targets(agent_id, 50)
      assert length(remaining) == 1
    end

    test "delete_agent は intent 無しなら terminal notice を出さない" do
      agent_id = "test.del-without-intent"
      peer_id = "test.del-without-intent-peer"
      cid = "cnv-del-without-intent"

      assert :ok =
               ConversationStates.record_message(
                 cid,
                 agent_id,
                 peer_id,
                 "ordinary",
                 1,
                 false,
                 true
               )

      @endpoint.subscribe("wrapper:" <> peer_id)
      assert :noop = PeerConnectivity.delete(agent_id)

      refute_received %Phoenix.Socket.Broadcast{
        topic: "wrapper:" <> ^peer_id,
        payload: %{"payload" => %{"conversation_id" => ^cid}}
      }

      assert {[{^cid, [^peer_id]}], 0} =
               ConversationStates.claim_unreachable_targets(agent_id, 50)
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

    # ふじ R1 must-fix (2026-07-23): live reject 時、revoke と revoked
    # broadcast は一切走らない (以前は purge_agent_records の内側で live
    # を検知していたので、拒否 reply の時点で token 恒久 revoke + live
    # 切断が済んでいた regression の pin)。
    test "live agent 拒否時は revoke も revoked broadcast も走らない (R1 side-effect pin)" do
      agent_id = "test.del-live-noop"
      put_agent(agent_id)
      on_exit(fn -> TokenDenylist.restore(agent_id) end)

      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      ref = push(socket, "delete_agent", %{"agent_id" => agent_id})
      assert_reply ref, :error, %{reason: "not_disconnected"}

      # denylist 反映を待って照合 — DETS write 経路と同じ GenServer.call
      # を通すことで in-flight があれば必ず観測できる。
      _ = TokenDenylist.all()
      assert TokenDenylist.revoked?(agent_id) == false

      # broadcast 到達を短い timeout で refute (Phoenix.PubSub は同期的に
      # ローカル配送するので、即時 refute で十分観測できる)。
      refute_broadcast "revoked", %{}, 100
      refute_broadcast "agent_deleted", %{"agent_id" => ^agent_id}, 100

      # agent state は無変化。
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

    # M3 (ふじ #72 must-fix, 2026-07-23): purge_agent_records の
    # 順序線形化を pin する。revoke + fsync が最初、次に revoked
    # broadcast (live channel の force disconnect)、そのあと store
    # purge。この順序でなければ revoke 失敗時に「token 有効なのに
    # directory 消失」や race rejoin が起こる。
    test "delete_agent は revoke → broadcast → purge の順で走る (M3 順序 pin)" do
      agent_id = "test.del-order-1"
      put_disconnected(agent_id)
      AgentDirectory.record(agent_id, @ao["id"], @ao["name"])
      on_exit(fn -> TokenDenylist.restore(agent_id) end)

      # wrapper:<id> topic を subscribe して broadcast を捕捉。
      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      ref = push(socket, "delete_agent", %{"agent_id" => agent_id})
      assert_reply ref, :ok, %{}, @purge_reply_timeout

      # order pin: revoke が store purge より先に走っているので、
      # broadcast + revoked? が :ok reply の時点で確定している。
      _ = TokenDenylist.all()
      assert TokenDenylist.revoked?(agent_id) == true

      # revoked broadcast reason="agent_deleted" が飛ぶ (revoke_wrapper_token
      # と同じ topic だが reason で区別できる、監査用)。
      assert_broadcast "revoked", %{
        "reason" => "agent_deleted",
        "revoked_at" => _
      }

      assert_broadcast "agent_deleted", %{"agent_id" => ^agent_id}
      refute AgentStates.known?(agent_id)
      assert AgentDirectory.get(agent_id) == nil
    end

    test "delete_agent 直後に revoked token で rejoin を試みても拒否される (rejoin race pin)" do
      # M3 must-fix: 順序線形化のおかげで、broadcast が store purge
      # より先に走るので、broadcast 到達 → 拒否まで denylist が有効。
      # rejoin 試行は Auth.authorize_wrapper の denylist gate で unauthorized。
      agent_id = "test.del-order-2"
      put_disconnected(agent_id)
      AgentDirectory.record(agent_id, @ao["id"], @ao["name"])
      on_exit(fn -> TokenDenylist.restore(agent_id) end)
      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      ref = push(socket, "delete_agent", %{"agent_id" => agent_id})
      assert_reply ref, :ok, %{}, @purge_reply_timeout

      # 削除直後、pre-revoke に mint された token を用いて再 join を試行
      # → denylist gate で unauthorized。
      token = KaoiroServer.Auth.mint_wrapper_token(agent_id)

      assert {:error, :unauthorized} =
               KaoiroServer.Auth.authorize_wrapper(agent_id, token)
    end
  end

  describe "revoke_wrapper_token (issue #72)" do
    test "operator の revoke は TokenDenylist を投入し wrapper:<id> へ revoked を broadcast" do
      agent_id = "test.revoke-1"

      # live agent (稼働中でも revoke できる — 進行中の compromise を切る用途)。
      put_agent(agent_id)
      on_exit(fn -> TokenDenylist.restore(agent_id) end)

      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      ref = push(socket, "revoke_wrapper_token", %{"agent_id" => agent_id})

      assert_reply ref, :ok, %{"revoked_at" => revoked_at}
      assert is_binary(revoked_at)
      # DETS 反映を待ってから照合。
      _ = TokenDenylist.all()
      assert TokenDenylist.revoked?(agent_id) == true

      assert_broadcast "revoked", %{
        "reason" => "operator_revoke",
        "revoked_at" => ^revoked_at
      }
    end

    test "disconnected agent の revoke も通る (再接続を封じる恒久対策)" do
      agent_id = "test.revoke-dc"
      put_disconnected(agent_id)
      AgentDirectory.record(agent_id, @ao["id"], @ao["name"])
      _ = AgentDirectory.get(agent_id)
      on_exit(fn -> TokenDenylist.restore(agent_id) end)

      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      ref = push(socket, "revoke_wrapper_token", %{"agent_id" => agent_id})

      assert_reply ref, :ok, %{}
      _ = TokenDenylist.all()
      assert TokenDenylist.revoked?(agent_id) == true
    end

    test "viewer の revoke は forbidden" do
      agent_id = "test.revoke-viewer"
      put_agent(agent_id)
      socket = join_as(:viewer)
      assert_push "snapshot", %{"agents" => _}

      ref = push(socket, "revoke_wrapper_token", %{"agent_id" => agent_id})
      assert_reply ref, :error, %{reason: "forbidden"}
      # denylist にも入らない (副作用なし)。
      _ = TokenDenylist.all()
      refute TokenDenylist.revoked?(agent_id)
    end

    test "未知 agent の revoke は unknown_agent" do
      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      ref =
        push(socket, "revoke_wrapper_token", %{"agent_id" => "test.revoke-none"})

      assert_reply ref, :error, %{reason: "unknown_agent"}
    end
  end

  describe "rename_agent (issue #197 段階3, D12)" do
    test "live agent を rename でき、AgentDirectory が更新され wrapper へ persona_sync が relay される" do
      agent_id = "test.rename-1"
      put_agent(agent_id)
      AgentDirectory.record(agent_id, @ao["id"], @ao["name"])

      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      ref = push(socket, "rename_agent", %{"agent_id" => agent_id, "name" => "あお(改名)"})

      # issue #219 D23: reply vocabulary is display_name, no persona key.
      # revision 2 (not 1): AgentDirectory.record/4's baseline is
      # @initial_revision = 1 (issue #219 MF-2), so the first rename bumps
      # a freshly-recorded entry from 1 to 2.
      assert_reply ref, :ok, %{"display_name" => "あお(改名)", "revision" => 2}

      # issue #219 D22: DUAL-emit at the same revision — legacy
      # `persona_sync` (old wrapper builds) and new `display_name_sync`
      # (new wrapper builds), both version-stamped (ADR-0015, issue #197
      # 段階3 ふじ MF-1 レビュー指摘).
      assert_broadcast "persona_sync", %{"version" => "0", "name" => "あお(改名)", "revision" => 2}

      assert_broadcast "display_name_sync", %{
        "version" => "0",
        "display_name" => "あお(改名)",
        "revision" => 2
      }

      assert %{display_name: "あお(改名)", revision: 2, persona_id: "ao"} =
               AgentDirectory.get(agent_id)
    end

    test "disconnected agent も rename できる (wrapper 不在でも relay broadcast 自体は行う)" do
      agent_id = "test.rename-dc"
      put_disconnected(agent_id)
      AgentDirectory.record(agent_id, @ao["id"], @ao["name"])

      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      ref = push(socket, "rename_agent", %{"agent_id" => agent_id, "name" => "オフライン改名"})

      # revision 2: baseline is @initial_revision = 1 (issue #219 MF-2).
      assert_reply ref, :ok, %{"revision" => 2}
      assert %{display_name: "オフライン改名"} = AgentDirectory.get(agent_id)
    end

    test "2 回 rename すると revision が単調に進み、最新の name だけが残る" do
      agent_id = "test.rename-twice"
      put_agent(agent_id)
      AgentDirectory.record(agent_id, @ao["id"], @ao["name"])
      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      # baseline @initial_revision = 1 (issue #219 MF-2), so 2 renames land
      # at 2 then 3, not 1 then 2.
      ref1 = push(socket, "rename_agent", %{"agent_id" => agent_id, "name" => "一回目"})
      assert_reply ref1, :ok, %{"revision" => 2}

      ref2 = push(socket, "rename_agent", %{"agent_id" => agent_id, "name" => "二回目"})
      assert_reply ref2, :ok, %{"revision" => 3}

      assert %{display_name: "二回目", revision: 3} = AgentDirectory.get(agent_id)
    end

    test "viewer の rename は forbidden、AgentDirectory は無変化" do
      agent_id = "test.rename-viewer"
      put_agent(agent_id)
      AgentDirectory.record(agent_id, @ao["id"], @ao["name"])
      socket = join_as(:viewer)
      assert_push "snapshot", %{"agents" => _}

      ref = push(socket, "rename_agent", %{"agent_id" => agent_id, "name" => "乗っ取り"})

      assert_reply ref, :error, %{reason: "forbidden"}
      # revision 1: fresh-record baseline @initial_revision (issue #219
      # MF-2), unchanged since the rejected rename never mutates it.
      assert %{display_name: "あお", revision: 1} = AgentDirectory.get(agent_id)
    end

    test "未知 agent は unknown_agent" do
      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      ref = push(socket, "rename_agent", %{"agent_id" => "test.rename-none", "name" => "x"})
      assert_reply ref, :error, %{reason: "unknown_agent"}
    end

    # ADR-0015 (issue #197 段階3, ふじ MF-1 レビュー指摘): rename_agent は
    # runner へ中継されないが、client -> server のあらゆる message が
    # version を要求される点は変わらない (`launch_defaults` と同じ
    # "accepting" action)。一致は無音、欠落/不一致は警告した上で処理は
    # 継続する。
    test "version 不一致は警告してから処理を継続する (ADR-0015)" do
      agent_id = "test.rename-version-mismatch"
      put_agent(agent_id)
      AgentDirectory.record(agent_id, @ao["id"], @ao["name"])
      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      log =
        capture_log(fn ->
          ref =
            push(socket, "rename_agent", %{
              "agent_id" => agent_id,
              "name" => "改名済み",
              "version" => "99"
            })

          # revision 2: baseline is @initial_revision = 1 (issue #219 MF-2).
          assert_reply ref, :ok, %{"revision" => 2}
        end)

      assert log =~ "client declared protocol version"
      assert log =~ "\"99\""
    end

    test "version 省略も警告した上で処理を継続する" do
      agent_id = "test.rename-version-absent"
      put_agent(agent_id)
      AgentDirectory.record(agent_id, @ao["id"], @ao["name"])
      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      log =
        capture_log(fn ->
          ref = push(socket, "rename_agent", %{"agent_id" => agent_id, "name" => "改名済み"})
          # revision 2: baseline is @initial_revision = 1 (issue #219 MF-2).
          assert_reply ref, :ok, %{"revision" => 2}
        end)

      assert log =~ "client declared protocol version (absent)"
    end

    test "version が \"0\" なら警告しない" do
      agent_id = "test.rename-version-match"
      put_agent(agent_id)
      AgentDirectory.record(agent_id, @ao["id"], @ao["name"])
      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      log =
        capture_log(fn ->
          ref =
            push(socket, "rename_agent", %{
              "agent_id" => agent_id,
              "name" => "改名済み",
              "version" => "0"
            })

          # revision 2: baseline is @initial_revision = 1 (issue #219 MF-2).
          assert_reply ref, :ok, %{"revision" => 2}
        end)

      refute log =~ "client declared protocol version"
    end

    test "空白 / 64 grapheme 超 / 制御文字混入の name は invalid_name として拒否され AgentDirectory は無変化" do
      agent_id = "test.rename-invalid"
      put_agent(agent_id)
      AgentDirectory.record(agent_id, @ao["id"], @ao["name"])
      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      for bad_name <- ["", "   ", String.duplicate("a", 65), "bad" <> <<0x01>> <> "name"] do
        ref = push(socket, "rename_agent", %{"agent_id" => agent_id, "name" => bad_name})
        assert_reply ref, :error, %{reason: "invalid_name"}
      end

      # revision 1: fresh-record baseline @initial_revision (issue #219
      # MF-2), unchanged since every rename in the loop was rejected.
      assert %{display_name: "あお", revision: 1} = AgentDirectory.get(agent_id)
    end

    # issue #219 MF-3 (クロエ実測検証, rename 経路): 単独 null / null +
    # valid sibling の両方が invalid_name として拒否され、AgentDirectory
    # が無変化のままであることを spawn 経路と対で pin する (spawn 側の
    # 同種テストは spawn describe ブロックにある)。
    test "display_name が単独で null なら invalid_name、AgentDirectory は無変化 (MF-3)" do
      agent_id = "test.rename-null-alone"
      put_agent(agent_id)
      AgentDirectory.record(agent_id, @ao["id"], @ao["name"])
      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      ref = push(socket, "rename_agent", %{"agent_id" => agent_id, "display_name" => nil})
      assert_reply ref, :error, %{reason: "invalid_name"}

      assert %{display_name: "あお", revision: 1} = AgentDirectory.get(agent_id)
    end

    test "display_name が null で name が有効値でも invalid_name (legacy name を受理しない、MF-3)" do
      agent_id = "test.rename-null-with-legacy"
      put_agent(agent_id)
      AgentDirectory.record(agent_id, @ao["id"], @ao["name"])
      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      ref =
        push(socket, "rename_agent", %{
          "agent_id" => agent_id,
          "display_name" => nil,
          "name" => "改名済み"
        })

      assert_reply ref, :error, %{reason: "invalid_name"}

      assert %{display_name: "あお", revision: 1} = AgentDirectory.get(agent_id)
    end

    # D16: 既に join 済みの operator の directory copy が rename 後に live で
    # 更新される。viewer には決して届かない (ADR-0030 D10)。
    test "rename は既 join operator の directory を live 更新し、viewer には届かない" do
      agent_id = "test.rename-directory"
      put_agent(agent_id)
      AgentDirectory.record(agent_id, @ao["id"], @ao["name"])

      operator_socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}
      assert_push "directory", %{"entries" => _}

      viewer_socket = join_as(:viewer)
      assert_push "snapshot", %{"agents" => _}

      ref = push(operator_socket, "rename_agent", %{"agent_id" => agent_id, "name" => "改名済み"})
      assert_reply ref, :ok, %{}

      assert_push "directory", %{"entries" => entries}
      assert %{"display_name" => "改名済み"} = entries[agent_id]

      # viewer 側の socket には "directory" が一切来ない (join 時も rename 後も)。
      refute_push "directory", %{}
      _ = viewer_socket
    end
  end

  describe "rename_user (issue #197 段階3, D13)" do
    test "operator は既存 user を rename でき、更新後の public entry を返す" do
      user = KaoiroServer.Users.get_or_create({:oauth, "github", "rename-1"}, "user", "R")
      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      ref = push(socket, "rename_user", %{"user_id" => user.id, "name" => "あお(user)"})

      assert_reply ref, :ok, %{id: id, kind: "user", display_name: "あお(user)"}
      assert id == user.id

      assert KaoiroServer.Users.get(user.id) == %{
               id: user.id,
               kind: "user",
               display_name: "あお(user)"
             }
    end

    # Every other test in this describe block sends the legacy `"name"`
    # key (issue #209 D23 compatibility window) — the dashboard's own
    # `renameUser()` (issue #207) sends the canonical `"display_name"`
    # key instead, and nothing here previously exercised that leg of
    # extract_name_field/1.
    test "canonical display_name key でも rename できる (issue #207 のdashboard producer が送るキー)" do
      user = KaoiroServer.Users.get_or_create({:oauth, "github", "rename-canonical"}, "user", "R")
      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      ref =
        push(socket, "rename_user", %{"user_id" => user.id, "display_name" => "あお(canonical)"})

      assert_reply ref, :ok, %{id: id, kind: "user", display_name: "あお(canonical)"}
      assert id == user.id
    end

    test "viewer の rename_user は forbidden" do
      user = KaoiroServer.Users.get_or_create({:oauth, "github", "rename-viewer"}, "user", "R")
      socket = join_as(:viewer)
      assert_push "snapshot", %{"agents" => _}

      ref = push(socket, "rename_user", %{"user_id" => user.id, "name" => "乗っ取り"})

      assert_reply ref, :error, %{reason: "forbidden"}
      assert KaoiroServer.Users.get(user.id).display_name == "R"
    end

    test "未知 user は unknown_user" do
      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      ref = push(socket, "rename_user", %{"user_id" => "no-such-user", "name" => "x"})
      assert_reply ref, :error, %{reason: "unknown_user"}
    end

    test "charset 違反の user_id は invalid_user_id" do
      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      ref = push(socket, "rename_user", %{"user_id" => "has space", "name" => "x"})
      assert_reply ref, :error, %{reason: "invalid_user_id"}
    end

    # ADR-0015 (issue #197 段階3, ふじ MF-1 レビュー指摘): rename_agent と
    # 同じ "accepting" action の version 検証。
    test "version 不一致は警告してから処理を継続する (ADR-0015)" do
      user = KaoiroServer.Users.get_or_create({:oauth, "github", "rename-vmismatch"}, "user", "R")
      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      log =
        capture_log(fn ->
          ref =
            push(socket, "rename_user", %{
              "user_id" => user.id,
              "name" => "改名済み",
              "version" => "99"
            })

          assert_reply ref, :ok, %{display_name: "改名済み"}
        end)

      assert log =~ "client declared protocol version"
      assert log =~ "\"99\""
    end

    test "version 省略も警告した上で処理を継続する" do
      user = KaoiroServer.Users.get_or_create({:oauth, "github", "rename-vabsent"}, "user", "R")
      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      log =
        capture_log(fn ->
          ref = push(socket, "rename_user", %{"user_id" => user.id, "name" => "改名済み"})
          assert_reply ref, :ok, %{display_name: "改名済み"}
        end)

      assert log =~ "client declared protocol version (absent)"
    end

    test "version が \"0\" なら警告しない" do
      user = KaoiroServer.Users.get_or_create({:oauth, "github", "rename-vmatch"}, "user", "R")
      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      log =
        capture_log(fn ->
          ref =
            push(socket, "rename_user", %{
              "user_id" => user.id,
              "name" => "改名済み",
              "version" => "0"
            })

          assert_reply ref, :ok, %{display_name: "改名済み"}
        end)

      refute log =~ "client declared protocol version"
    end

    test "空白 / 64 grapheme 超 / 制御文字混入の name は invalid_name" do
      user = KaoiroServer.Users.get_or_create({:oauth, "github", "rename-invalid"}, "user", "R")
      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      for bad_name <- ["", String.duplicate("a", 65), "bad" <> <<0x01>> <> "name"] do
        ref = push(socket, "rename_user", %{"user_id" => user.id, "name" => bad_name})
        assert_reply ref, :error, %{reason: "invalid_name"}
      end

      assert KaoiroServer.Users.get(user.id).display_name == "R"
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

  # admin は operator の上位 (ADR-0050 D2)。inbound だけ通して outbound を
  # 落とすと「全コマンドを実行できるが何も見えない admin」になり、実装中に
  # 実際にその一歩手前まで行った (`require_operator/1` に admin を足しても、
  # `role == :operator` の直接比較が別に 8 箇所残っていた)。inbound 側と
  # outbound 側の両方を、同じ describe で並べて pin する。
  describe "admin は operator 経路を inbound / outbound とも通る (issue #198)" do
    test "operator 限定 inbound を admin が通せる" do
      agent_id = "test.admin-inbound"
      put_agent(agent_id)
      socket = join_as(:admin)
      assert_push "snapshot", %{"agents" => _}

      ref = push(socket, "instruction", %{"agent_id" => agent_id, "text" => "x"})

      assert_reply ref, :ok, _
    end

    test "operator 限定 outbound (history_reset) を admin が受け取る" do
      agent_id = "test.admin-outbound"
      _socket = join_as(:admin)

      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "history_reset", %{
        "agent_id" => agent_id
      })

      assert_push "history_reset", %{"agent_id" => ^agent_id}
    end

    test "viewer が落とす envelope allow-list を admin は通過する" do
      envelope = inter_agent_envelope("test.iam-adm-from", "test.iam-adm-to")
      _socket = join_as(:admin)

      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "envelope", envelope)

      assert_push "envelope", %{"type" => "inter_agent_message"}
    end

    test "join 時の task_snapshot に admin でも tasks キーが入る" do
      # snapshot の tasks は handle_out ではなく join 経路の別ゲート
      # (ふじ should 1)。集約したうちの 1 箇所だけ直接比較へ戻る回帰は
      # 上の 3 本では拾えない。
      on_exit(fn -> TaskStates.discard_for_agent("test.task-snap-admin") end)
      TaskStates.put(task_envelope("test.task-snap-admin", "t1"))

      _socket = join_as(:admin)

      assert_push "task_snapshot", %{"tasks" => tasks}
      assert %{"test.task-snap-admin" => %{"t1" => stored}} = tasks
      assert stored["payload"]["task_id"] == "t1"
    end

    # 未知 role の fail-closed はここでは測れない: `parse_role/1` が 3 語
    # 以外を nil にするため、未知の role atom が `require_operator/1` へ
    # 到達する経路が無い。assigns へ直接入れると #158 の role 再解決の
    # 不一致経路を測ることになり、意図と別のものが通ってしまう。綴り違い
    # の fail-closed は auth_test 側で pin してある。
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

    test "operator は history_replay_complete を受け取る" do
      agent_id = "test.reset-complete-op"
      _socket = join_as(:operator)

      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "history_replay_complete", %{
        "agent_id" => agent_id,
        "replay_id" => "replay-1"
      })

      assert_push "history_replay_complete", %{
        "agent_id" => ^agent_id,
        "replay_id" => "replay-1"
      }
    end

    test "viewer には history_replay_complete を配信しない (fail-closed)" do
      _socket = join_as(:viewer)

      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "history_replay_complete", %{
        "agent_id" => "test.reset-complete-vw",
        "replay_id" => "replay-1"
      })

      refute_push "history_replay_complete", %{}
    end

    # ふじ 30-10 must-fix M2: 復元 IA は pane を名乗る専用 event で届く。
    # transcript 系と同じく operator 限定。
    test "operator は history_replay_envelope を pane 付きで受け取る" do
      agent_id = "test.replay-env-op"
      _socket = join_as(:operator)

      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "history_replay_envelope", %{
        "pane_agent_id" => agent_id,
        "envelope" => %{"type" => "inter_agent_message", "agent_id" => "test.peer"}
      })

      assert_push "history_replay_envelope", %{
        "pane_agent_id" => ^agent_id,
        "envelope" => %{"agent_id" => "test.peer"}
      }
    end

    test "viewer には history_replay_envelope を配信しない (fail-closed)" do
      _socket = join_as(:viewer)

      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "history_replay_envelope", %{
        "pane_agent_id" => "test.replay-env-vw",
        "envelope" => %{"type" => "inter_agent_message", "agent_id" => "test.peer"}
      })

      refute_push "history_replay_envelope", %{}
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
        # issue #180: "task" WAS this placeholder until it became a real
        # type — see the "task 型 (issue #180, ADR-0021)" describe block
        # below for its actual, now-real allow-list behavior.
        "type" => "hypothetical_future_type",
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
        "type" => "hypothetical_future_type",
        "state" => "thinking",
        "payload" => %{"task_id" => "t1"}
      }

      KaoiroServerWeb.Endpoint.broadcast(
        "agents:lobby",
        "envelope",
        future_envelope
      )

      assert_push "envelope", pushed
      assert pushed["type"] == "hypothetical_future_type"
    end

    test "viewer snapshot は未知 type の agent をスキップする" do
      agent_id = "test.future-3"

      :ok =
        AgentStates.put(%{
          "version" => "0",
          "agent_id" => agent_id,
          "ts" => "2026-06-11T00:00:00Z",
          "type" => "hypothetical_future_type",
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

  # issue #180 (ADR-0019/0047/0048): task envelope の実際の role gating。
  # sanitize_envelope_for/2 に "task" 専用の clause は追加していない —
  # 既存の :operator 素通し句と :viewer fail-closed 句(catch-all)が
  # そのまま正しく機能する設計(こはく決定 2026-08-09: task はoperator限定)。
  describe "task 型の role gating (issue #180, ADR-0021)" do
    defp task_envelope(agent_id, task_id, kind \\ "started") do
      %{
        "version" => "0",
        "agent_id" => agent_id,
        "persona" => %{"id" => "p", "name" => "P", "sprite_set" => "p"},
        "ts" => "2026-08-09T00:00:00Z",
        "type" => "task",
        "state" => "idle",
        "payload" => %{
          "kind" => kind,
          "agent_id" => agent_id,
          "task_id" => task_id,
          "task_type" => "local_agent",
          "status" => "running",
          "summary" => "content-bearing progress text"
        },
        "ext" => %{}
      }
    end

    test "live broadcast: viewer には届かない (fail-closed catch-all)" do
      _socket = join_as(:viewer)

      KaoiroServerWeb.Endpoint.broadcast(
        "agents:lobby",
        "envelope",
        task_envelope("test.task-viewer", "t1")
      )

      refute_push "envelope", %{}
    end

    test "live broadcast: operator には素通しで届く" do
      _socket = join_as(:operator)

      KaoiroServerWeb.Endpoint.broadcast(
        "agents:lobby",
        "envelope",
        task_envelope("test.task-operator", "t1")
      )

      assert_push "envelope", pushed
      assert pushed["type"] == "task"
      assert pushed["payload"]["summary"] == "content-bearing progress text"
    end

    test "task_snapshot: operator には tasks キーが入る (ADR-0048 F3)" do
      on_exit(fn -> TaskStates.discard_for_agent("test.task-snap-op") end)
      TaskStates.put(task_envelope("test.task-snap-op", "t1"))

      _socket = join_as(:operator)

      assert_push "task_snapshot", %{"tasks" => tasks}
      # M1 fix-round: TaskStates is now keyed agent_id => %{task_id =>
      # envelope}.
      assert %{"test.task-snap-op" => %{"t1" => stored}} = tasks
      assert stored["payload"]["task_id"] == "t1"
    end

    test "task_snapshot: viewer には tasks キーが空で届く (operator 限定、こはく決定 2026-08-09)" do
      on_exit(fn -> TaskStates.discard_for_agent("test.task-snap-viewer") end)
      TaskStates.put(task_envelope("test.task-snap-viewer", "t1"))

      _socket = join_as(:viewer)

      assert_push "task_snapshot", %{"tasks" => tasks}
      assert tasks == %{}
    end

    test "delivery_snapshot: viewer には deliveries キーが空で届く" do
      agent_id = "test.delivery-snap-viewer"
      on_exit(fn -> DeliveryStates.delete(agent_id) end)
      assert %{issued_seq: 0} = DeliveryStates.bind(agent_id, "delivery-snap-viewer-generation")

      _socket = join_as(:viewer)

      assert_push "delivery_snapshot", %{"deliveries" => deliveries}
      assert deliveries == %{}
    end

    # M3 round2 must-fix (2026-08-09, ふじ round 2): AgentStates と
    # TaskStates は別 GenServer で、after_join の snapshot 読み取りは
    # (AgentStates.snapshot/0, TaskStates.snapshot/0) の 2 回の独立した
    # 呼び出し。WrapperChannel.terminate/2 の実行順 (disconnect →
    # discard_for_agent → broadcast, M3 fix-round) のうち disconnect と
    # discard_for_agent の間に新規 join が挟まると、snapshot は「agent は
    # disconnected だが tasks はまだ残っている」という一時的な不整合を
    # 返しうる。ここでは terminate/2 の内部ステップを手動で分割実行して
    # (a) その不整合が実際に snapshot 上で観測できること、(b) 収束は
    # 「同じ join の PubSub 購読は join/3 の時点で既に確立済みなので、
    # 後着の disconnected broadcast を同じ client が確実に受け取る」こと
    # に依存する、の両方を確認する。dashboard 側の収束契約そのもの
    # (broadcast 受信 → purgeTasksForAgent) は protocol.test.ts の M3
    # regression 側で固定済み — ここは server 側の「取りこぼされない」
    # 半分を固定する。
    #
    # S2 round-3 訂正(2026-08-09、ふじ round 3、こはく指摘): この手動
    # sequencing は terminate/2 を一切通らないため、discard→broadcast の
    # "順序そのもの" は判別できない(旧順序 broadcast→discard へ戻して
    # も green のまま)。その production-path 保証は
    # wrapper_channel_test.exs の「channel 終了時、TaskStates の discard
    # 完了まで disconnected broadcast は届かない」(:sys.suspend で実
    # terminate/2 を止める、mutation test 済み)が別途固定している —
    # このテストは (a)(b) の 2 点のみを担う。
    test "join snapshot と disconnect の交差: 一時的な不整合は後着の disconnected broadcast で収束する (M3 round2 fix-round)" do
      agent_id = "test.task-interleave-1"
      on_exit(fn -> TaskStates.discard_for_agent(agent_id) end)

      owner = spawn(fn -> Process.sleep(:infinity) end)
      on_exit(fn -> Process.exit(owner, :kill) end)

      :ok =
        AgentStates.put(
          %{
            "version" => "0",
            "agent_id" => agent_id,
            "ts" => "2026-08-09T00:00:00Z",
            "type" => "state_change",
            "state" => "tool_running"
          },
          owner: owner
        )

      TaskStates.put(task_envelope(agent_id, "t1"))

      # terminate/2 の前半だけを手動で再現する: AgentStates はすでに
      # disconnected を反映しているが、TaskStates はまだ purge されて
      # いない — この間隙で新規 client が join する状況を作る。
      {:ok, disconnected_envelope} =
        AgentStates.disconnect(agent_id, owner, "2026-08-09T00:00:01Z")

      socket = join_as(:operator)

      assert_push "snapshot", %{"agents" => agents}
      assert_push "task_snapshot", %{"tasks" => tasks}
      assert agents[agent_id]["state"] == "disconnected"
      # 交差の実物: disconnected な agent の task がまだ snapshot に
      # 残っている — これが収束を broadcast 側に依存させている理由。
      assert %{^agent_id => %{"t1" => _}} = tasks

      # terminate/2 の後半 (M3 の順序どおり discard → broadcast) を
      # 手動で完了させる。
      TaskStates.discard_for_agent(agent_id)
      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "envelope", disconnected_envelope)

      # 新規 join した client も (join/3 で購読は snapshot push より前に
      # 確立済みなので) この broadcast を確実に受け取る。
      assert_push "envelope", %{"agent_id" => ^agent_id, "state" => "disconnected"}

      _ = socket
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

    # ADR-0051 D3-1: a live accept allocates ONE ingress stamp and upserts
    # the envelope into both the sender's and the receiver's pane under it.
    # Seeding through the same API keeps these tests on the production
    # contract. Both panes need an AgentStates entry — the per-pane
    # projection lives inside it, which is also why the pre-ADR-0051
    # "IA survives an empty AgentStates" behaviour is gone (D3-5).
    defp seed_ia(ia_env) do
      sender_id = ia_env["agent_id"]
      receiver_id = ia_env["payload"]["to"]
      put_agent(sender_id)
      put_agent(receiver_id)
      stamp = KaoiroServer.IngressOrder.allocate()
      :ok = AgentStates.upsert_ia(sender_id, stamp, ia_env)
      :ok = AgentStates.upsert_ia(receiver_id, stamp, ia_env)
      stamp
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

    # ふじ R3 must-fix (2026-07-23): history push は projection marker を
    # 同梱する。 marker があるので new client は自前 fanOut をスキップし
    # server pre-fan-out 結果をそのまま使い、marker が無い old server と
    # new client の組合せでは client が自前 fanOut に fallback する
    # (test/protocol.test.ts の parseHistoryPayload 群で pin)。
    test "history push は projection_epoch を同梱する (ADR-0051 D4)" do
      agent_id = "test.hist-epoch"
      put_agent(agent_id)
      _socket = join_as(:operator)

      assert_push "snapshot", %{"agents" => _}
      assert_push "history", payload
      assert payload["projection_epoch"] == AgentStates.projection_epoch()
      assert is_binary(payload["projection_epoch"])
    end

    # ADR-0051 D6: the cap belongs to the FINAL merged projection. Before
    # this the transcript capped at 200 on its own and IA was cap-exempt,
    # so a pane could serve well past 200 rows.
    test "(h) transcript + IA 合算 201 件は最終投影で newest 200 に切られる" do
      agent_id = "test.cap-201"
      peer_id = "test.cap-201-peer"
      put_agent(agent_id)
      put_agent(peer_id)

      # 101 transcript rows then 100 IA rows, all with distinct {ts, seq}.
      for n <- 1..101 do
        :ok = AgentStates.append_log(capped_log(agent_id, n))
      end

      for n <- 102..201 do
        :ok =
          AgentStates.upsert_ia(
            agent_id,
            KaoiroServer.IngressOrder.allocate(),
            capped_ia(agent_id, peer_id, n)
          )
      end

      _socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}
      assert_push "history", %{"agents" => agents}

      entries = agents[agent_id]
      assert length(entries) == 200
      # 最古の 1 件 (n=1) だけが落ちる。
      assert List.first(entries)["seq"] == 2
      assert List.last(entries)["seq"] == 201
    end

    test "(h) transcript 200 + IA 200 でも合算 400 にはならず 200 に切られる" do
      agent_id = "test.cap-400"
      peer_id = "test.cap-400-peer"
      put_agent(agent_id)
      put_agent(peer_id)

      for n <- 1..200 do
        :ok = AgentStates.append_log(capped_log(agent_id, n))
      end

      for n <- 201..400 do
        :ok =
          AgentStates.upsert_ia(
            agent_id,
            KaoiroServer.IngressOrder.allocate(),
            capped_ia(agent_id, peer_id, n)
          )
      end

      _socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}
      assert_push "history", %{"agents" => agents}

      entries = agents[agent_id]
      assert length(entries) == 200
      assert List.first(entries)["seq"] == 201
      assert List.last(entries)["seq"] == 400
    end

    defp capped_log(agent_id, n) do
      %{
        "version" => "0",
        "agent_id" => agent_id,
        "ts" => "2026-06-11T00:00:00Z",
        "seq" => n,
        "type" => "log",
        "state" => "thinking",
        "payload" => %{"kind" => "assistant", "text" => "m#{n}"}
      }
    end

    defp capped_ia(agent_id, peer_id, n) do
      durable_inter_agent_envelope(agent_id, peer_id, n) |> Map.put("seq", n)
    end

    test "history push は history_projection=per-pane-v1 を同梱 (R3)" do
      agent_id = "test.hist-projection"
      put_agent(agent_id)
      _socket = join_as(:operator)

      assert_push "snapshot", %{"agents" => _}
      assert_push "history", payload
      assert payload["history_projection"] == "per-pane-v1"
    end

    test "IA は per-pane projection から sender / receiver 両 pane に載る (ADR-0051 D3-1)" do
      agent_id = "test.hist-durable"
      peer_id = "test.hist-peer"
      ia = durable_inter_agent_envelope(agent_id, peer_id, 1)
      _stamp = seed_ia(ia)

      # transcript history とは別の入れ物なので混ざらない。
      refute Map.has_key?(AgentStates.histories(), agent_id)
      _socket = join_as(:operator)

      assert_push "snapshot", %{"agents" => _}
      assert_push "history", %{"agents" => agents}
      assert agents[agent_id] == [ia]
      assert agents[peer_id] == [ia]
    end

    test "同一 ingress stamp の再 upsert は pane 内で重複しない (replay retry 冪等)" do
      agent_id = "test.hist-dedupe"
      peer_id = "test.hist-dedupe-peer"
      ia = durable_inter_agent_envelope(agent_id, peer_id, 1)
      stamp = seed_ia(ia)
      # A `replay_ia` retry of the same row lands on the same identity.
      :ok = AgentStates.upsert_ia(agent_id, stamp, ia)

      _socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}
      assert_push "history", %{"agents" => agents}
      assert agents[agent_id] == [ia]
    end

    test "clear watermark より古い ingress order の durable IA は sender pane から drop (issue #109 M6)" do
      agent_id = "test.hist-wm"
      peer_id = "test.hist-wm-peer"
      old = durable_inter_agent_envelope(agent_id, peer_id, 1)
      new = durable_inter_agent_envelope(agent_id, peer_id, 2)
      _ = seed_ia(old)
      # sender の clear watermark を、old append 後 + new append 前 に置く。
      # ingress order tuple を server が発行しているので、時計 skew や wire
      # ts の言葉には依存しない (M6 must-fix)。
      Process.sleep(1)
      order = {System.system_time(:microsecond), System.unique_integer([:positive, :monotonic])}
      display = DateTime.utc_now() |> DateTime.to_iso8601()
      :ok = ClearWatermarks.record(agent_id, order, display)
      Process.sleep(1)
      _ = seed_ia(new)

      on_exit(fn ->
        ClearWatermarks.delete(agent_id)
      end)

      _socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      assert_push "history", %{
        "agents" => agents,
        "clear_watermarks" => watermarks
      }

      # sender pane: watermark 以前の old は落ちる、new のみ残る。
      assert agents[agent_id] == [new]
      # receiver pane (peer): peer 側 watermark 未設定なので両方届く
      # (peer 側 表示不変 semantics — sender の clear は peer に影響しない)。
      assert agents[peer_id] == [old, new]
      # watermarks は display 用の hint (ISO ts)。client-side filter は
      # 使わない (server が全部 filter する)。
      assert watermarks[agent_id] == display
    end

    test "sender と receiver 両方に watermark があれば両 pane で個別に filter される" do
      agent_id = "test.hist-wm-both"
      peer_id = "test.hist-wm-both-peer"
      env = durable_inter_agent_envelope(agent_id, peer_id, 1)
      _ = seed_ia(env)
      # env より後 order で sender / peer 双方に watermark を置く。
      Process.sleep(1)

      sender_order =
        {System.system_time(:microsecond), System.unique_integer([:positive, :monotonic])}

      peer_order =
        {System.system_time(:microsecond), System.unique_integer([:positive, :monotonic])}

      :ok =
        ClearWatermarks.record(
          agent_id,
          sender_order,
          DateTime.utc_now() |> DateTime.to_iso8601()
        )

      :ok =
        ClearWatermarks.record(peer_id, peer_order, DateTime.utc_now() |> DateTime.to_iso8601())

      on_exit(fn ->
        ClearWatermarks.delete(agent_id)
        ClearWatermarks.delete(peer_id)
      end)

      _socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}
      assert_push "history", %{"agents" => agents}
      # 両 pane から drop。
      refute Map.has_key?(agents, agent_id)
      refute Map.has_key?(agents, peer_id)
    end

    test "watermark 未記録の agent は durable IA が全部見える (backward-compat regression pin)" do
      agent_id = "test.hist-nowm"
      peer_id = "test.hist-nowm-peer"
      env = durable_inter_agent_envelope(agent_id, peer_id, 1)
      _ = seed_ia(env)

      _socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}
      assert_push "history", %{"agents" => agents, "clear_watermarks" => watermarks}
      # sender + receiver 両方に届く (server pre-fanOut)、drop は無し。
      assert agents[agent_id] == [env]
      assert agents[peer_id] == [env]
      refute Map.has_key?(watermarks, agent_id)
    end

    # ふじ R2 must-fix (2026-07-23): 前回の M6 修正は legacy 2-tuple record
    # を `{{0, 0}, iso}` に変換していたが、新 IA order は必ずそれを上回るの
    # で watermark が inert 化 → 旧 clear 済み IA が redeploy で全件再露出
    # する regression があった。修正: legacy は :iso_only モードで保持し、
    # agents_channel filter path が wire ts と iso を比較する。以下 2 テ
    # ストは「旧 watermark が隠していた IA は隠れ続ける」を pin。
    test "legacy iso_only watermark は wire ts が iso 以前の IA を hide (R2)" do
      agent_id = "test.hist-wm-legacy"
      peer_id = "test.hist-wm-legacy-peer"
      # 一方は legacy iso より前、一方は後。
      old =
        durable_inter_agent_envelope(agent_id, peer_id, 1)
        |> Map.put("ts", "2026-06-01T00:00:00Z")

      new =
        durable_inter_agent_envelope(agent_id, peer_id, 2)
        |> Map.put("ts", "2026-08-01T00:00:00Z")

      _ = seed_ia(old)
      _ = seed_ia(new)

      # sender pane に legacy iso_only watermark を注入 (実運用では旧 DETS
      # record が load_watermarks/1 経由でこの shape を作る)。
      legacy_iso = "2026-07-01T00:00:00Z"

      :sys.replace_state(ClearWatermarks, fn state ->
        %{state | watermarks: Map.put(state.watermarks, agent_id, {:iso_only, legacy_iso})}
      end)

      on_exit(fn ->
        ClearWatermarks.delete(agent_id)
      end)

      _socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}
      assert_push "history", %{"agents" => agents}

      # sender pane: legacy iso 以前の old は drop、後の new のみ残る。
      assert agents[agent_id] == [new]
      # peer pane は watermark 未設定 → 両方見える (per-pane 独立性の維持)。
      assert agents[peer_id] == [old, new]
    end

    test "次回 record/4 で legacy watermark は tuple domain に promote される (R2)" do
      agent_id = "test.hist-wm-promote"
      peer_id = "test.hist-wm-promote-peer"

      env =
        durable_inter_agent_envelope(agent_id, peer_id, 1)
        |> Map.put("ts", "2026-08-01T00:00:00Z")

      _ = seed_ia(env)

      # まず legacy iso_only を注入。env の ts より後の iso なので env は
      # 隠される (ts <= iso)。
      :sys.replace_state(ClearWatermarks, fn state ->
        %{
          state
          | watermarks: Map.put(state.watermarks, agent_id, {:iso_only, "2026-09-01T00:00:00Z"})
        }
      end)

      # 新規 clear = tuple record: legacy は無条件に置換される (比較可能
      # order が無いので monotonic-advance の制約なし)。
      Process.sleep(1)

      new_order =
        {System.system_time(:microsecond), System.unique_integer([:positive, :monotonic])}

      new_display = DateTime.utc_now() |> DateTime.to_iso8601()
      :ok = ClearWatermarks.record(agent_id, new_order, new_display)

      on_exit(fn ->
        ClearWatermarks.delete(agent_id)
      end)

      # env の ingress order は new_order より前なので、tuple domain 昇格
      # 後も env は sender pane から drop される (promotion 後も semantics
      # が保存されることを pin)。
      _socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}
      assert_push "history", %{"agents" => agents}
      refute Map.has_key?(agents, agent_id)
    end

    test "sender clear は peer pane の表示に影響しない (peer 側 表示不変)" do
      # M6/M7 の per-pane filter が「pane ごとに独立」であることの pin。
      agent_id = "test.hist-peer-immune"
      peer_id = "test.hist-peer-immune-peer"
      env = durable_inter_agent_envelope(agent_id, peer_id, 1)
      _ = seed_ia(env)
      # sender の watermark は envelope order の後に置く → sender pane
      # からは消える。peer pane は watermark 未記録なので env が残る。
      Process.sleep(1)
      order = {System.system_time(:microsecond), System.unique_integer([:positive, :monotonic])}
      display = DateTime.utc_now() |> DateTime.to_iso8601()
      :ok = ClearWatermarks.record(agent_id, order, display)

      on_exit(fn ->
        ClearWatermarks.delete(agent_id)
      end)

      _socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}
      assert_push "history", %{"agents" => agents}
      refute Map.has_key?(agents, agent_id)
      assert agents[peer_id] == [env]
    end

    test "clear_history は現行 session の IA を残す (実機検収 2 マスター指示、旧 M7 pin の仕様反転)" do
      # 実機検収 2 (2026-07-23 マスター指示): 旧 M7/R4 pin では
      # IA(t1) → CLEAR(t2) → 再 join で sender pane から IA が
      # 消えることを assert していたが、これは「clear_history 実行で
      # 現行 session の IA まで消える」という regression の直接原因
      # だった。仕様修正: clear_history は現行 session の IA を残す
      # (境界前進は SessionResets confirm_connection 経由のみ)。
      # 反転した pin: clear 後の reload で env が **残っていること**。
      agent_id = "test.hist-order-1"
      peer_id = "test.hist-order-1-peer"
      env = durable_inter_agent_envelope(agent_id, peer_id, 1)
      _ = seed_ia(env)

      :ok =
        AgentStates.put(%{
          "version" => "0",
          "agent_id" => agent_id,
          "ts" => "2026-06-11T00:00:00Z",
          "type" => "state_change",
          "state" => "waiting_input",
          "session_id" => "sess-order-1"
        })

      on_exit(fn ->
        ClearWatermarks.delete(agent_id)
      end)

      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}
      assert_push "history", %{"agents" => before_agents}
      assert env in (before_agents[agent_id] || [])

      Process.sleep(1)
      ref = push(socket, "clear_history", %{"agent_id" => agent_id})
      assert_reply ref, :ok
      assert_broadcast "history_cleared", %{"agent_id" => ^agent_id}

      # 再 join (reload シミュレーション): env は sender pane に残る
      # (clear_history は境界を advance しないので filter は inert)。
      _socket2 = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}
      assert_push "history", %{"agents" => after_agents}
      assert env in (after_agents[agent_id] || [])
      # 境界も未 seed のまま。
      assert ClearWatermarks.get(agent_id) == nil
    end

    test "CLEAR(t1) → IA(t2) の順序では新しい IA は sender pane に残る (event 順序 pin その 2)" do
      # 逆順序の regression pin: clear より後に到着した IA は order
      # tuple が watermark を上回るので pane に残る。
      agent_id = "test.hist-order-2"
      peer_id = "test.hist-order-2-peer"

      :ok =
        AgentStates.put(%{
          "version" => "0",
          "agent_id" => agent_id,
          "ts" => "2026-06-11T00:00:00Z",
          "type" => "state_change",
          "state" => "waiting_input",
          "session_id" => "sess-order-2"
        })

      on_exit(fn ->
        ClearWatermarks.delete(agent_id)
      end)

      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}
      assert_push "history", %{"agents" => _}

      ref = push(socket, "clear_history", %{"agent_id" => agent_id})
      assert_reply ref, :ok
      assert_broadcast "history_cleared", %{"agent_id" => ^agent_id}

      Process.sleep(1)
      later = durable_inter_agent_envelope(agent_id, peer_id, 42)
      _ = seed_ia(later)

      _socket2 = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}
      assert_push "history", %{"agents" => after_agents}
      assert later in (after_agents[agent_id] || [])
    end

    test "clear_history は過去 IA を隠し現行 session IA を残す (reload 一致)" do
      agent_id = "test.clear-ia-projection"
      peer_id = "test.clear-ia-projection-peer"
      old = durable_inter_agent_envelope(agent_id, peer_id, 1)
      _ = seed_ia(old)

      {:ok, {_start_order, display, "sess-current"}} =
        KaoiroServer.SessionStarts.advance_transition(agent_id, "sess-current")

      current = durable_inter_agent_envelope(agent_id, peer_id, 2)
      _ = seed_ia(current)

      :ok =
        AgentStates.put(%{
          "version" => "0",
          "agent_id" => agent_id,
          "ts" => "2026-06-11T00:00:00Z",
          "type" => "state_change",
          "state" => "waiting_input",
          "session_id" => "sess-current"
        })

      on_exit(fn ->
        ClearWatermarks.delete(agent_id)
        KaoiroServer.SessionStarts.delete(agent_id)
      end)

      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}
      assert_push "history", %{"agents" => before}
      assert old in (before[agent_id] || [])
      assert current in (before[agent_id] || [])

      assert_reply push(socket, "clear_history", %{"agent_id" => agent_id}), :ok

      assert_broadcast "history_cleared", %{
        "agent_id" => ^agent_id,
        "clear_watermark" => ^display
      }

      _reload = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}
      assert_push "history", %{"agents" => after_clear}
      refute old in (after_clear[agent_id] || [])
      assert current in (after_clear[agent_id] || [])
    end

    test "開始点なし clear は既存 watermark を変えず hidden IA を再露出しない" do
      agent_id = "test.clear-missing-start-preserve"
      peer_id = "test.clear-missing-start-peer"
      old = durable_inter_agent_envelope(agent_id, peer_id, 1)
      _ = seed_ia(old)

      :ok =
        ClearWatermarks.record(
          agent_id,
          {System.system_time(:microsecond), 0},
          "2026-07-23T15:00:00Z"
        )

      before = ClearWatermarks.get(agent_id)

      :ok =
        AgentStates.put(%{
          "version" => "0",
          "agent_id" => agent_id,
          "ts" => "2026-06-11T00:00:00Z",
          "type" => "state_change",
          "state" => "waiting_input",
          "session_id" => "sess-current"
        })

      on_exit(fn ->
        ClearWatermarks.delete(agent_id)
        KaoiroServer.SessionStarts.delete(agent_id)
      end)

      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}
      assert_push "history", %{"agents" => _}
      assert_reply push(socket, "clear_history", %{"agent_id" => agent_id}), :ok
      assert ClearWatermarks.get(agent_id) == before

      _reload = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}
      assert_push "history", %{"agents" => histories}
      refute old in (histories[agent_id] || [])
    end

    test "wire ts と server ingress order が乖離しても filter は server order を使う (clock-skew pin)" do
      # M6 core pin: envelope の wire ts (producer clock) が clear
      # watermark の display ISO より新しいのに、server の ingress
      # order は watermark より古い場合、filter は order を優先して
      # IA を hide する (逆に、wire ts が古くても ingress order が
      # 新しければ表示される)。
      agent_id = "test.hist-skew"
      peer_id = "test.hist-skew-peer"
      # ingress order = t0 (古い) だが wire ts は未来。
      env = durable_inter_agent_envelope(agent_id, peer_id, 1)
      env_future = Map.put(env, "ts", "2099-01-01T00:00:00Z")
      _ = seed_ia(env_future)
      Process.sleep(1)
      # watermark を env の ingress order より後に置く
      # (display ISO は env の wire ts (2099-...) より過去)。
      order = {System.system_time(:microsecond), System.unique_integer([:positive, :monotonic])}
      display = DateTime.utc_now() |> DateTime.to_iso8601()
      :ok = ClearWatermarks.record(agent_id, order, display)

      on_exit(fn ->
        ClearWatermarks.delete(agent_id)
      end)

      _socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}
      assert_push "history", %{"agents" => agents}
      # wire ts (2099-...) > display (2026-...) だが、ingress order は
      # watermark 以前なので sender pane から dropped。
      refute Map.has_key?(agents, agent_id)
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
      on_exit(fn -> ClearWatermarks.delete(agent_id) end)
      :ok = AgentStates.put(state_with_session(agent_id, "s2"))
      :ok = AgentStates.append_log(log_with_session(agent_id, "old", "s1"))
      :ok = AgentStates.append_log(log_with_session(agent_id, "cur", "s2"))
      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      ref = push(socket, "clear_history", %{"agent_id" => agent_id})

      assert_reply ref, :ok
      # 実機検収 2 (2026-07-23 マスター指示): clear_history は IA
      # visibility boundary を advance しなくなった (境界前進は
      # SessionResets.confirm_connection と外部 switch_session 経由の
      # み)。broadcast の `clear_watermark` は「A の現行 session 境界
      # display ISO」の audit hint に意味 shift 済み — 境界が未設定
      # なら空文字列を送る (wire は据置)。この test では ClearWatermarks
      # は未 seed なので空文字列を assert。
      assert_broadcast "history_cleared", %{
        "agent_id" => ^agent_id,
        "session_id" => "s2",
        "clear_watermark" => ""
      }

      # ClearWatermarks には何も書き込まれない (境界前進なし)。
      assert ClearWatermarks.get(agent_id) == nil
      # Only the current session's reply line survives server-side.
      assert [%{"payload" => %{"text" => "cur"}}] = AgentStates.histories()[agent_id]
    end

    test "clear_history は現行 session start を watermark として採用する" do
      agent_id = "test.clear-boundary-hint"

      on_exit(fn ->
        ClearWatermarks.delete(agent_id)
        KaoiroServer.SessionStarts.delete(agent_id)
      end)

      :ok = AgentStates.put(state_with_session(agent_id, "s2"))

      # A transition records only a start; visibility remains unchanged until
      # this operator clear adopts it.
      {:ok, {existing_order, existing_display, "sess-existing"}} =
        KaoiroServer.SessionStarts.advance_transition(agent_id, "sess-existing")

      assert ClearWatermarks.get(agent_id) == nil

      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      ref = push(socket, "clear_history", %{"agent_id" => agent_id})
      assert_reply ref, :ok

      assert_broadcast "history_cleared", %{
        "agent_id" => ^agent_id,
        "clear_watermark" => ^existing_display
      }

      assert {^existing_order, ^existing_display, nil} =
               ClearWatermarks.get(agent_id)
    end

    test "clear_history は CAS clear → watermark fsync → broadcast の順に実行する" do
      agent_id = "test.clear-workflow-order"

      on_exit(fn ->
        case Process.whereis(ClearWatermarks) do
          pid when is_pid(pid) -> :sys.resume(pid)
          _ -> :ok
        end

        ClearWatermarks.delete(agent_id)
        KaoiroServer.SessionStarts.delete(agent_id)
      end)

      :ok = AgentStates.put(state_with_session(agent_id, "s-current"))
      :ok = AgentStates.append_log(log_with_session(agent_id, "old", "s-old"))
      :ok = AgentStates.append_log(log_with_session(agent_id, "current", "s-current"))

      {:ok, {_order, display, "s-current"}} =
        KaoiroServer.SessionStarts.advance_transition(agent_id, "s-current")

      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      # Suspending the fsync-gated watermark store makes the channel stop
      # exactly between CAS clear and broadcast. Reversing either boundary
      # operation causes the assertions below to fail.
      :ok = :sys.suspend(ClearWatermarks)
      ref = push(socket, "clear_history", %{"agent_id" => agent_id})

      assert :ok =
               wait_until_clear_workflow(fn ->
                 case AgentStates.histories()[agent_id] do
                   [%{"payload" => %{"text" => "current"}}] -> true
                   _ -> false
                 end
               end)

      refute_broadcast "history_cleared", %{"agent_id" => ^agent_id}

      :ok = :sys.resume(ClearWatermarks)

      assert_reply ref, :ok

      assert_broadcast "history_cleared", %{
        "agent_id" => ^agent_id,
        "clear_watermark" => ^display
      }

      assert {_, ^display, nil} = ClearWatermarks.get(agent_id)
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

    # issue #219 D22: `AgentDirectory.record/4` は spawn broadcast より前に
    # 同期的に完了する(record/4 自体が GenServer.call へ改訂された) —
    # これにより、runner が spawn broadcast を受けて実際に wrapper process
    # を起動し join してくる頃には、AgentDirectory に必ず entry が
    # committed 済みであることを保証する。以前 (record が cast だった頃)
    # は spawn broadcast が先に飛び、wrapper が極端に速く join した場合
    # after_join の persona_sync/display_name_sync push が
    # `AgentDirectory.get/1` を nil で引いて sync をスキップし得た
    # (silently、リトライもされない)。この test は broadcast が届いた
    # 時点で AgentDirectory の書き込みが既に観測できることを直接 pin する
    # — broadcast 後に spawn を担当した caller プロセス自身が読んでも
    # 見える、という形で「commit → broadcast」の順序を検証する。
    test "operator の spawn: spawn broadcast が届く時点で AgentDirectory への record は既に commit 済み (issue #219 D22 race 対策)" do
      host_id = "lab-pc-1-race"
      register_host(host_id)
      @endpoint.subscribe("runner:" <> host_id)
      socket = join_as(:operator)

      ref =
        push(socket, "spawn", %{
          "host_id" => host_id,
          "persona" => "ao",
          "cwd" => "/home/user/proj",
          "name" => "早すぎる join"
        })

      assert_reply ref, :ok, %{"agent_id" => agent_id}

      # broadcast が届いた時点で読む — record がまだ mailbox に cast の
      # まま滞留していれば、ここで entry が見えない (旧実装の race を
      # 再現し得るタイミング)。
      assert_broadcast "spawn", _payload

      assert %{persona_id: "ao", display_name: "早すぎる join"} =
               AgentDirectory.get(agent_id)
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
               %{
                 session_id: nil,
                 cwd: "/home/user/seed",
                 engine: "claude-code",
                 snapshot: nil,
                 effort_revision: nil
               }
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

    test "operator の spawn: 任意 name は display_name のみに反映され persona は不変 (#22, revised issue #219 D19)" do
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
      # name は trim され display_name (新規 top-level field) のみに反映
      # される; persona (canonical) は issue #219 D19 のとおり不変。
      assert_broadcast "spawn", %{"persona" => persona, "display_name" => "レビュー担当"}
      assert persona == %{"id" => "ao", "name" => "あお", "sprite_set" => "ao"}
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
      # 未指定/空白は persona 自身の canonical name が display_name の
      # 既定値になる (issue #219 D20 — created-time persistence)。
      assert payload["display_name"] == @ao["name"]
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

    # issue #219 MF-3 (クロエ実測検証): a JSON `null` for `display_name`
    # is a PRESENT key, not an absent one — `Map.get/2` alone cannot tell
    # the two apart (both read as `nil`), which previously let a lone
    # `{"display_name" => null}` fall through to the canonical-fallback
    # branch as if the key were never sent, and
    # `{"display_name" => null, "name" => "X"}` fall through to silently
    # accepting the legacy `"X"`. Both contradicted `extract_name_field/1`'s
    # own documented "present non-binary key -> invalid_name" contract.
    test "operator の spawn: display_name が単独で null なら invalid_name (persona 既定名へフォールバックしない)" do
      host_id = "lab-pc-1f"
      register_host(host_id)
      @endpoint.subscribe("runner:" <> host_id)
      socket = join_as(:operator)

      ref =
        push(socket, "spawn", %{
          "host_id" => host_id,
          "persona" => "ao",
          "cwd" => "/home/user/proj",
          "display_name" => nil
        })

      assert_reply ref, :error, %{reason: "invalid_name"}
      refute_broadcast "spawn", %{}
    end

    test "operator の spawn: display_name が null で name が有効値でも invalid_name (legacy name を受理しない)" do
      host_id = "lab-pc-1g"
      register_host(host_id)
      @endpoint.subscribe("runner:" <> host_id)
      socket = join_as(:operator)

      ref =
        push(socket, "spawn", %{
          "host_id" => host_id,
          "persona" => "ao",
          "cwd" => "/home/user/proj",
          "display_name" => nil,
          "name" => "レビュー担当"
        })

      assert_reply ref, :error, %{reason: "invalid_name"}
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
        assert payload["version"] == "0"
      end
    end

    test "live agent の restart は server-issued request_id を runner と planned intent に共有する" do
      host_id = "lab-pc-restart-planned"
      agent_id = host_id <> ".a"
      register_host(host_id)
      put_agent(agent_id)
      @endpoint.subscribe("runner:" <> host_id)
      socket = join_as(:operator)

      ref = push(socket, "restart", %{"host_id" => host_id, "agent_id" => agent_id})
      assert_reply ref, :ok
      assert_broadcast "restart", %{"agent_id" => ^agent_id, "request_id" => request_id}
      assert is_binary(request_id) and request_id != ""

      assert %{
               transition_id: ^request_id,
               kind: :restart,
               phase: :announced
             } = PlannedDisconnects.get(agent_id)

      duplicate = push(socket, "restart", %{"host_id" => host_id, "agent_id" => agent_id})
      assert_reply duplicate, :error, %{reason: "agent_busy"}
      refute_broadcast "restart", _

      stop = push(socket, "stop", %{"host_id" => host_id, "agent_id" => agent_id})
      assert_reply stop, :ok
      assert_broadcast "stop", %{"agent_id" => ^agent_id}
      refute PlannedDisconnects.active?(agent_id)
    end

    test "restart/stop は agent_id の owning host だけが relay と intent mutation を行える" do
      owner_host = "lab-pc-lifecycle-owner"
      wrong_host = "lab-pc-lifecycle-wrong"
      agent_id = owner_host <> ".a"
      register_host(owner_host)
      register_host(wrong_host)
      put_agent(agent_id)
      @endpoint.subscribe("runner:" <> wrong_host)
      socket = join_as(:operator)

      wrong_restart =
        push(socket, "restart", %{"host_id" => wrong_host, "agent_id" => agent_id})

      assert_reply wrong_restart, :error, %{reason: "agent_not_owned"}
      refute_broadcast "restart", _
      refute PlannedDisconnects.active?(agent_id)

      @endpoint.subscribe("runner:" <> owner_host)
      control = push(socket, "restart", %{"host_id" => owner_host, "agent_id" => agent_id})
      assert_reply control, :ok
      assert_broadcast "restart", %{"agent_id" => ^agent_id, "request_id" => request_id}
      assert %{transition_id: ^request_id} = PlannedDisconnects.get(agent_id)

      bounced_peer = "lab-pc-lifecycle-stop-peer"
      bounced_cid = "cnv-lifecycle-stop-bounce"
      @endpoint.subscribe("wrapper:" <> bounced_peer)

      assert {:tracked, _} =
               PlannedDisconnects.track_bounce(agent_id, bounced_cid, bounced_peer)

      wrong_stop = push(socket, "stop", %{"host_id" => wrong_host, "agent_id" => agent_id})
      assert_reply wrong_stop, :error, %{reason: "agent_not_owned"}
      refute_broadcast "stop", _
      assert %{transition_id: ^request_id} = PlannedDisconnects.get(agent_id)

      refute_received %Phoenix.Socket.Broadcast{
        topic: "wrapper:" <> ^bounced_peer,
        payload: %{"payload" => %{"error" => %{"code" => "disconnected"}}}
      }

      control_stop = push(socket, "stop", %{"host_id" => owner_host, "agent_id" => agent_id})
      assert_reply control_stop, :ok
      assert_broadcast "stop", %{"agent_id" => ^agent_id}
      refute PlannedDisconnects.active?(agent_id)

      assert_received %Phoenix.Socket.Broadcast{
        topic: "wrapper:" <> ^bounced_peer,
        payload: %{
          "payload" => %{
            "conversation_id" => ^bounced_cid,
            "error" => %{"code" => "disconnected"}
          }
        }
      }
    end

    test "version 不一致は警告してから v0 へ normalize する (ADR-0015)" do
      host_id = "lab-pc-2v"
      register_host(host_id)
      @endpoint.subscribe("runner:" <> host_id)
      socket = join_as(:operator)

      # Warn-then-accept: the mismatch is observable in the log (this is the
      # only hop that can see it), and the outbound hop is still v0.
      log =
        capture_log(fn ->
          ref =
            push(socket, "stop", %{
              "host_id" => host_id,
              "agent_id" => "lab-pc-2v.a",
              "version" => "99"
            })

          assert_reply ref, :ok
        end)

      assert log =~ "client declared protocol version"
      assert log =~ "\"99\""
      assert_broadcast "stop", payload
      assert payload["version"] == "0"
    end

    # #182 で dashboard が version を stamp するようになったので、absent の
    # 無警告受理 (carve-out) を廃止した。欠落は「まだ版を送らない client」
    # ではなく検知したい状態そのもの。
    test "version 省略も警告する (stamp は従来どおり)" do
      host_id = "lab-pc-2w"
      register_host(host_id)
      @endpoint.subscribe("runner:" <> host_id)
      socket = join_as(:operator)

      log =
        capture_log(fn ->
          ref = push(socket, "stop", %{"host_id" => host_id, "agent_id" => "lab-pc-2w.a"})
          assert_reply ref, :ok
        end)

      assert log =~ "client declared protocol version (absent)"
      assert_broadcast "stop", payload
      assert payload["version"] == "0"
    end

    # 一致は無音であること。これが無いと「全部 warn する」実装でも上の 2 件が
    # 通ってしまい、閾値のない warn が常時鳴る退行を検出できない。
    test "version が \"0\" なら警告しない" do
      host_id = "lab-pc-2x"
      register_host(host_id)
      @endpoint.subscribe("runner:" <> host_id)
      socket = join_as(:operator)

      log =
        capture_log(fn ->
          ref =
            push(socket, "stop", %{
              "host_id" => host_id,
              "agent_id" => "lab-pc-2x.a",
              "version" => "0"
            })

          assert_reply ref, :ok
        end)

      refute log =~ "client declared protocol version"
      assert_broadcast "stop", payload
      assert payload["version"] == "0"
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
      :ok = AgentDirectory.record(agent_id, @ao["id"], @ao["name"])
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

    # issue #219 D21 acceptance pin: restore は既存どおり unknown persona
    # で fail-closed。persona_id が pack で解決できない agent の restore
    # を「推測で埋めて通す」ことはしない — 消えた pack の agent_id での
    # spawn は不可 (ADR-0029 F3) という既存規範を issue #219 後も保つ。
    test "persona_id が pack で解決できない agent の restore は unknown_persona で拒否される" do
      host_id = "lab-pc-pack-gone"
      agent_id = host_id <> ".rev"
      register_host(host_id)

      :ok =
        AgentStates.put(%{
          "version" => "0",
          "agent_id" => agent_id,
          "persona" => %{"id" => "nonexistent-pack-xyz", "name" => "旧表示", "sprite_set" => "x"},
          "ts" => "2026-06-11T00:00:00Z",
          "type" => "state_change",
          "state" => "disconnected",
          "session_id" => "sess-pack-gone"
        })

      :ok = AgentDirectory.record(agent_id, "nonexistent-pack-xyz", "消えたパックの通称")
      :ok = SessionPointers.record(agent_id, "sess-pack-gone", "/home/user/proj")
      SessionPointers.get(agent_id)
      @endpoint.subscribe("runner:" <> host_id)
      socket = join_as(:operator)

      ref = push(socket, "restore", %{"agent_id" => agent_id})

      assert_reply ref, :error, %{reason: "unknown_persona"}
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

      :ok = AgentDirectory.record(agent_id, @ao["id"], @ao["name"])
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

      :ok = AgentDirectory.record(agent_id, @ao["id"], @ao["name"])
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

      assert %{
               transition_id: transition_id,
               kind: :switch_session,
               phase: :announced
             } = PlannedDisconnects.get(agent_id)

      assert payload["request_id"] == transition_id
      refute_broadcast "spawn", %{}
    end

    test "switch_session の AgentActivity setup が exit しても planned intent を残さない" do
      agent_id = "lab-pc-1.live-swap-setup-exit"
      put_agent(agent_id)
      Process.flag(:trap_exit, true)
      socket = join_as(:operator)
      channel_pid = socket.channel_pid
      monitor_ref = Process.monitor(channel_pid)

      assert :ok =
               Supervisor.terminate_child(
                 KaoiroServer.Supervisor,
                 KaoiroServer.AgentActivity
               )

      try do
        _ref =
          push(socket, "resume_session", %{
            "agent_id" => agent_id,
            "session_id" => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
          })

        assert_receive {:DOWN, ^monitor_ref, :process, ^channel_pid, _reason}, 500
        assert_receive {:EXIT, ^channel_pid, _reason}, 500
        refute PlannedDisconnects.active?(agent_id)
      after
        assert {:ok, _pid} =
                 Supervisor.restart_child(
                   KaoiroServer.Supervisor,
                   KaoiroServer.AgentActivity
                 )
      end
    end

    # ADR-0051 D2 追補 (Q1, クロエ承認 2026-08-08): the counterpart of
    # failure-matrix (c). An ordinary reconnect must NOT replay, but an
    # operator pointing the wrapper at a different session must, or the
    # pane keeps showing the session being left.
    test "hydrated な agent の resume_session は hydration を invalidate する" do
      host_id = "lab-pc-1"
      agent_id = "lab-pc-1.live-swap-hydration"
      put_agent(agent_id)
      {:required, replay_id} = AgentStates.hydration_verdict(agent_id, self())
      :ok = AgentStates.complete_hydration(agent_id, replay_id, self())
      assert :not_required = AgentStates.hydration_verdict(agent_id, self())

      @endpoint.subscribe("runner:" <> host_id)
      socket = join_as(:operator)

      ref =
        push(socket, "resume_session", %{
          "agent_id" => agent_id,
          "session_id" => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        })

      assert_reply ref, :ok
      assert_broadcast "switch_session", %{}
      # 次の wrapper join は replay を要求する。
      assert {:required, _} = AgentStates.hydration_verdict(agent_id, self())
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
      :ok = AgentDirectory.record(agent_id, @ao["id"], @ao["name"])
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
      :ok = AgentDirectory.record(agent_id, @ao["id"], @ao["name"])
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
      :ok = AgentDirectory.record(agent_id, @ao["id"], @ao["name"])
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
      :ok = AgentDirectory.record(agent_id, @ao["id"], @ao["name"])
      _ = AgentDirectory.get(agent_id)

      _operator = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}
      assert_push "directory", %{"entries" => entries}
      # issue #219 D19/spec-gate: wire shape is the JOINED entry —
      # canonical `persona` (fresh-joined against PersonaAssets, not a
      # stored snapshot) plus `display_name`, both string-keyed (the
      # join-time push and the live `handle_out("directory", ...)`
      # intercept produce the IDENTICAL shape).
      assert entries[agent_id] == %{
               "persona" => @ao,
               "display_name" => @ao["name"],
               "last_seen" => nil
             }
    end

    # issue #219 D21/D27 acceptance pin: pack が消えた (persona_id が
    # PersonaAssets で解決不能な) entry は canonical を非開示 ("typed
    # unresolved" — `persona` は `{"id" => ...}` のみ、`name`/`sprite_set`
    # を OMIT、sentinel 文字列は使わない) にしつつ、`display_name` は
    # そのまま維持して開示する。canonical と display_name が食い違う
    # (というより canonical 側が丸ごと欠ける) 状態を直接 pin する。
    test "join 時 operator の directory push: persona_id が pack で解決できない entry は canonical を省略し display_name のみ開示する (issue #219 D21 typed unresolved)" do
      agent_id = "lab-pc-1.dir-pack-gone"
      :ok = AgentDirectory.record(agent_id, "nonexistent-pack-xyz", "消えたパックの通称")

      _operator = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}
      assert_push "directory", %{"entries" => entries}

      assert entries[agent_id] == %{
               "persona" => %{"id" => "nonexistent-pack-xyz"},
               "display_name" => "消えたパックの通称",
               "last_seen" => nil
             }
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
                         "origin" => "operator",
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

      assert %{origin: :operator} = :sys.get_state(KaoiroServer.SessionResets).pending[agent_id]

      assert %{transition_id: ^request_id, kind: :reset, phase: :announced} =
               PlannedDisconnects.get(agent_id)

      # ADR-0055 phase-33 Stage B.
      assert [%{kind: "session_reset_started", trigger: nil}] =
               KaoiroServer.SessionLifecycleEvents.list_for_agent(agent_id)
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

    test "別 lifecycle の planned intent と競合した reset は取得済み lock を cancel する" do
      agent_id = "sess-reset.planned-conflict"
      put_agent_with_caps(agent_id)
      assert :ok = PlannedDisconnects.begin(agent_id, "restart-won", :restart)
      @endpoint.subscribe("runner:sess-reset")
      socket = join_as(:operator)

      ref = push(socket, "session_reset", %{"agent_id" => agent_id, "mode" => "new"})
      assert_reply ref, :error, %{reason: "agent_busy"}
      refute KaoiroServer.SessionResets.pending?(agent_id)
      refute_broadcast "reset_session", _
      assert %{transition_id: "restart-won"} = PlannedDisconnects.get(agent_id)
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
          "origin" => "agent_self",
          "reason" => "WORKLOG を外部化済み",
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

    test "pending 中は admin の instruction も reject される (issue #198)" do
      # admin は operator の上位だが、この guard は権限ではなく順序の
      # 不変条件なので免除しない。免除すると race が戻る (ふじ should 1)。
      agent_id = "gp.instr-admin"
      acquire_reset_lock(agent_id)
      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:admin)

      ref = push(socket, "instruction", %{"agent_id" => agent_id, "text" => "hi"})

      assert_reply ref, :error, %{reason: "session_reset_pending"}
      refute_broadcast "instruction", _

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

    # ふじ must-fix B (#158): guard と relay が同じ live role を見ることを
    # pin する。connect 時の snapshot を guard が見ていた頃は、この 2 本が
    # どちらも逆側へ倒れていた。
    test "昇格した socket も reset-pending guard を通る (snapshot 素通り防止)" do
      agent_id = "gp.promoted"
      acquire_reset_lock(agent_id)
      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:viewer)
      assert_push "snapshot", %{"agents" => _}

      # snapshot は viewer のまま operator へ昇格させる。guard が snapshot を
      # 見ていると viewer 扱いで素通りし、relay 側は live の operator と
      # 判定するので指示が pending 中に通ってしまう。
      Application.put_env(:kaoiro_server, :client_tokens, "tok-viewer:operator")

      ref = push(socket, "instruction", %{"agent_id" => agent_id, "text" => "hi"})

      assert_reply ref, :error, %{reason: "session_reset_pending"}
      refute_broadcast "instruction", _

      _ = KaoiroServer.SessionResets.delete(agent_id)
    end

    test "降格した socket は forbidden 前に dispatch cooldown を汚さない" do
      agent_id = "gp.demoted"
      put_agent(agent_id)
      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      Application.put_env(:kaoiro_server, :client_tokens, "tok-operator:viewer")

      ref = push(socket, "instruction", %{"agent_id" => agent_id, "text" => "hi"})
      assert_reply ref, :error, %{reason: "forbidden"}

      # guard_instruction/1 は成功時に last_dispatch を stamp する。降格済み
      # socket の指示でそれが入ると、正当な reset の cooldown が延びる。
      state = :sys.get_state(KaoiroServer.SessionResets)
      refute Map.has_key?(state.last_dispatch, agent_id)

      _ = KaoiroServer.SessionResets.delete(agent_id)
    end
  end

  # issue #88: LaunchDialog persona-scoped effort default. Two tiers —
  # `compute_launch_defaults/2` is exercised directly against hand-built
  # directory/pointers maps for the full selection matrix (including the
  # legacy `effort_revision: nil` branches — reachable in production from
  # any pointer that predates this feature, just not CONSTRUCTABLE through
  # the current write API in a single test call; see the moduledoc on that
  # function), and the channel wire path is covered separately for the
  # operator gate and the common (revision-bearing) case reachable through
  # the real stores. A migration-path integration test (isolated DETS, the
  # real loader) lives in session_pointers_test.exs / below.
  describe "compute_launch_defaults/2 選択規則 (issue #88)" do
    test "revision が最大の候補を採用する (a)" do
      directory = %{
        "a1" => %{persona_id: "p1"},
        "a2" => %{persona_id: "p1"}
      }

      pointers = %{
        "a1" => %{snapshot: %{"effort" => "low"}, effort_revision: 3},
        "a2" => %{snapshot: %{"effort" => "high"}, effort_revision: 5}
      }

      assert AgentsChannel.compute_launch_defaults(directory, pointers) == %{"p1" => "high"}
    end

    test "revision なし・単独 candidate はそのまま採用する (b)" do
      directory = %{"a1" => %{persona_id: "p2"}}
      pointers = %{"a1" => %{snapshot: %{"effort" => "mid"}, effort_revision: nil}}

      assert AgentsChannel.compute_launch_defaults(directory, pointers) == %{"p2" => "mid"}
    end

    test "revision なし・複数 candidate が同値なら採用する (b)" do
      directory = %{
        "a1" => %{persona_id: "p3"},
        "a2" => %{persona_id: "p3"}
      }

      pointers = %{
        "a1" => %{snapshot: %{"effort" => "high"}, effort_revision: nil},
        "a2" => %{snapshot: %{"effort" => "high"}, effort_revision: nil}
      }

      assert AgentsChannel.compute_launch_defaults(directory, pointers) == %{"p3" => "high"}
    end

    test "revision なし・複数 candidate が不一致なら no preference で persona 自体を除外する (b)" do
      directory = %{
        "a1" => %{persona_id: "p4"},
        "a2" => %{persona_id: "p4"}
      }

      pointers = %{
        "a1" => %{snapshot: %{"effort" => "low"}, effort_revision: nil},
        "a2" => %{snapshot: %{"effort" => "high"}, effort_revision: nil}
      }

      assert AgentsChannel.compute_launch_defaults(directory, pointers) == %{}
    end

    test "revision ありと revision なしが混在しても revision ありが勝つ" do
      directory = %{
        "a1" => %{persona_id: "p5"},
        "a2" => %{persona_id: "p5"}
      }

      pointers = %{
        "a1" => %{snapshot: %{"effort" => "low"}, effort_revision: nil},
        "a2" => %{snapshot: %{"effort" => "high"}, effort_revision: 1}
      }

      assert AgentsChannel.compute_launch_defaults(directory, pointers) == %{"p5" => "high"}
    end

    test "空文字 effort は malformed として defensive に skip される" do
      directory = %{"a1" => %{persona_id: "p6"}}
      pointers = %{"a1" => %{snapshot: %{"effort" => ""}, effort_revision: nil}}

      assert AgentsChannel.compute_launch_defaults(directory, pointers) == %{}
    end

    test "effort フィールド自体が無い snapshot は skip される (haiku 等 effort 非対応モデル)" do
      directory = %{"a1" => %{persona_id: "p7"}}
      pointers = %{"a1" => %{snapshot: %{"model" => "haiku"}, effort_revision: nil}}

      assert AgentsChannel.compute_launch_defaults(directory, pointers) == %{}
    end

    test "persona に id が無い agent は skip され、他 persona には影響しない" do
      directory = %{
        "a1" => %{display_name: "no-id"},
        "a2" => %{persona_id: "p8"}
      }

      pointers = %{
        "a1" => %{snapshot: %{"effort" => "high"}, effort_revision: 1},
        "a2" => %{snapshot: %{"effort" => "low"}, effort_revision: 1}
      }

      assert AgentsChannel.compute_launch_defaults(directory, pointers) == %{"p8" => "low"}
    end

    test "pointer が存在しない agent (SessionPointers 未記録) は skip される" do
      directory = %{"a1" => %{persona_id: "p9"}}

      assert AgentsChannel.compute_launch_defaults(directory, %{}) == %{}
    end

    test "directory が空なら defaults も空" do
      assert AgentsChannel.compute_launch_defaults(%{}, %{}) == %{}
    end
  end

  describe "launch_defaults 経路 (issue #88, f)" do
    test "viewer は forbidden" do
      socket = join_as(:viewer)

      ref = push(socket, "launch_defaults", %{})

      assert_reply ref, :error, %{reason: "forbidden"}
    end

    test "既知 agent が無ければ空 defaults" do
      socket = join_as(:operator)

      ref = push(socket, "launch_defaults", %{})

      assert_reply ref, :ok, %{"defaults" => %{}}
    end

    test "実ストア経由で同一 persona 複数 agent の最新 effort が返る" do
      persona = %{"id" => "gp.ld-persona", "name" => "LD", "sprite_set" => "ao"}
      agent_1 = "gp.ld-rev-1"
      agent_2 = "gp.ld-rev-2"

      :ok = AgentDirectory.record(agent_1, persona["id"], persona["name"])
      :ok = AgentDirectory.record(agent_2, persona["id"], persona["name"])
      :ok = SessionPointers.record(agent_1, "s1", "/home/user/proj")
      :ok = SessionPointers.record(agent_2, "s2", "/home/user/proj")

      :ok =
        SessionPointers.record_snapshot(agent_1, %{
          "effort" => "low",
          "effort_source" => "launch"
        })

      _ = SessionPointers.get(agent_1)

      # Committed strictly after agent_1's, so its effort_revision is higher
      # regardless of what other (unrelated) tests bumped the counter to.
      :ok =
        SessionPointers.record_snapshot(agent_2, %{
          "effort" => "high",
          "effort_source" => "launch"
        })

      _ = SessionPointers.get(agent_2)

      socket = join_as(:operator)
      ref = push(socket, "launch_defaults", %{})

      assert_reply ref, :ok, %{"defaults" => defaults}
      assert defaults["gp.ld-persona"] == "high"
    end
  end

  describe "list_conversations 経路 (issue #276, require_operator ゲート)" do
    test "viewer は forbidden" do
      socket = join_as(:viewer)

      ref = push(socket, "list_conversations", %{})

      assert_reply ref, :error, %{reason: "forbidden"}
    end

    test "operator は ConversationStates の内容を受け取る" do
      cid = "gp.list-conv-#{System.unique_integer([:positive])}"

      assert :ok =
               ConversationStates.record_message(cid, "gp.lc-a", "gp.lc-b", "hi", 1, false, true)

      socket = join_as(:operator)
      ref = push(socket, "list_conversations", %{})

      assert_reply ref, :ok, %{"conversations" => conversations}

      assert %{
               "conversation_id" => ^cid,
               "participants" => ["gp.lc-a", "gp.lc-b"],
               "status" => "open"
             } = Enum.find(conversations, &(&1["conversation_id"] == cid))
    end

    test "admin も通る (require_operator は operator/admin いずれも許可)" do
      socket = join_as(:admin)

      ref = push(socket, "list_conversations", %{})

      assert_reply ref, :ok, %{"conversations" => conversations}
      assert is_list(conversations)
    end
  end

  describe "list_users 経路 (issue #207)" do
    test "viewer は forbidden" do
      socket = join_as(:viewer)

      ref = push(socket, "list_users", %{})

      assert_reply ref, :error, %{reason: "forbidden"}
    end

    test "operator は Users.all_with_role/1 の内容を受け取る (id/kind/display_name/role)" do
      on_exit(fn -> Application.delete_env(:kaoiro_server, :oauth_allowlist_path) end)

      KaoiroServer.OAuthAllowlistFixture.put_allowlist("github:list-users-1:viewer\n")

      user =
        KaoiroServer.Users.get_or_create({:oauth, "github", "list-users-1"}, "user", "R")

      socket = join_as(:operator)
      ref = push(socket, "list_users", %{})

      assert_reply ref, :ok, %{"users" => users}

      entry = Enum.find(users, &(&1.id == user.id))
      assert %{id: id, kind: "user", display_name: "R", role: :viewer} = entry
      assert id == user.id

      # code-review-assessment (issue #207): a plain map pattern match
      # (the assertion just above) only asserts these 4 keys are
      # PRESENT — Elixir map patterns do not reject extras, so it would
      # still pass if the handler leaked an extra field (e.g. `source`)
      # onto the wire. This closed-key-set check is what actually pins
      # the boundary the handler's own comment claims to hold.
      assert Map.keys(entry) |> Enum.sort() == [:display_name, :id, :kind, :role]
    end

    test "admin も通る (require_operator は operator/admin いずれも許可)" do
      socket = join_as(:admin)

      ref = push(socket, "list_users", %{})

      assert_reply ref, :ok, %{"users" => users}
      assert is_list(users)
    end
  end

  describe "list_session_events 経路 (issue #200, ADR-0055, require_operator ゲート)" do
    # `SessionLifecycleEvents.append/4` casts, so it returns before the
    # store necessarily processed it. `:sys.get_state/1` forces a
    # synchronous round trip through the SAME mailbox, so any append
    # issued before it is guaranteed processed by the time this returns —
    # a deterministic barrier instead of relying on the channel
    # round-trip's own latency to win the race.
    defp sync_lifecycle_store do
      _ = :sys.get_state(KaoiroServer.SessionLifecycleEvents)
    end

    test "viewer は forbidden" do
      socket = join_as(:viewer)

      ref = push(socket, "list_session_events", %{"agent_id" => "test.lse-viewer"})

      assert_reply ref, :error, %{reason: "forbidden"}
    end

    test "operator は agent の session_lifecycle timeline を newest-first で受け取る" do
      agent_id = "test.lse-happy-#{System.unique_integer([:positive])}"

      SessionLifecycleEvents.append(agent_id, "compacting", nil, "2026-08-31T00:00:01Z")

      SessionLifecycleEvents.append(
        agent_id,
        "compact_boundary",
        "request_compact",
        "2026-08-31T00:00:02Z"
      )

      sync_lifecycle_store()

      socket = join_as(:operator)
      ref = push(socket, "list_session_events", %{"agent_id" => agent_id})

      assert_reply ref, :ok, %{"events" => events}

      assert events == [
               %{
                 "kind" => "compact_boundary",
                 "trigger" => "request_compact",
                 "at" => "2026-08-31T00:00:02Z"
               },
               %{"kind" => "compacting", "trigger" => nil, "at" => "2026-08-31T00:00:01Z"}
             ]
    end

    test "admin も通る (require_operator は operator/admin いずれも許可)" do
      socket = join_as(:admin)

      ref = push(socket, "list_session_events", %{"agent_id" => "test.lse-admin"})

      assert_reply ref, :ok, %{"events" => []}
    end

    test "agent_id 欠落は missing_agent_id" do
      socket = join_as(:operator)

      ref = push(socket, "list_session_events", %{})

      assert_reply ref, :error, %{reason: "missing_agent_id"}
    end

    test "agent_id の charset 違反は invalid_agent_id" do
      socket = join_as(:operator)

      ref = push(socket, "list_session_events", %{"agent_id" => "bad id!"})

      assert_reply ref, :error, %{reason: "invalid_agent_id"}
    end

    test "未知の agent_id は error ではなく空配列を返す (existence check 無し)" do
      socket = join_as(:operator)

      ref = push(socket, "list_session_events", %{"agent_id" => "test.lse-never-existed"})

      assert_reply ref, :ok, %{"events" => []}
    end

    # delete_agent の purge_agent_records/1 は SessionLifecycleEvents を
    # purge 対象に含まないため履歴は残り、fetch_agent_id/
    # fetch_restorable_agent_id と違い existence check を課さないこの
    # クエリなら削除後も問い合わせを継続できる — 事後デバッグ・監査と
    # いう機能の狙いに直結する挙動。
    test "削除済み agent の履歴も問い合わせ可能 (delete_agent は SessionLifecycleEvents を purge しない)" do
      agent_id = "test.lse-deleted-#{System.unique_integer([:positive])}"
      put_disconnected(agent_id)
      SessionLifecycleEvents.append(agent_id, "conversation_reset", nil, "2026-08-31T00:00:01Z")
      sync_lifecycle_store()

      socket = join_as(:operator)
      assert_push "snapshot", %{"agents" => _}

      ref = push(socket, "delete_agent", %{"agent_id" => agent_id})
      assert_reply ref, :ok, %{}, @purge_reply_timeout
      assert_broadcast "agent_deleted", %{"agent_id" => ^agent_id}
      refute AgentStates.known?(agent_id)
      assert AgentDirectory.get(agent_id) == nil

      ref2 = push(socket, "list_session_events", %{"agent_id" => agent_id})

      assert_reply ref2, :ok, %{
        "events" => [%{"kind" => "conversation_reset", "trigger" => nil, "at" => _}]
      }
    end
  end

  # ふじ独立レビュー round 2: 上の exact-key-set test は
  # `Users.all_with_role/1` を経由するため、`Users`(現状ちょうど 4 key
  # しか返さない)の CURRENT な形に依存している — `project_user_entry/1`
  # の projection コードそのものを取り除いても、`Users` が 4 key しか
  # 返さない限り exact-key-set assertion は依然 green のままで、
  # projection の存在を独立に検証できていなかった。この describe は
  # `project_user_entry/1` を `Users` を経由せず直接呼び、5 key 目
  # (`source`)を手で与えた入力に対して projection 単独が正しく
  # ストリップすることを、`Users` の CURRENT な形とは無関係に pin する。
  describe "project_user_entry/1 (issue #207 のprojectionを単独で検証する)" do
    test "id/kind/display_name/role の 4 key だけを返し、それ以外の key (例: source) は落とす" do
      entry = %{
        id: "u1",
        kind: "user",
        display_name: "R",
        role: :viewer,
        source: {:oauth, "github", "leaked"}
      }

      assert KaoiroServerWeb.AgentsChannel.project_user_entry(entry) == %{
               id: "u1",
               kind: "user",
               display_name: "R",
               role: :viewer
             }
    end
  end

  describe "close_conversation 経路 (issue #276, manual close)" do
    test "viewer は forbidden" do
      socket = join_as(:viewer)

      ref = push(socket, "close_conversation", %{"conversation_id" => "c"})

      assert_reply ref, :error, %{reason: "forbidden"}
    end

    test "operator の close は :ok を返し、両 participants へ conversation_closed 通知を broadcast する" do
      cid = "gp.close-conv-#{System.unique_integer([:positive])}"
      a = "gp.cc-a-#{System.unique_integer([:positive])}"
      b = "gp.cc-b-#{System.unique_integer([:positive])}"
      assert :ok = ConversationStates.record_message(cid, a, b, "hi", 1, false, true)

      @endpoint.subscribe("wrapper:" <> a)
      @endpoint.subscribe("wrapper:" <> b)

      socket = join_as(:operator)
      ref = push(socket, "close_conversation", %{"conversation_id" => cid})

      assert_reply ref, :ok, %{}

      # deliver_conversation_closed (issue #221 の GC 経路と同じ関数) が
      # 各 participant の wrapper トピックへ synth envelope を broadcast
      # する — kind=done / meta.done=true が wrapper 側の "server 発
      # closed" 判定 (agent-common receiveInbound) の契約 (SynthEnvelope
      # のモジュール doc)。
      assert_broadcast "envelope", %{
        "agent_id" => "server",
        "payload" => %{"to" => ^a, "conversation_id" => ^cid, "kind" => "done"}
      }

      assert_broadcast "envelope", %{
        "agent_id" => "server",
        "payload" => %{"to" => ^b, "conversation_id" => ^cid, "kind" => "done"}
      }

      assert %{status: :closed, reason: :operator_closed} = ConversationStates.get(cid)
    end

    test "既に closed な会話への close は conversation_closed エラー (冪等)" do
      cid = "gp.close-conv-twice-#{System.unique_integer([:positive])}"
      assert :ok = ConversationStates.record_message(cid, "gp.a", "gp.b", "x", 1, true, true)

      assert :both_done =
               ConversationStates.record_message(cid, "gp.b", "gp.a", "y", 2, true, true)

      socket = join_as(:operator)
      ref = push(socket, "close_conversation", %{"conversation_id" => cid})

      assert_reply ref, :error, %{reason: "conversation_closed"}
    end

    test "存在しない conversation_id への close は unknown_conversation_id" do
      socket = join_as(:operator)
      ref = push(socket, "close_conversation", %{"conversation_id" => "no-such-cid"})

      assert_reply ref, :error, %{reason: "unknown_conversation_id"}
    end

    test "conversation_id 欠落は missing_conversation_id" do
      socket = join_as(:operator)
      ref = push(socket, "close_conversation", %{})

      assert_reply ref, :error, %{reason: "missing_conversation_id"}
    end
  end

  # ふじ review 2026-08-05, should-fix 1: the pure-selection test above and
  # SessionPointers' own legacy-loader unit test cover the pieces
  # separately; this connects them — a REAL isolated SessionPointers
  # instance loads pre-#88 5-tuples off disk (no test-only shortcut), and
  # the resulting `effort_revision: nil` pointers feed
  # `compute_launch_defaults/2` directly. Isolated instance, not the app
  # singleton — no need to restart the shared store for this.
  describe "migration 統合: legacy 5-tuple -> compute_launch_defaults (issue #88, should-fix 1)" do
    test "異 effort の legacy 2 agent は no preference、片方が正常 commit すると revisioned candidate が勝つ" do
      name = :"sp_migration_#{System.unique_integer([:positive])}"
      path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "#{name}.dets"])
      File.rm(path)
      {:ok, _pid} = SessionPointers.start_link(name: name, path: path)

      # Safety net for both a mid-test assertion failure (the explicit
      # GenServer.stop/1 calls below would then never run) and the normal
      # path (stop_quietly/1 on an already-stopped registered name is a
      # no-op). Uses the ATOM `name`, not a captured pid, so it resolves
      # to whichever process is currently registered even across the
      # mid-test restart below (ふじ review, test hygiene).
      on_exit(fn ->
        stop_quietly(name)
        File.rm(path)
      end)

      agent_1 = "gp.ld-legacy-1"
      agent_2 = "gp.ld-legacy-2"

      # Seed pre-#88 legacy 5-tuples directly on the DETS table (same
      # technique as session_pointers_test.exs) — bypasses
      # record_snapshot's revision-assigning write path entirely, so the
      # loaded pointer is exactly what a pre-feature row looks like.
      :ok =
        :dets.insert(
          name,
          {agent_1, "s1", "/w", nil, %{"effort" => "low", "effort_source" => "launch"}}
        )

      :ok =
        :dets.insert(
          name,
          {agent_2, "s2", "/w", nil, %{"effort" => "high", "effort_source" => "launch"}}
        )

      :ok = GenServer.stop(name)
      {:ok, _pid} = SessionPointers.start_link(name: name, path: path)

      persona_id = "gp.ld-legacy-persona"

      directory = %{
        agent_1 => %{persona_id: persona_id, last_seen: nil},
        agent_2 => %{persona_id: persona_id, last_seen: nil}
      }

      pointers = SessionPointers.all(name)
      assert %{effort_revision: nil, snapshot: %{"effort" => "low"}} = pointers[agent_1]
      assert %{effort_revision: nil, snapshot: %{"effort" => "high"}} = pointers[agent_2]

      # Two disagreeing legacy candidates, neither revisioned -> no
      # preference (selection rule 4).
      assert AgentsChannel.compute_launch_defaults(directory, pointers) == %{}

      # agent_2 gets a real commit -> lazy migration assigns it a revision.
      :ok =
        SessionPointers.record_snapshot(
          agent_2,
          %{"effort" => "high", "effort_source" => "launch"},
          name
        )

      pointers_after = SessionPointers.all(name)
      assert %{effort_revision: rev} = pointers_after[agent_2]
      assert is_integer(rev)

      assert AgentsChannel.compute_launch_defaults(directory, pointers_after) ==
               %{"gp.ld-legacy-persona" => "high"}

      GenServer.stop(name)
    end
  end

  # ADR-0015 の受信側規則を server -> wrapper 経路で pin する (issue #218)。
  #
  # runner 経路 (relay_to_runner/4) は #182 で閉じていたが、wrapper 経路は
  # 「client が付けていないので届かない」状態のまま残っていた。#218 で
  # relay/5 が version を stamp するようになり、受信側の warn は
  # require_operator/4 に溶接された。ここで pin するのはその 2 点。
  describe "server -> wrapper の version stamp と受信側検査 (issue #218, ADR-0015)" do
    # relay/5 経路の代表として set_model を使う。instruction / interrupt /
    # permission_decision / question_response / set_effort / refresh_models /
    # set_permission_mode は同じ relay/5 を通るので helper 単位で 1 本。
    test "client が version を送らなくても wrapper には v0 が届き、欠落は警告される" do
      agent_id = "test.v218-absent"
      put_agent(agent_id)
      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:operator)

      log =
        capture_log(fn ->
          ref = push(socket, "set_model", %{"agent_id" => agent_id, "model" => "opus"})
          assert_reply ref, :ok
        end)

      assert log =~ "set_model: client declared protocol version (absent)"
      assert_broadcast "set_model", payload
      assert payload["version"] == "0"
      assert payload["model"] == "opus"
    end

    test "version 不一致は警告した上で v0 へ normalize して relay する" do
      agent_id = "test.v218-mismatch"
      put_agent(agent_id)
      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:operator)

      log =
        capture_log(fn ->
          ref =
            push(socket, "set_model", %{
              "agent_id" => agent_id,
              "model" => "opus",
              "version" => "99"
            })

          assert_reply ref, :ok
        end)

      assert log =~ "client declared protocol version"
      assert log =~ "\"99\""
      # ベストエフォート受理: 不一致でも relay は止まらない。
      assert_broadcast "set_model", payload
      assert payload["version"] == "0"
    end

    # 一致が無音であることを pin しないと、「常時 warn する」実装でも上の
    # 2 件は通ってしまう。
    test "version が \"0\" なら警告しない" do
      agent_id = "test.v218-match"
      put_agent(agent_id)
      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:operator)

      log =
        capture_log(fn ->
          ref =
            push(socket, "set_model", %{
              "agent_id" => agent_id,
              "model" => "opus",
              "version" => "0"
            })

          assert_reply ref, :ok
        end)

      refute log =~ "client declared protocol version"
      assert_broadcast "set_model", payload
      assert payload["version"] == "0"
    end

    # relay されない (server が直接応答する) event でも同じ検査が走ること。
    # #88 / #197 段階3 で二度 must-fix になった誤読 —「runner に中継され
    # ないから version 不要」— が再発しない側の pin。
    test "relay されない event (clear_history) でも version を検査する" do
      agent_id = "test.v218-direct"
      put_agent(agent_id)
      socket = join_as(:operator)

      log =
        capture_log(fn ->
          ref = push(socket, "clear_history", %{"agent_id" => agent_id, "version" => "99"})
          # 検査は受理可否に影響しない (この agent には current session が
          # 無いので no_current_session で返る) — warn されることが主題。
          assert_reply ref, :error, _
        end)

      assert log =~ "clear_history: client declared protocol version"
      assert log =~ "\"99\""
    end

    # 検査を role gate の AFTER に置いている理由の pin。viewer が version を
    # 詐称して warn ログを焚けると、認証前のログ書き込み手段になる。
    test "viewer の不正 version は warn を出さない (role gate が先)" do
      agent_id = "test.v218-viewer"
      put_agent(agent_id)
      socket = join_as(:viewer)

      log =
        capture_log(fn ->
          ref =
            push(socket, "set_model", %{
              "agent_id" => agent_id,
              "model" => "opus",
              "version" => "99"
            })

          assert_reply ref, :error, %{reason: "forbidden"}
        end)

      refute log =~ "client declared protocol version"
    end

    # サイズ上限は stamp 後の map に掛かること (こはく D2 の付帯要請)。
    # stamp 前の map を測っていると、上限ぴったりの payload が stamp 分だけ
    # 超過したまま wrapper へ届く。
    test "relay サイズ上限は version stamp 込みで判定される (境界)" do
      agent_id = "test.v218-size"
      put_agent(agent_id)
      @endpoint.subscribe("wrapper:" <> agent_id)
      socket = join_as(:operator)

      # AgentsChannel の @max_relay_bytes と同値。
      max_bytes = 131_072

      probe = fn len ->
        :erlang.external_size(%{"model" => "m", "blob" => :binary.copy("a", len)})
      end

      # external_size はバイナリ長に対して傾き 1 なので 1 回の補正で一致する。
      exact_len = 130_000 + (max_bytes - probe.(130_000))

      # 前提そのものを assert する: 以下の判定は「stamp 前がちょうど上限」に
      # 依存しており、ここがズレるとテストが測る対象も変わる。
      assert probe.(exact_len) == max_bytes

      ref =
        push(socket, "set_model", %{
          "agent_id" => agent_id,
          "model" => "m",
          "blob" => :binary.copy("a", exact_len)
        })

      assert_reply ref, :error, %{reason: "payload_too_large"}
      refute_broadcast "set_model", %{}
    end
  end

  # ふじ #218 レビュー MF-1: scalar payload での crash regression。
  #
  # 親 74a545c では `Map.delete/2` が全 shape check の後に走っていたが、
  # #218 で normalize を `with` の手前へ hoist した結果、raw websocket から
  # の非 map payload が role 解決前に BadMapError で落ちるようになった。
  # relay/5 経路も同じ helper を通るので、attach_* だけの問題ではない。
  describe "非 map payload の防御 (issue #218 ふじ MF-1)" do
    @non_map_events ["attach_open", "attach_close", "instruction", "set_model"]

    test "operator の scalar payload は crash せず missing_agent_id を返す" do
      socket = join_as(:operator)

      for event <- @non_map_events do
        ref = push(socket, event, "not-a-map")
        assert_reply ref, :error, %{reason: reason}, 1000
        assert reason == "missing_agent_id", "#{event}: got #{inspect(reason)}"
      end
    end

    # shape gate は role 解決より前に走るので、viewer にも `forbidden` では
    # なく shape 判定が返る。これは意図した優先順位で、role を gate 内で
    # 解決すると #158 が閉じた「1 メッセージ 1 回だけ解決する」性質が壊れる
    # (2 回目の解決の間に role 変更が挟まると disconnect broadcast が二重に
    # 出る)。malformed payload への shape 判定は viewer 自身の入力について
    # の verdict でしかなく、サーバ側の状態を一切開示しない。
    test "viewer の scalar payload も crash せず fail-closed に返る" do
      socket = join_as(:viewer)

      for event <- @non_map_events do
        ref = push(socket, event, "not-a-map")
        assert_reply ref, :error, %{reason: "missing_agent_id"}, 1000
      end
    end

    # 上の優先順位が「role gate が死んだ」ことを意味しないことの pin。
    # well-formed payload では従来どおり viewer は forbidden で弾かれる。
    test "well-formed payload では viewer は従来どおり forbidden" do
      agent_id = "test.mf1-role"
      put_agent(agent_id)
      socket = join_as(:viewer)

      ref = push(socket, "set_model", %{"agent_id" => agent_id, "model" => "opus"})
      assert_reply ref, :error, %{reason: "forbidden"}
    end

    # list / 数値も map ではない。binary だけを弾く実装に縮退していないこと。
    test "list / 数値 payload も同様に扱う" do
      socket = join_as(:operator)

      for payload <- [["a"], 42, nil] do
        ref = push(socket, "attach_open", payload)
        assert_reply ref, :error, %{reason: "missing_agent_id"}, 1000
      end
    end
  end

  # ふじ #218 レビュー MF-3: 「全 inbound handler が version 検査付き gate を
  # 通る」という protocol.md の主張が構造として pin されていなかった。
  # `delete_agent` の `require_operator/4` を `require_operator_role/1` へ
  # 差し替えても全 1147 件が green のままだった (実測)。
  #
  # 対象一覧をテスト側に手書きすると一覧外の追加を拾えないので、**モジュール
  # 自身の AST から event 名を列挙**する。新しい `handle_in` 節を足せば、その
  # event は自動でこの検査の対象に入る。
  #
  # 検査は構文ではなく**挙動**で行う: operator として不正 version を push し、
  # gate の warn が出ることを確かめる。role gate だけ残して version 検査を
  # 外す (= ふじの mutation) と warn が消えるので red になる。
  describe "inbound gate の網羅性 (issue #218 ふじ MF-3)" do
    @channel_source "lib/kaoiro_server_web/channels/agents_channel.ex"

    # ADR-0015 の恒久 carve-out。binary frame は version キーを置く JSON
    # オブジェクトを持たないため、この event だけ gate を通さない
    # (protocol.md 「version 棚卸し」)。ここに足さない限り、検査を外した
    # event は下のテストで落ちる。
    @version_gate_exempt ["attach_chunk"]

    # `def handle_in(...)` の第 1 引数がリテラル文字列の節だけを拾う。
    # 非 map payload の shape gate は `handle_in(event, payload, socket)` と
    # 変数で受けるので、ここでは自然に除外される。
    defp inbound_events do
      @channel_source
      |> File.read!()
      |> Code.string_to_quoted!()
      |> Macro.prewalk([], fn
        {:def, _, [{:when, _, [{:handle_in, _, [event | _]}, _guard]} | _]} = node, acc ->
          {node, [event | acc]}

        {:def, _, [{:handle_in, _, [event | _]} | _]} = node, acc ->
          {node, [event | acc]}

        node, acc ->
          {node, acc}
      end)
      |> elem(1)
      |> Enum.filter(&is_binary/1)
      |> Enum.uniq()
      |> Enum.sort()
    end

    test "AST 列挙が実際に機能している (vacuous green の防止)" do
      events = inbound_events()

      # 列挙が壊れて空/極小になったら、下の網羅テストは無条件 green になる。
      assert length(events) >= 20, "列挙できた event は #{length(events)} 件"
      # 既知の代表を含むこと。パーサ節の取りこぼしはここで出る。
      for known <- ~w(instruction spawn delete_agent rename_user attach_chunk) do
        assert known in events, "#{known} が AST 列挙から漏れている"
      end
    end

    test "carve-out は attach_chunk ただ 1 件であること" do
      assert @version_gate_exempt == ["attach_chunk"]
    end

    test "carve-out 以外の全 inbound event が version 検査付き gate を通る" do
      socket = join_as(:operator)

      for event <- inbound_events(), event not in @version_gate_exempt do
        log =
          capture_log(fn ->
            # 存在しない agent_id を使うので、gate 通過後の検証は必ず失敗して
            # 終わる = 副作用ゼロ。見たいのは gate を通ったかどうかだけ。
            push(socket, event, %{
              "agent_id" => "test.gate-probe-absent",
              "version" => "99"
            })

            # push は非同期なので、channel プロセスが処理し終えるまで同期する。
            _ = :sys.get_state(socket.channel_pid)
          end)

        assert log =~ "#{event}: client declared protocol version",
               "#{event} が version 検査付き gate を通っていない " <>
                 "(require_operator/4 を迂回している可能性)"
      end
    end
  end

  describe "ADR-0015 stage 2 server -> client egress funnel (issue #270)" do
    test "T4-1: join-time の6種は version を stamp する" do
      _socket = join_as(:operator)

      for event <- ~w(snapshot task_snapshot delivery_snapshot history hosts directory) do
        assert_push ^event, %{"version" => "0"}
      end
    end

    test "T4-2: 個別 handle_out 4種は version を stamp する" do
      _socket = join_as(:operator)

      for {event, payload} <- [
            {"history_cleared", %{"agent_id" => "t4.clear"}},
            {"directory", %{"entries" => []}},
            {"history_reset", %{"agent_id" => "t4.reset"}},
            {"history_replay_complete", %{"agent_id" => "t4.complete"}}
          ] do
        KaoiroServerWeb.Endpoint.broadcast("agents:lobby", event, payload)
        assert_push ^event, %{"version" => "0"}
      end
    end

    test "T4-3: catch-all 8種は version を stamp する" do
      _socket = join_as(:operator)

      for event <- ~w(
            runner_sessions spawn_result hosts catalog_result
            session_reset_started session_reset_completed session_reset_failed delivery_status
          ) do
        KaoiroServerWeb.Endpoint.broadcast("agents:lobby", event, %{"request_id" => "t4"})
        assert_push ^event, %{"version" => "0"}
      end
    end

    test "T4-4: agent_deleted は viewer 配信を保ち version を stamp する" do
      _socket = join_as(:viewer)
      assert_push "snapshot", %{"version" => "0"}

      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "agent_deleted", %{
        "agent_id" => "t4.deleted"
      })

      assert_push "agent_deleted", %{"agent_id" => "t4.deleted", "version" => "0"}
    end

    test "T4-5: history_replay_envelope は flat version を stamp する" do
      _socket = join_as(:operator)

      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "history_replay_envelope", %{
        "pane_agent_id" => "t4.pane",
        "envelope" => %{"agent_id" => "t4.peer"}
      })

      assert_push "history_replay_envelope", %{"version" => "0"}
    end

    test "T4-6: envelope は frame version を server が確定する" do
      _socket = join_as(:operator)

      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "envelope", %{
        "version" => "9",
        "agent_id" => "t4.envelope",
        "ts" => "2026-08-21T00:00:00Z",
        "type" => "state_change",
        "state" => "idle"
      })

      assert_push "envelope", %{"version" => "0", "agent_id" => "t4.envelope"}
    end

    test "T4-7: policy は19種のみを許可し、未宣言 event は funnel で拒否する" do
      policy = AgentsChannel.client_event_policy()

      assert MapSet.size(policy) == 19
      refute MapSet.member?(policy, "not_declared")

      source = File.read!("lib/kaoiro_server_web/channels/agents_channel.ex")
      assert source =~ "is not declared in @client_event_policy"
    end

    test "join snapshot frame の event/key 対応は不足も取り違えも拒否する" do
      frames = %{
        "snapshot" => %{"agents" => %{}},
        "task_snapshot" => %{"tasks" => %{}},
        "delivery_snapshot" => %{"deliveries" => %{}}
      }

      assert :ok = AgentsChannel.validate_join_snapshot_frames(frames)

      assert {:error, :snapshot_frame_key_mismatch} =
               AgentsChannel.validate_join_snapshot_frames(
                 Map.delete(frames, "delivery_snapshot")
               )

      assert {:error, :snapshot_frame_key_mismatch} =
               AgentsChannel.validate_join_snapshot_frames(%{
                 frames
                 | "task_snapshot" => %{"deliveries" => %{}}
               })
    end

    test "T4-8: raw push は push_versioned の本体の1箇所だけ" do
      {:ok, ast} =
        "lib/kaoiro_server_web/channels/agents_channel.ex"
        |> File.read!()
        |> Code.string_to_quoted()

      raw_pushes =
        ast
        |> Macro.prewalker()
        |> Enum.filter(fn
          {:push, _, [{:socket, _, _}, _event, _payload]} -> true
          _ -> false
        end)

      assert length(raw_pushes) == 1
    end
  end
end
