defmodule KaoiroServerWeb.RunnerChannelTest do
  use KaoiroServerWeb.ChannelCase, async: false

  alias KaoiroServer.HostRegistry

  defp join_runner(host_id) do
    {:ok, _reply, socket} =
      KaoiroServerWeb.RunnerSocket
      |> socket(nil, %{})
      |> subscribe_and_join(KaoiroServerWeb.RunnerChannel, "runner:" <> host_id)

    socket
  end

  defp register_payload do
    %{
      "personas" => [%{"id" => "mio", "name" => "澪", "sprite_set" => "mio"}],
      "cwd_allowlist" => ["/home/user/proj"]
    }
  end

  describe "register" do
    test "register で HostRegistry に登録され hosts が operator へ broadcast される" do
      host_id = "lab-pc-1"
      @endpoint.subscribe("agents:lobby")
      socket = join_runner(host_id)

      ref = push(socket, "register", register_payload())

      assert_reply ref, :ok
      assert_broadcast "hosts", %{"hosts" => _}

      entry = HostRegistry.get(host_id)
      assert entry.personas == [%{"id" => "mio", "name" => "澪", "sprite_set" => "mio"}]
      assert entry.cwd_allowlist == ["/home/user/proj"]
    end

    test "personas/cwd_allowlist の型不正は invalid_register で拒否される" do
      socket = join_runner("lab-pc-bad")

      ref = push(socket, "register", %{"personas" => "x", "cwd_allowlist" => []})
      assert_reply ref, :error, %{reason: "invalid_register"}

      refute HostRegistry.get("lab-pc-bad")
    end
  end

  describe "heartbeat" do
    test "heartbeat は last_heartbeat を更新する" do
      host_id = "lab-pc-hb"
      socket = join_runner(host_id)

      ref = push(socket, "register", register_payload())
      assert_reply ref, :ok
      before = HostRegistry.get(host_id).last_heartbeat

      Process.sleep(10)
      ref = push(socket, "heartbeat", %{})
      assert_reply ref, :ok

      assert HostRegistry.get(host_id).last_heartbeat >= before
    end
  end

  describe "runner → operator の転送" do
    test "sessions は host_id を付与して runner_sessions として agents:lobby へ転送する" do
      host_id = "lab-pc-sess"
      @endpoint.subscribe("agents:lobby")
      socket = join_runner(host_id)

      ref =
        push(socket, "sessions", %{
          "cwd" => "/home/user/proj",
          "sessions" => [%{"session_id" => "s1"}]
        })

      assert_reply ref, :ok

      assert_broadcast "runner_sessions", %{
        "host_id" => ^host_id,
        "cwd" => "/home/user/proj",
        "sessions" => [%{"session_id" => "s1"}]
      }
    end

    test "spawn_result は host_id を付与して agents:lobby へ転送する" do
      host_id = "lab-pc-spawn"
      @endpoint.subscribe("agents:lobby")
      socket = join_runner(host_id)

      ref =
        push(socket, "spawn_result", %{
          "agent_id" => "lab-pc-spawn.a",
          "ok" => false,
          "reason" => "already_running"
        })

      assert_reply ref, :ok

      assert_broadcast "spawn_result", %{
        "host_id" => ^host_id,
        "agent_id" => "lab-pc-spawn.a",
        "ok" => false,
        "reason" => "already_running"
      }
    end
  end

  describe "切断時のホスト削除" do
    test "channel 終了でホストエントリを drop する" do
      host_id = "lab-pc-disc"
      socket = join_runner(host_id)

      ref = push(socket, "register", register_payload())
      assert_reply ref, :ok
      assert HostRegistry.get(host_id)

      Process.unlink(socket.channel_pid)
      :ok = close(socket)

      # close/1 returns once terminate has run; the entry is gone.
      assert HostRegistry.get(host_id) == nil
    end
  end

  defp join_with_token(host_id, token) do
    KaoiroServerWeb.RunnerSocket
    |> socket(nil, %{runner_token: token})
    |> subscribe_and_join(
      KaoiroServerWeb.RunnerChannel,
      "runner:" <> host_id
    )
  end

  describe "runner token 認証 (ADR-0023)" do
    setup do
      Application.put_env(:kaoiro_server, :runner_tokens, "lab-pc-1:tok-1")
      on_exit(fn -> Application.delete_env(:kaoiro_server, :runner_tokens) end)
    end

    test "正しいトークンで join できる" do
      assert {:ok, _reply, _socket} = join_with_token("lab-pc-1", "tok-1")
    end

    test "不一致・欠落トークンは join を拒否する" do
      assert {:error, %{reason: "unauthorized"}} = join_with_token("lab-pc-1", "wrong")
      assert {:error, %{reason: "unauthorized"}} = join_with_token("lab-pc-1", nil)
      assert {:error, %{reason: "unauthorized"}} = join_with_token("lab-pc-unlisted", "tok-1")
    end
  end

  describe "host_id 文字種ガード" do
    test "不正な文字種の host_id は join を拒否する" do
      for bad <- ["bad*host", "with#hash", "a/b/c", "has space"] do
        assert {:error, %{reason: "invalid_host_id"}} =
                 KaoiroServerWeb.RunnerSocket
                 |> socket(nil, %{})
                 |> subscribe_and_join(
                   KaoiroServerWeb.RunnerChannel,
                   "runner:" <> bad
                 )
      end
    end
  end
end
