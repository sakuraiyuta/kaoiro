defmodule KaoiroServerWeb.RestoreCwdTest do
  use KaoiroServerWeb.ChannelCase, async: false
  alias KaoiroServer.{AgentStates, Auth, HostRegistry, SessionPointers, TestTimeouts}

  test "default channels restore launch cwd after a worktree report, including detached fresh restore" do
    previous_tokens = Application.get_env(:kaoiro_server, :client_tokens)
    Application.put_env(:kaoiro_server, :client_tokens, "restore-cwd-test:operator")

    root =
      Path.join(
        System.tmp_dir!(),
        "fuji480-launch-#{System.pid()}-#{System.unique_integer([:positive])}"
      )

    moved = Path.join(root, "worktrees/moved")
    File.mkdir_p!(moved)

    on_exit(fn ->
      Application.put_env(:kaoiro_server, :client_tokens, previous_tokens)
      File.rm_rf!(root)
    end)

    host = "restore-cwd-test"

    HostRegistry.register(
      host,
      %{policy: :accept_all, cwd_allowlist: [root], capabilities: ["claude-code"]},
      self()
    )

    fingerprint = Auth.socket_id("restore-cwd-test")

    {:ok, _, client} =
      socket(KaoiroServerWeb.ClientSocket, nil, %{
        role: :operator,
        credential: {:token_fingerprint, fingerprint},
        socket_id: fingerprint
      })
      |> subscribe_and_join(KaoiroServerWeb.AgentsChannel, "agents:lobby")

    @endpoint.subscribe("runner:" <> host)

    assert_reply push(client, "spawn", %{
                   "version" => "0",
                   "host_id" => host,
                   "persona" => "fuji",
                   "cwd" => root,
                   "engine" => "claude-code"
                 }),
                 :ok,
                 %{"agent_id" => id},
                 TestTimeouts.slow_path()

    assert_broadcast "spawn", initial, TestTimeouts.slow_path()
    assert initial["cwd"] == root
    assert SessionPointers.get(id).cwd == root
    on_exit(fn -> SessionPointers.delete(id) end)

    {:ok, _, wrapper} =
      socket(KaoiroServerWeb.WrapperSocket, nil, %{})
      |> subscribe_and_join(KaoiroServerWeb.WrapperChannel, "wrapper:" <> id, %{
        "persona_id" => "fuji"
      })

    envelope = %{
      "version" => "0",
      "agent_id" => id,
      "persona" => %{"id" => "fuji", "name" => "Fuji", "sprite_set" => "fuji"},
      "ts" => "2026-10-02T00:00:00Z",
      "type" => "state_change",
      "state" => "idle",
      "session_id" => "launch-session",
      "payload" => %{},
      "ext" => %{"cwd" => root, "engine" => "claude-code"}
    }

    assert_reply push(wrapper, "envelope", envelope), :ok
    assert SessionPointers.get(id).session_id == "launch-session"

    moved_envelope = %{
      envelope
      | "session_id" => "latest-session",
        "ext" => %{"cwd" => moved, "engine" => "claude-code"}
    }

    assert_reply push(wrapper, "envelope", moved_envelope), :ok
    assert %{cwd: ^root, session_id: "latest-session"} = SessionPointers.get(id)
    assert AgentStates.get_envelope(id)["ext"]["cwd"] == moved

    assert_reply push(client, "enumerate_sessions", %{
                   "version" => "0",
                   "host_id" => host,
                   "agent_id" => id
                 }),
                 :ok

    assert_broadcast "enumerate_sessions", enumeration
    assert enumeration["cwd"] == root

    assert_reply push(client, "enumerate_sessions", %{
                   "version" => "0",
                   "host_id" => host,
                   "agent_id" => id,
                   "cwd" => moved
                 }),
                 :ok

    assert_broadcast "enumerate_sessions", explicit
    assert explicit["cwd"] == moved
    AgentStates.disconnect(id, wrapper.channel_pid, "2026-10-02T00:01:00Z")
    assert_reply push(client, "restore", %{"version" => "0", "agent_id" => id}), :ok
    assert_broadcast "spawn", restored
    assert restored["cwd"] == root
    assert restored["resume_session_id"] == "latest-session"

    SessionPointers.detach_session(id)
    assert_reply push(client, "restore", %{"version" => "0", "agent_id" => id}), :ok
    assert_broadcast "spawn", fresh
    assert fresh["cwd"] == root
    refute Map.has_key?(fresh, "resume_session_id")
    assert fresh["apply_resume_snapshot"] == true
  end
end
