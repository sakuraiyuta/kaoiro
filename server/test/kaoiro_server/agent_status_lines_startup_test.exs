defmodule KaoiroServer.AgentStatusLinesStartupTest do
  # What `init/1` does with the files and neighbours it meets: open errors, the
  # single-opener rule, the revoked-id sweep, announcement after a child restart
  # and a failed sync at start (issue 482 design r6 section 3, r7 section 4, r8
  # sections 1, 2 and 4, r9 sections 2 and 3). Each case runs a real store on a
  # real file; only the seams the case is about are injected.
  use ExUnit.Case, async: true

  import ExUnit.CaptureLog

  alias KaoiroServer.AgentStatusLines
  alias KaoiroServer.StatusLinesFixture, as: Fixture
  alias KaoiroServer.TokenDenylist

  defp frozen_clock, do: ~U[2026-10-04 01:02:03Z]

  # Names and a file for a store this case starts itself, with every file the
  # case may leave behind (backups included) removed at teardown.
  defp case_names do
    ctx = Fixture.names()
    on_exit(fn -> Enum.each(Path.wildcard(ctx.path <> "*"), &File.rm/1) end)
    ctx
  end

  defp base(ctx), do: Map.to_list(Map.take(ctx, [:name, :table, :building, :path]))

  defp write_random(path, size \\ 4_096) do
    File.mkdir_p!(Path.dirname(path))
    bytes = :crypto.strong_rand_bytes(size)
    File.write!(path, bytes)
    bytes
  end

  defp backups(path), do: Path.wildcard(path <> ".corrupt-*")

  # `start_link` of a store that is expected to refuse. The exit signal of a
  # stopping init would kill this process unless it traps exits.
  defp refused(ctx, extra \\ []) do
    Process.flag(:trap_exit, true)
    AgentStatusLines.start_link(Fixture.opts(ctx, extra))
  end

  describe "a file that is not a DETS file" do
    test "is moved aside whole and the store starts empty" do
      ctx = case_names()
      original = write_random(ctx.path)

      log =
        capture_log(fn ->
          started = Fixture.start_store(base(ctx) ++ [clock: &frozen_clock/0])
          send(self(), {:started, started})
        end)

      assert_received {:started, started}

      assert [backup] = backups(ctx.path)
      assert File.read!(backup) == original
      assert backup =~ ~r/\.corrupt-20261004T010203Z-\d+$/
      assert log =~ "is not a DETS file"
      assert log =~ backup

      assert {:ok, %{}} = AgentStatusLines.heads(started.table)
      assert {:ok, %{retention: 20, source: :default}} = AgentStatusLines.settings(started.name)
      assert {:ok, %{seq: 1}} = AgentStatusLines.put("a.one", "fresh", started.name)
    end

    test "an empty file is moved aside as well" do
      ctx = case_names()
      File.mkdir_p!(Path.dirname(ctx.path))
      File.write!(ctx.path, "")

      capture_log(fn ->
        Fixture.start_store(base(ctx) ++ [clock: &frozen_clock/0])
      end)

      assert [backup] = backups(ctx.path)
      assert File.read!(backup) == ""
    end

    test "an existing backup is never replaced; the next name is used" do
      ctx = case_names()
      original = write_random(ctx.path)
      {:ok, counter} = Agent.start_link(fn -> [1, 1, 2] end)
      suffix = fn -> Agent.get_and_update(counter, fn [n | rest] -> {n, rest} end) end

      first = "#{ctx.path}.corrupt-20261004T010203Z-1"
      File.write!(first, "an earlier backup")

      capture_log(fn ->
        Fixture.start_store(
          base(ctx) ++
            [clock: &frozen_clock/0, backup_suffix: suffix]
        )
      end)

      assert File.read!(first) == "an earlier backup"
      assert File.read!("#{ctx.path}.corrupt-20261004T010203Z-2") == original
    end

    test "three collisions stop init, and the file is not replaced by a fresh one" do
      ctx = case_names()
      original = write_random(ctx.path)
      for n <- 1..3, do: File.write!("#{ctx.path}.corrupt-20261004T010203Z-#{n}", "backup #{n}")
      {:ok, counter} = Agent.start_link(fn -> 0 end)
      suffix = fn -> Agent.get_and_update(counter, fn n -> {n + 1, n + 1} end) end

      log =
        capture_log(fn ->
          assert {:error, {:status_line_move_aside_failed, {:link, :eexist}}} =
                   refused(ctx, clock: &frozen_clock/0, backup_suffix: suffix)
        end)

      assert File.read!(ctx.path) == original
      assert length(backups(ctx.path)) == 3
      refute log =~ "starting empty"
    end

    test "a link that fails stops init with the file untouched" do
      ctx = case_names()
      original = write_random(ctx.path)

      assert {:error, {:status_line_move_aside_failed, {:link, :eacces}}} =
               refused(ctx, ln_fun: fn _from, _to -> {:error, :eacces} end)

      assert File.read!(ctx.path) == original
      assert backups(ctx.path) == []
    end

    # The backup link exists by now, so nothing is lost; what must not happen is
    # a fresh file replacing the one that could not be removed.
    test "an unlink that fails stops init and opens no fresh file" do
      ctx = case_names()
      original = write_random(ctx.path)

      assert {:error, {:status_line_move_aside_failed, {:unlink, :eacces}}} =
               refused(ctx, clock: &frozen_clock/0, rm_fun: fn _path -> {:error, :eacces} end)

      assert File.read!(ctx.path) == original
      assert [backup] = backups(ctx.path)
      assert File.read!(backup) == original
    end
  end

  describe "every other open error" do
    test "a file of another DETS type stops init and is left as it was" do
      ctx = case_names()
      File.mkdir_p!(Path.dirname(ctx.path))
      probe = :"asl_bag_#{System.unique_integer([:positive])}"
      {:ok, ^probe} = :dets.open_file(probe, file: String.to_charlist(ctx.path), type: :bag)
      :ok = :dets.insert(probe, {:k, 1})
      :ok = :dets.close(probe)
      before = File.read!(ctx.path)

      assert {:error, {:status_line_open_failed, {:type_mismatch, _path}}} = refused(ctx)

      assert File.read!(ctx.path) == before
      assert backups(ctx.path) == []
    end

    test "a file that cannot be read stops init, keeps its bytes and mode, and reads again once fixed" do
      ctx = case_names()
      Fixture.seed(ctx.path, [{{:agent, "a.one"}, [Fixture.entry(1, "kept")]}])
      before = File.read!(ctx.path)
      File.chmod!(ctx.path, 0o000)
      on_exit(fn -> File.chmod(ctx.path, 0o600) end)

      # Root ignores the mode bits, so there is nothing to refuse there; CI runs
      # this as an ordinary user.
      if match?({:error, :eacces}, File.read(ctx.path)) do
        assert {:error, {:status_line_open_failed, {:file_error, _path, :eacces}}} = refused(ctx)

        assert File.stat!(ctx.path).mode |> Bitwise.band(0o777) == 0
        File.chmod!(ctx.path, 0o600)
        assert File.read!(ctx.path) == before
        assert backups(ctx.path) == []

        again = Fixture.start_store(base(ctx))

        assert {:ok, %{entry: %{text: "kept"}}} =
                 AgentStatusLines.read_latest("a.one", again.table)
      end
    end
  end

  describe "the single-opener rule" do
    test "a table that is already open stops init and is left alone" do
      ctx = case_names()
      Fixture.seed(ctx.path, [{{:agent, "a.one"}, [Fixture.entry(1, "kept")]}])
      before = File.read!(ctx.path)
      parent = self()

      helper =
        spawn_link(fn ->
          {:ok, _} = :dets.open_file(ctx.name, file: String.to_charlist(ctx.path), type: :set)
          send(parent, :opened)

          receive do
            :close -> send(parent, {:closed, :dets.close(ctx.name)})
          end
        end)

      assert_receive :opened

      assert {:error, :status_line_table_already_open} = refused(ctx)

      # The helper is still the table's only user: when it closes, the table is
      # gone. A store that had joined it would have kept it alive.
      assert [{{:agent, "a.one"}, [%{text: "kept"}]}] = :dets.lookup(ctx.name, {:agent, "a.one"})
      send(helper, :close)
      assert_receive {:closed, :ok}
      assert :dets.info(ctx.name) == :undefined
      assert File.read!(ctx.path) == before
    end

    # What an operator sees after terminate_child while DETS has not yet
    # processed the old owner's exit, and what clears it.
    test "a supervised restart is refused while the table is held, and succeeds once it is released" do
      ctx = case_names()

      {:ok, sup} =
        Supervisor.start_link(
          [%{id: :store, start: {AgentStatusLines, :start_link, [Fixture.opts(ctx)]}}],
          strategy: :one_for_one
        )

      on_exit(fn -> KaoiroServer.TestTeardown.stop_quietly(sup) end)
      assert {:ok, %{seq: 1}} = AgentStatusLines.put("a.one", "kept", ctx.name)

      :ok = Supervisor.terminate_child(sup, :store)
      Fixture.wait_dets_closed(ctx.name)
      parent = self()

      helper =
        spawn_link(fn ->
          {:ok, _} = :dets.open_file(ctx.name, file: String.to_charlist(ctx.path), type: :set)
          send(parent, :opened)

          receive do
            :close -> :dets.close(ctx.name)
          end
        end)

      assert_receive :opened

      assert {:error, :status_line_table_already_open} = Supervisor.restart_child(sup, :store)
      assert [{{:agent, "a.one"}, [%{text: "kept"}]}] = :dets.lookup(ctx.name, {:agent, "a.one"})

      send(helper, :close)
      Fixture.eventually(fn -> :dets.info(ctx.name) == :undefined end)

      assert {:ok, _pid} = Supervisor.restart_child(sup, :store)
      assert {:ok, %{entry: %{text: "kept"}}} = AgentStatusLines.read_latest("a.one", ctx.table)
    end
  end

  describe "the revoked-id sweep" do
    # Three agents on one file: deleted (revoked, and its purge was refused
    # while the store was dirty), revoked only (it keeps its card), and one that
    # was never revoked. The store never consults AgentDirectory: only the
    # denylist decides.
    defp seed_three(ctx) do
      Fixture.seed(ctx.path, [
        {{:agent, "a.deleted"}, [Fixture.entry(2, "second"), Fixture.entry(1, "first")]},
        {{:agent, "a.revoked"}, [Fixture.entry(1, "revoked only")]},
        {{:agent, "a.kept"}, [Fixture.entry(1, "kept")]}
      ])
    end

    defp heads_of(ctx) do
      {:ok, heads} = AgentStatusLines.heads(ctx.table)
      heads |> Map.keys() |> Enum.sort()
    end

    test "drops revoked and deleted agents from the view and from the file, and keeps the rest" do
      ctx = case_names()
      seed_three(ctx)
      denylist = Fixture.start_denylist(["a.deleted", "a.revoked"])

      started = Fixture.start_store(base(ctx) ++ [denylist: denylist])

      assert heads_of(started) == ["a.kept"]
      assert {:ok, []} = AgentStatusLines.history("a.deleted", started.name)
      assert Map.keys(Fixture.disk(started.path).agents) == ["a.kept"]
    end

    test "a purge refused while dirty is completed by the next start" do
      ctx = case_names()
      denylist = Fixture.start_denylist()
      {flag, sync} = Fixture.switchable_sync()

      first = Fixture.start_store(base(ctx) ++ [denylist: denylist, sync_fun: sync])

      for agent <- ["a.deleted", "a.kept"],
          do: {:ok, _} = AgentStatusLines.put(agent, "line", first.name)

      :ok = TokenDenylist.revoke("a.deleted", nil, denylist)

      Fixture.set_sync(flag, {:error, :enospc})

      capture_log(fn ->
        assert {:error, :status_line_unavailable} =
                 AgentStatusLines.put("a.kept", "x", first.name)
      end)

      assert {:error, :status_line_unavailable} = AgentStatusLines.purge("a.deleted", first.name)
      Fixture.stop_store(first)

      again = Fixture.start_store(path: ctx.path, denylist: denylist)

      assert heads_of(again) == ["a.kept"]
      assert Map.keys(Fixture.disk(again.path).agents) == ["a.kept"]
    end

    test "a start whose sync fails still leaves swept agents out of the view, and the next start removes them from disk" do
      ctx = case_names()
      seed_three(ctx)
      denylist = Fixture.start_denylist(["a.deleted", "a.revoked"])
      names = base(ctx)

      log =
        capture_log(fn ->
          failed =
            Fixture.start_store(
              names ++ [denylist: denylist, sync_fun: fn _ -> {:error, :enospc} end]
            )

          send(self(), {:failed, failed})
        end)

      assert_received {:failed, failed}
      assert log =~ "start failed"

      # Dirty, but the view is the post-sweep set and serves the survivors.
      assert heads_of(failed) == ["a.kept"]
      assert {:error, :status_line_unavailable} = AgentStatusLines.history("a.kept", failed.name)
      assert {:error, :status_line_unavailable} = AgentStatusLines.put("a.kept", "x", failed.name)

      Fixture.stop_store(failed)
      again = Fixture.start_store(path: ctx.path, denylist: denylist)

      assert heads_of(again) == ["a.kept"]
      assert Map.keys(Fixture.disk(again.path).agents) == ["a.kept"]
    end

    test "an agent that is both over retention and revoked is swept without a trace" do
      ctx = case_names()
      entries = for seq <- 5..1//-1, do: Fixture.entry(seq, "text #{seq}")

      Fixture.seed(ctx.path, [
        {:retention, 2},
        {{:agent, "a.deleted"}, entries},
        {{:agent, "a.kept"}, entries}
      ])

      denylist = Fixture.start_denylist(["a.deleted"])

      started = Fixture.start_store(base(ctx) ++ [denylist: denylist])

      assert heads_of(started) == ["a.kept"]
      assert Fixture.disk(started.path).agents["a.kept"] |> Enum.map(& &1.seq) == [5, 4]
      refute Map.has_key?(Fixture.disk(started.path).agents, "a.deleted")
    end

    test "an unreadable denylist stops init and the file is left as it was" do
      ctx = case_names()
      seed_three(ctx)
      before = File.read!(ctx.path)

      assert {:error, {:noproc, {GenServer, :call, _args}}} =
               refused(ctx, denylist: :asl_no_such_denylist)

      assert File.read!(ctx.path) == before
    end
  end

  describe "announcement" do
    defp seed_announced(ctx) do
      Fixture.seed(ctx.path, [
        {{:agent, "a.one"}, [Fixture.entry(1, "one")]},
        {{:agent, "a.cleared"}, [Fixture.entry(2, nil), Fixture.entry(1, "was set")]},
        {{:agent, "a.long"}, [Fixture.entry(1, String.duplicate("a", 600))]}
      ])
    end

    test "the first boot announces nothing" do
      ctx = case_names()
      seed_announced(ctx)

      Fixture.start_store(
        base(ctx) ++
          [broadcast: Fixture.forward_broadcast(self()), endpoint_up?: fn -> false end]
      )

      refute_receive {:broadcast, _, _}
    end

    test "a child restart announces every row, stamped clears included, and the settings" do
      ctx = case_names()
      seed_announced(ctx)

      Fixture.start_store(
        base(ctx) ++
          [broadcast: Fixture.forward_broadcast(self()), endpoint_up?: fn -> true end]
      )

      assert_receive {:broadcast, "status_line",
                      %{"agent_id" => "a.one", "seq" => 1, "head" => "one"}}

      assert_receive {:broadcast, "status_line",
                      %{"agent_id" => "a.cleared", "seq" => 2, "cleared" => true}}

      assert_receive {:broadcast, "status_line",
                      %{"agent_id" => "a.long", "truncated" => true, "bytes" => 600}}

      assert_receive {:broadcast, "status_line_settings",
                      %{"retention" => 20, "source" => "default"}}
    end

    test "a broadcast that raises does not stop the others or dirty the store" do
      ctx = case_names()
      seed_announced(ctx)
      parent = self()
      {:ok, calls} = Agent.start_link(fn -> 0 end)

      failing_first = fn event, payload ->
        if Agent.get_and_update(calls, fn n -> {n, n + 1} end) == 0,
          do: raise("subscriber failed")

        send(parent, {:broadcast, event, payload})
      end

      log =
        capture_log(fn ->
          started =
            Fixture.start_store(
              base(ctx) ++ [broadcast: failing_first, endpoint_up?: fn -> true end]
            )

          send(self(), {:started, started})
        end)

      assert log =~ "broadcast raised"
      assert_received {:started, started}

      # Four broadcasts were attempted (three rows and the settings); the first
      # raised and the other three arrived.
      assert_receive {:broadcast, _, _}
      assert_receive {:broadcast, _, _}
      assert_receive {:broadcast, _, _}
      refute_receive {:broadcast, _, _}

      assert {:ok, %{seq: 2}} = AgentStatusLines.put("a.one", "writable", started.name)
    end
  end

  describe "a sync that fails at start" do
    test "starts dirty, publishes the rows as read and refuses history and writes" do
      ctx = case_names()
      entries = for seq <- 6..1//-1, do: Fixture.entry(seq, "text #{seq}")
      Fixture.seed(ctx.path, [{:retention, 3}, {{:agent, "a.one"}, entries}])
      names = base(ctx)

      log =
        capture_log(fn ->
          failed = Fixture.start_store(names ++ [sync_fun: fn _ -> {:error, :enospc} end])
          send(self(), {:failed, failed})
        end)

      assert_received {:failed, failed}
      assert log =~ "refusing history and writes"

      # The sync failed, so the store cannot vouch for the disk; the latest is
      # on it and is served.
      assert {:ok, %{entry: %{seq: 6}}} = AgentStatusLines.read_latest("a.one", failed.table)
      assert {:error, :status_line_unavailable} = AgentStatusLines.history("a.one", failed.name)
      assert {:error, :status_line_unavailable} = AgentStatusLines.put("a.one", "x", failed.name)
      assert {:ok, %{retention: 3, source: :stored}} = AgentStatusLines.settings(failed.name)

      # A start whose sync works prunes the disk.
      Fixture.stop_store(failed)
      again = Fixture.start_store(path: ctx.path)

      assert {:ok, [%{seq: 6}, %{seq: 5}, %{seq: 4}]} =
               AgentStatusLines.history("a.one", again.name)

      assert Fixture.disk(again.path).agents["a.one"] |> Enum.map(& &1.seq) == [6, 5, 4]
    end

    # Nothing in these files needs repair, so only the sync itself can tell
    # that the disk cannot be written.
    test "a clean file whose sync fails starts dirty all the same" do
      ctx = case_names()

      Fixture.seed(ctx.path, [
        {{:agent, "a.one"}, [Fixture.entry(2, "two"), Fixture.entry(1, "one")]}
      ])

      names = base(ctx)

      log =
        capture_log(fn ->
          failed = Fixture.start_store(names ++ [sync_fun: fn _ -> {:error, :enospc} end])
          send(self(), {:failed, failed})
        end)

      assert_received {:failed, failed}
      assert log =~ "refusing history and writes"

      assert {:ok, %{entry: %{seq: 2}}} = AgentStatusLines.read_latest("a.one", failed.table)
      assert {:error, :status_line_unavailable} = AgentStatusLines.history("a.one", failed.name)
      assert {:error, :status_line_unavailable} = AgentStatusLines.put("a.one", "x", failed.name)

      # The control: the same file starts clean once its sync works.
      Fixture.stop_store(failed)
      again = Fixture.start_store(path: ctx.path)
      assert {:ok, [%{seq: 2}, %{seq: 1}]} = AgentStatusLines.history("a.one", again.name)
      assert {:ok, %{seq: 3}} = AgentStatusLines.put("a.one", "three", again.name)
    end

    test "a new file whose sync fails starts dirty all the same" do
      ctx = case_names()

      log =
        capture_log(fn ->
          failed = Fixture.start_store(base(ctx) ++ [sync_fun: fn _ -> {:error, :enospc} end])
          send(self(), {:failed, failed})
        end)

      assert_received {:failed, failed}
      assert log =~ "refusing history and writes"
      assert {:ok, %{}} = AgentStatusLines.heads(failed.table)
      assert {:error, :status_line_unavailable} = AgentStatusLines.put("a.one", "x", failed.name)
    end

    test "every start syncs exactly once, whether or not there was anything to repair" do
      ctx = case_names()
      sync = Fixture.counting_sync(self())

      first = Fixture.start_store(base(ctx) ++ [sync_fun: sync])
      assert_receive {:sync_called, _}
      refute_received {:sync_called, _}

      {:ok, _} = AgentStatusLines.put("a.one", "one", first.name)
      assert_receive {:sync_called, _}
      Fixture.stop_store(first)

      # A restart over a clean, already-pruned file.
      again = Fixture.start_store(path: ctx.path, sync_fun: sync)
      assert_receive {:sync_called, _}
      refute_received {:sync_called, _}
      Fixture.stop_store(again)
    end
  end
end
