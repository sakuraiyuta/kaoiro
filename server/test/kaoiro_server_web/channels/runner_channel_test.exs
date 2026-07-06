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

  defp register_payload(extra \\ %{}) do
    Map.merge(%{"cwd_allowlist" => ["/home/user/proj"]}, extra)
  end

  describe "register (ADR-0031 persona trust policy)" do
    test "accept-all: persona 関連フィールド無しなら :accept_all として保持" do
      host_id = "lab-pc-accept-all"
      @endpoint.subscribe("agents:lobby")
      socket = join_runner(host_id)

      ref = push(socket, "register", register_payload())

      assert_reply ref, :ok
      assert_broadcast "hosts", %{"hosts" => _}

      entry = HostRegistry.get(host_id)
      assert entry.policy == :accept_all
      assert entry.cwd_allowlist == ["/home/user/proj"]
    end

    test "allowlist: allowed_personas が MapSet として保持される" do
      host_id = "lab-pc-allow"
      socket = join_runner(host_id)

      ref =
        push(
          socket,
          "register",
          register_payload(%{"allowed_personas" => ["ao", "kuroe"]})
        )

      assert_reply ref, :ok
      entry = HostRegistry.get(host_id)
      assert entry.policy == {:allowlist, MapSet.new(["ao", "kuroe"])}
    end

    test "blocklist: blocked_personas が MapSet として保持される" do
      host_id = "lab-pc-block"
      socket = join_runner(host_id)

      ref =
        push(
          socket,
          "register",
          register_payload(%{"blocked_personas" => ["fuji"]})
        )

      assert_reply ref, :ok
      entry = HostRegistry.get(host_id)
      assert entry.policy == {:blocklist, MapSet.new(["fuji"])}
    end

    test "allowed_personas と blocked_personas 同時指定は invalid_register" do
      socket = join_runner("lab-pc-both")

      ref =
        push(
          socket,
          "register",
          register_payload(%{
            "allowed_personas" => ["ao"],
            "blocked_personas" => ["fuji"]
          })
        )

      assert_reply ref, :error, %{reason: "both_persona_policies"}
      refute HostRegistry.get("lab-pc-both")
    end

    test "legacy personas + 新フィールド同時は invalid_register" do
      socket = join_runner("lab-pc-mix")

      ref =
        push(
          socket,
          "register",
          register_payload(%{
            "personas" => [%{"id" => "ao"}],
            "allowed_personas" => ["ao"]
          })
        )

      assert_reply ref, :error, %{reason: "legacy_and_new_persona_policy"}
      refute HostRegistry.get("lab-pc-mix")
    end

    test "legacy personas は allowlist として受理される (deprecation)" do
      host_id = "lab-pc-legacy"
      socket = join_runner(host_id)

      ref =
        push(
          socket,
          "register",
          register_payload(%{
            "personas" => [
              %{"id" => "mio", "name" => "澪", "sprite_set" => "mio"}
            ]
          })
        )

      assert_reply ref, :ok
      entry = HostRegistry.get(host_id)
      # id のみを取り、name/sprite_set は server SoT に委ねる
      assert entry.policy == {:allowlist, MapSet.new(["mio"])}
    end

    test "型不正 (allowed_personas が文字列でない) は invalid_persona_id" do
      socket = join_runner("lab-pc-badtype")

      ref =
        push(
          socket,
          "register",
          register_payload(%{"allowed_personas" => [123]})
        )

      assert_reply ref, :error, %{reason: "invalid_persona_id"}
    end

    test "cwd_allowlist の型不正は invalid_register" do
      socket = join_runner("lab-pc-badcwd")

      ref = push(socket, "register", %{"cwd_allowlist" => "x"})
      assert_reply ref, :error, %{reason: "invalid_register"}

      refute HostRegistry.get("lab-pc-badcwd")
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
