defmodule KaoiroServerWeb.WrapperChannelTest do
  use KaoiroServerWeb.ChannelCase, async: false

  alias KaoiroServer.AgentStates
  alias KaoiroServer.InterAgentHistory
  alias KaoiroServer.SessionPointers
  alias KaoiroServer.TokenDenylist
  alias KaoiroServerWeb.WrapperChannel

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

  defp join_wrapper(agent_id, persona_id \\ "default") do
    {:ok, _reply, socket} =
      KaoiroServerWeb.WrapperSocket
      |> socket(nil, %{})
      |> subscribe_and_join(
        KaoiroServerWeb.WrapperChannel,
        "wrapper:" <> agent_id,
        %{"persona_id" => persona_id}
      )

    socket
  end

  defp seed_snapshot(agent_id, model) do
    SessionPointers.record(agent_id, "seed-session", "/workspace", :codex)
    SessionPointers.record_snapshot(agent_id, %{"model" => model})
    _ = :sys.get_state(SessionPointers)
    :ok
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
             |> subscribe_and_join(
               KaoiroServerWeb.WrapperChannel,
               "wrapper:" <> agent_id,
               %{"persona_id" => "default"}
             )
  end

  test "wrapper:<id> への 'revoked' broadcast で channel が shutdown する (issue #72)" do
    agent_id = "test.revoke-live"
    # ChannelCase は test process を channel process と link するので、
    # :shutdown exit が test process を巻き添えにする。trap_exit で吸収。
    Process.flag(:trap_exit, true)
    socket = join_wrapper(agent_id)
    ref = push(socket, "envelope", envelope(agent_id, "idle"))
    assert_reply ref, :ok

    channel_pid = socket.channel_pid
    monitor_ref = Process.monitor(channel_pid)

    KaoiroServerWeb.Endpoint.broadcast(
      "wrapper:" <> agent_id,
      "revoked",
      %{"reason" => "operator_revoke", "revoked_at" => "2026-07-23T15:00:00Z"}
    )

    # handle_out で {:stop, :shutdown, socket} を返すので channel 終了。
    assert_receive {:DOWN, ^monitor_ref, :process, ^channel_pid, :shutdown}, 500
    # trap_exit で受けた {:EXIT, ...} も drain (test 分離のため)。
    assert_receive {:EXIT, ^channel_pid, :shutdown}

    # terminate/2 が走って disconnected envelope が derive され、
    # 通常経路 (agents:lobby) に broadcast される。
    on_exit(fn -> AgentStates.delete(agent_id) end)
  end

  # ふじ R1-race must-fix (2026-07-23, 3rd review): Auth.authorize_wrapper
  # の denylist=false 確認と Phoenix の topic subscribe 完了の間に
  # delete_agent / revoke_wrapper_token が完走すると、`revoked` broadcast
  # は未 subscribe channel に届かず、intercept("revoked") 経由の
  # handle_out も走らないため after_join が persona_prompt を push して
  # 初回 envelope で AgentStates を再 seed してしまう。fix:
  # handle_info(:after_join, socket) 冒頭で TokenDenylist を再確認、
  # revoked なら {:stop, :shutdown, socket}。
  #
  # 真の race を試験の中で決定的に再現するのは Phoenix.ChannelTest の
  # 制約 (subscribe_and_join return と after_join 処理が別 process で
  # 非決定的にインタリーブ) で困難なため、guard 自体を unit level で
  # pin する: fabricated socket に対して handle_info(:after_join) を
  # 直接呼び、denylist=true のときの return value を assert する。
  test "after_join: TokenDenylist に revoked 済み agent は channel stop する (R1-race pin)" do
    agent_id = "test.after-join-race"
    on_exit(fn -> TokenDenylist.restore(agent_id) end)

    :ok = TokenDenylist.revoke(agent_id, "2026-07-23T15:00:00Z")
    assert TokenDenylist.revoked?(agent_id) == true

    socket = %Phoenix.Socket{
      assigns: %{agent_id: agent_id, persona_id: "default"},
      channel: WrapperChannel,
      endpoint: KaoiroServerWeb.Endpoint,
      handler: KaoiroServerWeb.WrapperSocket,
      pubsub_server: KaoiroServer.PubSub,
      transport: :channel_test,
      transport_pid: self(),
      serializer: Phoenix.Socket.V2.JSONSerializer,
      topic: "wrapper:" <> agent_id,
      channel_pid: self()
    }

    assert {:stop, :shutdown, ^socket} = WrapperChannel.handle_info(:after_join, socket)

    # ふじ 4th advisory 1 (2026-07-23): stop の前に persona_prompt を
    # 決して push しないことも直接 pin。`{:stop, ...}` を返しても実装が
    # うっかり先に push(socket, "persona_prompt", …) してしまう改変を
    # 検出する security property test — revoked agent には prompt を
    # 与えないという不変条件が「実装順序」に依存することを回避する。
    # (fake socket は transport_pid: self() で push を test 側の
    # mailbox へ落とすので refute_push が有効。)
    refute_push "persona_prompt", %{}, 50
  end

  # 陽性 case (guard が誤発火しない) の pin: denylist に居ないなら
  # 従来通り persona_prompt を push して continue。
  test "after_join: denylist に無ければ従来通り persona_prompt を push (R1-race pin 陰性)" do
    agent_id = "test.after-join-clean"
    # revoke 履歴が無い状態を保証。
    _ = TokenDenylist.restore(agent_id)
    refute TokenDenylist.revoked?(agent_id)

    socket = join_wrapper(agent_id)
    # join_wrapper 内部で subscribe_and_join → after_join 経路が走る。
    # denylist clean なら persona_prompt 到達を assert できる。
    assert_push "persona_prompt", %{prompt: prompt}
    assert is_binary(prompt)
    _ = socket
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
      "wrapper:" <> agent_id,
      %{"persona_id" => "default"}
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

  describe "persona_prompt push と unknown persona reject (ADR-0029)" do
    test "join params の persona_id が欠落なら missing_persona_id で拒否" do
      assert {:error, %{reason: "missing_persona_id"}} =
               KaoiroServerWeb.WrapperSocket
               |> socket(nil, %{})
               |> subscribe_and_join(
                 KaoiroServerWeb.WrapperChannel,
                 "wrapper:test.persona-miss",
                 %{}
               )
    end

    test "manifest にない persona_id は unknown_persona で拒否" do
      assert {:error, %{reason: "unknown_persona"}} =
               KaoiroServerWeb.WrapperSocket
               |> socket(nil, %{})
               |> subscribe_and_join(
                 KaoiroServerWeb.WrapperChannel,
                 "wrapper:test.persona-unk",
                 %{"persona_id" => "does-not-exist"}
               )
    end

    test "reserved default は pack なしでも known 扱い + footer のみが push される" do
      _socket = join_wrapper("test.persona-default", "default")
      assert_push "persona_prompt", %{prompt: prompt}
      assert prompt == KaoiroServer.PersonaAssets.common_footer()
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
                   "wrapper:" <> bad,
                   %{"persona_id" => "default"}
                 )
      end
    end

    test "正規の文字種の agent_id は join できる" do
      assert {:ok, _reply, _socket} =
               KaoiroServerWeb.WrapperSocket
               |> socket(nil, %{})
               |> subscribe_and_join(
                 KaoiroServerWeb.WrapperChannel,
                 "wrapper:ok.id-1_2",
                 %{"persona_id" => "default"}
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

    test "refresh_models_result は中継しつつ最新状態を上書きしない (ADR-0039 F9 v2 must-fix 1)" do
      # transient completion envelope: broadcast (client pending map で
      # settle される) が、AgentStates.put されない = 直前 state_change の
      # rich models が snapshot に残る。
      agent_id = "test.refresh-transient"
      @endpoint.subscribe("agents:lobby")
      socket = join_wrapper(agent_id)

      # Establish latest state with a state_change carrying rich models.
      rich_state =
        %{envelope(agent_id, "tool_running") | "ext" => %{"models" => [%{"value" => "sonnet"}]}}

      ref = push(socket, "envelope", rich_state)
      assert_reply ref, :ok
      assert_broadcast "envelope", %{"state" => "tool_running"}

      # Wrapper emits refresh_models_result immediately after.
      result_env = %{
        "version" => "0",
        "agent_id" => agent_id,
        "persona" => %{"id" => "mio", "name" => "澪", "sprite_set" => "mio"},
        "ts" => "2026-06-11T00:00:01Z",
        "type" => "refresh_models_result",
        "state" => "tool_running",
        "payload" => %{
          "request_id" => "req-1",
          "ok" => true,
          "models_count" => 3
        },
        "ext" => %{}
      }

      ref = push(socket, "envelope", result_env)
      assert_reply ref, :ok
      # Broadcast still fires (client pending map needs it).
      assert_broadcast "envelope", %{"type" => "refresh_models_result"}

      # But snapshot latest is untouched — the rich_state remains.
      assert AgentStates.snapshot()[agent_id]["type"] == "state_change"

      assert AgentStates.snapshot()[agent_id]["ext"]["models"] == [
               %{"value" => "sonnet"}
             ]
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

      assert_broadcast "history_reset", %{
        "agent_id" => ^agent_id,
        "preserve_inter_agent" => true
      }

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
               %{session_id: "sess-xyz", cwd: "/home/user/proj", engine: nil, snapshot: nil}
    end

    test "session_id なし envelope はポインタを作らない" do
      agent_id = "test.ptr-2"
      socket = join_wrapper(agent_id)

      ref = push(socket, "envelope", envelope(agent_id, "thinking"))
      assert_reply ref, :ok

      assert KaoiroServer.SessionPointers.get(agent_id) == nil
    end
  end

  # 実機検収 2 (2026-07-23 マスター指示): A の IA visibility 境界は
  # SessionResets confirm_connection (Trigger 1) と外部 switch_session
  # (Trigger 2) の 2 経路でのみ前進する。以下 4 pin はクロエ 追加条件:
  #   - 条件 1: resume で境界を前進させない (dogfood 再起動 + 同一
  #     session 復帰後の durable IA 表示が壊れないこと)
  #   - 条件 2: 未発話 agent の初回 sid 報告で境界を前進させない
  #     (fresh spawn 直後の IA が誤って hidden 化しないこと)
  describe "IA visibility 境界の前進 trigger (実機検収 2)" do
    alias KaoiroServer.ClearWatermarks
    alias KaoiroServer.SessionPointers, as: SP

    setup do
      # 各 test 独立に境界と durable sid を purge。 テスト singleton は
      # per-run tmp DETS だが agent_id 名前空間は共有なので on_exit で
      # 明示 clean up する。
      on_exit(fn -> :ok end)
      :ok
    end

    test "条件 2a: fresh spawn の初 state_change (durable sid 未登録) で境界前進しない" do
      agent_id = "test.boundary-fresh"

      on_exit(fn ->
        SP.delete(agent_id)
        ClearWatermarks.delete(agent_id)
      end)

      socket = join_wrapper(agent_id)

      env =
        envelope(agent_id, "thinking")
        |> Map.put("session_id", "sess-fresh-1")

      ref = push(socket, "envelope", env)
      assert_reply ref, :ok

      # durable sid が新規登録される (record_session_pointer 経由)。
      assert %{session_id: "sess-fresh-1"} = SP.get(agent_id)
      # 境界は未 seed のまま (Trigger 2 が「prior_sid nil のとき前進
      # しない」を守る)。 未発話 agent の初回 IA 保護。
      assert ClearWatermarks.get(agent_id) == nil
    end

    test "条件 1: 同一 sid の再報告 (dogfood restart + resume) で境界前進しない" do
      agent_id = "test.boundary-resume"
      # pre-restart 状態: durable sid が既に seed 済み。
      SP.record(agent_id, "sess-durable", "/proj")
      _ = :sys.get_state(SP)

      on_exit(fn ->
        SP.delete(agent_id)
        ClearWatermarks.delete(agent_id)
      end)

      socket = join_wrapper(agent_id)

      # 同じ sid で state_change (resume 経路)。
      env =
        envelope(agent_id, "waiting_input")
        |> Map.put("session_id", "sess-durable")

      ref = push(socket, "envelope", env)
      assert_reply ref, :ok

      # 境界不変 (prior == new)。
      assert ClearWatermarks.get(agent_id) == nil
    end

    test "Trigger 2: durable prior_sid と異なる sid が届いたら境界を前進 (external switch)" do
      agent_id = "test.boundary-switch"
      SP.record(agent_id, "sess-old", "/proj")
      _ = :sys.get_state(SP)

      on_exit(fn ->
        SP.delete(agent_id)
        ClearWatermarks.delete(agent_id)
      end)

      socket = join_wrapper(agent_id)

      # 明示的な別 sid (restore/resume_session 経由の外部 switch を模擬)。
      env =
        envelope(agent_id, "waiting_input")
        |> Map.put("session_id", "sess-new")

      ref = push(socket, "envelope", env)
      assert_reply ref, :ok

      # 境界が seed されている: tuple 記録 + display ISO。
      assert {{us, seq}, iso, sid} = ClearWatermarks.get(agent_id)
      assert is_integer(us) and is_integer(seq)
      assert String.match?(iso, ~r/^\d{4}-\d{2}-\d{2}T/)
      # M3: Trigger 2 は envelope.session_id を transition identity と
      # して record する (crash 後 restart で同一 transition を retry
      # しても no-op になる)。
      assert sid == "sess-new"

      # durable sid も update されている (Trigger 2 は
      # record_session_pointer より前に走るので、record 前の値が読める
      # ことを確認済み)。
      assert %{session_id: "sess-new"} = SP.get(agent_id)
    end

    test "R1: crash後の old pointer + pending lazy boundary は new sid を二重advanceせず adopt" do
      agent_id = "test.boundary-r1-crash"
      SP.record(agent_id, "sess-old", "/proj")
      _ = :sys.get_state(SP)

      on_exit(fn ->
        SP.delete(agent_id)
        ClearWatermarks.delete(agent_id)
      end)

      # Trigger 1 は Codex lazy sid=nil のまま、old pointer identity を
      # fsync済 boundary に残す。ここで detach 前 crash を模擬する。
      assert {:ok, {order1, display1, nil}} =
               ClearWatermarks.advance_transition(agent_id, nil, "sess-old", ClearWatermarks)

      @endpoint.subscribe("agents:lobby")
      socket = join_wrapper(agent_id)
      env = envelope(agent_id, "waiting_input") |> Map.put("session_id", "sess-new")
      assert_reply push(socket, "envelope", env), :ok

      assert ClearWatermarks.get(agent_id) == {order1, display1, "sess-new"}
      # Trigger 1 が既に通知済みの boundary を patch しただけで、O2 の
      # live re-filter event は追加発火しない。
      refute_receive %Phoenix.Socket.Broadcast{event: "session_boundary_advanced"}
    end

    test "R1 non-regression: 通常detach後の nil→sid は Trigger 2 不発で adopt_sid" do
      agent_id = "test.boundary-r1-detach"
      SP.record(agent_id, "sess-old", "/proj")

      assert {:ok, {order1, display1, nil}} =
               ClearWatermarks.advance_transition(agent_id, nil, "sess-old", ClearWatermarks)

      SP.detach_session(agent_id)
      _ = :sys.get_state(SP)

      on_exit(fn ->
        SP.delete(agent_id)
        ClearWatermarks.delete(agent_id)
      end)

      socket = join_wrapper(agent_id)
      env = envelope(agent_id, "waiting_input") |> Map.put("session_id", "sess-new")
      assert_reply push(socket, "envelope", env), :ok
      assert ClearWatermarks.get(agent_id) == {order1, display1, "sess-new"}
    end

    test "R3: AgentStates cap error はchannelをcrashせず error reply、boundaryは成立する" do
      agent_id = "test.boundary-cap"
      SP.record(agent_id, "sess-old", "/proj")
      _ = :sys.get_state(SP)
      original_state = :sys.get_state(AgentStates)

      on_exit(fn ->
        :sys.replace_state(AgentStates, fn _ -> original_state end)
        SP.delete(agent_id)
        ClearWatermarks.delete(agent_id)
      end)

      # Directly seed the singleton to its documented cap. The entry values
      # are irrelevant to put/2's cap guard; this avoids 1000 channel joins.
      full_state = Map.new(1..1000, fn n -> {"cap-#{n}", %{}} end)
      :sys.replace_state(AgentStates, fn _ -> full_state end)
      socket = join_wrapper(agent_id)

      env = envelope(agent_id, "waiting_input") |> Map.put("session_id", "sess-new")
      assert_reply push(socket, "envelope", env), :error, %{reason: "too_many_agents"}
      assert Process.alive?(socket.channel_pid)
      assert {{_us, _seq}, _display, "sess-new"} = ClearWatermarks.get(agent_id)

      # A living channel can process the next message after capacity recovers.
      :sys.replace_state(AgentStates, fn _ -> original_state end)
      assert_reply push(socket, "envelope", env), :ok
    end

    test "M1 wire (fix-round): Trigger 2 は session_boundary_advanced を agents:lobby へ broadcast する" do
      agent_id = "test.boundary-broadcast"
      SP.record(agent_id, "sess-a", "/proj")
      _ = :sys.get_state(SP)

      on_exit(fn ->
        SP.delete(agent_id)
        ClearWatermarks.delete(agent_id)
      end)

      @endpoint.subscribe("agents:lobby")
      socket = join_wrapper(agent_id)

      env =
        envelope(agent_id, "waiting_input")
        |> Map.put("session_id", "sess-b")

      ref = push(socket, "envelope", env)
      assert_reply ref, :ok

      # M1: additive wire。 boundary display iso を payload に載せて
      # live client が受信、in-memory IA を再 filter する契約。
      assert_receive %Phoenix.Socket.Broadcast{
        event: "session_boundary_advanced",
        payload: %{"agent_id" => ^agent_id, "boundary" => boundary}
      }

      assert is_binary(boundary)
      assert String.match?(boundary, ~r/^\d{4}-\d{2}-\d{2}T/)
    end

    test "M2 fix-round: 新 session の初 envelope が IA でも、その IA が境界以下にならない" do
      # pre-M2 は store(envelope) の後に maybe_advance を呼んでいたので、
      # IA envelope が先に InterAgentHistory.append (order N) → boundary
      # が後で allocate (order N+1) となり、その current-session IA が
      # reload で filter 落ちする regression があった。 fix: advance を
      # store より前に置く。
      alias KaoiroServer.InterAgentHistory
      agent_id = "test.boundary-order-ia"
      peer_id = "test.boundary-order-ia-peer"
      SP.record(agent_id, "sess-old", "/proj")
      _ = :sys.get_state(SP)

      # IA は route_inter_agent で受信 agent の existence check を通る
      # ので、peer を AgentStates に seed しておく (直接 put)。
      :ok =
        AgentStates.put(%{
          "version" => "0",
          "agent_id" => peer_id,
          "persona" => %{"id" => "peer", "name" => "peer", "sprite_set" => "peer"},
          "ts" => "2026-07-23T14:00:00Z",
          "type" => "state_change",
          "state" => "idle",
          "payload" => %{},
          "ext" => %{}
        })

      on_exit(fn ->
        SP.delete(agent_id)
        ClearWatermarks.delete(agent_id)
        InterAgentHistory.delete_agent(agent_id)
        AgentStates.delete(peer_id)
      end)

      socket = join_wrapper(agent_id)

      # まず sess-old の state_change を送って AgentStates に snapshot を
      # 作る (以後 IA の append_log が :noop にならないため)。
      ref0 =
        push(
          socket,
          "envelope",
          envelope(agent_id, "idle") |> Map.put("session_id", "sess-old")
        )

      assert_reply ref0, :ok

      # 新 session の初 envelope が IA (transition + IA が同時)。
      ia_env = %{
        "version" => "0",
        "agent_id" => agent_id,
        "persona" => %{"id" => "mio", "name" => "澪", "sprite_set" => "mio"},
        "ts" => "2026-07-23T15:00:00Z",
        "seq" => 1,
        "type" => "inter_agent_message",
        "state" => "tool_running",
        "session_id" => "sess-new",
        "payload" => %{
          "to" => peer_id,
          "conversation_id" => "cid-transition-#{System.unique_integer([:positive])}",
          "turn_number" => 1,
          "kind" => "inform",
          "body" => "hello",
          "meta" => %{"done" => false, "propose_next" => "reply"},
          "owner" => %{"kind" => "agent", "id" => agent_id}
        },
        "ext" => %{}
      }

      ref = push(socket, "envelope", ia_env)
      assert_reply ref, :ok

      # 境界の order は IA の order より小さい必要がある (advance が先)。
      [{ia_order, _ia_env}] = InterAgentHistory.all_with_order()[agent_id]
      {boundary_order, _display, _sid} = ClearWatermarks.get(agent_id)
      assert boundary_order < ia_order
    end

    test "Trigger 2: session_id 未同梱 envelope は境界に影響しない" do
      agent_id = "test.boundary-no-sid"
      SP.record(agent_id, "sess-x", "/proj")
      _ = :sys.get_state(SP)

      on_exit(fn ->
        SP.delete(agent_id)
        ClearWatermarks.delete(agent_id)
      end)

      socket = join_wrapper(agent_id)

      # session_id 無し (permission_request 等の中間 envelope)。
      ref = push(socket, "envelope", envelope(agent_id, "waiting_permission"))
      assert_reply ref, :ok

      assert ClearWatermarks.get(agent_id) == nil
    end
  end

  describe "成功 effective snapshot の永続 (ADR-0035 F3)" do
    test "pending/errorなしのeffectiveをsnapshotへ記録する" do
      agent_id = "test.snapshot-success"
      socket = join_wrapper(agent_id)

      env =
        envelope(agent_id, "waiting_input")
        |> Map.put("session_id", "sess-success")
        |> Map.put("ext", %{
          "effective" => %{"model" => "gpt-5.6-sol", "effort" => "low"}
        })

      ref = push(socket, "envelope", env)
      assert_reply ref, :ok

      assert %{snapshot: snapshot} = KaoiroServer.SessionPointers.get(agent_id)
      assert snapshot == %{"model" => "gpt-5.6-sol", "effort" => "low"}
    end

    test "switch_error付きstate_changeは既存snapshotを更新しない" do
      agent_id = "test.snapshot-failure"
      socket = join_wrapper(agent_id)
      seed_snapshot(agent_id, "gpt-5.6-terra")

      env =
        envelope(agent_id, "error")
        |> Map.put("ext", %{
          "effective" => %{"model" => "not-entitled"},
          "switch_error" => %{
            "kind" => "model",
            "requested" => "not-entitled",
            "reason" => "turn_failed",
            "rolled_back_to" => "gpt-5.6-terra"
          }
        })

      ref = push(socket, "envelope", env)
      assert_reply ref, :ok

      assert %{snapshot: %{"model" => "gpt-5.6-terra"}} =
               KaoiroServer.SessionPointers.get(agent_id)
    end

    test "pending model/effort付きstate_changeは既存snapshotを更新しない" do
      agent_id = "test.snapshot-pending"
      socket = join_wrapper(agent_id)
      seed_snapshot(agent_id, "gpt-5.6-terra")

      for pending <- [
            %{"pending_model" => "gpt-5.6-sol"},
            %{"pending_effort" => "high"}
          ] do
        ext = Map.put(pending, "effective", %{"model" => "pending-value"})
        ref = push(socket, "envelope", Map.put(envelope(agent_id, "idle"), "ext", ext))
        assert_reply ref, :ok
      end

      assert %{snapshot: %{"model" => "gpt-5.6-terra"}} =
               KaoiroServer.SessionPointers.get(agent_id)
    end
  end

  # phase-17 17-11 (ε): boundary marker の to_session_id 後追い patch
  # 経路 (Codex lazy 采番用) の race テスト。maybe_patch_boundary_to_session_id
  # は record_session_pointer の直後に発火し、AgentStates.pending_boundary_patch
  # に stash が無ければ noop (通常 envelope の hot path に影響最小)。
  describe "session_boundary の to_session_id 後追い patch (17-11)" do
    test "pending stash 有りの envelope 到達で marker の to_session_id が確定する" do
      agent_id = "test.patch-1"
      socket = join_wrapper(agent_id)

      # AgentStates entry を先に作る (join 経路で通常できる、明示的に put)。
      idle_env = envelope(agent_id, "idle")
      ref0 = push(socket, "envelope", idle_env)
      assert_reply ref0, :ok

      # marker を stash 付き (to_session_id nil) で追加。SessionResets
      # 経由でなく直接 AgentStates を叩いてラボ環境を再現。
      marker =
        Map.merge(idle_env, %{
          "type" => "session_boundary",
          "state" => "idle",
          "payload" => %{
            "mode" => "new",
            "request_id" => "rs_patch_1",
            "to_session_id" => nil
          }
        })

      assert :ok = KaoiroServer.AgentStates.append_boundary(agent_id, marker)

      # 続く session_id 付き envelope の到達で patch fire。
      env_with_sid =
        envelope(agent_id, "thinking") |> Map.put("session_id", "sess-fresh-1")

      ref = push(socket, "envelope", env_with_sid)
      assert_reply ref, :ok

      history = KaoiroServer.AgentStates.histories()[agent_id]
      [patched_marker] = Enum.filter(history, &(&1["type"] == "session_boundary"))
      assert patched_marker["payload"]["to_session_id"] == "sess-fresh-1"
    end

    test "pending stash 無しの通常 envelope は patch fire しても noop (hot path 無害)" do
      # 15-8 Finding 2 同型穴の phase-17 版: reset が発火する前
      # (SessionResets.append_boundary 未実行) に旧 wrapper の envelope が
      # 到達しても、pending_boundary_patch が nil なので patch は noop
      # で marker を汚さない (order independence)。
      agent_id = "test.patch-noop"
      socket = join_wrapper(agent_id)

      env_with_sid =
        envelope(agent_id, "thinking") |> Map.put("session_id", "sess-normal")

      ref = push(socket, "envelope", env_with_sid)
      assert_reply ref, :ok

      # marker が存在しない → history に session_boundary なし、
      # SessionPointers は通常経路で record 済み。
      history = KaoiroServer.AgentStates.histories()[agent_id]
      assert history == nil or Enum.all?(history, &(&1["type"] != "session_boundary"))
    end
  end

  describe "after_join permission_mode push (#58)" do
    test "永続化された permission_mode を join 直後に push する" do
      agent_id = "test.after-join-perm-1"
      KaoiroServer.PermissionModes.record(agent_id, "plan")
      # Wait for the cast to land before joining so the after_join push reads
      # the value (record is fire-and-forget).
      :ok = wait_until(fn -> KaoiroServer.PermissionModes.get(agent_id) == "plan" end)

      _socket = join_wrapper(agent_id)
      assert_push "set_permission_mode", %{mode: "plan"}
    end

    test "永続値が無ければ join 直後の set_permission_mode は飛ばない" do
      agent_id = "test.after-join-perm-2"
      assert KaoiroServer.PermissionModes.get(agent_id) == nil

      _socket = join_wrapper(agent_id)
      refute_push "set_permission_mode", _
    end

    defp wait_until(predicate, attempts \\ 50) do
      cond do
        predicate.() -> :ok
        attempts <= 0 -> :timeout
        true -> Process.sleep(5) && wait_until(predicate, attempts - 1)
      end
    end
  end

  describe "inter_agent_message ルーティング (protocol-inter-agent, phase-8)" do
    setup do
      # This durable fixture uses a fixed sender id, so remove only its
      # previous entries before and after each test run.
      :ok = InterAgentHistory.delete_agent("test.iam-from")
      on_exit(fn -> InterAgentHistory.delete_agent("test.iam-from") end)
    end

    defp inter_envelope(agent_id, to, opts \\ []) do
      meta =
        opts[:meta] ||
          %{"done" => false, "propose_next" => ""}

      payload = %{
        "to" => to,
        # Unique per call so the supervised ConversationStates (one instance
        # for the whole describe block) cannot leak state between tests via a
        # shared cid — that would surface as a false participants_mismatch.
        "conversation_id" => opts[:cid] || "cnv-#{System.unique_integer([:positive])}",
        "turn_number" => opts[:turn] || 1,
        "kind" => opts[:kind] || "inform",
        "body" => opts[:body] || "hi",
        "meta" => meta,
        "owner" => opts[:owner] || %{"kind" => "user", "id" => "operator"}
      }

      %{
        "version" => "0",
        "agent_id" => agent_id,
        "persona" => %{"id" => "mio", "name" => "澪", "sprite_set" => "mio"},
        "ts" => "2026-06-29T00:00:00Z",
        "type" => "inter_agent_message",
        "state" => "tool_running",
        "payload" => payload,
        "ext" => %{}
      }
    end

    # 受信側エージェント(to)が known? に通るよう、まず state_change を投入して
    # AgentStates に登録しておく。
    defp seed_known(agent_id) do
      socket = join_wrapper(agent_id)
      ref = push(socket, "envelope", envelope(agent_id, "idle"))
      assert_reply ref, :ok
      socket
    end

    test "正常な inter_agent_message を wrapper:<to> へ broadcast し agents:lobby も流す" do
      from_id = "test.iam-from"
      to_id = "test.iam-to"
      _to_socket = seed_known(to_id)
      from_socket = seed_known(from_id)

      @endpoint.subscribe("wrapper:" <> to_id)
      @endpoint.subscribe("agents:lobby")

      env = inter_envelope(from_id, to_id)
      ref = push(from_socket, "envelope", env)
      assert_reply ref, :ok

      assert_broadcast "envelope", ^env
      # ルーティング先(wrapper:<to>)にも同じ envelope が届く。
      assert_received %Phoenix.Socket.Broadcast{
        topic: "wrapper:" <> ^to_id,
        event: "envelope",
        payload: ^env
      }

      # inter_agent_message は state_change ではないので AgentStates の latest
      # 状態(state)を上書きしない。
      assert AgentStates.snapshot()[from_id]["state"] == "idle"
      assert [stored] = AgentStates.histories()[from_id]
      assert stored == env
      assert InterAgentHistory.list_for(from_id) == [env]
    end

    test "自己ルーティングは :self_routing で拒否する" do
      from_id = "test.iam-self"
      from_socket = seed_known(from_id)

      env = inter_envelope(from_id, from_id)
      ref = push(from_socket, "envelope", env)
      assert_reply ref, :error, %{reason: "self_routing"}
    end

    test "未知の to_agent は :unknown_agent で拒否する" do
      from_id = "test.iam-unk-from"
      from_socket = seed_known(from_id)

      env = inter_envelope(from_id, "test.iam-unk-target")
      ref = push(from_socket, "envelope", env)
      assert_reply ref, :error, %{reason: "unknown_agent"}
    end

    test "kind=reject で reject_reason 欠落の envelope を拒否する" do
      from_id = "test.iam-reject"
      to_id = "test.iam-reject-to"
      _ = seed_known(to_id)
      from_socket = seed_known(from_id)

      env =
        inter_envelope(from_id, to_id,
          kind: "reject",
          meta: %{"done" => false, "propose_next" => ""}
        )

      ref = push(from_socket, "envelope", env)
      assert_reply ref, :error, %{reason: "invalid value: payload.meta"}
    end

    test "kind=reject で reject_reason ありなら通す" do
      from_id = "test.iam-reject-ok"
      to_id = "test.iam-reject-ok-to"
      _ = seed_known(to_id)
      from_socket = seed_known(from_id)

      env =
        inter_envelope(from_id, to_id,
          kind: "reject",
          meta: %{
            "done" => false,
            "propose_next" => "",
            "reject_reason" => "ベンチ未収束"
          }
        )

      ref = push(from_socket, "envelope", env)
      assert_reply ref, :ok
    end

    test "未知の kind 値を拒否する" do
      from_id = "test.iam-badkind"
      to_id = "test.iam-badkind-to"
      _ = seed_known(to_id)
      from_socket = seed_known(from_id)

      env = inter_envelope(from_id, to_id, kind: "shout")
      ref = push(from_socket, "envelope", env)
      assert_reply ref, :error, %{reason: "invalid value: payload.kind"}
    end

    test "ConversationStates が :exceeded を返したら side ごとに正しい payload.to で escalate を流す" do
      # default max_turns=20 を待たずに、テスト専用の conversation_id を直接
      # ConversationStates へ過去ターン分仕込んでおき、20 ターン状態の続きから
      # 21 通目を送ることで :exceeded を再現する。
      from_id = "test.iam-quota-from"
      to_id = "test.iam-quota-to"
      cid = "cnv-quota-#{System.unique_integer([:positive])}"
      _ = seed_known(to_id)
      from_socket = seed_known(from_id)

      @endpoint.subscribe("wrapper:" <> from_id)
      @endpoint.subscribe("wrapper:" <> to_id)

      # 既定 max_turns=20 まで埋める (done=false で push)
      for n <- 1..20 do
        :ok =
          KaoiroServer.ConversationStates.record_message(
            cid,
            from_id,
            to_id,
            "msg-#{n}",
            false
          )
      end

      # 21 通目で max_turns 超過 → 合成 escalate が両側に届く。
      env = inter_envelope(from_id, to_id, cid: cid, turn: 21)
      ref = push(from_socket, "envelope", env)
      assert_reply ref, :ok

      # 合成 escalate は side ごとに payload.to がその recipient を指す。
      assert_received %Phoenix.Socket.Broadcast{
        topic: "wrapper:" <> ^from_id,
        event: "envelope",
        payload: %{
          "agent_id" => "server",
          "type" => "inter_agent_message",
          "payload" => %{
            "kind" => "escalate-to-user",
            "to" => ^from_id,
            "conversation_id" => ^cid
          }
        }
      }

      assert_received %Phoenix.Socket.Broadcast{
        topic: "wrapper:" <> ^to_id,
        event: "envelope",
        payload: %{
          "agent_id" => "server",
          "payload" => %{
            "kind" => "escalate-to-user",
            "to" => ^to_id
          }
        }
      }
    end

    test "片側のみ done=true ではエントリは閉じない (両 owner-side 同意要件)" do
      from_id = "test.iam-onedone-a"
      to_id = "test.iam-onedone-b"
      cid = "cnv-onedone-#{System.unique_integer([:positive])}"
      _ = seed_known(to_id)
      from_socket = seed_known(from_id)

      meta_done = %{"done" => true, "propose_next" => ""}
      env = inter_envelope(from_id, to_id, cid: cid, meta: meta_done)
      ref = push(from_socket, "envelope", env)
      assert_reply ref, :ok

      # done_by に from のみ。エントリは残存。
      assert %{done_by: done_by} =
               KaoiroServer.ConversationStates.get(cid)

      assert MapSet.equal?(done_by, MapSet.new([from_id]))
    end

    test "第三者が既存 cid を流用すると participants_mismatch エラーで拒否" do
      a_id = "test.iam-poll-a"
      b_id = "test.iam-poll-b"
      c_id = "test.iam-poll-c"
      cid = "cnv-poll-#{System.unique_integer([:positive])}"
      _ = seed_known(b_id)
      a_socket = seed_known(a_id)
      c_socket = seed_known(c_id)

      # a→b で正規エントリを確立
      env_ab = inter_envelope(a_id, b_id, cid: cid)
      ref = push(a_socket, "envelope", env_ab)
      assert_reply ref, :ok

      # c が同じ cid を流用 → 拒否
      env_cb = inter_envelope(c_id, b_id, cid: cid)
      ref = push(c_socket, "envelope", env_cb)
      assert_reply ref, :error, %{reason: "participants_mismatch"}

      # 正規エントリは無傷
      assert %{turns: 1} = KaoiroServer.ConversationStates.get(cid)
    end
  end

  describe "directory_request (protocol-inter-agent コンパニオンツール)" do
    test "自分以外の agent を返し未stamp optional fieldは省略する" do
      self_id = "test.dir-self"
      peer_id = "test.dir-peer"

      # peer を先に登録 (seed_known と同じ要領で state_change を流す)
      peer_socket = join_wrapper(peer_id)

      peer_env =
        envelope(peer_id, "thinking")
        |> Map.put("persona", %{
          "id" => "ao",
          "name" => "あお",
          "sprite_set" => "ao"
        })

      ref = push(peer_socket, "envelope", peer_env)
      assert_reply ref, :ok

      self_socket = join_wrapper(self_id)
      ref = push(self_socket, "envelope", envelope(self_id, "idle"))
      assert_reply ref, :ok

      ref = push(self_socket, "directory_request", %{})

      assert_reply ref, :ok, %{"agents" => agents}
      assert is_list(agents)

      # 自分を除外して peer のみが返る
      assert Enum.any?(agents, fn a ->
               a["agent_id"] == peer_id and
                 a["persona"]["name"] == "あお" and
                 a["state"] == "thinking" and
                 not Map.has_key?(a, "engine") and
                 not Map.has_key?(a, "model") and
                 not Map.has_key?(a, "effort")
             end)

      refute Enum.any?(agents, fn a -> a["agent_id"] == self_id end)
    end

    test "他 agent が居ない場合は空リストで応答" do
      socket = join_wrapper("test.dir-lonely")
      ref = push(socket, "envelope", envelope("test.dir-lonely", "idle"))
      assert_reply ref, :ok

      ref = push(socket, "directory_request", %{})
      assert_reply ref, :ok, %{"agents" => agents}

      refute Enum.any?(agents, fn a -> a["agent_id"] == "test.dir-lonely" end)
    end

    test "engine/model/effortだけをextから公開しoperator-grade fieldは除外する" do
      peer_id = "test.dir-strip-peer"
      peer_socket = join_wrapper(peer_id)

      env =
        envelope(peer_id, "tool_running")
        |> Map.put("persona", %{
          "id" => "kuroe",
          "name" => "クロエ",
          "sprite_set" => "kuroe"
        })
        |> Map.put("ext", %{
          "engine" => "claude-code",
          "model" => "claude-opus",
          "effort" => "high",
          "model_source" => "config",
          "session_capabilities" => %{"supports_attachments" => true},
          "cwd" => "/secret/path"
        })

      ref = push(peer_socket, "envelope", env)
      assert_reply ref, :ok

      self_socket = join_wrapper("test.dir-strip-self")
      ref = push(self_socket, "envelope", envelope("test.dir-strip-self", "idle"))
      assert_reply ref, :ok

      ref = push(self_socket, "directory_request", %{})
      assert_reply ref, :ok, %{"agents" => agents}

      entry = Enum.find(agents, fn a -> a["agent_id"] == peer_id end)

      assert entry["persona"] == %{
               "id" => "kuroe",
               "name" => "クロエ",
               "sprite_set" => "kuroe"
             }

      assert Map.take(entry, ["engine", "model", "effort"]) == %{
               "engine" => "claude-code",
               "model" => "claude-opus",
               "effort" => "high"
             }

      # #102の3 field以外のoperator-grade情報は引き続き含まれない。
      refute Map.has_key?(entry, "ext")
      refute Map.has_key?(entry, "cwd")
      refute Map.has_key?(entry, "model_source")
      refute Map.has_key?(entry, "session_capabilities")
    end

    test "malformed optional fieldはentryを落とさずfieldだけ省略する" do
      peer_id = "test.dir-malformed-peer"
      peer_socket = join_wrapper(peer_id)

      env =
        envelope(peer_id, "idle")
        |> Map.put("ext", %{"engine" => 1, "model" => "", "effort" => ["high"]})

      ref = push(peer_socket, "envelope", env)
      assert_reply ref, :ok

      self_socket = join_wrapper("test.dir-malformed-self")
      ref = push(self_socket, "envelope", envelope("test.dir-malformed-self", "idle"))
      assert_reply ref, :ok

      ref = push(self_socket, "directory_request", %{})
      assert_reply ref, :ok, %{"agents" => agents}

      entry = Enum.find(agents, fn a -> a["agent_id"] == peer_id end)
      assert entry["state"] == "idle"
      refute Map.has_key?(entry, "engine")
      refute Map.has_key?(entry, "model")
      refute Map.has_key?(entry, "effort")
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
