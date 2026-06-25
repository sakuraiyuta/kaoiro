defmodule KaoiroServerWeb.WrapperChannelTest do
  use KaoiroServerWeb.ChannelCase, async: false

  alias KaoiroServer.AgentStates

  defp envelope(agent_id, state) do
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
      |> subscribe_and_join(KaoiroServerWeb.WrapperChannel, "wrapper:" <> agent_id)

    socket
  end

  test "envelope を受けて agents:lobby へ中継し最新状態を保持する" do
    agent_id = "test.relay-1"
    @endpoint.subscribe("agents:lobby")
    socket = join_wrapper(agent_id)

    envelope = envelope(agent_id, "tool_running")
    ref = push(socket, "envelope", envelope)

    assert_reply ref, :ok
    assert_broadcast "envelope", ^envelope
    assert AgentStates.snapshot()[agent_id] == envelope
  end

  test "稼働中 agent_id への二重 join を already_connected で拒否する (ADR-0024 D5)" do
    agent_id = "test.d5-dup"
    socket = join_wrapper(agent_id)
    # The first wrapper owns the entry once it reports state.
    ref = push(socket, "envelope", envelope(agent_id, "idle"))
    assert_reply ref, :ok

    # A second concurrent connection for the same agent_id is rejected; the
    # incumbent keeps the slot (reject-newcomer, anti adversarial-eviction).
    assert {:error, %{reason: "already_connected"}} =
             KaoiroServerWeb.WrapperSocket
             |> socket(nil, %{})
             |> subscribe_and_join(KaoiroServerWeb.WrapperChannel, "wrapper:" <> agent_id)
  end

  test "フレームキー欠落の envelope を拒否し中継しない" do
    agent_id = "test.invalid-1"
    @endpoint.subscribe("agents:lobby")
    socket = join_wrapper(agent_id)

    ref = push(socket, "envelope", Map.delete(envelope(agent_id, "idle"), "state"))

    assert_reply ref, :error, %{reason: "missing key: state"}
    refute_broadcast "envelope", %{}
    refute Map.has_key?(AgentStates.snapshot(), agent_id)
  end

  test "topic と不一致の agent_id を拒否する" do
    socket = join_wrapper("test.mismatch-1")

    ref = push(socket, "envelope", envelope("test.other", "idle"))

    assert_reply ref, :error, %{reason: "agent_id does not match topic"}
  end

  test "オブジェクトでない envelope を拒否する" do
    socket = join_wrapper("test.nonmap-1")

    ref = push(socket, "envelope", "not a map")

    assert_reply ref, :error, %{reason: "envelope must be an object"}
  end

  defp join_with_token(agent_id, token) do
    KaoiroServerWeb.WrapperSocket
    |> socket(nil, %{wrapper_token: token})
    |> subscribe_and_join(
      KaoiroServerWeb.WrapperChannel,
      "wrapper:" <> agent_id
    )
  end

  describe "wrapper token 認証 (ADR-0011)" do
    setup do
      Application.put_env(:kaoiro_server, :wrapper_tokens, "test.auth-1:tok-1")
      on_exit(fn -> Application.delete_env(:kaoiro_server, :wrapper_tokens) end)
    end

    test "正しいトークンで join できる" do
      assert {:ok, _reply, _socket} = join_with_token("test.auth-1", "tok-1")
    end

    test "不一致・欠落トークンは join を拒否する" do
      assert {:error, %{reason: "unauthorized"}} =
               join_with_token("test.auth-1", "wrong")

      assert {:error, %{reason: "unauthorized"}} =
               join_with_token("test.auth-1", nil)

      assert {:error, %{reason: "unauthorized"}} =
               join_with_token("test.unlisted", "tok-1")
    end
  end

  describe "agent_id 文字種ガード (issue #61)" do
    test "不正な文字種の agent_id は join を拒否する" do
      for bad <- ["bad*id", "with#hash", "a/b/c", "has space"] do
        assert {:error, %{reason: "invalid_agent_id"}} =
                 KaoiroServerWeb.WrapperSocket
                 |> socket(nil, %{})
                 |> subscribe_and_join(
                   KaoiroServerWeb.WrapperChannel,
                   "wrapper:" <> bad
                 )
      end
    end

    test "正規の文字種の agent_id は join できる" do
      assert {:ok, _reply, _socket} =
               KaoiroServerWeb.WrapperSocket
               |> socket(nil, %{})
               |> subscribe_and_join(
                 KaoiroServerWeb.WrapperChannel,
                 "wrapper:ok.id-1_2"
               )
    end
  end

  describe "log/result の履歴振り分け (ADR-0012)" do
    defp log_env(agent_id) do
      %{
        "version" => "0",
        "agent_id" => agent_id,
        "persona" => %{"id" => "mio", "name" => "澪", "sprite_set" => "mio"},
        "ts" => "2026-06-11T00:00:00Z",
        "type" => "log",
        "state" => "thinking",
        "payload" => %{"kind" => "assistant", "text" => "やります"},
        "ext" => %{}
      }
    end

    test "log は中継しつつ最新状態を上書きせず履歴へ積む" do
      agent_id = "test.log-1"
      @endpoint.subscribe("agents:lobby")
      socket = join_wrapper(agent_id)

      # Establish a latest state, then send a reply log line.
      ref = push(socket, "envelope", envelope(agent_id, "tool_running"))
      assert_reply ref, :ok
      assert_broadcast "envelope", %{"state" => "tool_running"}

      log = log_env(agent_id)
      ref = push(socket, "envelope", log)
      assert_reply ref, :ok
      assert_broadcast "envelope", ^log

      # The log neither changes the latest state nor is dropped: snapshot
      # stays tool_running and the line lands in history.
      assert AgentStates.snapshot()[agent_id]["state"] == "tool_running"
      assert [%{"payload" => %{"text" => "やります"}}] = AgentStates.histories()[agent_id]
    end

    test "状態未確立の log は ack のみで中継も履歴もしない" do
      agent_id = "test.log-noop"
      @endpoint.subscribe("agents:lobby")
      socket = join_wrapper(agent_id)

      # No prior state_change: append_log is :noop, so nothing is retained
      # and the live broadcast is suppressed (still acked).
      ref = push(socket, "envelope", log_env(agent_id))
      assert_reply ref, :ok
      refute_broadcast "envelope", %{}
      refute Map.has_key?(AgentStates.snapshot(), agent_id)
      refute Map.has_key?(AgentStates.histories(), agent_id)
    end
  end

  describe "history_reset (resume 再構築, issue #50)" do
    test "履歴を全消去し history_reset を broadcast、最新状態は残す" do
      agent_id = "test.reset-1"
      @endpoint.subscribe("agents:lobby")
      socket = join_wrapper(agent_id)

      # Seed a latest state + a reply line, then reset.
      ref = push(socket, "envelope", envelope(agent_id, "thinking"))
      assert_reply ref, :ok
      ref = push(socket, "envelope", log_env(agent_id))
      assert_reply ref, :ok
      assert [%{"payload" => %{"text" => "やります"}}] = AgentStates.histories()[agent_id]

      ref = push(socket, "history_reset", %{})
      assert_reply ref, :ok
      assert_broadcast "history_reset", %{"agent_id" => ^agent_id}

      # History gone; latest state untouched.
      refute Map.has_key?(AgentStates.histories(), agent_id)
      assert AgentStates.snapshot()[agent_id]["state"] == "thinking"
    end

    test "状態未確立(未知 agent)の history_reset は ack のみで broadcast しない" do
      agent_id = "test.reset-noop"
      @endpoint.subscribe("agents:lobby")
      socket = join_wrapper(agent_id)

      ref = push(socket, "history_reset", %{})
      assert_reply ref, :ok
      refute_broadcast "history_reset", %{}
    end
  end

  describe "session_id ポインタの永続 (ADR-0014 F1, #49)" do
    test "session_id 付き envelope でポインタを記録する" do
      agent_id = "test.ptr-1"
      socket = join_wrapper(agent_id)

      env =
        envelope(agent_id, "thinking")
        |> Map.put("session_id", "sess-xyz")
        |> Map.put("ext", %{"cwd" => "/home/user/proj"})

      ref = push(socket, "envelope", env)
      assert_reply ref, :ok

      assert KaoiroServer.SessionPointers.get(agent_id) ==
               %{session_id: "sess-xyz", cwd: "/home/user/proj"}
    end

    test "session_id なし envelope はポインタを作らない" do
      agent_id = "test.ptr-2"
      socket = join_wrapper(agent_id)

      ref = push(socket, "envelope", envelope(agent_id, "thinking"))
      assert_reply ref, :ok

      assert KaoiroServer.SessionPointers.get(agent_id) == nil
    end
  end

  describe "切断時の disconnected 導出" do
    test "channel 終了で disconnected を broadcast し snapshot を更新する" do
      agent_id = "test.disc-1"
      @endpoint.subscribe("agents:lobby")
      socket = join_wrapper(agent_id)

      ref = push(socket, "envelope", envelope(agent_id, "thinking"))
      assert_reply ref, :ok

      Process.unlink(socket.channel_pid)
      :ok = close(socket)

      assert_broadcast "envelope", %{
        "agent_id" => ^agent_id,
        "state" => "disconnected"
      }

      assert AgentStates.snapshot()[agent_id]["state"] == "disconnected"
    end
  end
end
