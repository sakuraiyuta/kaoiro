defmodule KaoiroServerWeb.WrapperChannelTest do
  use KaoiroServerWeb.ChannelCase, async: false

  alias KaoiroServer.AgentStates
  alias KaoiroServer.SessionPointers

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
    test "自分以外の agent を {agent_id, persona, state} で返す" do
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
                 a["state"] == "thinking"
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

    test "persona フィールドは id/name/sprite_set のみで cwd 等を含まない" do
      peer_id = "test.dir-strip-peer"
      peer_socket = join_wrapper(peer_id)

      env =
        envelope(peer_id, "tool_running")
        |> Map.put("persona", %{
          "id" => "kuroe",
          "name" => "クロエ",
          "sprite_set" => "kuroe"
        })
        |> Map.put("ext", %{"cwd" => "/secret/path", "model" => "claude"})

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

      # cwd や model のような operator-grade フィールドは含まれない
      refute Map.has_key?(entry, "ext")
      refute Map.has_key?(entry, "cwd")
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
