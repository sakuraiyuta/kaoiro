defmodule KaoiroServerWeb.DeliveryPolicyTest do
  use KaoiroServerWeb.ChannelCase, async: false
  alias KaoiroServer.{AgentAcceptance, AgentDirectory, AgentStates, DeliveryPolicies, WorkStore}
  alias KaoiroServerWeb.{AgentsChannel, ClientSocket, WrapperChannel, WrapperSocket}

  # CI scales receive budgets; the elapsed-time assertions still reject the
  # policy owner's one-second stall even if its reply arrives within that budget.

  setup do
    previous = Application.get_env(:kaoiro_server, :client_tokens)

    Application.put_env(
      :kaoiro_server,
      :client_tokens,
      "dp-operator:operator,dp-viewer:viewer,dp-admin:admin"
    )

    on_exit(fn ->
      if previous,
        do: Application.put_env(:kaoiro_server, :client_tokens, previous),
        else: Application.delete_env(:kaoiro_server, :client_tokens)
    end)

    %{id: "fuji559-channel-#{System.unique_integer([:positive])}"}
  end

  defp client(role) do
    fingerprint = KaoiroServer.Auth.socket_id("dp-#{role}")

    {:ok, _, socket} =
      ClientSocket
      |> socket(nil, %{
        role: role,
        credential: {:token_fingerprint, fingerprint},
        socket_id: fingerprint
      })
      |> subscribe_and_join(AgentsChannel, "agents:lobby")

    socket
  end

  defp modes(early \\ "steer"),
    do: %{"version" => "v1", "early" => early, "yield" => "none", "stage_reports" => true}

  defp wrapper(id, options \\ %{}, seed_state? \\ true) do
    params =
      Map.merge(
        %{
          "persona_id" => "default",
          "inter_agent_delivery_modes" => modes(),
          "inter_agent_reply_basis" => "v1",
          "inter_agent_delivery_ack" => "dispatch-v1",
          "delivery_generation" => id,
          "delivery_resync" => "skip-v1"
        },
        options
      )

    {:ok, reply, socket} =
      WrapperSocket
      |> socket(nil, %{})
      |> subscribe_and_join(WrapperChannel, "wrapper:" <> id, params)

    if seed_state?, do: assert_reply(push(socket, "envelope", state(id)), :ok)
    {reply, socket}
  end

  defp state(id),
    do: %{
      "version" => "0",
      "agent_id" => id,
      "persona" => %{"id" => "default", "name" => "Default", "sprite_set" => "default"},
      "ts" => "2026-10-09T00:00:00Z",
      "type" => "state_change",
      "state" => "idle",
      "payload" => %{},
      "ext" => %{}
    }

  defp request(id, policy, expected),
    do: %{"version" => "0", "agent_id" => id, "policy" => policy, "expected_revision" => expected}

  defp with_suspended(name, fun) do
    pid = Process.whereis(name)
    assert is_pid(pid)
    :ok = :sys.suspend(pid)

    try do
      fun.()
    after
      :sys.resume(pid)
    end
  end

  defp notification(id, "permission_request") do
    %{
      state(id)
      | "type" => "permission_request",
        "state" => "waiting_permission",
        "payload" => %{"request_id" => id <> "-permission", "tool_name" => "Bash", "input" => %{}}
    }
  end

  defp notification(id, "question_request") do
    %{
      state(id)
      | "type" => "question_request",
        "state" => "waiting_question",
        "payload" => %{
          "request_id" => id <> "-question",
          "questions" => [
            %{
              "question" => "Choice?",
              "header" => "Choice",
              "multiSelect" => false,
              "options" => [%{"label" => "A", "description" => "a"}]
            }
          ]
        }
    }
  end

  defp notification(id, "state_change"), do: state(id)

  test "lobby declares policy controls and read is role-first, exact and side-effect free", %{
    id: id
  } do
    AgentDirectory.record(id, "default", "Policy")
    viewer = client(:viewer)
    operator = client(:operator)
    @endpoint.subscribe("wrapper:" <> id)
    read = %{"version" => "0", "agent_id" => id}

    for target <- [id, id <> "-unknown"] do
      assert_reply push(viewer, "get_delivery_policy", %{read | "agent_id" => target}), :error, %{
        reason: "forbidden"
      }
    end

    assert_reply push(operator, "get_delivery_policy", read), :ok, %{
      "agent_id" => ^id,
      "delivery_policy" => %{"policy" => "unknown"}
    }

    assert {:ok, nil} = DeliveryPolicies.get(id)
    assert :dets.lookup(DeliveryPolicies, {:counter, id}) == []
    refute_broadcast "delivery_policy", _

    for bad <- [Map.put(read, "extra", true), Map.delete(read, "version")] do
      assert_reply push(operator, "get_delivery_policy", bad), :error, %{
        reason: "invalid_payload"
      }
    end

    assert_reply push(operator, "get_delivery_policy", %{read | "agent_id" => id <> "-unknown"}),
                 :error,
                 %{reason: "unknown_agent"}

    assert {:ok, %{delivery_policy_control: "v1"}, _} =
             ClientSocket
             |> socket(nil, %{
               role: :operator,
               credential: {:token_fingerprint, KaoiroServer.Auth.socket_id("dp-operator")},
               socket_id: KaoiroServer.Auth.socket_id("dp-operator")
             })
             |> subscribe_and_join(AgentsChannel, "agents:lobby")
  end

  test "fresh read, event and viewer projection use only current-owner mechanisms", %{id: id} do
    {_, a} = wrapper(id, %{"delivery_policy" => "v1"})
    operator = client(:operator)
    read = %{"version" => "0", "agent_id" => id}

    assert_reply push(operator, "get_delivery_policy", read), :ok, %{
      "delivery_policy" => %{"mechanisms" => %{"operator_early" => "steer"}}
    }

    replacement =
      start_supervised!(
        {Task,
         fn ->
           receive do
             :stop -> :ok
           end
         end}
      )

    on_exit(fn -> WorkStore.unregister_modes(id, replacement) end)

    for declared <- [modes("none"), nil] do
      :ok =
        WorkStore.register_delivery(id, replacement, declared, false, %{"early" => "none"}, true)

      :ok = WorkStore.unregister_modes(id, a.channel_pid)
      assert {:error, :policy_unconfirmed} = WorkStore.acknowledge_policy(id, a.channel_pid, 1)

      assert_reply push(operator, "get_delivery_policy", read), :ok, %{
        "delivery_policy" => %{
          "mechanisms" => %{
            "operator_early" => "none",
            "inter_agent_early" => "none",
            "inter_agent_yield" => "none"
          }
        }
      }

      view = KaoiroServer.DeliveryPolicyAdmission.refresh(id).view
      assert view["mechanisms"]["inter_agent_early"] == "none"
      assert_push "delivery_policy_changed", %{"agent_id" => ^id, "delivery_policy" => ^view}

      assert {:ok, sanitized} =
               KaoiroServerWeb.ViewerAgentProjection.sanitize(%{
                 state(id)
                 | "ext" => %{"delivery_policy" => view}
               })

      assert sanitized["ext"]["delivery_policy"]["mechanisms"] == view["mechanisms"]
    end

    :ok = WorkStore.unregister_modes(id, replacement)

    assert_reply push(operator, "get_delivery_policy", read), :ok, %{
      "delivery_policy" => disconnected
    }

    refute Map.has_key?(disconnected, "mechanisms")
  end

  test "operator none does not fall back and viewer mechanisms expose only valid enums", %{id: id} do
    {_, _} = wrapper(id, %{"operator_input_modes" => %{"version" => "v1", "early" => "none"}})
    operator = client(:operator)

    assert_reply push(operator, "get_delivery_policy", %{"version" => "0", "agent_id" => id}),
                 :ok,
                 %{"delivery_policy" => view}

    assert view["mechanisms"] == %{
             "operator_early" => "none",
             "inter_agent_early" => "steer",
             "inter_agent_yield" => "none"
           }

    dirty = Map.put(view, "mechanisms", Map.put(view["mechanisms"], "token", "private"))

    assert {:ok, safe} =
             KaoiroServerWeb.ViewerAgentProjection.sanitize(%{
               state(id)
               | "ext" => %{"delivery_policy" => dirty, "cwd" => "/private"}
             })

    assert safe["ext"] == %{"delivery_policy" => view}
    malformed = put_in(dirty, ["mechanisms", "operator_early"], "invented")

    assert {:ok, safe} =
             KaoiroServerWeb.ViewerAgentProjection.sanitize(%{
               state(id)
               | "ext" => %{"delivery_policy" => malformed}
             })

    refute Map.has_key?(safe["ext"]["delivery_policy"], "mechanisms")
  end

  test "fresh read refuses a snapshot with inconsistent owner identities", %{id: id} do
    wrapper(id, %{"delivery_policy" => "v1"})
    operator = client(:operator)
    foreign = self()
    previous = :sys.get_state(WorkStore).operator_modes[id]

    :sys.replace_state(WorkStore, fn state ->
      %{state | operator_modes: Map.put(state.operator_modes, id, {foreign, modes()})}
    end)

    try do
      assert_reply push(operator, "get_delivery_policy", %{"version" => "0", "agent_id" => id}),
                   :ok,
                   %{"delivery_policy" => view}

      refute Map.has_key?(view, "mechanisms")
      assert view["confirmed"] == false
    after
      :sys.replace_state(WorkStore, fn state ->
        %{state | operator_modes: Map.put(state.operator_modes, id, previous)}
      end)
    end
  end

  test "two dashboard channels race once and the losing CAS cannot overwrite", %{id: id} do
    wrapper(id, %{"delivery_policy" => "v1"})
    first = client(:operator)
    second = client(:admin)
    left = push(first, "set_delivery_policy", request(id, "off", 1))
    right = push(second, "set_delivery_policy", request(id, "off", 1))
    assert_receive %Phoenix.Socket.Reply{ref: ^left, status: left_status, payload: left_payload}

    assert_receive %Phoenix.Socket.Reply{
      ref: ^right,
      status: right_status,
      payload: right_payload
    }

    results = [{left_status, left_payload}, {right_status, right_payload}]
    assert {:ok, %{"revision" => 2, "status" => "pending"}} in results

    assert {:error,
            %{"reason" => "revision_conflict", "current_revision" => 2, "policy" => "off"}} in results

    assert {:ok, %{policy: :off, revision: 2}} = DeliveryPolicies.get(id)
  end

  test "viewer unknown-agent write is forbidden before existence lookup", %{id: id} do
    viewer = client(:viewer)

    assert_reply push(viewer, "set_delivery_policy", request(id, "on", 0)), :error, %{
      reason: "forbidden"
    }

    assert {:ok, nil} = DeliveryPolicies.get(id)
    assert :dets.lookup(DeliveryPolicies, {:counter, id}) == []
    refute Map.has_key?(AgentDirectory.all(), id)
  end

  for ack? <- [false, true] do
    test "first state uses the join/ack view with WorkStore suspended: ack=#{ack?}", %{id: id} do
      {_, socket} = wrapper(id, %{"delivery_policy" => "v1"}, false)
      assert_push "delivery_policy", %{"revision" => 1, "policy" => "on"}

      if unquote(ack?) do
        assert_reply push(socket, "delivery_policy_applied", %{"version" => "0", "revision" => 1}),
                     :ok
      end

      _ = :sys.get_state(socket.channel_pid)
      @endpoint.subscribe("agents:lobby")

      with_suspended(WorkStore, fn ->
        started = System.monotonic_time(:microsecond)
        assert_reply push(socket, "envelope", state(id)), :ok
        elapsed = System.monotonic_time(:microsecond) - started
        assert elapsed < 500_000
        IO.puts("559 availability first-state ack=#{unquote(ack?)}: #{elapsed} us")
        assert_broadcast "envelope", %{"agent_id" => ^id} = live
        assert live == AgentStates.get_envelope(id)
        view = get_in(live, ["ext", "delivery_policy"])
        assert view["policy"] == "on"
        assert view["revision"] == 1
        assert view["confirmed"] == unquote(ack?)
      end)
    end
  end

  for type <- ["state_change", "permission_request", "question_request"] do
    test "#{type} keeps cached off and broadcasts without WorkStore", %{id: id} do
      {_, socket} = wrapper(id, %{"delivery_policy" => "v1"})
      assert_push "delivery_policy", %{"revision" => 1}
      assert {:ok, _} = DeliveryPolicies.compare_and_set(id, :off, 1)
      assert_push "delivery_policy", %{"revision" => 2, "policy" => "off"}
      _ = :sys.get_state(socket.channel_pid)
      cached = get_in(AgentStates.get_envelope(id), ["ext", "delivery_policy"])
      @endpoint.subscribe("agents:lobby")

      forged =
        put_in(notification(id, unquote(type)), ["ext", "delivery_policy"], %{
          "policy" => "on",
          "revision" => 900
        })

      with_suspended(WorkStore, fn ->
        started = System.monotonic_time(:microsecond)
        assert_reply push(socket, "envelope", forged), :ok
        elapsed = System.monotonic_time(:microsecond) - started
        assert elapsed < 500_000
        IO.puts("559 availability #{unquote(type)}: #{elapsed} us")
        assert_broadcast "envelope", %{"agent_id" => ^id, "type" => unquote(type)} = live
        assert live == AgentStates.get_envelope(id)
        assert get_in(live, ["ext", "delivery_policy"]) == cached
        assert cached["policy"] == "off"
        assert cached["revision"] == 2
      end)
    end
  end

  test "explicit-normal operator input bypasses suspended DeliveryPolicies", %{id: id} do
    {_, _} = wrapper(id)
    operator = client(:operator)
    @endpoint.subscribe("wrapper:" <> id)

    with_suspended(DeliveryPolicies, fn ->
      started = System.monotonic_time(:microsecond)

      assert_reply push(operator, "instruction", %{
                     "version" => "0",
                     "agent_id" => id,
                     "text" => "ordinary",
                     "delivery_intent" => "normal"
                   }),
                   :ok,
                   %{"delivery_intent" => "normal"}

      assert System.monotonic_time(:microsecond) - started < 500_000

      assert_broadcast "instruction", %{"text" => "ordinary", "delivery_intent" => "normal"}
    end)
  end

  for intent <- [nil, "normal"] do
    test "ordinary IA bypasses suspended DeliveryPolicies: intent=#{inspect(intent)}", %{id: id} do
      from = id <> "-sender"
      {_, sender} = wrapper(from)
      {_, _} = wrapper(id)
      @endpoint.subscribe("wrapper:" <> id)

      payload = %{
        "to" => id,
        "conversation_id" => id <> "-ordinary",
        "turn_number" => 1,
        "kind" => "inform",
        "body" => "ordinary",
        "meta" => %{"done" => false, "propose_next" => ""},
        "owner" => %{"kind" => "user", "id" => "operator"},
        "new_conversation" => true,
        "in_reply_to" => 0
      }

      payload =
        if unquote(intent),
          do: Map.put(payload, "delivery_intent", unquote(intent)),
          else: payload

      envelope = %{state(from) | "type" => "inter_agent_message", "payload" => payload}

      with_suspended(DeliveryPolicies, fn ->
        started = System.monotonic_time(:microsecond)

        assert_reply push(sender, "envelope", envelope),
                     :ok,
                     %{"delivery_authority" => %{requested: "normal", granted: "normal"}}

        assert System.monotonic_time(:microsecond) - started < 500_000

        assert_broadcast "envelope", %{
          "type" => "inter_agent_message",
          "payload" => %{"body" => "ordinary", "delivery_authority" => %{granted: "normal"}}
        }
      end)
    end
  end

  defp instruction(client, id, intent, expected, reason \\ nil) do
    payload = %{"version" => "0", "agent_id" => id, "text" => "policy test"}
    payload = if intent, do: Map.put(payload, "delivery_intent", intent), else: payload
    ref = push(client, "instruction", payload)

    if reason do
      assert_reply ref, :ok, %{"delivery_intent" => ^expected, "downgrade_reason" => ^reason}
    else
      assert_reply ref, :ok, %{"delivery_intent" => ^expected}
    end

    assert_broadcast "instruction", %{"version" => "0", "delivery_intent" => ^expected}
  end

  test "viewer direct command with forged operator metadata has no effects", %{id: id} do
    AgentDirectory.record(id, "default", "Policy")
    viewer = client(:viewer)

    assert_reply push(viewer, "set_delivery_policy", request(id, "on", 0)), :error, %{
      reason: "forbidden"
    }

    ref = push(viewer, "set_delivery_policy", Map.put(request(id, "on", 0), "role", "operator"))
    assert_reply ref, :error, %{reason: "forbidden"}
    assert {:ok, nil} = DeliveryPolicies.get(id)
    assert :dets.lookup(DeliveryPolicies, {:counter, id}) == []
  end

  test "unknown and malformed writes cannot create rows or revisions", %{id: id} do
    operator = client(:operator)

    assert_reply push(operator, "set_delivery_policy", request(id, "on", 0)), :error, %{
      reason: "unknown_agent"
    }

    AgentDirectory.record(id, "default", "Policy")

    for {policy, expected} <- [
          {"unknown", 0},
          {"on", -1},
          {"on", 0.0},
          {"off", 1.0},
          {"on", "0"},
          {"off", 9_007_199_254_740_992}
        ] do
      assert_reply push(operator, "set_delivery_policy", request(id, policy, expected)),
                   :error,
                   %{reason: "invalid_payload"}
    end

    assert {:ok, nil} = DeliveryPolicies.get(id)
  end

  test "known disconnected CAS zero survives legacy join and every explicit intent is clamped", %{
    id: id
  } do
    AgentDirectory.record(id, "default", "Policy")
    operator = client(:operator)

    assert_reply push(operator, "set_delivery_policy", request(id, "off", 0)), :ok, %{
      "revision" => 1,
      "status" => "pending"
    }

    {reply, _socket} = wrapper(id)
    refute Map.has_key?(reply, "delivery_policy")
    @endpoint.subscribe("wrapper:" <> id)

    for intent <- [nil, "early", "yield"],
        do: instruction(operator, id, intent, "normal", "recipient_policy_off")

    assert {:ok, %{policy: :off, revision: 1}} = DeliveryPolicies.get(id)
  end

  test "current legacy owner on is the sole no-ack exception", %{id: id} do
    {reply, _socket} = wrapper(id)
    refute Map.has_key?(reply, "delivery_policy")
    operator = client(:operator)
    @endpoint.subscribe("wrapper:" <> id)
    instruction(operator, id, nil, "early")
    assert %{support: false, applied_revision: nil} = WorkStore.delivery_snapshot(id)
  end

  test "supporting owner needs exact ack; off is immediate and same-value CAS becomes pending", %{
    id: id
  } do
    {reply, socket} = wrapper(id, %{"delivery_policy" => "v1"})
    assert reply["delivery_policy"] == "v1"
    assert_push "delivery_policy", %{"version" => "0", "revision" => 1, "policy" => "on"}
    operator = client(:operator)
    @endpoint.subscribe("wrapper:" <> id)
    instruction(operator, id, "early", "normal", "policy_unconfirmed")

    assert_reply push(socket, "delivery_policy_applied", %{"version" => "0", "revision" => 2}),
                 :error,
                 %{reason: "policy_unconfirmed"}

    assert_reply push(socket, "delivery_policy_applied", %{"version" => "0", "revision" => 1}),
                 :ok

    instruction(operator, id, nil, "early")

    assert_reply push(operator, "set_delivery_policy", request(id, "off", 1)), :ok, %{
      "revision" => 2
    }

    instruction(operator, id, "early", "normal", "recipient_policy_off")

    assert_reply push(operator, "set_delivery_policy", request(id, "on", 2)), :ok, %{
      "revision" => 3
    }

    instruction(operator, id, "early", "normal", "policy_unconfirmed")

    assert_reply push(socket, "delivery_policy_applied", %{"version" => "0", "revision" => 3}),
                 :ok

    assert_reply push(operator, "set_delivery_policy", request(id, "on", 3)), :ok, %{
      "revision" => 4,
      "status" => "pending"
    }

    instruction(operator, id, "early", "normal", "policy_unconfirmed")

    assert_reply push(socket, "delivery_policy_applied", %{"version" => "0", "revision" => 3}),
                 :error

    assert %{applied_revision: 3} = WorkStore.delivery_snapshot(id)

    assert_reply push(operator, "set_delivery_policy", request(id, "off", 3)), :error, %{
      "reason" => "revision_conflict",
      "current_revision" => 4,
      "policy" => "on"
    }
  end

  test "operator none overrides IA modes and explicit early cannot bypass it", %{id: id} do
    {_, _} = wrapper(id, %{"operator_input_modes" => Map.delete(modes("none"), "stage_reports")})
    operator = client(:operator)
    @endpoint.subscribe("wrapper:" <> id)
    instruction(operator, id, nil, "normal")
    instruction(operator, id, "early", "normal", "unsupported_by_recipient")
  end

  test "absent current registration is never a legacy wrapper", %{id: id} do
    :ok = AgentStates.put(state(id), owner: self())
    assert {:ok, _} = DeliveryPolicies.ensure(id)
    operator = client(:operator)
    @endpoint.subscribe("wrapper:" <> id)
    instruction(operator, id, "early", "normal", "unsupported_by_recipient")
  end

  test "replacement supporting owner is unconfirmed and retains off", %{id: id} do
    {_, socket} = wrapper(id, %{"delivery_policy" => "v1"})

    assert_reply push(socket, "delivery_policy_applied", %{"version" => "0", "revision" => 1}),
                 :ok

    assert {:ok, %{revision: 2}} = DeliveryPolicies.compare_and_set(id, :off, 1)
    Process.flag(:trap_exit, true)
    monitor = Process.monitor(socket.channel_pid)
    close(socket)
    assert_receive {:DOWN, ^monitor, :process, _, _}
    {_, replacement} = wrapper(id, %{"delivery_policy" => "v1"})
    assert %{owner: owner, applied_revision: nil} = WorkStore.delivery_snapshot(id)
    assert owner == replacement.channel_pid
    assert {:ok, %{policy: :off, revision: 2}} = DeliveryPolicies.get(id)
  end

  test "role is resolved again after waiting for the per-agent acceptance worker", %{id: id} do
    AgentDirectory.record(id, "default", "Policy")
    parent = self()

    task =
      Task.async(fn ->
        AgentAcceptance.run(id, :set_delivery_policy, fn ->
          send(parent, {:blocked_worker, self()})

          receive do
            :release -> :ok
          end
        end)
      end)

    assert_receive {:blocked_worker, worker}
    operator = client(:operator)
    :erlang.trace(operator.channel_pid, true, [:send, {:tracer, self()}])
    ref = push(operator, "set_delivery_policy", request(id, "on", 0))
    assert_receive {:trace, _, :send, {:"$gen_call", _, {:run, :set_delivery_policy, _}}, ^worker}
    Application.put_env(:kaoiro_server, :client_tokens, "dp-operator:viewer,dp-viewer:viewer")
    send(worker, :release)
    assert Task.await(task) == :ok
    assert_reply ref, :error, %{reason: "forbidden"}
    assert {:ok, nil} = DeliveryPolicies.get(id)
    :erlang.trace(operator.channel_pid, false, [:send])
  end

  test "durable change still notifies the real wrapper after the client times out", %{id: id} do
    {_, socket} = wrapper(id, %{"delivery_policy" => "v1"})
    assert_push "delivery_policy", %{"revision" => 1}
    previous = :sys.get_state(DeliveryPolicies).after_sync
    parent = self()

    :sys.replace_state(DeliveryPolicies, fn state ->
      %{
        state
        | after_sync: fn
            :row ->
              send(parent, {:row_durable, self()})

              receive do
                :release -> :ok
              end

            _ ->
              :ok
          end
      }
    end)

    on_exit(fn -> :sys.replace_state(DeliveryPolicies, &%{&1 | after_sync: previous}) end)

    caller =
      spawn(fn ->
        result =
          try do
            GenServer.call(DeliveryPolicies, {:cas, id, :off, 1}, 25)
          catch
            :exit, _ -> :timed_out
          end

        send(parent, {:caller_result, result})
      end)

    monitor = Process.monitor(caller)
    assert_receive {:row_durable, owner}
    assert_receive {:caller_result, :timed_out}
    assert_receive {:DOWN, ^monitor, :process, ^caller, :normal}
    send(owner, :release)
    assert_push "delivery_policy", %{"revision" => 2, "policy" => "off"}
    assert {:ok, %{revision: 2, policy: :off}} = DeliveryPolicies.get(id)

    assert_reply push(socket, "delivery_policy_applied", %{"version" => "0", "revision" => 1}),
                 :error
  end

  test "wrapper cannot forge a policy overlay and snapshots use the authoritative view", %{id: id} do
    {_, socket} = wrapper(id)
    assert {:ok, _} = DeliveryPolicies.compare_and_set(id, :off, 1)
    forged = put_in(state(id), ["ext", "delivery_policy"], %{"policy" => "on", "revision" => 900})
    assert_reply push(socket, "envelope", forged), :ok
    assert get_in(AgentStates.get_envelope(id), ["ext", "delivery_policy", "policy"]) == "off"
    _operator = client(:operator)
    assert_push "snapshot", %{"agents" => agents}
    assert get_in(agents[id], ["ext", "delivery_policy", "policy"]) == "off"
  end

  test "IA off downgrade precedes early quota and still delivers one normal item", %{id: id} do
    from = id <> "-sender"
    {_, sender} = wrapper(from)
    {_, _recipient} = wrapper(id)
    assert {:ok, _} = DeliveryPolicies.compare_and_set(id, :off, 1)
    @endpoint.subscribe("wrapper:" <> id)

    payload = %{
      "to" => id,
      "conversation_id" => id <> "-cid",
      "turn_number" => 1,
      "kind" => "inform",
      "body" => "policy IA",
      "meta" => %{"done" => false, "propose_next" => ""},
      "owner" => %{"kind" => "user", "id" => "operator"},
      "new_conversation" => true,
      "delivery_intent" => "early",
      "in_reply_to" => 0
    }

    envelope = %{state(from) | "type" => "inter_agent_message", "payload" => payload}

    assert_reply push(sender, "envelope", envelope), :ok, %{
      "delivery_authority" => %{
        requested: "early",
        granted: "normal",
        downgrade: "recipient_policy_off"
      }
    }

    assert_broadcast "envelope", %{
      "type" => "inter_agent_message",
      "payload" => %{"delivery_authority" => %{granted: "normal"}}
    }

    assert KaoiroServer.DeliveryStates.pending_early(from, id) == {0, 0}
  end

  test "changed queued reports preserve timestamp, expose the local result, and do not ack delivery",
       %{id: id} do
    from = id <> ".sender"
    {%{"inter_agent_delivery_incarnation" => incarnation}, receiver} = wrapper(id)
    {_, sender} = wrapper(from)
    @endpoint.subscribe("wrapper:" <> id)
    cid = id <> ".queued"

    payload = %{
      "to" => id,
      "kind" => "inform",
      "body" => "queued policy",
      "conversation_id" => cid,
      "turn_number" => 1,
      "delivery_intent" => "early",
      "meta" => %{"done" => false, "propose_next" => ""},
      "owner" => %{"kind" => "user", "id" => "operator"},
      "new_conversation" => true,
      "in_reply_to" => 0
    }

    assert_reply push(sender, "envelope", %{
                   state(from)
                   | "type" => "inter_agent_message",
                     "payload" => payload
                 }),
                 :ok

    assert_broadcast "envelope", %{
      "delivery_seq" => seq,
      "payload" => %{"delivery_authority" => %{granted: "early"}}
    }

    first = DateTime.utc_now() |> DateTime.to_iso8601()
    later = DateTime.utc_now() |> DateTime.add(1, :second) |> DateTime.to_iso8601()

    queued = %{
      "version" => "0",
      "incarnation" => incarnation,
      "generation" => id,
      "delivery_seq" => seq,
      "stage" => "queued",
      "at" => first,
      "mode" => "early"
    }

    assert_reply push(receiver, "delivery_stage", queued), :ok
    assert {:ok, _} = DeliveryPolicies.compare_and_set(id, :off, 1)
    disposition = %{"outcome" => "downgraded", "reason" => "local_policy_disabled", "at" => later}

    changed =
      Map.merge(queued, %{
        "mode" => "normal",
        "reason" => "local_policy_disabled",
        "at" => later,
        "yield_disposition" => disposition
      })

    assert_reply push(receiver, "delivery_stage", changed), :ok
    assert_reply push(receiver, "delivery_stage", changed), :ok

    assert_reply push(sender, "delivery_status_request", %{
                   "version" => "0",
                   "conversation_id" => cid,
                   "turn_number" => 1
                 }),
                 :ok,
                 %{
                   "delivery_status" => %{
                     stages: %{"queued" => ^first},
                     changed_at: ^later,
                     mode: "normal",
                     reason: "local_policy_disabled",
                     yield_disposition: ^disposition
                   }
                 }

    assert %{acked_seq: 0} = KaoiroServer.DeliveryStates.get(id)
    assert KaoiroServer.DeliveryStates.pending_early(from, id) == {1, 1}
  end

  test "non-normal IA admission reads durable off despite an obsolete on display view", %{id: id} do
    from = id <> ".sender"
    {_, receiver} = wrapper(id)
    {_, sender} = wrapper(from)
    assert {:ok, %{revision: 2}} = DeliveryPolicies.compare_and_set(id, :off, 1)
    _ = :sys.get_state(receiver.channel_pid)

    stale = %{
      "policy" => "on",
      "revision" => 1,
      "confirmed" => true,
      "pending" => false,
      "wrapper_support" => false
    }

    AgentStates.overlay_delivery_policy(id, stale)
    assert AgentStates.get_envelope(id)["ext"]["delivery_policy"] == stale
    @endpoint.subscribe("wrapper:" <> id)

    ref =
      push(sender, "envelope", %{
        "version" => "0",
        "agent_id" => from,
        "ts" => "T",
        "type" => "inter_agent_message",
        "state" => "thinking",
        "payload" => %{
          "to" => id,
          "kind" => "inform",
          "body" => "obsolete view",
          "conversation_id" => id <> ".stale",
          "turn_number" => 1,
          "delivery_intent" => "early",
          "meta" => %{"done" => false, "propose_next" => ""},
          "owner" => %{"kind" => "user", "id" => "operator"},
          "new_conversation" => true,
          "in_reply_to" => 0
        }
      })

    assert_reply ref, :ok, %{
      "delivery_authority" => %{
        requested: "early",
        granted: "normal",
        downgrade: "recipient_policy_off"
      }
    }

    assert_broadcast "envelope", %{
      "type" => "inter_agent_message",
      "payload" => %{"delivery_authority" => %{granted: "normal"}}
    }

    assert {:ok, %{policy: :off, revision: 2}} = DeliveryPolicies.get(id)
    assert KaoiroServer.DeliveryStates.pending_early(from, id) == {0, 0}
  end

  test "real register and operator hosts preserve launch metadata and defaults independently", %{
    id: id
  } do
    {:ok, _, runner} =
      KaoiroServerWeb.RunnerSocket
      |> socket(nil, %{})
      |> subscribe_and_join(KaoiroServerWeb.RunnerChannel, "runner:" <> id)

    client(:operator)

    none = %{
      "operator_early" => "none",
      "inter_agent_early" => "none",
      "inter_agent_yield" => "none"
    }

    peer = %{none | "inter_agent_early" => "steer"}
    defaults = %{"claude-code" => true, "codex" => true, "antigravity" => false}

    engines =
      for engine <- ["claude-code", "codex", "antigravity"] do
        %{
          "id" => engine,
          "models" => [],
          "launch_delivery_policy" => %{
            "version" => "v1",
            "ceiling" => true,
            "mechanisms" => if(engine == "antigravity", do: none, else: peer),
            "persona_overrides" => %{"disabled-persona" => none}
          }
        }
      end

    for catalogs <- [engines, Enum.map(engines, &Map.delete(&1, "launch_delivery_policy"))] do
      assert_reply push(runner, "register", %{
                     "version" => "0",
                     "cwd_allowlist" => ["/test"],
                     "capabilities" => Map.keys(defaults),
                     "engines" => catalogs,
                     "in_flight_defaults" => defaults
                   }),
                   :ok

      assert_push "hosts", %{"hosts" => %{^id => host}}
      wire = host |> Jason.encode!() |> Jason.decode!()
      assert wire["engines"] == catalogs
      assert wire["in_flight_defaults"] == defaults
    end
  end

  test "runner defaults are strict and spawn consumes explicit policy before broadcast", %{id: id} do
    {:ok, _, runner} =
      KaoiroServerWeb.RunnerSocket
      |> socket(nil, %{})
      |> subscribe_and_join(KaoiroServerWeb.RunnerChannel, "runner:" <> id)

    registration = %{
      "version" => "0",
      "cwd_allowlist" => ["/home/user/proj"],
      "capabilities" => ["claude-code", "codex", "antigravity"],
      "in_flight_defaults" => %{"codex" => false}
    }

    assert_reply push(runner, "register", registration), :ok
    before = KaoiroServer.HostRegistry.get(id)

    for defaults <- [%{"claude" => true}, %{"codex" => "false"}, [], nil] do
      assert_reply push(
                     runner,
                     "register",
                     Map.put(registration, "in_flight_defaults", defaults)
                   ),
                   :error,
                   %{reason: "invalid_register"}

      assert KaoiroServer.HostRegistry.get(id) == before
    end

    @endpoint.subscribe("runner:" <> id)
    operator = client(:operator)

    payload = %{
      "version" => "0",
      "host_id" => id,
      "persona" => "ao",
      "cwd" => "/home/user/proj",
      "engine" => "codex"
    }

    assert_reply push(operator, "spawn", payload), :ok, %{"agent_id" => seeded}
    assert_broadcast "spawn", %{"agent_id" => ^seeded} = first
    assert first["agent_id"] == seeded
    assert {:ok, %{policy: :off, revision: 1}} = DeliveryPolicies.get(seeded)

    assert_reply push(operator, "spawn", Map.put(payload, "delivery_policy", "on")), :ok, %{
      "agent_id" => explicit
    }

    assert_broadcast "spawn", %{"agent_id" => ^explicit} = second
    assert second["agent_id"] == explicit
    refute Map.has_key?(second, "delivery_policy")
    assert {:ok, %{policy: :on, revision: 1}} = DeliveryPolicies.get(explicit)

    assert_reply push(operator, "spawn", Map.put(payload, "delivery_policy", "unknown")),
                 :error,
                 %{reason: "invalid_payload"}

    assert_reply push(runner, "register", %{
                   registration
                   | "in_flight_defaults" => %{"codex" => true}
                 }),
                 :ok

    assert {:ok, %{policy: :off, revision: 1}} = DeliveryPolicies.get(seeded)
  end

  test "store outage preserves ordinary communication and refuses spawn without leaving pending activity",
       %{id: id} do
    {:ok, _, runner} =
      KaoiroServerWeb.RunnerSocket
      |> socket(nil, %{})
      |> subscribe_and_join(KaoiroServerWeb.RunnerChannel, "runner:" <> id)

    assert_reply push(runner, "register", %{"cwd_allowlist" => ["/home/user/proj"]}), :ok
    operator = client(:operator)
    :ok = Supervisor.terminate_child(KaoiroServer.Supervisor, DeliveryPolicies)

    on_exit(fn ->
      case Supervisor.restart_child(KaoiroServer.Supervisor, DeliveryPolicies) do
        {:ok, _} -> :ok
        {:error, :running} -> :ok
      end
    end)

    {_, socket} = wrapper(id <> ".existing", %{"delivery_policy" => "v1"})
    assert AgentStates.connected?(id <> ".existing")

    assert get_in(AgentStates.get_envelope(id <> ".existing"), [
             "ext",
             "delivery_policy",
             "policy"
           ]) == "unknown"

    @endpoint.subscribe("wrapper:" <> id <> ".existing")
    instruction(operator, id <> ".existing", "early", "normal", "policy_unknown")
    @endpoint.subscribe("runner:" <> id)
    before = Map.keys(AgentDirectory.all())

    assert_reply push(operator, "spawn", %{
                   "host_id" => id,
                   "persona" => "ao",
                   "cwd" => "/home/user/proj"
                 }),
                 :error,
                 %{reason: "policy_unknown"}

    allocated = Map.keys(AgentDirectory.all()) -- before
    assert length(allocated) == 1
    [agent_id] = allocated
    refute Map.has_key?(:sys.get_state(KaoiroServer.AgentActivity).pending, agent_id)
    assert_reply push(socket, "envelope", state(id <> ".existing")), :ok
    assert {:ok, _} = Supervisor.restart_child(KaoiroServer.Supervisor, DeliveryPolicies)
  end

  test "IA supporting wrapper unconfirmed is normal until its own current revision ack", %{id: id} do
    from = id <> "-sender"
    {_, sender} = wrapper(from)
    {_, recipient} = wrapper(id, %{"delivery_policy" => "v1"})

    for {index, expected, reason} <- [{1, "normal", "policy_unconfirmed"}, {2, "early", nil}] do
      if index == 2,
        do:
          assert_reply(
            push(recipient, "delivery_policy_applied", %{"version" => "0", "revision" => 1}),
            :ok
          )

      payload = %{
        "to" => id,
        "conversation_id" => id <> "-#{index}",
        "turn_number" => 1,
        "kind" => "inform",
        "body" => "IA",
        "meta" => %{"done" => false, "propose_next" => ""},
        "owner" => %{"kind" => "user", "id" => "operator"},
        "new_conversation" => true,
        "delivery_intent" => "early",
        "in_reply_to" => 0
      }

      ref =
        push(sender, "envelope", %{
          state(from)
          | "type" => "inter_agent_message",
            "payload" => payload
        })

      assert_reply ref, :ok, %{"delivery_authority" => %{granted: ^expected} = authority}
      assert authority[:downgrade] == reason
    end
  end

  test "viewer receives the safe policy view while host metadata stays private", %{id: id} do
    {_, socket} = wrapper(id)

    assert_reply push(socket, "envelope", %{
                   state(id)
                   | "ext" => %{"cwd" => "/private", "model" => "private-model"}
                 }),
                 :ok

    _viewer = client(:viewer)
    assert_push "snapshot", %{"agents" => agents}
    assert Map.keys(agents[id]["ext"]) == ["delivery_policy"]
    assert agents[id]["ext"]["delivery_policy"]["policy"] == "on"
  end

  test "fresh snapshot re-reads policy rather than trusting a cached on during outage", %{id: id} do
    {_, _} = wrapper(id)
    assert get_in(AgentStates.get_envelope(id), ["ext", "delivery_policy", "policy"]) == "on"
    :ok = Supervisor.terminate_child(KaoiroServer.Supervisor, DeliveryPolicies)

    on_exit(fn ->
      case Supervisor.restart_child(KaoiroServer.Supervisor, DeliveryPolicies) do
        {:ok, _} -> :ok
        {:error, :running} -> :ok
      end
    end)

    _operator = client(:operator)
    assert_push "snapshot", %{"agents" => agents}
    assert get_in(agents[id], ["ext", "delivery_policy", "policy"]) == "unknown"
    assert {:ok, _} = Supervisor.restart_child(KaoiroServer.Supervisor, DeliveryPolicies)
  end

  test "real operator deletion purges the row and blocks late backfill without deleting its allocator",
       %{id: id} do
    Process.flag(:trap_exit, true)
    {_, wrapper} = wrapper(id)
    monitor = Process.monitor(wrapper.channel_pid)
    close(wrapper)
    assert_receive {:DOWN, ^monitor, :process, _, _}
    operator = client(:operator)
    assert_reply push(operator, "delete_agent", %{"version" => "0", "agent_id" => id}), :ok
    assert :dets.lookup(DeliveryPolicies, {:settings, id}) == []
    assert :dets.lookup(DeliveryPolicies, {:counter, id}) == [{{:counter, id}, 1}]
    assert {:error, :policy_unknown} = DeliveryPolicies.ensure(id)

    assert {:error, _} =
             WrapperSocket
             |> socket(nil, %{})
             |> subscribe_and_join(WrapperChannel, "wrapper:" <> id, %{"persona_id" => "default"})

    on_exit(fn -> KaoiroServer.TokenDenylist.restore(id) end)
    _ = wrapper
  end

  test "directory outage is a closed write error and cannot create a policy row", %{id: id} do
    AgentDirectory.record(id, "default", "Policy")
    operator = client(:operator)
    :ok = Supervisor.terminate_child(KaoiroServer.Supervisor, AgentDirectory)

    on_exit(fn ->
      case Supervisor.restart_child(KaoiroServer.Supervisor, AgentDirectory) do
        {:ok, _} -> :ok
        {:error, :running} -> :ok
      end
    end)

    assert_reply push(operator, "set_delivery_policy", request(id, "off", 0)), :error, %{
      reason: "policy_unknown"
    }

    assert {:ok, nil} = DeliveryPolicies.get(id)
    assert {:ok, _} = Supervisor.restart_child(KaoiroServer.Supervisor, AgentDirectory)
  end

  test "policy denial drops a minted yield token and delivers the work item only once", %{id: id} do
    from = id <> "-director"
    {_, sender} = wrapper(from, %{"work_control" => "v1"})

    {_, _} =
      wrapper(id, %{
        "work_control" => "v1",
        "inter_agent_delivery_modes" => %{modes() | "yield" => "replace_root"}
      })

    assert {:ok, _} = DeliveryPolicies.compare_and_set(id, :off, 1)
    cid = id <> "-yield"
    principal = %{"kind" => "agent", "id" => from}

    operation_id = fn ->
      "op_#{System.system_time(:millisecond)}_" <>
        Base.url_encode64(:crypto.strong_rand_bytes(16), padding: false)
    end

    assert {:ok, %{work: initial}} =
             WorkStore.apply(
               principal,
               %{"op" => "assign", "operation_id" => operation_id.(), "title" => cid},
               %{recipient: id, conversation_id: cid, turn_number: 1, new_conversation?: true}
             )

    assert {:ok, %{work: active}} =
             WorkStore.apply(
               %{"kind" => "agent", "id" => id},
               %{
                 "op" => "accept_assignment",
                 "operation_id" => operation_id.(),
                 "work_id" => initial.work_id
               },
               %{recipient: from, conversation_id: cid, turn_number: 2}
             )

    payload = %{
      "to" => id,
      "conversation_id" => cid,
      "turn_number" => 1,
      "kind" => "request",
      "body" => "yield",
      "meta" => %{"done" => false, "propose_next" => ""},
      "owner" => %{"kind" => "user", "id" => "operator"},
      "new_conversation" => true,
      "delivery_intent" => "yield",
      "in_reply_to" => 0,
      "work_id" => active.work_id,
      "expected_authority_epoch" => active.authority_epoch
    }

    @endpoint.subscribe("wrapper:" <> id)

    assert_reply push(sender, "envelope", %{
                   state(from)
                   | "type" => "inter_agent_message",
                     "payload" => payload
                 }),
                 :ok,
                 %{
                   "delivery_authority" => %{
                     requested: "yield",
                     granted: "normal",
                     downgrade: "recipient_policy_off"
                   }
                 }

    assert_broadcast "envelope", %{"payload" => %{"delivery_authority" => authority}}
    refute Map.has_key?(authority, :yield_token)

    refute Enum.any?(:sys.get_state(WorkStore).yield_tokens, fn {_token, value} ->
             value.work_id == active.work_id
           end)

    assert KaoiroServer.DeliveryStates.pending_early(from, id) == {0, 0}
    assert {:ok, %{work: %{revision: revision}}} = WorkStore.status(principal, active.work_id)
    assert revision == active.revision
  end
end
