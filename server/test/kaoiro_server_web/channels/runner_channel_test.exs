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

    test "capabilities 旧値 claude は claude-code に正規化、engines は保持 (ADR-0032 F4a/F4bc)" do
      host_id = "lab-pc-engines"
      socket = join_runner(host_id)

      engines = [
        %{"id" => "claude-code", "models" => []},
        %{
          "id" => "codex",
          "models" => [%{"value" => "gpt-5.6-sol", "display_name" => "GPT-5.6 Sol"}]
        }
      ]

      ref =
        push(
          socket,
          "register",
          register_payload(%{"capabilities" => ["claude", "codex"], "engines" => engines})
        )

      assert_reply ref, :ok
      entry = HostRegistry.get(host_id)
      assert entry.capabilities == ["claude-code", "codex"]
      assert entry.engines == engines
    end

    test "engines の型崩れは invalid_register" do
      host_id = "lab-pc-bad-engines"
      socket = join_runner(host_id)

      ref =
        push(
          socket,
          "register",
          register_payload(%{"engines" => [%{"id" => 1}]})
        )

      assert_reply ref, :error, %{reason: "invalid_engines"}
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

    test "spawn_result の host spoof と malformed shape は ack するが転送も mutation もしない" do
      @endpoint.subscribe("agents:lobby")
      socket = join_runner("lab-pc-spawn-guard")

      ref =
        push(socket, "spawn_result", %{
          "agent_id" => "other-host.a",
          "ok" => false,
          "request_id" => "stale"
        })

      assert_reply ref, :ok
      refute_broadcast "spawn_result", _

      ref = push(socket, "spawn_result", %{"agent_id" => "lab-pc-spawn-guard.a", "ok" => "false"})
      assert_reply ref, :ok
      refute_broadcast "spawn_result", _
    end

    test "spawn_result ok=true は matching request_id でも Activity を activate しない" do
      host_id = "lab-pc-spawn-ok"
      agent_id = host_id <> ".a"

      :ok =
        KaoiroServer.AgentActivity.begin_transition(
          agent_id,
          "p1",
          :spawn,
          "2026-07-28T00:00:00Z"
        )

      socket = join_runner(host_id)

      ref =
        push(socket, "spawn_result", %{"agent_id" => agent_id, "ok" => true, "request_id" => "p1"})

      assert_reply ref, :ok
      # A following matching join is still the only activation signal.
      assert :activated = KaoiroServer.AgentActivity.activate_or_rebind(agent_id, self(), "p1")
    end

    test "catalog_result は host_id を付与して agents:lobby へ転送する (Option E, ADR-0039)" do
      host_id = "lab-pc-catalog"
      @endpoint.subscribe("agents:lobby")
      socket = join_runner(host_id)

      ref =
        push(socket, "catalog_result", %{
          "engine" => "claude-code",
          "request_id" => "req-cat-1",
          "ok" => true,
          "models_count" => 6
        })

      assert_reply ref, :ok

      assert_broadcast "catalog_result", %{
        "host_id" => ^host_id,
        "engine" => "claude-code",
        "request_id" => "req-cat-1",
        "ok" => true,
        "models_count" => 6
      }
    end
  end

  # phase-17 chunk β (17-4): session_reset_result relay through
  # SessionResets.resolve/6 → agents:lobby broadcasts.
  describe "session_reset_result (ADR-0036 F7, phase-17 17-4)" do
    defp acquire_reset_lock(agent_id, prev_sid) do
      # Seed AgentStates so the channel-side path is consistent even
      # though we bypass agents_channel here; the SessionResets store
      # decides on its own.
      :ok =
        KaoiroServer.AgentStates.put(%{
          "version" => "0",
          "agent_id" => agent_id,
          "ts" => "2026-07-12T00:00:00Z",
          "type" => "state_change",
          "state" => "idle",
          "session_id" => prev_sid
        })

      {:ok, request_id, _} =
        KaoiroServer.SessionResets.check_and_acquire(
          agent_id,
          "new",
          "idle",
          prev_sid
        )

      request_id
    end

    test "ok=true は :awaiting_connect に移行 (completed broadcast はまだ、confirm_connection で発火)" do
      # ADR-0036 F2 two-phase: runner ok=true は spawn 成功の中間報告。
      # completed は fresh wrapper の channel join (confirm_connection) で発火。
      host_id = "lab-pc-reset-ok"
      agent_id = "lab-pc-reset-ok.a"
      request_id = acquire_reset_lock(agent_id, "sess-old")

      @endpoint.subscribe("agents:lobby")
      socket = join_runner(host_id)

      ref =
        push(socket, "session_reset_result", %{
          "agent_id" => agent_id,
          "request_id" => request_id,
          "mode" => "new",
          "ok" => true,
          "to_session_id" => "sess-new"
        })

      assert_reply ref, :ok

      # completed broadcast は未発火 (lock は :awaiting_connect のまま)。
      refute_broadcast "session_reset_completed", _

      assert KaoiroServer.SessionResets.pending?(agent_id)

      # confirm_connection (wrapper join 相当) で completed 発火。
      # Claude 側で init が到達した後の session_id を明示的に渡す想定。
      :legacy_absent = KaoiroServer.SessionResets.confirm_connection(agent_id, "sess-new-init")

      assert_broadcast "session_reset_completed", %{
        "agent_id" => ^agent_id,
        "mode" => "new",
        "request_id" => ^request_id,
        "previous_session_id" => "sess-old",
        "to_session_id" => "sess-new-init"
      }

      refute KaoiroServer.SessionResets.pending?(agent_id)
      _ = KaoiroServer.SessionResets.delete(agent_id)
    end

    test "ok=true + to_session_id=nil (Codex lazy 採番) は confirm 時 nil のまま completed" do
      # runner が nil で報告 → 次の confirm_connection で joining session_id
      # が渡らなければ lock 側 (nil) がそのまま completed に載る。Codex の
      # lazy 採番はこの経路: init state_change には thread ID なし、後の
      # envelope で session_id が確定して SessionPointers.record 経由で patch。
      host_id = "lab-pc-reset-lazy"
      agent_id = "lab-pc-reset-lazy.a"
      request_id = acquire_reset_lock(agent_id, "sess-old-codex")

      @endpoint.subscribe("agents:lobby")
      socket = join_runner(host_id)

      ref =
        push(socket, "session_reset_result", %{
          "agent_id" => agent_id,
          "request_id" => request_id,
          "mode" => "new",
          "ok" => true,
          "to_session_id" => nil
        })

      assert_reply ref, :ok
      refute_broadcast "session_reset_completed", _

      :legacy_absent = KaoiroServer.SessionResets.confirm_connection(agent_id, nil)

      assert_broadcast "session_reset_completed",
                       %{"agent_id" => ^agent_id, "to_session_id" => nil}

      _ = KaoiroServer.SessionResets.delete(agent_id)
    end

    test "ok=false + closed vocab reason は failed broadcast" do
      host_id = "lab-pc-reset-fail"
      agent_id = "lab-pc-reset-fail.a"
      request_id = acquire_reset_lock(agent_id, "sess-old-fail")

      @endpoint.subscribe("agents:lobby")
      socket = join_runner(host_id)

      ref =
        push(socket, "session_reset_result", %{
          "agent_id" => agent_id,
          "request_id" => request_id,
          "mode" => "new",
          "ok" => false,
          "reason" => "spawn_failed"
        })

      assert_reply ref, :ok

      assert_broadcast "session_reset_failed", %{
        "agent_id" => ^agent_id,
        "mode" => "new",
        "request_id" => ^request_id,
        "reason" => "spawn_failed"
      }

      refute KaoiroServer.SessionResets.pending?(agent_id)
      _ = KaoiroServer.SessionResets.delete(agent_id)
    end

    test "unknown vocab reason は invalid_reason" do
      host_id = "lab-pc-reset-badreason"
      socket = join_runner(host_id)

      ref =
        push(socket, "session_reset_result", %{
          "agent_id" => "a.x",
          "request_id" => "rs_x",
          "ok" => false,
          "reason" => "not-in-vocab"
        })

      assert_reply ref, :error, %{reason: "invalid_reason"}
    end

    test "malformed payload は invalid_payload" do
      host_id = "lab-pc-reset-malformed"
      socket = join_runner(host_id)

      ref = push(socket, "session_reset_result", %{"agent_id" => "a.x"})
      assert_reply ref, :error, %{reason: "invalid_payload"}
    end

    test "他 host の agent_id を name-spoof した result は agent_not_owned で reject" do
      # ADR-0024 D3 の host binding: agent_id は "<host_id>.<rand>" 形式で
      # allocation されるので、他 host が echo した agent_id は SessionResets
      # の副作用 (lock release + detach) に到達させない。
      host_id = "lab-pc-reset-crosshost"
      socket = join_runner(host_id)

      ref =
        push(socket, "session_reset_result", %{
          "agent_id" => "lab-pc-other-host.a",
          "request_id" => "rs_x",
          "mode" => "new",
          "ok" => true,
          "to_session_id" => "sess"
        })

      assert_reply ref, :error, %{reason: "agent_not_owned"}
    end

    test "nested-prefix spoof (host_id が . 含み) も agent_not_owned で reject" do
      # host_id / agent_id は同 charset ([A-Za-z0-9._-]) で dot を含める。
      # 正当な allocation は agent_id="alpha.beta.<rand>" → true owner
      # "alpha.beta"。runner が host_id="alpha" で認証を通していても
      # このペアを spoof すべきでない (単純な starts_with? だと通ってしまう)。
      # AgentId.host_id_from/1 の逆演算で防ぐ regression。
      socket = join_runner("alpha")

      ref =
        push(socket, "session_reset_result", %{
          "agent_id" => "alpha.beta.xyz",
          "request_id" => "rs_nest",
          "mode" => "new",
          "ok" => true,
          "to_session_id" => "sess"
        })

      assert_reply ref, :error, %{reason: "agent_not_owned"}
    end

    test "stale request_id は silent drop (broadcast なし)" do
      host_id = "lab-pc-reset-stale"
      agent_id = "lab-pc-reset-stale.a"
      _real_rid = acquire_reset_lock(agent_id, "sess")

      @endpoint.subscribe("agents:lobby")
      socket = join_runner(host_id)

      ref =
        push(socket, "session_reset_result", %{
          "agent_id" => agent_id,
          "request_id" => "rs_ghost",
          "mode" => "new",
          "ok" => true,
          "to_session_id" => "sess-new"
        })

      assert_reply ref, :ok

      refute_broadcast "session_reset_completed", _
      refute_broadcast "session_reset_failed", _

      _ = KaoiroServer.SessionResets.delete(agent_id)
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
