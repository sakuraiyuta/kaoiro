defmodule KaoiroServerWeb.DisplayNameProjectionTest do
  use KaoiroServerWeb.ChannelCase, async: false

  alias KaoiroServer.{AgentDirectory, AgentStates, Auth, TestTimeouts}
  alias KaoiroServerWeb.{AgentsChannel, ClientSocket, WrapperChannel, WrapperSocket}

  @persona %{"id" => "default", "name" => "Default", "sprite_set" => "default"}
  # The self view also carries the caller's room (issue #537).
  @lobby %{"id" => "lobby", "name" => nil}

  setup do
    previous = Application.get_env(:kaoiro_server, :client_tokens)
    Application.put_env(:kaoiro_server, :client_tokens, "rename-test:operator")
    on_exit(fn -> Application.put_env(:kaoiro_server, :client_tokens, previous) end)

    fingerprint = Auth.socket_id("rename-test")

    {:ok, _, operator} =
      ClientSocket
      |> socket(nil, %{
        role: :operator,
        credential: {:token_fingerprint, fingerprint},
        socket_id: fingerprint
      })
      |> subscribe_and_join(AgentsChannel, "agents:lobby")

    AgentDirectory.record("rename.observer", "default", "Observer")
    observer = join_wrapper("rename.observer")
    publish(observer, "rename.observer", "codex", "Observer")
    %{operator: operator, observer: observer}
  end

  for engine <- ~w(claude-code codex antigravity grok) do
    @engine engine
    test "#{@engine} reads the committed rename before an echo and after an old envelope", ctx do
      id = "rename.#{@engine}"
      AgentDirectory.record(id, "default", "Original")
      peer = join_wrapper(id)
      publish(peer, id, @engine, "Original")

      assert_reply push(ctx.operator, "rename_agent", %{
                     "version" => "0",
                     "agent_id" => id,
                     "name" => "Renamed"
                   }),
                   :ok,
                   %{"revision" => 2, "display_name" => "Renamed"}

      assert_push "display_name_sync", %{"display_name" => "Renamed", "revision" => 2}
      assert AgentDirectory.get(id).display_name == "Renamed"
      assert [{^id, "default", 2, "Renamed"}] = :dets.lookup(AgentDirectory, id)
      assert AgentStates.snapshot()[id]["display_name"] == "Original"
      assert_live_name(ctx.observer, id, @engine, "Renamed")
      assert_self_name(peer, id, "Renamed")

      publish(peer, id, @engine, "Original")
      assert_live_name(ctx.observer, id, @engine, "Renamed")
      assert_self_name(peer, id, "Renamed")
    end
  end

  test "a disconnected AgentStates entry uses the directory name", ctx do
    id = "rename.disconnected"
    AgentDirectory.record(id, "default", "Original")
    peer = join_wrapper(id)
    publish(peer, id, "grok", "Original", "disconnected")

    assert_reply push(ctx.operator, "rename_agent", %{
                   "version" => "0",
                   "agent_id" => id,
                   "name" => "Offline rename"
                 }),
                 :ok

    entry = entry(ctx.observer, id)
    assert entry["display_name"] == "Offline rename"
    assert entry["state"] == "disconnected"
    refute entry["directory_only"]
  end

  test "an envelope without a directory row keeps the legacy name", ctx do
    id = "rename.legacy"
    peer = join_wrapper(id)
    publish(peer, id, "codex", "Legacy")
    assert AgentDirectory.get(id) == nil
    assert_live_name(ctx.observer, id, "codex", "Legacy")
    assert_self_name(peer, id, "Legacy")
  end

  for invalid <- ["", "bad\nname", String.duplicate("x", 65)] do
    @invalid invalid
    test "an invalid authoritative name #{inspect(invalid)} is omitted without fallback", ctx do
      id = "rename.invalid"
      peer = join_wrapper(id)
      publish(peer, id, "grok", "Valid but stale")
      AgentDirectory.record(id, "default", @invalid)

      entry = entry(ctx.observer, id)
      refute Map.has_key?(entry, "display_name")

      assert_reply push(peer, "directory_request", %{"version" => "0", "scope" => "self"}),
                   :ok,
                   %{"self" => %{"agent_id" => ^id} = own}

      refute Map.has_key?(own, "display_name")
      assert entry["persona"] == @persona
      assert entry["engine"] == "grok"
    end
  end

  test "self view uses the socket identity before any envelope and ignores a forged id" do
    AgentDirectory.record("self.caller", "default", "Caller")
    AgentDirectory.record("self.other", "default", "Other")
    caller = join_wrapper("self.caller")
    assert AgentStates.get_envelope("self.caller") == nil

    assert_reply push(caller, "directory_request", %{
                   "version" => "0",
                   "scope" => "self",
                   "agent_id" => "self.other"
                 }),
                 :ok,
                 reply

    assert reply == %{
             "self" => %{
               "agent_id" => "self.caller",
               "display_name" => "Caller",
               "room" => @lobby
             }
           }
  end

  test "self view without either source omits the name" do
    caller = join_wrapper("self.missing")

    assert_reply push(caller, "directory_request", %{"version" => "0", "scope" => "self"}),
                 :ok,
                 %{"self" => %{"agent_id" => "self.missing"}} = reply

    assert reply == %{"self" => %{"agent_id" => "self.missing", "room" => @lobby}}
  end

  test "unknown scopes are refused instead of returning peers", ctx do
    for scope <- ["all", "peer", nil, 1, %{}] do
      assert_reply push(ctx.observer, "directory_request", %{"version" => "0", "scope" => scope}),
                   :error,
                   %{reason: "unsupported_scope"}
    end
  end

  test "self reply respects the encoded transport frame budget" do
    id = "self.large"
    # One grapheme can still exceed the byte budget after name validation.
    name = "a" <> String.duplicate("\u0301", 4_000_000)
    AgentDirectory.record(id, "default", name)
    caller = join_wrapper(id)

    assert_reply push(caller, "directory_request", %{"version" => "0", "scope" => "self"}),
                 :error,
                 %{reason: "self_identity_too_large"},
                 10 * TestTimeouts.slow_path()
  end

  defp assert_self_name(socket, id, name) do
    assert_reply push(socket, "directory_request", %{"version" => "0", "scope" => "self"}),
                 :ok,
                 %{"self" => %{"agent_id" => ^id, "display_name" => ^name}} = reply

    assert Map.keys(reply) == ["self"]
  end

  defp join_wrapper(id) do
    {:ok, _, socket} =
      WrapperSocket
      |> socket(nil, %{})
      |> subscribe_and_join(WrapperChannel, "wrapper:#{id}", %{"persona_id" => "default"})

    socket
  end

  defp publish(socket, id, engine, name, state \\ "idle") do
    assert_reply push(socket, "envelope", %{
                   "version" => "0",
                   "agent_id" => id,
                   "persona" => @persona,
                   "display_name" => name,
                   "ts" => "2026-10-15T00:00:00Z",
                   "type" => "state_change",
                   "state" => state,
                   "payload" => %{},
                   "ext" => %{"engine" => engine, "model" => "fixture-model"}
                 }),
                 :ok
  end

  defp entry(observer, id) do
    assert_reply push(observer, "directory_request", %{"version" => "0"}), :ok, %{
      "agents" => entries
    }

    refute Enum.any?(entries, &(&1["agent_id"] == "rename.observer"))
    Enum.find(entries, &(&1["agent_id"] == id))
  end

  defp assert_live_name(observer, id, engine, name) do
    entry = entry(observer, id)
    assert entry["display_name"] == name
    assert entry["persona"] == @persona
    assert entry["engine"] == engine
    assert entry["model"] == "fixture-model"
    assert entry["state"] == "idle"
    refute entry["directory_only"]
  end
end
