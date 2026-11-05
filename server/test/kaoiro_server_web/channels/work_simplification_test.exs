defmodule KaoiroServerWeb.WorkSimplificationTest do
  use KaoiroServerWeb.ChannelCase, async: false
  alias KaoiroServer.{ConversationStates, WorkStore}
  alias KaoiroServerWeb.{AgentsChannel, WrapperChannel}

  @legacy ~w(holds verdicts accepted_verdicts transfers subject requires_verdict reviews checks)a
  @removed ~w(revise hold release submit verdict withdraw_verdict accept_verdict revoke_verdict transfer release_transfer)
  @operator %{"kind" => "user", "id" => "operator"}
  defp agent(id), do: %{"kind" => "agent", "id" => id}

  defp opid,
    do:
      "op_#{System.system_time(:millisecond)}_#{Base.url_encode64(:crypto.strong_rand_bytes(16), padding: false)}"

  defp cid, do: "basic-#{System.unique_integer([:positive])}"

  defp frame(id, type, payload),
    do: %{
      "version" => "0",
      "agent_id" => id,
      "persona" => %{"id" => "default", "name" => "Default", "sprite_set" => "default"},
      "ts" => DateTime.utc_now() |> DateTime.to_iso8601(),
      "state" => "idle",
      "type" => type,
      "payload" => payload,
      "ext" => %{}
    }

  defp peer(id) do
    {:ok, _, socket} =
      KaoiroServerWeb.WrapperSocket
      |> socket(nil, %{})
      |> subscribe_and_join(WrapperChannel, "wrapper:" <> id, %{
        "persona_id" => "default",
        "work_control" => "v1",
        "inter_agent_delivery_ack" => "dispatch-v1",
        "delivery_generation" => id,
        "delivery_resync" => "skip-v1",
        "inter_agent_delivery_modes" => %{
          "version" => "v1",
          "early" => "fold",
          "yield" => "tool_boundary",
          "stage_reports" => true
        }
      })

    assert_reply push(socket, "envelope", frame(id, "state_change", %{})), :ok
    socket
  end

  defp operator_socket do
    previous = Application.fetch_env(:kaoiro_server, :client_tokens)
    Application.put_env(:kaoiro_server, :client_tokens, "u1-operator:operator")

    on_exit(fn ->
      case previous do
        {:ok, tokens} -> Application.put_env(:kaoiro_server, :client_tokens, tokens)
        :error -> Application.delete_env(:kaoiro_server, :client_tokens)
      end
    end)

    {:ok, connected} = connect(KaoiroServerWeb.ClientSocket, %{"token" => "u1-operator"})
    {:ok, _, socket} = subscribe_and_join(connected, AgentsChannel, "agents:lobby")

    socket
  end

  defp grant(director \\ "director", assignee \\ "assignee") do
    {:ok, %{work: %{work_id: id}}} =
      WorkStore.apply(
        @operator,
        %{
          "op" => "assign",
          "operation_id" => opid(),
          "title" => "Basic work",
          "director" => agent(director),
          "assignee" => assignee,
          "requires_verdict" => true,
          "reviews" => "ignored-review"
        },
        %{operator: true}
      )

    WorkStore.all()[id]
  end

  defp nominate(director \\ "director", assignee \\ "assignee") do
    {:ok, %{work: %{work_id: id}}} =
      WorkStore.apply(
        agent(director),
        %{"op" => "assign", "operation_id" => opid(), "title" => "Nomination"},
        %{recipient: assignee, conversation_id: cid(), turn_number: 1, new_conversation?: true}
      )

    WorkStore.all()[id]
  end

  defp apply_op(actor, work, op, extra \\ %{}) do
    WorkStore.apply(
      actor,
      Map.merge(%{"op" => op, "operation_id" => opid(), "work_id" => work.work_id}, extra),
      %{operator: true}
    )
  end

  defp message(socket, from, to, work, extra \\ %{}) do
    payload =
      Map.merge(
        %{
          "to" => to,
          "conversation_id" => cid(),
          "turn_number" => 1,
          "kind" => "inform",
          "body" => "Continue",
          "owner" => @operator,
          "meta" => %{"done" => false, "propose_next" => ""},
          "new_conversation" => true
        },
        extra
      )

    payload = if work, do: Map.put(payload, "work_id", work.work_id), else: payload

    {push(socket, "envelope", frame(from, "inter_agent_message", payload)),
     payload["conversation_id"]}
  end

  defp legacy(work, extra \\ %{}) do
    values = %{
      holds: [%{hold_id: "legacy-hold", reason: "pause", set_at_revision: 2}],
      transfers: [
        %{
          transfer_id: "legacy-transfer",
          old_assignee: agent("former"),
          new_assignee: work.assignee,
          epoch: 2,
          state: "pending"
        }
      ],
      verdicts: [%{verdict_id: "legacy-verdict", state: "recorded", outcome: "approve"}],
      requires_verdict: true
    }

    updated = Map.merge(work, Map.merge(values, extra))
    :sys.replace_state(WorkStore, fn state -> put_in(state, [:works, work.work_id], updated) end)
    updated
  end

  test "complete ignores artifacts and input revisions but preserves actor and state" do
    for extra <- [%{}, %{"subject_hash" => "unused", "expected_revision" => 999}] do
      work = grant()
      assert work.reviews == nil
      assert work.requires_verdict == false

      assert {:ok, %{work: %{state: "completed", revision: 2}}} =
               apply_op(agent("director"), work, "complete", extra)
    end

    work = nominate()
    assert {:error, :work_state_conflict} = apply_op(agent("director"), work, "complete")
    assert {:error, :work_not_authorized} = apply_op(agent("assignee"), work, "complete")
    assert {:ok, %{work: %{state: "declined"}}} = apply_op(agent("assignee"), work, "decline")
    work = nominate()

    assert {:ok, %{work: %{state: "active", revision: 1}}} =
             apply_op(agent("assignee"), work, "accept_assignment")

    assert {:error, :work_not_authorized} = apply_op(@operator, nominate(), "accept_assignment")
    assert {:ok, _} = apply_op(@operator, work, "cancel")
    assert {:error, :work_state_conflict} = apply_op(@operator, work, "cancel")
  end

  test "removed operations are rejected before identity and authority checks" do
    work = grant()
    before = WorkStore.all()

    for op <- @removed do
      assert {:error, :unsupported_work_operation} = apply_op(agent("stranger"), work, op)

      assert {:error, :unsupported_work_operation} =
               WorkStore.apply(
                 @operator,
                 %{"op" => op, "operation_id" => opid(), "work_id" => "missing"},
                 %{operator: true}
               )
    end

    assert WorkStore.all() == before
    sender = peer("stranger")
    _ = peer("assignee")
    id = opid()

    {ref, _} =
      message(sender, "stranger", "assignee", nil, %{
        "work_control" => %{"op" => "submit", "operation_id" => id, "work_id" => work.work_id}
      })

    assert_reply ref, :error, %{
      reason: "unsupported_work_operation",
      send_not_attempted: true,
      details: %{operation_id: ^id, delivery: "not_recorded"}
    }

    assert_reply push(sender, "work_op_result_request", %{"version" => "0", "operation_id" => id}),
                 :ok,
                 %{"error" => "unknown_operation"}

    assert WorkStore.all() == before
  end

  test "operator removed-operation errors preserve their public reason" do
    work = grant()
    operator = operator_socket()
    @endpoint.subscribe("wrapper:assignee")
    before = WorkStore.all()

    assert_reply push(operator, "work_control", %{
                   "version" => "0",
                   "work_control" => %{
                     "op" => "hold",
                     "operation_id" => opid(),
                     "work_id" => work.work_id,
                     "reason" => "pause"
                   }
                 }),
                 :error,
                 %{reason: "unsupported_work_operation"}

    assert WorkStore.all() == before
    refute_receive %Phoenix.Socket.Broadcast{event: "work_notice"}, 20
  end

  test "obsolete control requests are refused without disconnecting the channel" do
    socket = peer("director")

    for event <- ["work_check_request", "work_transfer_ack"] do
      assert_reply push(socket, event, %{
                     "version" => "0",
                     "work_id" => "unused",
                     "transfer_id" => "unused"
                   }),
                   :error,
                   %{reason: "unsupported_work_operation"}

      assert Process.alive?(socket.channel_pid)

      assert_reply push(socket, "work_status_request", %{"version" => "0"}), :ok, %{
        pending_transfers: []
      }
    end
  end

  test "legacy values remain intact on the wire but never grant access or block completion" do
    _ = peer("director")
    assignee = peer("assignee")
    _ = peer("former")
    for id <- ["director", "assignee", "former"], do: @endpoint.subscribe("wrapper:" <> id)
    work = legacy(grant(), %{authority_epoch: 2})
    review = grant("review-director", "reviewer") |> legacy(%{reviews: work.work_id})
    assert {:ok, %{pending_transfers: [], works: []}} = WorkStore.status(agent("former"))
    assert {:error, :work_not_authorized} = WorkStore.status(agent("former"), work.work_id)
    assert {:error, :work_not_authorized} = WorkStore.status(review.assignee, work.work_id)

    assert_reply push(assignee, "work_status_request", %{
                   "version" => "0",
                   "work_id" => work.work_id
                 }),
                 :ok,
                 %{work: %{verdicts: verdicts}}

    assert verdicts == work.verdicts
    operator = operator_socket()

    assert_reply push(operator, "work_control", %{
                   "version" => "0",
                   "work_control" => %{
                     "op" => "complete",
                     "operation_id" => opid(),
                     "work_id" => work.work_id
                   }
                 }),
                 :ok

    for id <- ["director", "assignee"] do
      topic = "wrapper:" <> id

      assert_receive %Phoenix.Socket.Broadcast{
        topic: ^topic,
        event: "work_notice",
        payload: %{"work" => noticed}
      }

      assert Map.take(noticed, @legacy) == Map.take(work, @legacy)
    end

    refute_receive %Phoenix.Socket.Broadcast{topic: "wrapper:former", event: "work_notice"}, 20
    assert Map.take(WorkStore.all()[work.work_id], @legacy) == Map.take(work, @legacy)
    assert WorkStore.all()[work.work_id].authority_epoch == 2
    other = legacy(grant())
    assert {:ok, _} = apply_op(@operator, other, "cancel")
    assert Map.take(WorkStore.all()[other.work_id], @legacy) == Map.take(other, @legacy)
  end

  test "ordinary links allow director assignee and early intent without receipts or revisions" do
    director = peer("director")
    assignee = peer("assignee")
    work = grant()

    for {socket, from, to, intent} <- [
          {director, "director", "assignee", "normal"},
          {assignee, "assignee", "director", "normal"},
          {director, "director", "assignee", "early"}
        ] do
      {ref, conversation} = message(socket, from, to, work, %{"delivery_intent" => intent})
      assert_reply ref, :ok, %{"work" => %{work_id: id, revision: 1}}
      assert id == work.work_id
      assert_push "envelope", %{"payload" => %{"work" => %{work_id: ^id}}}
      assert conversation in WorkStore.all()[id].links
    end

    assert WorkStore.all()[work.work_id].revision == work.revision
    assert WorkStore.all()[work.work_id].receipts == work.receipts
    before_restart = WorkStore.all()[work.work_id]
    :ok = Supervisor.terminate_child(KaoiroServer.Supervisor, WorkStore)
    {:ok, _} = Supervisor.restart_child(KaoiroServer.Supervisor, WorkStore)
    assert WorkStore.all()[work.work_id] == before_restart
  end

  test "preview rejects foreign closed and stale conversations before mutating links" do
    director = peer("director")
    _ = peer("assignee")
    stranger = peer("stranger")
    _ = peer("other")
    work = grant()
    {first, foreign} = message(stranger, "stranger", "other", nil)
    assert_reply first, :ok
    {ref, _} = message(director, "director", "assignee", work, %{"conversation_id" => foreign})
    assert_reply ref, :error, %{reason: "participants_mismatch", send_not_attempted: true}
    assert WorkStore.all()[work.work_id].links == []
    {first, closed} = message(director, "director", "assignee", nil)
    assert_reply first, :ok
    assert {:ok, _} = ConversationStates.close_by_operator(closed)
    {ref, _} = message(director, "director", "assignee", work, %{"conversation_id" => closed})
    assert_reply ref, :error, %{reason: "conversation_closed"}
    {first, stale} = message(director, "director", "assignee", nil)
    assert_reply first, :ok
    {ref, _} = message(director, "director", "assignee", work, %{"conversation_id" => stale})
    assert_reply ref, :error, %{reason: "stale_turn"}
    assert WorkStore.all()[work.work_id].links == []
  end

  test "existing same-participant conversations require an explicit new declaration" do
    director = peer("director")
    _ = peer("assignee")

    for flag <- [false, :absent, true] do
      work = grant()
      {first, conversation} = message(director, "director", "assignee", nil)
      assert_reply first, :ok

      payload = %{
        "to" => "assignee",
        "conversation_id" => conversation,
        "turn_number" => 2,
        "kind" => "inform",
        "body" => "Link existing",
        "owner" => @operator,
        "meta" => %{"done" => false, "propose_next" => ""},
        "work_id" => work.work_id
      }

      payload = if flag == :absent, do: payload, else: Map.put(payload, "new_conversation", flag)
      ref = push(director, "envelope", frame("director", "inter_agent_message", payload))

      if flag == true do
        assert_reply ref, :ok
        assert WorkStore.all()[work.work_id].links == [conversation]

        {repeat, _} =
          message(director, "director", "assignee", work, %{
            "conversation_id" => conversation,
            "turn_number" => 3,
            "new_conversation" => false
          })

        assert_reply repeat, :ok
        assert WorkStore.all()[work.work_id].links == [conversation]
      else
        assert_reply ref, :error, %{reason: "work_carriage_invalid", send_not_attempted: true}
        assert WorkStore.all()[work.work_id].links == []
      end
    end
  end

  test "link authority state conflict and settings checks preserve the record" do
    director = peer("director")
    stranger = peer("stranger")
    _ = peer("assignee")
    _ = peer("other")
    work = grant()

    for {socket, from, to, target, reason} <- [
          {stranger, "stranger", "assignee", work, "work_carriage_invalid"},
          {stranger, "stranger", "director", work, "work_carriage_invalid"},
          {director, "director", "other", work, "work_carriage_invalid"},
          {director, "director", "assignee", %{work_id: "unknown"}, "unknown_work"},
          {director, "director", "assignee", nominate(), "work_state_conflict"}
        ] do
      before = WorkStore.all()
      {ref, _} = message(socket, from, to, target)
      assert_reply ref, :error, %{reason: ^reason, send_not_attempted: true}
      assert WorkStore.all() == before
    end

    cancelled = grant()
    assert {:ok, _} = apply_op(@operator, cancelled, "cancel")
    {ref, _} = message(director, "director", "assignee", cancelled)
    assert_reply ref, :error, %{reason: "work_state_conflict"}
    linked = cid()

    assert {:ok, _} =
             WorkStore.link(agent("director"), work.work_id, %{
               recipient: "assignee",
               conversation_id: linked,
               new_conversation?: true
             })

    {ref, _} = message(director, "director", "assignee", grant(), %{"conversation_id" => linked})
    assert_reply ref, :error, %{reason: "work_carriage_invalid"}

    for status <- [:blocked_invalid, :blocked_unknown] do
      :sys.replace_state(WorkStore, &%{&1 | settings_status: status})
      {ref, _} = message(director, "director", "assignee", work)

      expected =
        if status == :blocked_invalid, do: "work_settings_corrupt", else: "work_settings_unknown"

      assert_reply ref, :error, %{reason: ^expected}
    end

    :sys.replace_state(WorkStore, &%{&1 | settings_status: :ready})

    {ref, _} =
      message(director, "director", "assignee", work, %{
        "work_control" => %{
          "op" => "complete",
          "work_id" => "different",
          "operation_id" => opid()
        }
      })

    assert_reply ref, :error, %{reason: "work_carriage_invalid"}

    {ref, _} =
      message(director, "director", "assignee", work, %{
        "work_control" => %{
          "op" => "complete",
          "work_id" => work.work_id,
          "operation_id" => opid()
        }
      })

    assert_reply ref, :ok, %{"work_control_result" => %{op: "complete"}}
  end

  test "link capacity rejects excess links and preserves repeated links" do
    director = peer("director")
    _ = peer("assignee")
    work = grant()

    for _ <- 1..32 do
      {ref, _} = message(director, "director", "assignee", work)
      assert_reply ref, :ok
    end

    before = WorkStore.all()[work.work_id]
    {ref, _} = message(director, "director", "assignee", work)

    assert_reply ref, :error, %{
      reason: "work_capacity",
      send_not_attempted: true,
      details: %{capacity: %{limit: "work_links_per_work", maximum: 32}}
    }

    assert WorkStore.all()[work.work_id] == before

    {repeat, _} =
      message(director, "director", "assignee", work, %{
        "conversation_id" => List.last(before.links),
        "turn_number" => 2
      })

    assert_reply repeat, :ok
    assert WorkStore.all()[work.work_id] == before
  end

  test "yield-only messages require an existing link and do not create one" do
    director = peer("director")
    _ = peer("assignee")
    other = grant()

    {ref, _} =
      message(director, "director", "assignee", other, %{
        "delivery_intent" => "yield",
        "expected_authority_epoch" => 1
      })

    assert_reply ref, :ok, %{"delivery_authority" => %{downgrade: "yield_not_authorized"}}
    assert WorkStore.all()[other.work_id].links == []
  end

  test "operation receipts deduplicate before delivery and reject different maps" do
    director = peer("director")
    _ = peer("assignee")
    op = %{"op" => "assign", "operation_id" => opid(), "title" => "Once"}
    {ref, _} = message(director, "director", "assignee", nil, %{"work_control" => op})
    assert_reply ref, :ok
    assert_push "envelope", %{"payload" => %{"body" => "Continue"}}

    {ref, _} =
      message(director, "director", "assignee", nil, %{
        "work_control" => op,
        "body" => "Changed body"
      })

    assert_reply ref, :error, %{reason: "work_operation_deduplicated"}
    refute_push "envelope", %{"payload" => %{"body" => "Changed body"}}

    {ref, _} =
      message(director, "director", "assignee", nil, %{
        "work_control" => %{op | "title" => "Different"}
      })

    assert_reply ref, :error, %{reason: "operation_id_conflict"}
    work = grant()
    old_op = %{"op" => "submit", "operation_id" => opid(), "work_id" => work.work_id}
    stamp = Map.take(work, [:work_id, :state, :revision, :authority_epoch])

    receipt = %{
      operation_id: old_op["operation_id"],
      principal: agent("director"),
      op_digest: WorkStore.digest(old_op),
      result: %{
        op: "submit",
        operation_id: old_op["operation_id"],
        outcome: "applied",
        work: stamp
      },
      issued_at_ms: System.system_time(:millisecond)
    }

    :sys.replace_state(WorkStore, fn state ->
      state
      |> put_in([:works, work.work_id, :receipts], [receipt | work.receipts])
      |> put_in(
        [:receipts, {{"agent", "director"}, old_op["operation_id"]}],
        {work.work_id, receipt}
      )
    end)

    {ref, _} = message(director, "director", "assignee", nil, %{"work_control" => old_op})

    assert_reply ref, :error, %{
      reason: "work_operation_deduplicated",
      details: %{work_control_result: %{op: "submit", deduplicated: true}}
    }
  end

  test "active capacity admits the sixteenth and rejects the seventeenth until disabled" do
    for _ <- 1..15, do: grant()
    sixteenth = nominate()
    assert {:ok, _} = apply_op(agent("assignee"), sixteenth, "accept_assignment")
    seventeenth = nominate()

    assert {:error, {:work_capacity, %{limit: "work_active_per_assignee"}}} =
             apply_op(agent("assignee"), seventeenth, "accept_assignment")

    assert {:ok, _} =
             WorkStore.set_settings(fn -> {:ok, @operator} end, 0, %{
               "work_active_per_assignee" => 0
             })

    assert {:ok, _} = apply_op(agent("assignee"), seventeenth, "accept_assignment")
  end

  test "epoch-two grants preserve reset and yield authorization through completion" do
    work = legacy(grant(), %{authority_epoch: 2, links: ["epoch-conversation"]})

    assert {:ok, work.work_id, 2} ==
             WorkStore.authorize_peer_reset(agent("director"), "assignee", work.work_id, 2)

    for {actor, epoch} <- [{agent("stranger"), 2}, {agent("director"), 1}] do
      assert {:error, :reset_not_authorized} =
               WorkStore.authorize_peer_reset(actor, "assignee", work.work_id, epoch)
    end

    assert {:ok, token} =
             WorkStore.admit_yield(
               agent("director"),
               "assignee",
               "epoch-conversation",
               1,
               work.work_id,
               2
             )

    request = %{
      "incarnation" => "same",
      "generation" => "same",
      "yield_token" => token.yield_token,
      "conversation_id" => "epoch-conversation",
      "turn_number" => 1,
      "work_id" => work.work_id,
      "authority_epoch" => 2
    }

    assert {:ok, %{granted: true}} = WorkStore.claim(agent("assignee"), request)
    assert {:ok, %{granted: true, repeated: true}} = WorkStore.claim(agent("assignee"), request)

    assert {:error, :yield_not_authorized} =
             WorkStore.admit_yield(agent("director"), "assignee", "unlinked", 1, work.work_id, 2)

    # An unclaimed pre-upgrade token must not acquire a new authority epoch.
    second =
      legacy(grant("director", "other-assignee"), %{authority_epoch: 2, links: ["old-epoch"]})

    assert {:ok, old} =
             WorkStore.admit_yield(
               agent("director"),
               "other-assignee",
               "old-epoch",
               1,
               second.work_id,
               2
             )

    :sys.replace_state(WorkStore, fn state ->
      put_in(state, [:works, second.work_id, :authority_epoch], 3)
    end)

    old_request = %{
      request
      | "yield_token" => old.yield_token,
        "conversation_id" => "old-epoch",
        "work_id" => second.work_id
    }

    assert {:ok, %{granted: false, reason: :grant_changed}} =
             WorkStore.claim(agent("other-assignee"), old_request)

    assert {:ok, _} = apply_op(@operator, second, "cancel")

    assert {:ok, %{granted: false, reason: :work_not_active}} =
             WorkStore.claim(agent("other-assignee"), old_request)

    assert {:ok, _} = apply_op(@operator, work, "complete")

    assert {:error, :reset_not_authorized} =
             WorkStore.authorize_peer_reset(agent("director"), "assignee", work.work_id, 2)
  end

  test "basic updates sweep and restart preserve every legacy key and value" do
    work = legacy(grant())
    assert {:ok, _} = apply_op(@operator, work, "complete")
    assert :ok = WorkStore.sweep()
    :ok = Supervisor.terminate_child(KaoiroServer.Supervisor, WorkStore)
    {:ok, _} = Supervisor.restart_child(KaoiroServer.Supervisor, WorkStore)
    loaded = WorkStore.all()[work.work_id]
    assert Map.take(loaded, @legacy) == Map.take(work, @legacy)
    assert Enum.all?(@legacy, &Map.has_key?(loaded, &1))
    assert loaded.state == "completed"
  end
end
