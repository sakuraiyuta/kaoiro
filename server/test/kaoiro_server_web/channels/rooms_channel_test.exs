defmodule KaoiroServerWeb.RoomsChannelTest do
  # Rooms through the real channels and the application's own stores (issue
  # #537 Phase 0): the server refuses a send across rooms at both checks, an
  # operator manages rooms, and a move closes the conversations it splits.
  use KaoiroServerWeb.ChannelCase, async: false

  import ExUnit.CaptureLog

  alias KaoiroServer.{
    AgentDirectory,
    AgentStates,
    ConversationStates,
    DeliveryStates,
    HostRegistry,
    PlannedDisconnects,
    Rooms,
    SessionLifecycleEvents,
    SessionResets,
    TestTimeouts,
    WorkStore
  }

  alias KaoiroServerWeb.{AgentId, AgentsChannel, WrapperChannel}

  @operator %{"kind" => "user", "id" => "operator"}
  @management ~w(create_room rename_room delete_room move_agent preview_room_move preview_room_delete)

  setup do
    Application.put_env(:kaoiro_server, :client_tokens, "tok-operator:operator,tok-viewer:viewer")

    on_exit(fn ->
      Application.delete_env(:kaoiro_server, :client_tokens)
      # A test that suspended or stopped a store must not leave it that way.
      for store <- [ConversationStates, WorkStore, Rooms], pid = Process.whereis(store) do
        :sys.resume(pid)
      end

      for store <- [Rooms, KaoiroServer.IngressOrder] do
        _ = Supervisor.restart_child(KaoiroServer.Supervisor, store)
      end
    end)

    n = System.unique_integer([:positive])
    %{a: "test.rooms#{n}-a", b: "test.rooms#{n}-b", c: "test.rooms#{n}-c"}
  end

  # Longer than the 2,000 ms a room save may wait inside the server.
  defp slow, do: TestTimeouts.supervised_restart()

  defp frame(id, type, payload, ext \\ %{}) do
    %{
      "version" => "0",
      "agent_id" => id,
      "persona" => %{"id" => "default", "name" => "Default", "sprite_set" => "default"},
      "ts" => DateTime.utc_now() |> DateTime.to_iso8601(),
      "state" => "idle",
      "type" => type,
      "payload" => payload,
      "ext" => ext
    }
  end

  # A wrapper that bound delivery resync, so a send to it holds a real
  # reservation, and that negotiated work control and delivery modes.
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

  defp client(role) do
    fingerprint = KaoiroServer.Auth.socket_id("tok-#{role}")
    assigns = %{role: role, credential: {:token_fingerprint, fingerprint}, socket_id: fingerprint}

    {:ok, _, socket} =
      KaoiroServerWeb.ClientSocket
      |> socket(nil, assigns)
      |> subscribe_and_join(AgentsChannel, "agents:lobby")

    socket
  end

  defp ia(from, to, extra, ext \\ %{}) do
    payload =
      Map.merge(
        %{
          "to" => to,
          "conversation_id" => "rooms-cnv-#{System.unique_integer([:positive])}",
          "turn_number" => 1,
          "kind" => "inform",
          "body" => "hello",
          "owner" => @operator,
          "meta" => %{"done" => false, "propose_next" => ""},
          "new_conversation" => true
        },
        extra
      )

    frame(from, "inter_agent_message", payload, ext)
  end

  defp send_ia(socket, from, to, extra \\ %{}, ext \\ %{}) do
    envelope = ia(from, to, extra, ext)
    {push(socket, "envelope", envelope), envelope["payload"]["conversation_id"]}
  end

  defp create_room(operator, name) do
    ref = push(operator, "create_room", %{"version" => "0", "name" => name})
    assert_reply ref, :ok, %{"room" => %{"id" => room_id, "name" => ^name}}
    room_id
  end

  defp move(operator, agent_id, room_id) do
    ref =
      push(operator, "move_agent", %{
        "version" => "0",
        "agent_id" => agent_id,
        "room_id" => room_id
      })

    assert_reply ref, :ok, counts
    counts
  end

  defp opid do
    "op_#{System.system_time(:millisecond)}_" <>
      Base.url_encode64(:crypto.strong_rand_bytes(16), padding: false)
  end

  defp reservations(agent_id) do
    Enum.count(:sys.get_state(DeliveryStates).reservations, fn {_token, reservation} ->
      reservation.agent_id == agent_id
    end)
  end

  # Waits until a call tagged `tag` sits in the suspended store's mailbox.
  defp await_queued(store, tag) do
    pid = Process.whereis(store)

    queued? = fn ->
      {:messages, messages} = Process.info(pid, :messages)

      Enum.any?(messages, fn
        {:"$gen_call", _caller, request} when is_tuple(request) -> elem(request, 0) == tag
        _other -> false
      end)
    end

    assert Enum.any?(1..300, fn _ -> queued?.() or (Process.sleep(10) && false) end)
  end

  defp rooms_snapshots do
    receive do
      %Phoenix.Socket.Message{event: "rooms_snapshot", payload: payload} ->
        [payload | rooms_snapshots()]
    after
      0 -> []
    end
  end

  defp assert_untouched(cid, to) do
    assert ConversationStates.get(cid) == nil
    assert reservations(to) == 0
    refute_push "envelope", %{"payload" => %{"conversation_id" => ^cid}}
  end

  test "with no room in use everyone is in the lobby and messages flow", ctx do
    sa = peer(ctx.a)
    _sb = peer(ctx.b)
    _operator = client(:operator)

    assert_push "rooms_snapshot", %{
      "rooms" => [%{"id" => "lobby", "name" => nil}],
      "memberships" => memberships
    }

    assert memberships[ctx.a] == "lobby" and memberships[ctx.b] == "lobby"

    {ref, cid} = send_ia(sa, ctx.a, ctx.b)
    assert_reply ref, :ok
    assert %{status: :open} = ConversationStates.get(cid)

    assert_reply push(sa, "directory_request", %{"version" => "0"}), :ok, %{"agents" => agents}

    assert %{"room" => %{"id" => "lobby", "name" => nil}} =
             Enum.find(agents, &(&1["agent_id"] == ctx.b))

    assert_reply push(sa, "directory_request", %{"version" => "0", "scope" => "self"}), :ok, %{
      "self" => %{"room" => %{"id" => "lobby", "name" => nil}}
    }
  end

  test "an operator creates, renames and deletes rooms; bad requests are refused", ctx do
    _sa = peer(ctx.a)
    operator = client(:operator)
    blue = create_room(operator, "Blue")

    assert_push "rooms_snapshot", %{
      "rooms" => [%{"id" => "lobby", "name" => nil}, %{"id" => ^blue, "name" => "Blue"}]
    }

    assert_reply push(operator, "rename_room", %{
                   "version" => "0",
                   "room_id" => blue,
                   "name" => " Sky "
                 }),
                 :ok,
                 %{
                   "room" => %{"id" => ^blue, "name" => "Sky"}
                 }

    assert_reply push(operator, "rename_room", %{
                   "version" => "0",
                   "room_id" => "lobby",
                   "name" => "Hall"
                 }),
                 :ok,
                 %{
                   "room" => %{"id" => "lobby", "name" => "Hall"}
                 }

    for name <- ["", "   ", "a\u0007b", String.duplicate("x", 65), 7, nil] do
      assert_reply push(operator, "create_room", %{"version" => "0", "name" => name}), :error, %{
        reason: "invalid_room_name"
      }
    end

    assert_reply push(operator, "create_room", %{"version" => "0"}), :error, %{
      reason: "invalid_room_name"
    }

    assert_reply push(operator, "rename_room", %{"version" => "0", "name" => "X"}), :error, %{
      reason: "missing_room_id"
    }

    for {event, payload, reason} <- [
          {"rename_room", %{"room_id" => "nope", "name" => "X"}, "unknown_room"},
          {"delete_room", %{"room_id" => "nope"}, "unknown_room"},
          {"delete_room", %{"room_id" => "lobby"}, "lobby_protected"},
          {"preview_room_delete", %{"room_id" => "lobby"}, "lobby_protected"},
          {"move_agent", %{"agent_id" => ctx.a, "room_id" => "nope"}, "unknown_room"},
          {"move_agent", %{"agent_id" => ctx.a}, "missing_room_id"},
          {"move_agent", %{"agent_id" => "test.rooms-nobody", "room_id" => blue},
           "unknown_agent"},
          {"preview_room_move", %{"agent_id" => "bad id", "room_id" => blue}, "invalid_agent_id"}
        ] do
      assert_reply push(operator, event, Map.put(payload, "version", "0")), :error, %{
        reason: ^reason
      }
    end

    assert_reply push(operator, "delete_room", %{"version" => "0", "room_id" => blue}), :ok, %{
      "closed_count" => 0,
      "member_count" => 0
    }

    assert {:ok, %{rooms: %{"lobby" => "Hall"} = rooms}} = Rooms.snapshot()
    assert map_size(rooms) == 1
  end

  test "a move closes the split conversation, tells both ends, and blocks later sends", ctx do
    sa = peer(ctx.a)
    sb = peer(ctx.b)
    _sc = peer(ctx.c)
    operator = client(:operator)
    blue = create_room(operator, "Blue")
    {ref, ab} = send_ia(sa, ctx.a, ctx.b)
    assert_reply ref, :ok
    {ref, bc} = send_ia(sb, ctx.b, ctx.c)
    assert_reply ref, :ok

    preview =
      push(operator, "preview_room_move", %{
        "version" => "0",
        "agent_id" => ctx.a,
        "room_id" => blue
      })

    assert_reply preview, :ok, %{"closing_count" => 1, "member_count" => 1}
    assert %{status: :open} = ConversationStates.get(ab)

    a = ctx.a
    b = ctx.b
    assert move(operator, a, blue) == %{"closed_count" => 1, "member_count" => 1}
    assert %{status: :closed, reason: :room_changed} = ConversationStates.get(ab)
    assert %{status: :open} = ConversationStates.get(bc)

    for recipient <- [a, b] do
      assert_push "envelope", %{
        "agent_id" => "server",
        "delivery_seq" => _,
        "payload" => %{
          "to" => ^recipient,
          "conversation_id" => ^ab,
          "kind" => "done",
          "turn_number" => 0,
          "body" => "conversation closed: room_changed",
          "meta" => %{"done" => true}
        }
      }
    end

    assert_push "envelope", %{
      "agent_id" => "server",
      "delivery_seq" => _,
      "payload" => %{
        "to" => ^a,
        "notice_type" => "room_changed",
        "kind" => "inform",
        "turn_number" => 0,
        "meta" => %{"done" => false},
        "conversation_id" => notice_cid,
        "body" => body
      }
    }

    assert body =~ ~s(room "Blue") and body =~ blue
    assert ConversationStates.get(notice_cid) == nil

    refute_push "envelope", %{
      "delivery_seq" => _,
      "payload" => %{"to" => ^b, "notice_type" => "room_changed"}
    }

    # The rule holds in both directions, and no field a wrapper sends bends it.
    for {socket, from, to} <- [{sa, a, b}, {sb, b, a}] do
      {ref, cid} = send_ia(socket, from, to, %{}, %{"room" => %{"id" => "lobby"}})
      assert_reply ref, :error, %{reason: "room_mismatch"}
      assert_untouched(cid, to)
    end

    # Moving to the room the agent is already in changes and announces nothing.
    assert move(operator, a, blue) == %{"closed_count" => 0, "member_count" => 0}

    refute_push "envelope", %{
      "delivery_seq" => _,
      "payload" => %{"notice_type" => "room_changed"}
    }

    assert_reply push(operator, "preview_room_delete", %{"version" => "0", "room_id" => blue}),
                 :ok,
                 %{
                   "closing_count" => 0,
                   "member_count" => 1
                 }

    assert_reply push(operator, "delete_room", %{"version" => "0", "room_id" => blue}), :ok, %{
      "closed_count" => 0,
      "member_count" => 1
    }

    assert_push "envelope", %{
      "delivery_seq" => _,
      "payload" => %{"to" => ^a, "notice_type" => "room_changed", "body" => lobby_body}
    }

    assert lobby_body =~ "the lobby"
    {ref, _cid} = send_ia(sa, a, b)
    assert_reply ref, :ok
  end

  test "every kind of send across rooms is refused before anything is touched", ctx do
    sa = peer(ctx.a)
    sb = peer(ctx.b)
    operator = client(:operator)
    {ref, existing} = send_ia(sa, ctx.a, ctx.b)
    assert_reply ref, :ok

    {:ok, %{work: work}} =
      WorkStore.apply(
        @operator,
        %{
          "op" => "assign",
          "operation_id" => opid(),
          "title" => "Rooms",
          "director" => %{"kind" => "agent", "id" => ctx.a},
          "assignee" => ctx.b
        },
        %{operator: true}
      )

    blue = create_room(operator, "Blue")
    move(operator, ctx.a, blue)
    # The move's notices are in the mailbox before the sends below are judged.
    for socket <- [sa, sb, operator], do: :sys.get_state(socket.channel_pid)
    flush_envelopes()
    works = WorkStore.all()
    projection = AgentStates.ia_projection()
    b = ctx.b

    for {label, extra} <- [
          {"a new conversation", %{}},
          {"done", %{"meta" => %{"done" => true, "propose_next" => ""}}},
          {"an existing conversation",
           %{"conversation_id" => existing, "turn_number" => 2, "new_conversation" => false}},
          {"a peer error notice",
           %{
             "error" => %{
               "code" => "api_error",
               "message" => "the peer reported an unspecified error"
             }
           }},
          {"early", %{"delivery_intent" => "early"}},
          {"yield",
           %{
             "delivery_intent" => "yield",
             "work_id" => work.work_id,
             "expected_authority_epoch" => work.authority_epoch
           }},
          {"a carried work id", %{"work_id" => work.work_id}},
          {"a work operation",
           %{"work_control" => %{"op" => "assign", "operation_id" => opid(), "title" => "New"}}}
        ] do
      {ref, cid} = send_ia(sa, ctx.a, b, extra)
      assert_reply ref, :error, reply
      assert reply == %{reason: "room_mismatch"}, "#{label}: #{inspect(reply)}"
      assert reservations(b) == 0, label
      assert WorkStore.all() == works, label
      assert AgentStates.ia_projection() == projection, label
      refute_push "envelope", %{"payload" => %{"conversation_id" => ^cid, "to" => ^b}}
      if cid != existing, do: assert(ConversationStates.get(cid) == nil, label)
    end
  end

  defp flush_envelopes do
    receive do
      %Phoenix.Socket.Message{event: "envelope"} -> flush_envelopes()
    after
      0 -> :ok
    end
  end

  test "a different room is reported before a restart, a disconnect or a backlog", ctx do
    Process.flag(:trap_exit, true)
    sa = peer(ctx.a)
    sb = peer(ctx.b)
    sc = peer(ctx.c)
    operator = client(:operator)
    blue = create_room(operator, "Blue")
    move(operator, ctx.a, blue)

    # Backlog: the recipient's reservation ledger is full for a same-room peer.
    for _ <- 1..1000, do: {:ok, _token} = DeliveryStates.reserve(ctx.b, self())
    {ref, _cid} = send_ia(sc, ctx.c, ctx.b)
    assert_reply ref, :error, %{reason: "delivery_backlog"}
    {ref, _cid} = send_ia(sa, ctx.a, ctx.b)
    assert_reply ref, :error, %{reason: "room_mismatch"}

    # Planned restart: a same-room send is bounced and tracked, a cross-room
    # one is neither.
    assert :ok = PlannedDisconnects.begin(ctx.b, "rooms-transition", :restart)
    {ref, cross} = send_ia(sa, ctx.a, ctx.b)
    assert_reply ref, :error, %{reason: "room_mismatch"}
    refute inspect(PlannedDisconnects.get(ctx.b)) =~ cross
    {ref, same} = send_ia(sc, ctx.c, ctx.b)
    assert_reply ref, :error, %{reason: "peer_reconnecting"}
    assert inspect(PlannedDisconnects.get(ctx.b)) =~ same

    # Disconnected.
    :ok = close(sb)
    {ref, _cid} = send_ia(sa, ctx.a, ctx.b)
    assert_reply ref, :error, %{reason: "room_mismatch"}
  end

  describe "a move racing a send" do
    setup ctx do
      sockets = %{sa: peer(ctx.a), sb: peer(ctx.b), operator: client(:operator)}
      Map.put(sockets, :blue, create_room(sockets.operator, "Blue"))
    end

    # The first check passed while both were in the lobby; the move is ahead
    # of the record in the tracker's mailbox, so the record's own check is
    # what refuses, and the reservation the channel took is released.
    test "the move first: the record is refused and nothing is delivered", ctx do
      :ok = :sys.suspend(ConversationStates)

      move_ref =
        push(ctx.operator, "move_agent", %{
          "version" => "0",
          "agent_id" => ctx.a,
          "room_id" => ctx.blue
        })

      await_queued(ConversationStates, :room_change)
      {send_ref, cid} = send_ia(ctx.sa, ctx.a, ctx.b)
      await_queued(ConversationStates, :record)
      assert reservations(ctx.b) == 1
      :ok = :sys.resume(ConversationStates)

      assert_reply move_ref, :ok, %{"closed_count" => 0}
      assert_reply send_ref, :error, %{reason: "room_mismatch"}
      assert_untouched(cid, ctx.b)
      refute Map.has_key?(AgentStates.ia_projection(), ctx.b)
    end

    test "the move after a work operation was applied: the work stays, the send is refused",
         ctx do
      operation_id = opid()
      operation = %{"op" => "assign", "operation_id" => operation_id, "title" => "Raced"}
      :ok = :sys.suspend(ConversationStates)
      ref = push(ctx.sa, "envelope", ia(ctx.a, ctx.b, %{"work_control" => operation}))
      await_queued(ConversationStates, :preview)
      :ok = :sys.suspend(WorkStore)
      :ok = :sys.resume(ConversationStates)
      # The preview passed in the lobby. The channel now waits on WorkStore.
      move(ctx.operator, ctx.a, ctx.blue)
      :ok = :sys.resume(WorkStore)

      assert_reply ref, :error, %{
        reason: "work_applied_message_rejected",
        send_not_attempted: true,
        details: %{
          work_control_result: %{operation_id: ^operation_id},
          conversation_error: "room_mismatch"
        }
      }

      assert {:ok, %{delivery: %{status: "not_recorded"}}} =
               WorkStore.op_result(%{"kind" => "agent", "id" => ctx.a}, operation_id)

      assert reservations(ctx.b) == 0
    end

    # Recorded under the old rooms, so the message is delivered; the move then
    # closes that conversation and both ends are told.
    test "the record first: the message is delivered and the conversation closed", ctx do
      a = ctx.a
      b = ctx.b
      :ok = :sys.suspend(ConversationStates)
      {send_ref, cid} = send_ia(ctx.sa, a, b)
      await_queued(ConversationStates, :record)

      move_ref =
        push(ctx.operator, "move_agent", %{
          "version" => "0",
          "agent_id" => a,
          "room_id" => ctx.blue
        })

      await_queued(ConversationStates, :room_change)
      :ok = :sys.resume(ConversationStates)

      assert_reply send_ref, :ok
      assert_reply move_ref, :ok, %{"closed_count" => 1, "member_count" => 1}
      assert %{status: :closed, reason: :room_changed} = ConversationStates.get(cid)

      assert_push "envelope", %{
        "agent_id" => ^a,
        "delivery_seq" => _,
        "payload" => %{"conversation_id" => ^cid, "to" => ^b, "body" => "hello"}
      }

      for recipient <- [a, b] do
        assert_push "envelope", %{
          "agent_id" => "server",
          "payload" => %{"conversation_id" => ^cid, "to" => ^recipient, "kind" => "done"}
        }
      end
    end

    for {label, reason} <- [{"killed", :kill}, {"crashed", {:boom, []}}] do
      test "a sending channel #{label} mid-send harms no store and no other pair", ctx do
        Process.flag(:trap_exit, true)
        sc = peer(ctx.c)

        stores =
          for store <- [ConversationStates, Rooms, DeliveryStates], do: Process.whereis(store)

        :ok = :sys.suspend(ConversationStates)
        {_ref, _cid} = send_ia(ctx.sa, ctx.a, ctx.b)
        await_queued(ConversationStates, :record)
        assert reservations(ctx.b) == 1

        monitor = Process.monitor(ctx.sa.channel_pid)
        Process.exit(ctx.sa.channel_pid, unquote(Macro.escape(reason)))
        assert_receive {:DOWN, ^monitor, :process, _pid, _reason}
        :ok = :sys.resume(ConversationStates)

        {ref, cid} = send_ia(sc, ctx.c, ctx.b)
        assert_reply ref, :ok
        assert %{status: :open} = ConversationStates.get(cid)
        # Only the delivery just accepted is not a leftover reservation.
        assert reservations(ctx.b) == 0

        assert stores ==
                 for(
                   store <- [ConversationStates, Rooms, DeliveryStates],
                   do: Process.whereis(store)
                 )

        assert Rooms.same_room(ctx.b, ctx.c) == :ok
      end
    end
  end

  test "Rooms not answering fails that send or request only", ctx do
    sa = peer(ctx.a)
    _sb = peer(ctx.b)
    operator = client(:operator)
    :ok = :sys.suspend(Rooms)

    {ref, cid} = send_ia(sa, ctx.a, ctx.b)
    assert_reply ref, :error, %{reason: "rooms_unavailable"}, slow()
    assert_untouched(cid, ctx.b)

    ref = push(sa, "directory_request", %{"version" => "0"})
    assert_reply ref, :ok, %{"agents" => agents}, slow()
    refute Enum.any?(agents, &Map.has_key?(&1, "room"))

    ref = push(operator, "create_room", %{"version" => "0", "name" => "Blue"})
    assert_reply ref, :error, %{reason: "room_change_unconfirmed"}, slow()

    :ok = :sys.resume(Rooms)
    {ref, _cid} = send_ia(sa, ctx.a, ctx.b)
    assert_reply ref, :ok
  end

  test "a failed notice is reported as unconfirmed and the channel lives on", ctx do
    sa = peer(ctx.a)
    _sb = peer(ctx.b)
    operator = client(:operator)
    blue = create_room(operator, "Blue")
    {ref, cid} = send_ia(sa, ctx.a, ctx.b)
    assert_reply ref, :ok
    :ok = Supervisor.terminate_child(KaoiroServer.Supervisor, KaoiroServer.IngressOrder)

    log =
      capture_log(fn ->
        ref =
          push(operator, "move_agent", %{"version" => "0", "agent_id" => ctx.a, "room_id" => blue})

        assert_reply ref, :error, %{reason: "room_change_unconfirmed"}
      end)

    assert log =~ "a room change notice"
    {:ok, _pid} = Supervisor.restart_child(KaoiroServer.Supervisor, KaoiroServer.IngressOrder)

    # Saved and closed all the same; reading again shows it.
    assert Rooms.same_room(ctx.a, ctx.b) == {:error, :room_mismatch}
    assert %{status: :closed} = ConversationStates.get(cid)

    assert_reply push(operator, "preview_room_delete", %{"version" => "0", "room_id" => blue}),
                 :ok,
                 %{
                   "member_count" => 1
                 }
  end

  test "a viewer reads rooms for the agents it sees and manages nothing", ctx do
    _sa = peer(ctx.a)
    offline = ctx.c <> "-offline"
    AgentDirectory.record(offline, "default", "Offline")
    operator = client(:operator)
    viewer = client(:viewer)
    blue = create_room(operator, "Blue")
    move(operator, ctx.a, blue)
    for socket <- [operator, viewer], do: :sys.get_state(socket.channel_pid)

    {operator_views, viewer_views} =
      Enum.split_with(rooms_snapshots(), &Map.has_key?(&1["memberships"], offline))

    assert %{"memberships" => %{^offline => "lobby"}} = List.last(operator_views)
    last = List.last(viewer_views)
    assert last["memberships"] == %{ctx.a => blue}
    assert %{"id" => blue, "name" => "Blue"} in last["rooms"]

    for event <- @management do
      payload = %{"name" => "X", "room_id" => blue, "agent_id" => ctx.a}
      assert_reply push(viewer, event, payload), :error, %{reason: "forbidden"}
    end

    assert {:ok, %{rooms: rooms, members: members}} = Rooms.snapshot()
    assert rooms == %{"lobby" => nil, blue => "Blue"} and members == %{ctx.a => blue}
  end

  test "an agent moved while offline is not notified, then or on reconnect", ctx do
    Process.flag(:trap_exit, true)
    sa = peer(ctx.a)
    sb = peer(ctx.b)
    operator = client(:operator)
    blue = create_room(operator, "Blue")
    :ok = close(sb)
    topic = "wrapper:" <> ctx.b
    @endpoint.subscribe(topic)

    assert move(operator, ctx.b, blue) == %{"closed_count" => 0, "member_count" => 1}
    sb = peer(ctx.b)
    refute_receive %Phoenix.Socket.Broadcast{topic: ^topic, event: "envelope"}
    refute_push "envelope", %{"payload" => %{"notice_type" => "room_changed"}}

    assert_reply push(sb, "directory_request", %{"version" => "0", "scope" => "self"}), :ok, %{
      "self" => %{"room" => %{"id" => ^blue, "name" => "Blue"}}
    }

    assert_reply push(sa, "directory_request", %{"version" => "0"}), :ok, %{"agents" => agents}
    assert %{"room" => %{"id" => ^blue}} = Enum.find(agents, &(&1["agent_id"] == ctx.b))
  end

  describe "the product store" do
    defp restart_rooms(prepare \\ fn _path -> :ok end) do
      :ok = Supervisor.terminate_child(KaoiroServer.Supervisor, Rooms)
      prepare.(Application.fetch_env!(:kaoiro_server, :rooms_path))
      {:ok, _pid} = Supervisor.restart_child(KaoiroServer.Supervisor, Rooms)
    end

    defp store_raw(path, record, type) do
      File.rm!(path)

      {:ok, table} =
        :dets.open_file(:rooms_channel_raw, file: String.to_charlist(path), type: type)

      :ok = :dets.insert(table, record)
      :ok = :dets.close(table)
    end

    test "keeps rooms across a restart, a reconnect and a delete", ctx do
      Process.flag(:trap_exit, true)
      sa = peer(ctx.a)
      _sb = peer(ctx.b)
      operator = client(:operator)
      blue = create_room(operator, "Blue")
      move(operator, ctx.a, blue)

      restart_rooms()
      assert {:ok, %{rooms: %{^blue => "Blue"}, members: members}} = Rooms.snapshot()
      assert members == %{ctx.a => blue}

      :ok = close(sa)
      sa = peer(ctx.a)
      {ref, _cid} = send_ia(sa, ctx.a, ctx.b)
      assert_reply ref, :error, %{reason: "room_mismatch"}

      :ok = close(sa)
      ref = push(operator, "delete_agent", %{"version" => "0", "agent_id" => ctx.a})
      assert_reply ref, :ok, %{}, TestTimeouts.purge_reply()
      assert {:ok, %{members: members}} = Rooms.snapshot()
      assert members == %{}
    end

    test "a delete succeeds even when the membership cannot be purged", ctx do
      Process.flag(:trap_exit, true)
      sa = peer(ctx.a)
      operator = client(:operator)
      move(operator, ctx.a, create_room(operator, "Blue"))
      :ok = close(sa)
      :ok = :sys.suspend(Rooms)

      log =
        capture_log(fn ->
          ref = push(operator, "delete_agent", %{"version" => "0", "agent_id" => ctx.a})
          assert_reply ref, :ok, %{}, slow() + TestTimeouts.purge_reply()
        end)

      assert log =~ "room membership of #{ctx.a} not purged (room_change_unconfirmed)"
      assert AgentDirectory.get(ctx.a) == nil
    end

    test "a stored membership naming no room puts that agent in the lobby", ctx do
      sa = peer(ctx.a)
      _sb = peer(ctx.b)

      log =
        capture_log(fn ->
          restart_rooms(&store_raw(&1, {:rooms_v1, %{"lobby" => nil}, %{ctx.a => "gone"}}, :set))
        end)

      assert log =~ "1 malformed membership"
      {ref, _cid} = send_ia(sa, ctx.a, ctx.b)
      assert_reply ref, :ok
    end

    test "a store that cannot be opened at start leaves everyone in the lobby", ctx do
      sa = peer(ctx.a)
      _sb = peer(ctx.b)
      operator = client(:operator)
      path = Application.fetch_env!(:kaoiro_server, :rooms_path)

      log = capture_log(fn -> restart_rooms(&store_raw(&1, {:kept, 1}, :bag)) end)
      assert log =~ "the store cannot be opened"

      {ref, _cid} = send_ia(sa, ctx.a, ctx.b)
      assert_reply ref, :ok

      capture_log(fn ->
        ref = push(operator, "create_room", %{"version" => "0", "name" => "Blue"})
        assert_reply ref, :error, %{reason: "rooms_unavailable"}
      end)

      {ref, _cid} = send_ia(sa, ctx.a, ctx.b)
      assert_reply ref, :ok

      File.rm!(path)
      blue = create_room(operator, "Blue")
      assert {:ok, %{rooms: %{^blue => "Blue"}}} = Rooms.snapshot()
    end
  end

  # The same-room rule on `peer_session_reset_request` (issue #1078). Every
  # case shares one setup that subscribes to both topics the reset reaches, so
  # an absence assertion cannot pass for want of a subscription, and the
  # same-room control asserts presence at the same four observation points.
  describe "peer session reset across rooms" do
    defp reset_target(agent_id) do
      socket = peer(agent_id)

      on_exit(fn ->
        AgentStates.delete(agent_id)
        SessionResets.delete(agent_id)
      end)

      ref =
        push(
          socket,
          "envelope",
          frame(agent_id, "state_change", %{}, %{
            "session_capabilities" => %{
              "supports_session_reset" => true,
              "session_reset_modes" => ["new", "clear"]
            }
          })
          |> Map.put("session_id", "sess-prev")
        )

      assert_reply ref, :ok
      socket
    end

    defp reset_setup(ctx) do
      director = peer(ctx.a)
      _target = reset_target(ctx.b)
      operator = client(:operator)
      @endpoint.subscribe("agents:lobby")
      @endpoint.subscribe("runner:#{AgentId.host_id_from(ctx.b)}")
      %{director: director, operator: operator}
    end

    defp grant(director_id, assignee_id) do
      assert {:ok, %{work: work}} =
               WorkStore.apply(
                 @operator,
                 %{
                   "op" => "assign",
                   "operation_id" => opid(),
                   "title" => "issue 1078",
                   "assignee" => assignee_id,
                   "director" => %{"kind" => "agent", "id" => director_id},
                   "requires_verdict" => false
                 },
                 %{operator: true}
               )

      work
    end

    defp request_reset(socket, target_id, work, overrides \\ %{}) do
      push(
        socket,
        "peer_session_reset_request",
        Map.merge(
          %{
            "version" => "0",
            "agent_id" => target_id,
            "mode" => "new",
            "work_id" => work.work_id,
            "expected_authority_epoch" => work.authority_epoch
          },
          overrides
        )
      )
    end

    defp assert_reset_observed(target_id) do
      assert_broadcast "session_reset_started", %{"agent_id" => ^target_id}
      assert_broadcast "reset_session", %{"agent_id" => ^target_id}
      assert [%{kind: "session_reset_started"}] = SessionLifecycleEvents.list_for_agent(target_id)
      assert SessionResets.pending?(target_id)
    end

    defp refute_reset_observed(target_id) do
      refute_broadcast "session_reset_started", _
      refute_broadcast "reset_session", _
      assert SessionLifecycleEvents.list_for_agent(target_id) == []
      refute SessionResets.pending?(target_id)
    end

    test "a same-room reset succeeds and is observed at every point", ctx do
      %{director: director} = reset_setup(ctx)
      work = grant(ctx.a, ctx.b)

      ref = request_reset(director, ctx.b, work)
      assert_reply ref, :ok, %{request_id: request_id}
      assert is_binary(request_id)
      assert_reset_observed(ctx.b)
    end

    test "a target moved before the grant is refused with room_mismatch", ctx do
      %{director: director, operator: operator} = reset_setup(ctx)
      move(operator, ctx.b, create_room(operator, "Away"))
      work = grant(ctx.a, ctx.b)

      ref = request_reset(director, ctx.b, work)
      assert_reply ref, :error, %{reason: "room_mismatch"}
      refute_reset_observed(ctx.b)
    end

    test "a director moved after the grant is refused with room_mismatch", ctx do
      %{director: director, operator: operator} = reset_setup(ctx)
      work = grant(ctx.a, ctx.b)
      move(operator, ctx.a, create_room(operator, "Away"))

      ref = request_reset(director, ctx.b, work)
      assert_reply ref, :error, %{reason: "room_mismatch"}
      refute_reset_observed(ctx.b)
      # The move leaves the grant active, so this is not an authority failure.
      assert %{state: "active"} = WorkStore.all()[work.work_id]
    end

    test "authority is decided before rooms", ctx do
      %{director: director, operator: operator} = reset_setup(ctx)
      work = grant(ctx.a, ctx.b)
      move(operator, ctx.b, create_room(operator, "Away"))

      ref =
        request_reset(director, ctx.b, work, %{
          "expected_authority_epoch" => work.authority_epoch + 1
        })

      assert_reply ref, :error, %{reason: "reset_not_authorized"}
      refute_reset_observed(ctx.b)
    end

    test "an unreadable rooms store refuses with rooms_unavailable", ctx do
      %{director: director} = reset_setup(ctx)
      work = grant(ctx.a, ctx.b)
      rooms = Process.whereis(Rooms)
      :sys.suspend(rooms)

      ref = request_reset(director, ctx.b, work)
      assert_reply ref, :error, %{reason: "rooms_unavailable"}, slow()
      :sys.resume(rooms)
      refute_reset_observed(ctx.b)
    end
  end

  # The room a new agent starts in (issue #1081 Phase 1-1, ADR-0073). Each
  # test below is one claim of the design, so one mutation turns exactly one
  # of them red.
  describe "the room a launch names" do
    setup do
      host_id = "launch#{System.unique_integer([:positive])}"

      :ok =
        HostRegistry.register(
          host_id,
          %{policy: :accept_all, cwd_allowlist: ["/work/proj"], capabilities: ["claude-code"]},
          self()
        )

      @endpoint.subscribe("runner:" <> host_id)
      %{host_id: host_id, operator: client(:operator)}
    end

    test "T1 the membership is saved before the runner is told", ctx do
      room_id = create_room(ctx.operator, "Ordering")
      tracker = Process.whereis(ConversationStates)
      :ok = :sys.suspend(tracker)
      ref = launch(ctx.operator, ctx.host_id, %{"room_id" => room_id})
      await_queued(ConversationStates, :room_change)

      refute_broadcast "spawn", _held, 0

      :sys.resume(tracker)
      assert_reply ref, :ok, %{"agent_id" => agent_id}, slow()

      # The same subscription receives it once the save completes, so the
      # refutation above is not a dead assertion.
      assert_broadcast "spawn", %{"agent_id" => ^agent_id}
      assert Map.get(members(), agent_id) == room_id
    end

    test "T2 the placement reaches every dashboard as a snapshot", ctx do
      room_id = create_room(ctx.operator, "Broadcast")
      ref = launch(ctx.operator, ctx.host_id, %{"room_id" => room_id})
      assert_reply ref, :ok, %{"agent_id" => agent_id}
      assert_broadcast "spawn", _payload

      # The `create_room` push arrives first; this is the launch's own, and
      # without it no dashboard would show the agent in its room.
      assert_push "rooms_snapshot", %{"memberships" => %{^agent_id => ^room_id}}
    end

    test "T3 a launch with no room reaches no store", ctx do
      tracker = Process.whereis(ConversationStates)
      rooms = Process.whereis(Rooms)
      :ok = :sys.suspend(tracker)
      :ok = :sys.suspend(rooms)

      ref = launch(ctx.operator, ctx.host_id)
      assert_reply ref, :ok, %{"agent_id" => agent_id, "room_id" => "lobby"}
      assert_broadcast "spawn", %{"agent_id" => ^agent_id}

      :sys.resume(rooms)
      :sys.resume(tracker)
      refute Map.has_key?(members(), agent_id)
    end

    test "T4 an unknown room leaves nothing behind", ctx do
      before = members()
      ref = launch(ctx.operator, ctx.host_id, %{"room_id" => "no-such-room"})
      assert_reply ref, :error, %{reason: "unknown_room"}
      refute_broadcast "spawn", _held, 0
      assert members() == before
      assert recorded_of(ctx.host_id) == []
    end

    test "T4b an unreadable rooms store refuses before any side effect", ctx do
      before = members()
      rooms = Process.whereis(Rooms)
      :ok = :sys.suspend(rooms)
      ref = launch(ctx.operator, ctx.host_id, %{"room_id" => "any-room"})
      assert_reply ref, :error, %{reason: "rooms_unavailable"}, slow()
      refute_broadcast "spawn", _held, 0
      :sys.resume(rooms)

      # The pre-check runs before the identity is recorded, so an unreadable
      # store leaves nothing at all — unlike a failed save below.
      assert members() == before
      assert recorded_of(ctx.host_id) == []
    end

    test "T5a a save that cannot complete refuses the launch", ctx do
      room_id = create_room(ctx.operator, "Refusal")
      rooms = hold_save(ctx, room_id)
      refute_broadcast "spawn", _held, 0
      :sys.resume(rooms)
    end

    test "T5b the refused launch keeps its identity", ctx do
      room_id = create_room(ctx.operator, "Residue")
      rooms = hold_save(ctx, room_id)
      :sys.resume(rooms)

      # The identity is what makes a membership clearable at all, so a
      # refusal must not discard it.
      assert [_one] = recorded_of(ctx.host_id)
    end

    test "T5c a save that completes after the refusal is still clearable", ctx do
      room_id = create_room(ctx.operator, "Late save")
      rooms = hold_save(ctx, room_id)

      # Observed, not assumed: the save the server gave up on lands anyway.
      :sys.resume(rooms)
      agent_id = await_member(room_id)
      assert [{^agent_id, _entry}] = recorded_of(ctx.host_id)

      ref = push(ctx.operator, "delete_agent", %{"version" => "0", "agent_id" => agent_id})
      assert_reply ref, :ok, %{}, TestTimeouts.purge_reply()
      refute Map.has_key?(members(), agent_id)
    end

    test "T6 a restore does not write the room", ctx do
      room_id = create_room(ctx.operator, "Resume")
      elsewhere = create_room(ctx.operator, "Elsewhere")
      ref = launch(ctx.operator, ctx.host_id, %{"room_id" => room_id})
      assert_reply ref, :ok, %{"agent_id" => agent_id}
      assert_broadcast "spawn", _payload

      # A restore reuses the agent id and names no room; one in its payload
      # changes nothing.
      ref =
        push(ctx.operator, "restore", %{
          "version" => "0",
          "agent_id" => agent_id,
          "room_id" => elsewhere
        })

      assert_reply ref, :ok, _reply, slow()
      assert Map.get(members(), agent_id) == room_id
    end

    test "T7 the reply carries the room id it placed the agent in", ctx do
      room_id = create_room(ctx.operator, "Reply")
      ref = launch(ctx.operator, ctx.host_id, %{"room_id" => room_id})
      assert_reply ref, :ok, %{"room_id" => ^room_id}
      assert_broadcast "spawn", _payload

      ref = launch(ctx.operator, ctx.host_id)
      assert_reply ref, :ok, %{"room_id" => "lobby"}
    end

    test "T8 a room_id that is present but unusable is refused", ctx do
      for unusable <- [123, "", nil, %{"id" => "x"}] do
        ref = launch(ctx.operator, ctx.host_id, %{"room_id" => unusable})
        assert_reply ref, :error, %{reason: "invalid_payload"}
        refute_broadcast "spawn", _held, 0
      end

      # The absent key is the lobby, not a refusal.
      ref = launch(ctx.operator, ctx.host_id)
      assert_reply ref, :ok, %{"room_id" => "lobby"}
    end

    test "T9 the room never reaches the runner", ctx do
      room_id = create_room(ctx.operator, "Server side")
      ref = launch(ctx.operator, ctx.host_id, %{"room_id" => room_id})
      assert_reply ref, :ok, %{"agent_id" => agent_id}
      assert_broadcast "spawn", payload
      assert payload["agent_id"] == agent_id
      refute Map.has_key?(payload, "room_id")
    end

    test "T10 placing a fresh agent closes nothing and notifies nobody", ctx do
      room_id = create_room(ctx.operator, "Side effects")
      ref = launch(ctx.operator, ctx.host_id, %{"room_id" => room_id})
      assert_reply ref, :ok, %{"agent_id" => agent_id}
      assert_broadcast "spawn", _payload
      assert Map.get(members(), agent_id) == room_id

      # No conversation to split, and the agent is not connected yet.
      refute_broadcast "envelope", _held, 0
    end

    defp launch(operator, host_id, extra \\ %{}) do
      payload =
        Map.merge(
          %{
            "version" => "0",
            "host_id" => host_id,
            "persona" => "default",
            "cwd" => "/work/proj"
          },
          extra
        )

      push(operator, "spawn", payload)
    end

    # A refusal that comes from the SAVE rather than the pre-check: the
    # snapshot read is already done when `Rooms` stops, so the launch has
    # reached the save and the identity is already recorded. Returns the held
    # store for the caller to resume.
    defp hold_save(ctx, room_id) do
      tracker = Process.whereis(ConversationStates)
      rooms = Process.whereis(Rooms)
      :ok = :sys.suspend(tracker)
      ref = launch(ctx.operator, ctx.host_id, %{"room_id" => room_id})
      await_queued(ConversationStates, :room_change)
      :ok = :sys.suspend(rooms)
      :sys.resume(tracker)
      assert_reply ref, :error, %{reason: "room_change_unconfirmed"}, slow()
      rooms
    end

    defp members do
      {:ok, %{members: members}} = Rooms.snapshot()
      members
    end

    # Directory entries allocated under one host, so a refusal can be checked
    # without an agent_id (an error reply carries none).
    defp recorded_of(host_id) do
      AgentDirectory.all()
      |> Enum.filter(fn {id, _entry} -> String.starts_with?(id, host_id <> ".") end)
    end

    defp await_member(room_id) do
      found = fn ->
        Enum.find_value(members(), fn {agent_id, held} ->
          if held == room_id, do: agent_id
        end)
      end

      agent_id = Enum.find_value(1..300, fn _ -> found.() || (Process.sleep(10) && false) end)
      assert is_binary(agent_id)
      agent_id
    end
  end
end
