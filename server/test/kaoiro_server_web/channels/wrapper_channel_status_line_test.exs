defmodule KaoiroServerWeb.WrapperChannelStatusLineTest do
  # The wrapper-facing half of issue 482: `status_line_set`, `status_line_get`,
  # the head in `directory_request`, and the purge on `delete_agent`. The
  # application's own store, AgentStates and AgentDirectory are used, so this
  # module is sync, and each case cleans what it wrote.
  use KaoiroServerWeb.ChannelCase, async: false

  import ExUnit.CaptureLog

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
  alias KaoiroServerWeb.DirectoryEligibility

  setup do
    # Entries other modules left in the suite-wide AgentDirectory flow into the
    # 32-entry directory-only cap and can push a fixture out of a reply.
    for {id, _entry} <- AgentDirectory.all(), do: AgentDirectory.delete(id)

    prefix = "test.sl#{System.unique_integer([:positive])}"

    on_exit(fn ->
      # A test killed by a timeout may leave the store stopped or flagged.
      {:ok, _} =
        Fixture.restart_child(KaoiroServer.Supervisor, AgentStatusLines, AgentStatusLines)

      :sys.replace_state(AgentStatusLines, fn state -> %{state | dirty: false} end)

      with {:ok, heads} <- AgentStatusLines.heads() do
        for {id, _row} <- heads, String.starts_with?(id, prefix), do: AgentStatusLines.purge(id)
      end

      for {id, _entry} <- AgentDirectory.all(), do: AgentDirectory.delete(id)
    end)

    %{prefix: prefix}
  end

  defp envelope(agent_id, state \\ "idle") do
    %{
      "version" => "0",
      "agent_id" => agent_id,
      "persona" => %{"id" => "mio", "name" => "澪", "sprite_set" => "mio"},
      "ts" => "2026-06-11T00:00:00Z",
      "type" => "state_change",
      "state" => state,
      "payload" => %{},
      "ext" => %{}
    }
  end

  defp join_wrapper(agent_id) do
    {:ok, _reply, socket} =
      KaoiroServerWeb.WrapperSocket
      |> socket(nil, %{})
      |> subscribe_and_join(KaoiroServerWeb.WrapperChannel, "wrapper:" <> agent_id, %{
        "persona_id" => "default"
      })

    assert_reply push(socket, "envelope", envelope(agent_id)), :ok
    socket
  end

  defp set_line(socket, text) do
    push(socket, "status_line_set", %{"version" => "0", "text" => text})
  end

  defp get_line(socket, id),
    do: push(socket, "status_line_get", %{"version" => "0", "agent_id" => id})

  defp directory(socket) do
    ref = push(socket, "directory_request", %{"version" => "0"})
    assert_reply ref, :ok, %{"agents" => agents}
    Map.new(agents, &{&1["agent_id"], &1})
  end

  defp stop_store do
    :ok = Supervisor.terminate_child(KaoiroServer.Supervisor, AgentStatusLines)
  end

  defp restart_store do
    {:ok, _} = Fixture.restart_child(KaoiroServer.Supervisor, AgentStatusLines, AgentStatusLines)
  end

  describe "status_line_set" do
    test "stores the line under the socket's own agent_id and replies with its size, not its text",
         %{prefix: prefix} do
      id = "#{prefix}.setter"
      socket = join_wrapper(id)

      assert_reply set_line(socket, "# Reviewing\n\nissue 482"), :ok, reply
      assert Map.keys(reply) == ["status_line"]
      assert Map.keys(reply["status_line"]) |> Enum.sort() == ["bytes", "truncated", "updated_at"]
      assert %{"bytes" => 22, "truncated" => false} = reply["status_line"]

      assert {:ok, %{entry: %{text: "# Reviewing\n\nissue 482"}}} =
               AgentStatusLines.read_latest(id)
    end

    test "a payload agent_id is never read", %{prefix: prefix} do
      id = "#{prefix}.forger"
      victim = "#{prefix}.victim"
      socket = join_wrapper(id)

      ref =
        push(socket, "status_line_set", %{
          "version" => "0",
          "text" => "mine",
          "agent_id" => victim
        })

      assert_reply ref, :ok

      assert {:ok, %{entry: %{text: "mine"}}} = AgentStatusLines.read_latest(id)
      assert {:ok, nil} = AgentStatusLines.read_latest(victim)
    end

    test "an empty text clears the line and replies null", %{prefix: prefix} do
      id = "#{prefix}.clearer"
      socket = join_wrapper(id)
      assert_reply set_line(socket, "working"), :ok

      assert_reply set_line(socket, "  "), :ok, %{"status_line" => nil}

      assert {:ok, %{entry: %{seq: 2, text: nil}}} = AgentStatusLines.read_latest(id)
    end

    test "refuses what the store refuses, with the store's reason", %{prefix: prefix} do
      socket = join_wrapper("#{prefix}.refused")

      assert_reply set_line(socket, String.duplicate("a", 16_385)), :error, %{
        reason: "status_line_too_large",
        max_bytes: 16_384,
        bytes: 16_385
      }

      assert_reply set_line(socket, "bad\e"), :error, %{reason: "status_line_invalid_characters"}
      assert_reply set_line(socket, 42), :error, %{reason: "invalid_status_line"}

      assert_reply push(socket, "status_line_set", %{"version" => "0"}), :error, %{
        reason: "invalid_status_line"
      }
    end

    test "answers status_line_unavailable and survives while the store is stopped",
         %{prefix: prefix} do
      socket = join_wrapper("#{prefix}.orphan")
      stop_store()

      capture_log(fn ->
        assert_reply set_line(socket, "nobody home"), :error, %{reason: "status_line_unavailable"}
      end)

      assert Process.alive?(socket.channel_pid)
      restart_store()
      assert_reply set_line(socket, "back"), :ok
    end
  end

  describe "status_line_get" do
    setup %{prefix: prefix} do
      peer = "#{prefix}.peer"
      requester = "#{prefix}.requester"
      peer_socket = join_wrapper(peer)
      requester_socket = join_wrapper(requester)
      %{peer: peer, peer_socket: peer_socket, requester: requester, socket: requester_socket}
    end

    test "returns a live peer's full text while the directory shows only the head", ctx do
      text = String.duplicate("あ", 2_000)
      assert_reply set_line(ctx.peer_socket, text), :ok

      assert_reply get_line(ctx.socket, ctx.peer), :ok, reply

      assert reply == %{
               "agent_id" => ctx.peer,
               "text" => text,
               "bytes" => 6_000,
               "updated_at" => reply["updated_at"]
             }

      head = directory(ctx.socket)[ctx.peer]["status_line"]
      assert head["truncated"] == true
      assert head["bytes"] == 6_000
      assert byte_size(head["head"]) == 510
    end

    test "returns a directory-only peer's line", %{prefix: prefix} = ctx do
      id = "#{prefix}.offline"
      AgentDirectory.record(id, "ao", "あお")
      {:ok, _} = AgentStatusLines.put(id, "left a note")

      assert_reply get_line(ctx.socket, id), :ok, %{"text" => "left a note"}
    end

    test "reads beyond the directory's cap of 32 directory-only entries",
         %{prefix: prefix} = ctx do
      ids = for n <- 1..40, do: "#{prefix}.dir#{String.pad_leading("#{n}", 2, "0")}"
      for id <- ids, do: AgentDirectory.record(id, "ao", "あお")
      for id <- ids, do: {:ok, _} = AgentStatusLines.put(id, "line of #{id}")

      listed = directory(ctx.socket) |> Map.keys() |> Enum.filter(&(&1 in ids))
      assert length(listed) == 32
      [beyond | _] = ids -- listed

      assert_reply get_line(ctx.socket, beyond), :ok, %{"text" => text}
      assert text == "line of #{beyond}"
    end

    test "the requester may read its own line", ctx do
      assert_reply set_line(ctx.socket, "my own"), :ok
      assert_reply get_line(ctx.socket, ctx.requester), :ok, %{"text" => "my own"}
    end

    test "an agent that is not eligible and one that does not exist get the same answer",
         %{prefix: prefix} = ctx do
      hidden = "#{prefix}.hidden"
      {:ok, _} = AgentStatusLines.put(hidden, "secret-ish")

      assert_reply get_line(ctx.socket, hidden), :error, hidden_reply
      assert_reply get_line(ctx.socket, "#{prefix}.nonexistent"), :error, missing_reply

      assert hidden_reply == %{reason: "unknown_agent"}
      assert missing_reply == hidden_reply
    end

    test "refuses a malformed or missing id before anything else", ctx do
      assert_reply get_line(ctx.socket, "has space"), :error, %{reason: "invalid_agent_id"}
      assert_reply get_line(ctx.socket, 42), :error, %{reason: "missing_agent_id"}

      assert_reply push(ctx.socket, "status_line_get", %{"version" => "0"}), :error, %{
        reason: "missing_agent_id"
      }
    end

    test "carries no history, and null for a cleared or absent line", ctx do
      assert_reply set_line(ctx.peer_socket, "first"), :ok
      assert_reply set_line(ctx.peer_socket, "second"), :ok
      assert_reply get_line(ctx.socket, ctx.peer), :ok, reply
      assert Map.keys(reply) |> Enum.sort() == ["agent_id", "bytes", "text", "updated_at"]

      assert_reply set_line(ctx.peer_socket, ""), :ok

      assert_reply get_line(ctx.socket, ctx.peer), :ok, %{
        "agent_id" => peer,
        "status_line" => nil
      }

      assert peer == ctx.peer
    end

    test "is refused while the store is dirty, but list_agents keeps serving the committed head",
         ctx do
      assert_reply set_line(ctx.peer_socket, "committed"), :ok
      :sys.replace_state(AgentStatusLines, fn state -> %{state | dirty: true} end)

      assert_reply get_line(ctx.socket, ctx.peer), :error, %{reason: "status_line_unavailable"}
      assert directory(ctx.socket)[ctx.peer]["status_line"]["head"] == "committed"

      # Who may be read is decided first: a hidden id is still just unknown.
      assert_reply get_line(ctx.socket, "#{ctx.peer}.hidden"), :error, %{reason: "unknown_agent"}
    end

    test "answers status_line_unavailable while the store is stopped, and the text after it restarts",
         ctx do
      assert_reply set_line(ctx.peer_socket, "survives"), :ok
      stop_store()

      assert_reply get_line(ctx.socket, ctx.peer), :error, %{reason: "status_line_unavailable"}
      assert Process.alive?(ctx.socket.channel_pid)

      restart_store()
      assert_reply get_line(ctx.socket, ctx.peer), :ok, %{"text" => "survives"}
    end
  end

  describe "directory_request" do
    test "carries the head, size and time of a live and a directory-only peer and never the full text",
         %{prefix: prefix} do
      live = "#{prefix}.live"
      live_socket = join_wrapper(live)
      long = String.duplicate("x", 16_384)
      assert_reply set_line(live_socket, long), :ok

      offline = "#{prefix}.offline"
      AgentDirectory.record(offline, "ao", "あお")
      {:ok, _} = AgentStatusLines.put(offline, "short note")

      asker = join_wrapper("#{prefix}.asker")
      agents = directory(asker)

      assert %{"head" => head, "truncated" => true, "bytes" => 16_384, "updated_at" => _} =
               agents[live]["status_line"]

      assert byte_size(head) == 512
      refute inspect(agents[live]) =~ long

      assert %{"head" => "short note", "truncated" => false, "bytes" => 10} =
               agents[offline]["status_line"]

      for {_id, entry} <- agents, line = entry["status_line"] do
        assert Map.keys(line) |> Enum.sort() == ["bytes", "head", "truncated", "updated_at"]
      end
    end

    test "omits the key for a cleared line and for an agent with none", %{prefix: prefix} do
      cleared = "#{prefix}.cleared"
      cleared_socket = join_wrapper(cleared)
      assert_reply set_line(cleared_socket, "was set"), :ok
      assert_reply set_line(cleared_socket, ""), :ok

      silent = "#{prefix}.silent"
      join_wrapper(silent)

      agents = directory(join_wrapper("#{prefix}.asker"))

      refute Map.has_key?(agents[cleared], "status_line")
      refute Map.has_key?(agents[silent], "status_line")
    end

    test "omits the field and keeps the rest while the store is stopped", %{prefix: prefix} do
      live = "#{prefix}.live"
      live_socket = join_wrapper(live)
      assert_reply set_line(live_socket, "committed"), :ok
      asker = join_wrapper("#{prefix}.asker")
      stop_store()

      agents = directory(asker)

      assert %{"agent_id" => ^live, "persona" => _} = agents[live]
      refute Map.has_key?(agents[live], "status_line")
    end

    # directory_request and status_line_get share DirectoryEligibility, and the
    # latter is not capped. With fewer entries than the cap the two sets agree.
    test "lists exactly the agents the eligibility rule names, less the requester",
         %{prefix: prefix} do
      live = join_wrapper("#{prefix}.live")
      asker = join_wrapper("#{prefix}.asker")
      offline = "#{prefix}.offline"
      AgentDirectory.record(offline, "ao", "あお")
      AgentDirectory.record("not a valid id", "ao", "x")
      AgentDirectory.record("#{prefix}.second-offline", "ao", "y")

      eligible = DirectoryEligibility.eligible_ids(AgentStates.snapshot(), AgentDirectory.all())
      listed = directory(asker) |> Map.keys() |> MapSet.new()

      assert MapSet.put(listed, "#{prefix}.asker") == eligible
      assert "#{prefix}.live" in listed
      assert live.channel_pid != asker.channel_pid
      refute "not a valid id" in eligible
    end

    test "the directory field is exactly what StatusLineWire builds from the published row", %{
      prefix: prefix
    } do
      live = "#{prefix}.live"
      assert_reply set_line(join_wrapper(live), "same shape"), :ok
      {:ok, row} = AgentStatusLines.read_latest(live)

      assert directory(join_wrapper("#{prefix}.asker"))[live]["status_line"] ==
               StatusLineWire.directory_field(row)
    end
  end

  describe "delete_agent" do
    setup do
      Application.put_env(:kaoiro_server, :client_tokens, "tok-operator:operator")
      on_exit(fn -> Application.delete_env(:kaoiro_server, :client_tokens) end)
      :ok
    end

    defp operator_socket do
      token = "tok-operator"
      fingerprint = KaoiroServer.Auth.socket_id(token)

      {:ok, _reply, socket} =
        KaoiroServerWeb.ClientSocket
        |> socket(nil, %{
          role: :operator,
          credential: {:token_fingerprint, fingerprint},
          socket_id: fingerprint
        })
        |> subscribe_and_join(KaoiroServerWeb.AgentsChannel, "agents:lobby")

      socket
    end

    defp disconnected(id) do
      :ok =
        AgentStates.put(%{
          "version" => "0",
          "agent_id" => id,
          "ts" => "2026-06-11T00:00:00Z",
          "type" => "state_change",
          "state" => "disconnected"
        })
    end

    test "purges the agent's status line record", %{prefix: prefix} do
      id = "#{prefix}.deleted"
      disconnected(id)
      AgentDirectory.record(id, "ao", "あお")
      on_exit(fn -> TokenDenylist.restore(id) end)
      {:ok, _} = AgentStatusLines.put(id, "about to go")
      socket = operator_socket()

      ref = push(socket, "delete_agent", %{"agent_id" => id})
      assert_reply ref, :ok, %{}, TestTimeouts.purge_reply()

      assert {:ok, nil} = AgentStatusLines.read_latest(id)
      assert {:ok, []} = AgentStatusLines.history(id)
    end

    test "still succeeds when the store cannot purge", %{prefix: prefix} do
      id = "#{prefix}.deleted-dirty"
      disconnected(id)
      AgentDirectory.record(id, "ao", "あお")
      on_exit(fn -> TokenDenylist.restore(id) end)
      {:ok, _} = AgentStatusLines.put(id, "stays on disk")
      socket = operator_socket()
      :sys.replace_state(AgentStatusLines, fn state -> %{state | dirty: true} end)

      ref = push(socket, "delete_agent", %{"agent_id" => id})
      assert_reply ref, :ok, %{}, TestTimeouts.purge_reply()

      # Refused, so the record is still there; the revoked token means the next
      # store start drops it.
      assert {:ok, %{entry: %{text: "stays on disk"}}} = AgentStatusLines.read_latest(id)
      assert TokenDenylist.revoked?(id)
    end
  end
end
