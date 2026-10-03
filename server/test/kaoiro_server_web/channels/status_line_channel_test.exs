defmodule KaoiroServerWeb.StatusLineChannelTest do
  # The dashboard-facing half of issue 482: the join snapshot frame, the live
  # event, the history request and the retention setting, with the production
  # wiring of the application tree (AgentStates announcing an agent that just
  # became visible, the store broadcasting through StatusLineBroadcast). The
  # application's own store, AgentStates and token list are used, so this module
  # is sync and each case cleans what it wrote.
  use KaoiroServerWeb.ChannelCase, async: false

  import ExUnit.CaptureLog

  import Phoenix.ChannelTest,
    except: [assert_reply: 2, assert_reply: 3, assert_reply: 4]

  require Phoenix.ChannelTest

  alias KaoiroServer.{
    AgentDirectory,
    AgentStates,
    AgentStatusLines,
    StatusLineWire,
    TestTimeouts,
    TokenDenylist
  }

  alias KaoiroServer.StatusLinesFixture, as: Fixture
  alias KaoiroServerWeb.StatusLineSnapshot

  defmacrop assert_reply(
              ref,
              status,
              payload \\ Macro.escape(%{}),
              timeout \\ TestTimeouts.durable_reply()
            ) do
    quote do
      Phoenix.ChannelTest.assert_reply(
        unquote(ref),
        unquote(status),
        unquote(payload),
        unquote(timeout)
      )
    end
  end

  setup do
    Application.put_env(
      :kaoiro_server,
      :client_tokens,
      "tok-operator:operator,tok-viewer:viewer,tok-admin:admin"
    )

    for {id, _entry} <- AgentDirectory.all(), do: AgentDirectory.delete(id)
    prefix = "test.slc#{System.unique_integer([:positive])}"

    on_exit(fn ->
      Application.delete_env(:kaoiro_server, :client_tokens)
      store = Process.whereis(AgentStatusLines)
      if store, do: :sys.resume(store)

      {:ok, _} =
        Fixture.restart_child(KaoiroServer.Supervisor, AgentStatusLines, AgentStatusLines)

      Fixture.reset_app_retention()

      with {:ok, heads} <- AgentStatusLines.heads() do
        for {id, _row} <- heads, String.starts_with?(id, prefix), do: AgentStatusLines.purge(id)
      end

      for {id, _entry} <- AgentDirectory.all(), do: AgentDirectory.delete(id)
    end)

    %{prefix: prefix}
  end

  ## helpers

  defp client_assigns(role) do
    fingerprint = KaoiroServer.Auth.socket_id("tok-#{role}")
    %{role: role, credential: {:token_fingerprint, fingerprint}, socket_id: fingerprint}
  end

  defp join_as(role) do
    {:ok, _reply, socket} =
      KaoiroServerWeb.ClientSocket
      |> socket(nil, client_assigns(role))
      |> subscribe_and_join(KaoiroServerWeb.AgentsChannel, "agents:lobby")

    socket
  end

  defp envelope(agent_id, type \\ "state_change", state \\ "idle") do
    %{
      "version" => "0",
      "agent_id" => agent_id,
      "persona" => %{"id" => "mio", "name" => "澪", "sprite_set" => "mio"},
      "ts" => "2026-06-11T00:00:00Z",
      "type" => type,
      "state" => state,
      "payload" => %{},
      "ext" => %{}
    }
  end

  # A projection-dropped latest envelope: the agent is not in a viewer's snapshot.
  defp hidden_envelope(agent_id), do: envelope(agent_id, "attach_rejected")

  defp join_wrapper(agent_id, first_envelope \\ :visible) do
    {:ok, _reply, socket} =
      KaoiroServerWeb.WrapperSocket
      |> socket(nil, %{})
      |> subscribe_and_join(KaoiroServerWeb.WrapperChannel, "wrapper:" <> agent_id, %{
        "persona_id" => "default"
      })

    case first_envelope do
      :visible -> assert_reply push(socket, "envelope", envelope(agent_id)), :ok
      :hidden -> assert_reply push(socket, "envelope", hidden_envelope(agent_id)), :ok
      :none -> :ok
    end

    socket
  end

  defp set_line(socket, text) do
    ref = push(socket, "status_line_set", %{"version" => "0", "text" => text})
    assert_reply ref, :ok
  end

  defp history(socket, id),
    do: push(socket, "status_line_history", %{"version" => "0", "agent_id" => id})

  defp stop_store, do: :ok = Supervisor.terminate_child(KaoiroServer.Supervisor, AgentStatusLines)

  defp restart_store do
    {:ok, _} = Fixture.restart_child(KaoiroServer.Supervisor, AgentStatusLines, AgentStatusLines)
  end

  defp drain_pushes do
    receive do
      %Phoenix.Socket.Message{} -> drain_pushes()
    after
      0 -> :ok
    end
  end

  ## join snapshot

  describe "status_line_snapshot" do
    setup %{prefix: prefix} do
      visible = "#{prefix}.visible"
      hidden = "#{prefix}.hidden"
      offline = "#{prefix}.offline"
      cleared = "#{prefix}.cleared"

      visible_socket = join_wrapper(visible)
      set_line(visible_socket, "visible line")

      hidden_socket = join_wrapper(hidden)
      set_line(hidden_socket, "hidden line")
      assert_reply push(hidden_socket, "envelope", hidden_envelope(hidden)), :ok

      AgentDirectory.record(offline, "ao", "あお")
      {:ok, _} = AgentStatusLines.put(offline, "offline line")

      cleared_socket = join_wrapper(cleared)
      set_line(cleared_socket, "was set")
      set_line(cleared_socket, "")

      %{visible: visible, hidden: hidden, offline: offline, cleared: cleared}
    end

    test "a viewer gets only the agents in its own snapshot", ctx do
      join_as(:viewer)
      assert_push "status_line_snapshot", %{"agents" => agents, "version" => "0"} = frame

      refute Map.has_key?(frame, "snapshot_incomplete")
      assert agents[ctx.visible]["head"] == "visible line"
      # Latest envelope dropped by the viewer projection, directory-only agent:
      # neither may leak a line.
      refute Map.has_key?(agents, ctx.hidden)
      refute Map.has_key?(agents, ctx.offline)
    end

    test "an operator and an admin get every committed row, cleared ones as stamped rows", ctx do
      for role <- [:operator, :admin] do
        join_as(role)
        assert_push "status_line_snapshot", %{"agents" => agents}

        assert agents[ctx.visible]["head"] == "visible line"
        assert agents[ctx.hidden]["head"] == "hidden line"
        assert agents[ctx.offline]["head"] == "offline line"
        assert %{"seq" => 2, "cleared" => true, "updated_at" => _} = agents[ctx.cleared]
        refute Map.has_key?(agents[ctx.cleared], "head")
      end
    end

    test "is incomplete, not empty, while the store is stopped", _ctx do
      stop_store()

      socket = join_as(:operator)
      assert_push "status_line_snapshot", %{"agents" => agents, "snapshot_incomplete" => true}

      assert agents == %{}
      assert Process.alive?(socket.channel_pid)
    end

    test "the frame builder is incomplete when the frame does not fit, and complete by default",
         ctx do
      states = AgentStates.snapshot()

      assert %{"agents" => %{}, "snapshot_incomplete" => true} =
               StatusLineSnapshot.build(:operator, states, fn _event, _payload -> false end)

      assert %{"agents" => agents} = StatusLineSnapshot.build(:operator, states)
      assert Map.has_key?(agents, ctx.visible)
    end

    test "carries the same head fields as the directory and the live event", ctx do
      long = String.duplicate("あ", 600)
      parity = "#{ctx.visible}.parity"
      socket = join_wrapper(parity)
      join_as(:operator)
      drain_pushes()

      set_line(socket, long)
      assert_push "status_line", live

      join_as(:operator)
      assert_push "status_line_snapshot", %{"agents" => agents}

      asker = join_wrapper("#{ctx.visible}.asker")
      ref = push(asker, "directory_request", %{"version" => "0"})
      assert_reply ref, :ok, %{"agents" => directory}
      from_directory = Enum.find(directory, &(&1["agent_id"] == parity))["status_line"]

      for key <- ["head", "truncated", "bytes", "updated_at"] do
        assert live[key] == agents[parity][key]
        assert live[key] == from_directory[key]
      end

      assert live["truncated"] == true
      assert live["bytes"] == 1_800
    end
  end

  ## live event and re-announcement

  describe "status_line (live)" do
    test "reaches an operator, an admin and a viewer who may see the agent", %{prefix: prefix} do
      id = "#{prefix}.live"
      socket = join_wrapper(id)
      for role <- [:operator, :admin, :viewer], do: join_as(role)
      drain_pushes()

      set_line(socket, "live")

      for _role <- 1..3 do
        assert_push "status_line", %{
          "agent_id" => ^id,
          "seq" => 1,
          "head" => "live",
          "version" => "0"
        }
      end
    end

    # A wrapper that writes before it has stored any envelope has no entry in
    # AgentStates, so a viewer must not receive its line.
    test "does not reach a viewer before the agent has an entry, and does reach an operator",
         %{prefix: prefix} do
      id = "#{prefix}.early"
      socket = join_wrapper(id, :none)
      join_as(:viewer)
      join_as(:operator)
      drain_pushes()

      set_line(socket, "too early")

      # One push is the operator's. A second one would be the viewer's.
      assert_push "status_line", %{"agent_id" => ^id}
      refute_push "status_line", %{"agent_id" => ^id}
    end

    test "does not reach a viewer when the agent's latest envelope is dropped by the projection",
         %{prefix: prefix} do
      id = "#{prefix}.dropped"
      socket = join_wrapper(id, :hidden)
      join_as(:viewer)
      drain_pushes()

      set_line(socket, "hidden from viewers")

      refute_push "status_line", %{"agent_id" => ^id}
    end

    test "a cleared line is a stamped row with no head", %{prefix: prefix} do
      id = "#{prefix}.cleared-live"
      socket = join_wrapper(id)
      join_as(:operator)
      set_line(socket, "set")
      drain_pushes()

      set_line(socket, " ")

      assert_push "status_line", %{"agent_id" => ^id, "seq" => 2, "cleared" => true} = payload
      refute Map.has_key?(payload, "head")
    end
  end

  describe "an agent that becomes visible after its line was written" do
    test "is announced to a viewer who joined first, on its first visible envelope",
         %{prefix: prefix} do
      id = "#{prefix}.late"
      socket = join_wrapper(id, :none)
      set_line(socket, "written before any envelope")
      join_as(:viewer)
      assert_push "status_line_snapshot", %{"agents" => agents}
      refute Map.has_key?(agents, id)
      drain_pushes()

      assert_reply push(socket, "envelope", envelope(id)), :ok

      assert_push "status_line", %{"agent_id" => ^id, "head" => "written before any envelope"}
    end

    test "is announced again when a projection-dropped envelope is replaced by a visible one",
         %{prefix: prefix} do
      id = "#{prefix}.flip"
      socket = join_wrapper(id, :hidden)
      set_line(socket, "set while hidden")
      join_as(:viewer)
      drain_pushes()

      assert_reply push(socket, "envelope", envelope(id)), :ok

      assert_push "status_line", %{"agent_id" => ^id, "head" => "set while hidden"}
    end

    # The disconnect overlay is a second writer of the slot: it can turn a
    # hidden agent visible without any envelope from the wrapper.
    test "is announced when the wrapper disconnects from a hidden latest envelope",
         %{prefix: prefix} do
      id = "#{prefix}.disconnecting"
      socket = join_wrapper(id, :hidden)
      set_line(socket, "set while hidden")
      join_as(:viewer)
      assert_push "status_line_snapshot", %{"agents" => agents}
      refute Map.has_key?(agents, id)
      drain_pushes()

      Process.unlink(socket.channel_pid)
      :ok = close(socket)

      assert_push "status_line", %{"agent_id" => ^id, "head" => "set while hidden"}
    end

    test "a stamped clear is announced too, so a cached older line is dropped", %{prefix: prefix} do
      id = "#{prefix}.cleared-late"
      socket = join_wrapper(id, :hidden)
      set_line(socket, "old")
      set_line(socket, "")
      join_as(:viewer)
      drain_pushes()

      assert_reply push(socket, "envelope", envelope(id)), :ok

      assert_push "status_line", %{"agent_id" => ^id, "cleared" => true}
    end
  end

  describe "one predicate for the snapshot, the live event and the history" do
    test "all three treat an agent with a projection-dropped latest envelope as hidden",
         %{prefix: prefix} do
      id = "#{prefix}.unity"
      socket = join_wrapper(id, :hidden)
      set_line(socket, "unity")
      viewer = join_as(:viewer)

      assert_push "status_line_snapshot", %{"agents" => agents}
      refute Map.has_key?(agents, id)

      set_line(socket, "unity again")
      refute_push "status_line", %{"agent_id" => ^id}

      assert_reply history(viewer, id), :error, %{reason: "unknown_agent"}
    end
  end

  ## history

  describe "status_line_history" do
    test "a viewer reads the full change log of an agent it may see, newest first", %{
      prefix: prefix
    } do
      id = "#{prefix}.logged"
      socket = join_wrapper(id)
      set_line(socket, "first")
      set_line(socket, String.duplicate("あ", 300))
      set_line(socket, "")
      viewer = join_as(:viewer)

      assert_reply history(viewer, id), :ok, %{"entries" => [cleared, long, first]}

      assert %{"seq" => 3, "text" => nil} = cleared
      assert %{"seq" => 2, "bytes" => 900} = long
      assert String.length(long["text"]) == 300
      assert %{"seq" => 1, "text" => "first", "bytes" => 5} = first
    end

    test "a hidden agent and one that does not exist get the same answer to a viewer",
         %{prefix: prefix} do
      hidden = "#{prefix}.hidden-log"
      socket = join_wrapper(hidden, :hidden)
      set_line(socket, "secret-ish")
      offline = "#{prefix}.offline-log"
      AgentDirectory.record(offline, "ao", "あお")
      {:ok, _} = AgentStatusLines.put(offline, "offline note")
      viewer = join_as(:viewer)

      assert_reply history(viewer, hidden), :error, hidden_reply
      assert_reply history(viewer, offline), :error, offline_reply
      assert_reply history(viewer, "#{prefix}.never"), :error, missing_reply

      assert hidden_reply == %{reason: "unknown_agent"}
      assert offline_reply == hidden_reply
      assert missing_reply == hidden_reply
    end

    test "an operator reads a recorded or known agent, and unknown_agent for any other", %{
      prefix: prefix
    } do
      recorded = "#{prefix}.recorded"
      AgentDirectory.record(recorded, "ao", "あお")
      {:ok, _} = AgentStatusLines.put(recorded, "directory-only note")
      known = "#{prefix}.known"
      join_wrapper(known)
      operator = join_as(:operator)

      assert_reply history(operator, recorded), :ok, %{
        "entries" => [%{"text" => "directory-only note"}]
      }

      assert_reply history(operator, known), :ok, %{"entries" => []}
      assert_reply history(operator, "#{prefix}.never"), :error, %{reason: "unknown_agent"}
    end

    test "refuses a bad id, and a role that is neither viewer, operator nor admin", %{
      prefix: prefix
    } do
      viewer = join_as(:viewer)
      assert_reply history(viewer, "has space"), :error, %{reason: "invalid_agent_id"}

      assert_reply push(viewer, "status_line_history", %{"version" => "0"}), :error, %{
        reason: "missing_agent_id"
      }

      # The role is re-resolved on every request: with the viewer's token gone
      # from the list it resolves to nothing at all.
      Application.put_env(:kaoiro_server, :client_tokens, "tok-other:operator")
      assert_reply history(viewer, "#{prefix}.any"), :error, %{reason: "forbidden"}
    end

    test "a viewer's request with a bad or missing version logs nothing; an operator's does",
         %{prefix: prefix} do
      id = "#{prefix}.quiet"
      join_wrapper(id)
      viewer = join_as(:viewer)
      operator = join_as(:operator)

      quiet =
        capture_log(fn ->
          for payload <- [%{"agent_id" => id}, %{"agent_id" => id, "version" => "99"}] do
            assert_reply push(viewer, "status_line_history", payload), :ok
          end
        end)

      assert quiet == ""

      loud =
        capture_log(fn ->
          assert_reply push(operator, "status_line_history", %{"agent_id" => id}), :ok
        end)

      assert loud =~ "status_line_history: client declared protocol version"
    end

    test "answers status_line_unavailable and survives while the store is stopped", %{
      prefix: prefix
    } do
      id = "#{prefix}.down"
      join_wrapper(id)
      viewer = join_as(:viewer)
      stop_store()

      assert_reply history(viewer, id), :error, %{reason: "status_line_unavailable"}
      assert Process.alive?(viewer.channel_pid)
    end

    test "a reply that does not fit is refused, not cut" do
      entries = [%{seq: 1, text: "one", updated_at: "2026-10-03T00:00:00.000000Z"}]

      assert {:error, :status_line_history_too_large} =
               KaoiroServerWeb.StatusLineHistory.reply(entries, fn _topic, _reply -> false end)

      assert {:ok, %{"entries" => [%{"seq" => 1, "text" => "one"}]}} =
               KaoiroServerWeb.StatusLineHistory.reply(entries)
    end

    # 100 entries of the largest legal text, every byte an escape in JSON.
    test "the largest change log fits the transport frame by a wide margin" do
      worst = String.duplicate("\"", AgentStatusLines.max_bytes())
      {_min, max_retention} = AgentStatusLines.retention_bounds()

      entries =
        for seq <- 1..max_retention do
          StatusLineWire.history_entry(%{
            seq: seq,
            text: worst,
            updated_at: "2026-10-03T00:00:00.000000Z"
          })
        end

      reply = %{"entries" => entries}
      measured = KaoiroServer.TransportLimits.reply_frame_bytes("agents:lobby", reply)

      assert KaoiroServer.TransportLimits.reply_frame_fits?("agents:lobby", reply)
      # The estimate behind the margin: JSON at most doubles an ASCII text.
      assert measured <= max_retention * (2 * AgentStatusLines.max_bytes() + 200)
    end
  end

  ## retention

  describe "set_status_line_retention" do
    test "a viewer is forbidden and nothing changes", %{prefix: prefix} do
      id = "#{prefix}.kept"
      socket = join_wrapper(id)
      for n <- 1..8, do: set_line(socket, "text #{n}")
      viewer = join_as(:viewer)

      ref = push(viewer, "set_status_line_retention", %{"version" => "0", "retention" => 2})
      assert_reply ref, :error, %{reason: "forbidden"}

      assert {:ok, %{retention: 20, source: :default}} = AgentStatusLines.settings()
      assert {:ok, entries} = AgentStatusLines.history(id)
      assert length(entries) == 8
    end

    test "an operator and an admin change it, the log is pruned at once, and operators are told",
         %{prefix: prefix} do
      id = "#{prefix}.pruned"
      socket = join_wrapper(id)
      for n <- 1..8, do: set_line(socket, "text #{n}")

      for {role, retention} <- [operator: 5, admin: 3] do
        client = join_as(role)
        drain_pushes()

        ref =
          push(client, "set_status_line_retention", %{"version" => "0", "retention" => retention})

        assert_reply ref, :ok, %{
          "retention" => ^retention,
          "source" => "stored",
          "min" => 1,
          "max" => 100
        }

        assert_push "status_line_settings", %{"retention" => ^retention, "source" => "stored"}
        assert {:ok, entries} = AgentStatusLines.history(id)
        assert length(entries) == retention
      end
    end

    test "rejects a value outside 1..100, a non-integer and an absent one", _ctx do
      operator = join_as(:operator)

      for bad <- [0, 101, -1, 5.5, "5", nil, [5]] do
        ref = push(operator, "set_status_line_retention", %{"version" => "0", "retention" => bad})
        assert_reply ref, :error, %{reason: "invalid_status_line_retention"}
      end

      ref = push(operator, "set_status_line_retention", %{"version" => "0"})
      assert_reply ref, :error, %{reason: "invalid_status_line_retention"}
      assert {:ok, %{source: :default}} = AgentStatusLines.settings()
    end

    test "an operator is told the retention at join" do
      join_as(:operator)

      assert_push "status_line_settings", %{
        "retention" => 20,
        "source" => "default",
        "min" => 1,
        "max" => 100,
        "version" => "0"
      }
    end

    test "a change reaches operators" do
      operator = join_as(:operator)
      drain_pushes()

      ref = push(operator, "set_status_line_retention", %{"version" => "0", "retention" => 9})
      assert_reply ref, :ok

      assert_push "status_line_settings", %{"retention" => 9, "source" => "stored"}
    end

    test "a viewer is told the retention neither at join nor when it changes" do
      viewer = join_as(:viewer)
      assert_push "status_line_snapshot", _
      refute_push "status_line_settings", _

      assert {:ok, _} = AgentStatusLines.set_retention(9)

      refute_push "status_line_settings", _
      assert Process.alive?(viewer.channel_pid)
    end

    test "answers status_line_unavailable while the store is stopped", _ctx do
      operator = join_as(:operator)
      stop_store()

      ref = push(operator, "set_status_line_retention", %{"version" => "0", "retention" => 4})
      assert_reply ref, :error, %{reason: "status_line_unavailable"}
    end
  end

  ## a store that goes away in the middle of a call

  describe "an owner that dies while a call from a channel is queued" do
    # The join's settings call blocks the channel behind the suspended owner for
    # as long as the call lasts, so the owner is stopped from another process
    # once that call is waiting.
    test "the operator's join skips the settings push and the channel survives", _ctx do
      :ok = :sys.suspend(AgentStatusLines)

      stopper =
        Task.async(fn ->
          Fixture.eventually(fn ->
            Process.info(Process.whereis(AgentStatusLines), :message_queue_len) ==
              {:message_queue_len, 1}
          end)

          stop_store()
        end)

      operator = join_as(:operator)
      assert :ok = Task.await(stopper)

      # The frames are built from ETS, which a suspended store still serves.
      assert_push "snapshot", _
      assert_push "status_line_snapshot", %{"agents" => _}
      refute_push "status_line_settings", _
      assert Process.alive?(operator.channel_pid)
    end

    test "a viewer's history request is answered status_line_unavailable", %{prefix: prefix} do
      id = "#{prefix}.queued"
      join_wrapper(id)
      viewer = join_as(:viewer)
      :ok = :sys.suspend(AgentStatusLines)

      ref = history(viewer, id)

      Fixture.eventually(fn ->
        Process.info(Process.whereis(AgentStatusLines), :message_queue_len) ==
          {:message_queue_len, 1}
      end)

      stop_store()

      assert_reply ref, :error, %{reason: "status_line_unavailable"}
      assert Process.alive?(viewer.channel_pid)
    end
  end

  ## store restart with a revoked-only agent

  describe "a store start that sweeps a revoked-only agent" do
    test "sends nothing for it; the next snapshot lacks its line but keeps the agent",
         %{prefix: prefix} do
      revoked = "#{prefix}.revoked"
      kept = "#{prefix}.kept"
      revoked_socket = join_wrapper(revoked)
      kept_socket = join_wrapper(kept)
      set_line(revoked_socket, "revoked line")
      set_line(kept_socket, "kept line")

      operator = join_as(:operator)
      assert_push "status_line_snapshot", %{"agents" => before}
      assert before[revoked]["head"] == "revoked line"
      drain_pushes()

      on_exit(fn -> TokenDenylist.restore(revoked) end)
      :ok = TokenDenylist.revoke(revoked, nil)
      stop_store()
      restart_store()

      # The surviving row is announced again, the swept one is not.
      assert_push "status_line", %{"agent_id" => ^kept, "head" => "kept line"}
      refute_push "status_line", %{"agent_id" => ^revoked}

      rejoined = join_as(:operator)
      assert_push "snapshot", %{"agents" => frames}
      assert_push "status_line_snapshot", %{"agents" => lines}

      assert Map.has_key?(frames, revoked)
      refute Map.has_key?(lines, revoked)
      assert lines[kept]["head"] == "kept line"
      assert Process.alive?(operator.channel_pid) and Process.alive?(rejoined.channel_pid)
    end
  end
end
