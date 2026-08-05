defmodule KaoiroServer.OAuthAllowlistWatcherTest do
  # Mutates :oauth_allowlist_path and the shared :persistent_term
  # checkpoint (issue #170) — both process-independent global state.
  use ExUnit.Case, async: false

  import KaoiroServer.OAuthAllowlistFixture

  alias KaoiroServer.Auth
  alias KaoiroServer.OAuthAllowlistWatcher

  @checkpoint_key {OAuthAllowlistWatcher, :checkpoint}

  setup do
    Application.delete_env(:kaoiro_server, :oauth_allowlist_path)
    :persistent_term.erase(@checkpoint_key)

    on_exit(fn ->
      Application.delete_env(:kaoiro_server, :oauth_allowlist_path)
      :persistent_term.erase(@checkpoint_key)
    end)

    :ok
  end

  # Fast timers by default so the suite does not pay @debounce_ms /
  # @reconcile_interval_ms's production values (300ms / 5s) per test.
  # Individual tests override these when the value under test IS the
  # timing itself.
  #
  # start_supervised! (not a raw start_link) so ExUnit stops every
  # watcher — and, transitively via terminate/2, its linked FileSystem
  # worker — BEFORE this test's on_exit callbacks run (ふじ must-fix
  # 2c, 2026-08-05): without that ordering guarantee, on_exit's
  # :persistent_term.erase can race a still-running watcher's own
  # reconcile re-putting the checkpoint.
  defp start_watcher(opts) do
    opts = Keyword.merge([debounce_ms: 20, reconcile_interval_ms: 300], opts)
    id = make_ref()

    start_supervised!(%{
      id: id,
      start: {OAuthAllowlistWatcher, :start_link, [opts]},
      # :temporary — several tests stop a watcher explicitly mid-test
      # (crash-surviving-checkpoint, broadcast-failure retry); a
      # :permanent (default) child spec would race that manual stop
      # with ExUnit's supervisor auto-restarting it.
      restart: :temporary
    })
  end

  defp subscribe(provider, identifier) do
    socket_id = Auth.oauth_socket_id(provider, identifier)
    KaoiroServerWeb.Endpoint.subscribe(socket_id)
    socket_id
  end

  # Exercises the SAME handle_info clause a real file_system event would
  # (issue #170 must-fix 1's debounce logic), without depending on an
  # actual inotify/FSEvents backend being available in the test
  # environment — `state.watcher` is whatever start_watching/1 resolved
  # (a real fs pid, or nil if the backend didn't start), and the pattern
  # match in handle_info only requires this message's 2nd element to
  # equal it, so this reaches the exact same code path either way.
  defp send_synthetic_event(pid, path) do
    %{watcher: watcher} = :sys.get_state(pid)
    send(pid, {:file_event, watcher, {path, [:modified]}})
  end

  describe "diff -> targeted disconnect" do
    test "operator -> viewer / 削除 / viewer -> operator が対象 identity topic だけを disconnect する" do
      path =
        put_allowlist("""
        github:ao:operator
        google:demoted-target@example.com:operator
        google:bystander@example.com:viewer
        nextcloud:removed-uid:viewer
        github:promoted-target:viewer
        """)

      demoted = subscribe("google", "demoted-target@example.com")
      bystander = subscribe("google", "bystander@example.com")
      removed = subscribe("nextcloud", "removed-uid")
      unchanged = subscribe("github", "ao")
      # ふじ must-fix 2a (2026-08-05): the old code named this variable
      # "promoted" but old/new both held :operator for it — no promotion
      # was ever exercised. This identity now genuinely goes
      # viewer -> operator below, so the promotion branch of
      # changed_keys/2 (and its resulting disconnect) is actually pinned.
      promoted = subscribe("github", "promoted-target")

      pid = start_watcher(path: path)
      # First boot: seed only, no live socket could exist yet either way.
      refute_receive %Phoenix.Socket.Broadcast{event: "disconnect"}, 50

      File.write!(path, """
      github:ao:operator
      google:demoted-target@example.com:viewer
      google:bystander@example.com:viewer
      github:promoted-target:operator
      """)

      send_synthetic_event(pid, path)

      assert_receive %Phoenix.Socket.Broadcast{event: "disconnect", topic: ^demoted}
      assert_receive %Phoenix.Socket.Broadcast{event: "disconnect", topic: ^removed}
      assert_receive %Phoenix.Socket.Broadcast{event: "disconnect", topic: ^promoted}
      refute_received %Phoenix.Socket.Broadcast{event: "disconnect", topic: ^bystander}
      refute_received %Phoenix.Socket.Broadcast{event: "disconnect", topic: ^unchanged}
    end

    test "同 role・コメント・空白だけの変更は disconnect しない" do
      path = put_allowlist("github:ao:operator\n# comment\n\n")
      target = subscribe("github", "ao")

      pid = start_watcher(path: path)
      refute_receive %Phoenix.Socket.Broadcast{event: "disconnect"}, 50

      File.write!(path, "github:ao:operator\n\n# comment changed\n\n\n")
      send_synthetic_event(pid, path)

      refute_receive %Phoenix.Socket.Broadcast{event: "disconnect", topic: ^target}, 100
    end

    test "Google は lower-case、GitHub/Nextcloud は大小区別で socket id と一致する" do
      path =
        put_allowlist("""
        google:Mixed-Case@Example.com:operator
        github:CaseSensitive:operator
        nextcloud:CaseSensitiveUid:operator
        """)

      # role_for/2 と同じ normalize を経由した identifier で計算した
      # socket_id — 大文字のまま計算した socket_id とは別物になる。
      google_target = subscribe("google", "mixed-case@example.com")
      github_target = subscribe("github", "CaseSensitive")
      nextcloud_target = subscribe("nextcloud", "CaseSensitiveUid")

      pid = start_watcher(path: path)
      refute_receive %Phoenix.Socket.Broadcast{event: "disconnect"}, 50

      File.write!(path, """
      google:Mixed-Case@Example.com:viewer
      github:CaseSensitive:viewer
      nextcloud:CaseSensitiveUid:viewer
      """)

      send_synthetic_event(pid, path)

      assert_receive %Phoenix.Socket.Broadcast{event: "disconnect", topic: ^google_target}
      assert_receive %Phoenix.Socket.Broadcast{event: "disconnect", topic: ^github_target}
      assert_receive %Phoenix.Socket.Broadcast{event: "disconnect", topic: ^nextcloud_target}
    end

    test "shared-token の socket id は対象にならない" do
      path = put_allowlist("github:ao:operator\n")
      token_socket_id = Auth.socket_id("some-shared-token")
      KaoiroServerWeb.Endpoint.subscribe(token_socket_id)

      pid = start_watcher(path: path)
      File.write!(path, "github:ao:viewer\n")
      send_synthetic_event(pid, path)

      refute_receive %Phoenix.Socket.Broadcast{event: "disconnect", topic: ^token_socket_id}, 100
    end
  end

  describe "crash-surviving checkpoint (懸念 A)" do
    test "watcher 停止中の file 変更を、同 BEAM 内の再起動時に retained checkpoint から検知する" do
      path = put_allowlist("github:ao:operator\n")
      socket_id = subscribe("github", "ao")

      pid = start_watcher(path: path)
      refute_receive %Phoenix.Socket.Broadcast{event: "disconnect"}, 50

      ref = Process.monitor(pid)
      GenServer.stop(pid)
      assert_receive {:DOWN, ^ref, :process, ^pid, :normal}

      File.write!(path, "github:ao:viewer\n")

      # 同 BEAM 内での再起動(supervisor restart 相当) — :persistent_term
      # の checkpoint は pid の生死と無関係に残っている。
      _pid2 = start_watcher(path: path)

      assert_receive %Phoenix.Socket.Broadcast{event: "disconnect", topic: ^socket_id}
    end
  end

  describe "FileSystem worker cleanup (must-fix 1)" do
    test "graceful stop で紐づく FileSystem worker も一緒に停止する(孤児化しない)" do
      path = put_allowlist("github:ao:operator\n")
      pid = start_watcher(path: path)

      %{watcher: fs_pid} = :sys.get_state(pid)
      assert is_pid(fs_pid)
      assert Process.alive?(fs_pid)

      ref = Process.monitor(pid)
      GenServer.stop(pid)
      assert_receive {:DOWN, ^ref, :process, ^pid, :normal}

      refute Process.alive?(fs_pid)
    end

    test "file_system backend の :stop 通知経路でも worker が孤児化しない" do
      path = put_allowlist("github:ao:operator\n")
      pid = start_watcher(path: path)

      %{watcher: fs_pid} = :sys.get_state(pid)
      assert is_pid(fs_pid)

      ref = Process.monitor(pid)
      send(pid, {:file_event, fs_pid, :stop})
      assert_receive {:DOWN, ^ref, :process, ^pid, :normal}

      refute Process.alive?(fs_pid)
    end
  end

  describe "periodic reconcile backstop (must-fix 1)" do
    test "event が一切無くても periodic reconcile だけで bounded time 内に disconnect する" do
      path = put_allowlist("github:ao:operator\n")
      socket_id = subscribe("github", "ao")

      start_watcher(path: path, reconcile_interval_ms: 50)
      refute_receive %Phoenix.Socket.Broadcast{event: "disconnect"}, 30

      File.write!(path, "github:ao:viewer\n")

      assert_receive %Phoenix.Socket.Broadcast{event: "disconnect", topic: ^socket_id}, 500
    end

    test "許可リストの親 dir が起動時に無くても :ignore にならず poll-only で生存する" do
      missing_dir =
        Path.join(
          System.tmp_dir!(),
          "kaoiro-oauth-watcher-missing-#{System.unique_integer([:positive])}"
        )

      path = Path.join(missing_dir, "allowlist")
      refute File.exists?(missing_dir)
      on_exit(fn -> File.rm_rf(missing_dir) end)

      pid = start_watcher(path: path, reconcile_interval_ms: 50)
      assert Process.alive?(pid)

      # dir が後から現れても :ignore していないので poll だけで拾える。
      # init/1 は dir の有無に関わらず reconcile_now/1 を無条件に一度実行
      # する(start_watching/1 が左右するのは file_system backend を
      # 起動するかどうかだけ)。つまり checkpoint は start_watcher/1 が
      # 返る時点で既に %{} へ seed 済み — 以下の最初の書き込みだけで
      # 既に real diff になり、2 回目の書き込みを待たず disconnect
      # しうる。assert_receive はどちらの disconnect が先に届いても
      # 一致するのでテストとしては両方とも成立する。
      File.mkdir_p!(missing_dir)
      socket_id = subscribe("github", "ao")
      File.write!(path, "github:ao:operator\n")
      Process.sleep(80)
      File.write!(path, "github:ao:viewer\n")

      assert_receive %Phoenix.Socket.Broadcast{event: "disconnect", topic: ^socket_id}, 500
    end
  end

  describe "bounded debounce, no starvation (must-fix 1)" do
    # ふじ must-fix 2b (2026-08-05): the previous version of this test
    # asserted an elapsed-time bound (a fixed debounce_ms plus a wall-clock
    # margin) instead of the state contract itself, leaving only ~20ms of
    # slack for scheduler/CI jitter -- a real flake risk that happened to
    # also catch the mutation, not a test that reliably catches only the
    # mutation. This version observes `state.event_pending`'s TIMER
    # REFERENCE directly: debounce_ms is set far longer than the test can
    # run, so the timer never actually fires, and the assertion is a pure
    # state comparison with zero timing dependency. A trailing-edge
    # cancel+reschedule mutation replaces the reference on every event;
    # the bounded (first-event-wins) implementation never does.
    test "連続する event でも最初の event の debounce timer を再スケジュールしない" do
      path = put_allowlist("github:ao:operator\n")
      _socket_id = subscribe("github", "ao")

      pid = start_watcher(path: path, debounce_ms: 60_000, reconcile_interval_ms: 60_000)
      File.write!(path, "github:ao:viewer\n")

      send_synthetic_event(pid, path)
      %{event_pending: first_ref} = :sys.get_state(pid)
      assert is_reference(first_ref)

      for _ <- 1..5 do
        send_synthetic_event(pid, path)
        assert %{event_pending: ^first_ref} = :sys.get_state(pid)
      end
    end
  end

  describe "fail-closed on a broken allow-list (懸念 B)" do
    test "unreadable な許可リストは空として扱われ、旧 operator を disconnect する (LKG 維持なし)" do
      path = put_allowlist("github:ao:operator\n")
      socket_id = subscribe("github", "ao")

      pid = start_watcher(path: path)
      refute_receive %Phoenix.Socket.Broadcast{event: "disconnect"}, 50

      File.rm!(path)
      send(pid, :periodic_reconcile)

      assert_receive %Phoenix.Socket.Broadcast{event: "disconnect", topic: ^socket_id}

      # 同一内容で復旧しても LKG からの黙示復元はせず、nil -> role の
      # addition diff として再度 disconnect する。
      File.write!(path, "github:ao:operator\n")
      send(pid, :periodic_reconcile)

      assert_receive %Phoenix.Socket.Broadcast{event: "disconnect", topic: ^socket_id}
    end

    # should-fix (ふじ 2026-08-05): the unreadable-file case above covers
    # a fully-empty snapshot; this covers a PARTIALLY malformed file —
    # some lines still parse, others don't — pinning that
    # OAuthAllowlist.snapshot/1's per-line skip (not an all-or-nothing
    # file-level failure) is what the watcher's diff actually sees.
    test "一部の行だけ malformed な許可リストは、有効な行は維持し欠落した行だけ disconnect する" do
      path = put_allowlist("github:ao:operator\ngoogle:kept@example.com:viewer\n")
      kept = subscribe("google", "kept@example.com")
      dropped = subscribe("github", "ao")

      pid = start_watcher(path: path)
      refute_receive %Phoenix.Socket.Broadcast{event: "disconnect"}, 50

      # 1 行目 (github:ao:operator) を role フィールドが未知語の malformed
      # 行にする(2 フィールドの `provider:identifier` は role 省略= viewer
      # として有効にパースされてしまうため、malformed にするには role
      # フィールドそのものを不正な値にする必要がある)。2 行目
      # (google:kept) は valid のまま。
      File.write!(path, "github:ao:not-a-real-role\ngoogle:kept@example.com:viewer\n")
      send(pid, :periodic_reconcile)

      assert_receive %Phoenix.Socket.Broadcast{event: "disconnect", topic: ^dropped}
      refute_received %Phoenix.Socket.Broadcast{event: "disconnect", topic: ^kept}
    end
  end

  describe "broadcast 失敗時は checkpoint を進めない (懸念 A の順序保証)" do
    test "broadcast が失敗すると checkpoint は旧のまま残り、次の reconcile で同じ diff を再送する" do
      path = put_allowlist("github:ao:operator\n")
      socket_id = subscribe("github", "ao")

      test_pid = self()

      failing_once = fn topic, _event, _payload ->
        send(test_pid, {:broadcast_attempt, topic})
        {:error, :simulated_failure}
      end

      pid = start_watcher(path: path, broadcast: failing_once)
      refute_receive %Phoenix.Socket.Broadcast{event: "disconnect"}, 50

      File.write!(path, "github:ao:viewer\n")
      send(pid, :periodic_reconcile)

      assert_receive {:broadcast_attempt, ^socket_id}
      # The stub never calls the real Endpoint, so no disconnect lands —
      # confirms the broadcast path was actually exercised (not skipped).
      refute_receive %Phoenix.Socket.Broadcast{event: "disconnect"}, 50

      # Swap in a working broadcast for the retry by pointing the SAME
      # checkpoint at a fresh watcher instance using the real Endpoint —
      # the checkpoint must still be the OLD (pre-diff) one, so the
      # retry recomputes and resends the SAME diff.
      :sys.replace_state(pid, fn state ->
        %{state | broadcast: &KaoiroServerWeb.Endpoint.broadcast/3}
      end)

      send(pid, :periodic_reconcile)

      assert_receive %Phoenix.Socket.Broadcast{event: "disconnect", topic: ^socket_id}
    end
  end

  describe "init/1 fallback" do
    test "path 未設定なら :ignore" do
      assert :ignore = OAuthAllowlistWatcher.init([])
    end
  end
end
