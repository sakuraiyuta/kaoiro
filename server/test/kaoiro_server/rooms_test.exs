defmodule KaoiroServer.RoomsTest do
  # Isolated stores on their own files (issue #537). The stored-record cases
  # write a real DETS file first and start the product init on it.
  use ExUnit.Case, async: true

  import ExUnit.CaptureLog

  alias KaoiroServer.{Rooms, TestTeardown}

  @lobby_only %{rooms: %{"lobby" => nil}, members: %{}}

  defp names do
    n = System.unique_integer([:positive])
    path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "rooms_#{n}.dets"])
    File.rm_rf!(path)
    on_exit(fn -> File.rm_rf(path) end)
    %{name: :"rooms_#{n}", path: path}
  end

  defp start(ctx, opts \\ []) do
    {:ok, pid} = Rooms.start_link([name: ctx.name, path: ctx.path] ++ opts)
    on_exit(fn -> TestTeardown.stop_quietly(pid) end)
    pid
  end

  defp restart(ctx, pid) do
    :ok = GenServer.stop(pid)
    start(ctx)
  end

  defp store_raw(ctx, record, type \\ :set) do
    File.mkdir_p!(Path.dirname(ctx.path))
    {:ok, table} = :dets.open_file(ctx.name, file: String.to_charlist(ctx.path), type: type)
    :ok = :dets.insert(table, record)
    :ok = :dets.close(table)
  end

  defp room!(ctx, name) do
    {:ok, %{room_id: id}} = Rooms.create(name, ctx.name)
    id
  end

  # A sync that fails once in the given way, then is the real one again.
  defp failing_sync(failure) do
    {:ok, flag} = Agent.start_link(fn -> failure end)

    {flag,
     fn table ->
       case Agent.get_and_update(flag, &{&1, :real}) do
         :real -> :dets.sync(table)
         :raise -> raise "sync raised"
         :exit -> exit(:sync_exited)
         error -> error
       end
     end}
  end

  test "a new store holds only the lobby, and everyone is in it" do
    ctx = names()
    log = capture_log(fn -> start(ctx) end)

    refute log =~ "rooms:"
    assert Rooms.snapshot(ctx.name) == {:ok, @lobby_only}
    assert Rooms.same_room("a", "b", ctx.name) == :ok
    assert Rooms.wire(@lobby_only, "lobby") == %{"id" => "lobby", "name" => nil}
  end

  test "rooms and memberships are saved and read back after a restart" do
    ctx = names()
    pid = start(ctx)
    blue = room!(ctx, "Blue")
    assert blue =~ ~r/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    assert {:ok, %{room_id: "lobby"}} = Rooms.rename("lobby", "Hall", ctx.name)
    assert {:ok, %{moved: ["a"]}} = Rooms.change({:move, "a", blue}, ctx.name)

    saved = %{rooms: %{"lobby" => "Hall", blue => "Blue"}, members: %{"a" => blue}}
    assert Rooms.snapshot(ctx.name) == {:ok, saved}
    assert Rooms.same_room("a", "b", ctx.name) == {:error, :room_mismatch}
    assert Rooms.wire(saved, blue) == %{"id" => blue, "name" => "Blue"}

    restart(ctx, pid)
    assert Rooms.snapshot(ctx.name) == {:ok, saved}
    assert Rooms.same_room("a", "b", ctx.name) == {:error, :room_mismatch}
  end

  test "a move within the same room changes nothing; a move to the lobby drops the record" do
    ctx = names()
    start(ctx)
    blue = room!(ctx, "Blue")

    assert {:ok, %{moved: []}} = Rooms.change({:move, "a", "lobby"}, ctx.name)
    assert {:ok, %{moved: ["a"]}} = Rooms.change({:move, "a", blue}, ctx.name)
    assert {:ok, %{moved: []}} = Rooms.change({:move, "a", blue}, ctx.name)
    assert {:ok, %{moved: ["a"], members: %{}}} = Rooms.change({:move, "a", "lobby"}, ctx.name)
  end

  test "unknown rooms and the lobby's deletion are refused" do
    ctx = names()
    start(ctx)

    assert Rooms.change({:move, "a", "nope"}, ctx.name) == {:error, :unknown_room}
    assert Rooms.rename("nope", "X", ctx.name) == {:error, :unknown_room}
    assert Rooms.change({:delete, "nope"}, ctx.name) == {:error, :unknown_room}
    assert Rooms.change({:delete, "lobby"}, ctx.name) == {:error, :lobby_protected}
    assert Rooms.snapshot(ctx.name) == {:ok, @lobby_only}
  end

  test "a delete returns every member to the lobby in one change" do
    ctx = names()
    start(ctx)
    blue = room!(ctx, "Blue")
    red = room!(ctx, "Red")
    for agent <- ["a", "b"], do: {:ok, _} = Rooms.change({:move, agent, blue}, ctx.name)
    {:ok, _} = Rooms.change({:move, "c", red}, ctx.name)

    assert {:ok, change} = Rooms.change({:delete, blue}, ctx.name)
    assert Enum.sort(change.moved) == ["a", "b"]
    assert change.members == %{"c" => red}
    refute Map.has_key?(change.rooms, blue)
    assert Rooms.snapshot(ctx.name) == {:ok, Map.take(change, [:rooms, :members])}
  end

  test "a preview answers like the change and saves nothing" do
    ctx = names()
    start(ctx)
    blue = room!(ctx, "Blue")
    {:ok, before} = Rooms.snapshot(ctx.name)

    assert {:ok, %{moved: ["a"], members: %{"a" => ^blue}}} =
             Rooms.preview({:move, "a", blue}, ctx.name)

    assert Rooms.preview({:delete, "lobby"}, ctx.name) == {:error, :lobby_protected}
    assert Rooms.snapshot(ctx.name) == {:ok, before}
  end

  test "a purge drops the agent's membership, and is a no-op without one" do
    ctx = names()
    start(ctx)
    blue = room!(ctx, "Blue")
    {:ok, _} = Rooms.change({:move, "a", blue}, ctx.name)

    assert Rooms.purge("a", ctx.name) == :ok
    assert Rooms.purge("never-moved", ctx.name) == :ok
    assert {:ok, %{members: %{}}} = Rooms.snapshot(ctx.name)
  end

  describe "stored records that are malformed" do
    @good %{"lobby" => nil, "r1" => "Blue"}

    for {label, rooms, members, kept_rooms, kept_members, warning} <- [
          {"a membership naming an unknown room", @good, %{"a" => "gone", "b" => "r1"}, @good,
           %{"b" => "r1"}, "1 malformed membership"},
          {"a membership whose room is not a string", @good, %{"a" => 7, "b" => "r1"}, @good,
           %{"b" => "r1"}, "1 malformed membership"},
          {"a membership whose agent is not a string", @good, %{:a => "r1", "b" => "r1"}, @good,
           %{"b" => "r1"}, "1 malformed membership"},
          {"a room without a name", Map.put(@good, "r2", nil), %{"a" => "r2", "b" => "r1"}, @good,
           %{"b" => "r1"}, "1 malformed room"},
          {"a room whose id is not a string", Map.put(@good, 9, "Nine"), %{"b" => "r1"}, @good,
           %{"b" => "r1"}, "1 malformed room"},
          {"a room whose name is not valid text", Map.put(@good, "r2", <<255>>), %{"b" => "r1"},
           @good, %{"b" => "r1"}, "1 malformed room"},
          {"a missing lobby", %{"r1" => "Blue"}, %{"b" => "r1"}, @good, %{"b" => "r1"}, nil}
        ] do
      test "#{label} falls back to the lobby and keeps the valid records" do
        ctx = names()
        store_raw(ctx, {:rooms_v1, unquote(Macro.escape(rooms)), unquote(Macro.escape(members))})

        log = capture_log(fn -> start(ctx) end)

        assert Rooms.snapshot(ctx.name) ==
                 {:ok,
                  %{
                    rooms: unquote(Macro.escape(kept_rooms)),
                    members: unquote(Macro.escape(kept_members))
                  }}

        case unquote(warning) do
          nil -> refute log =~ "rooms:"
          text -> assert log =~ text
        end

        refute log =~ "Blue"
      end
    end

    for {label, record} <- [
          {"a snapshot of another shape", {:rooms_v1, :bad}},
          {"rooms that are not a map", {:rooms_v1, [], %{}}},
          {"memberships that are not a map", {:rooms_v1, %{"lobby" => nil}, :bad}}
        ] do
      test "#{label} leaves everyone in the lobby, and the next save replaces it" do
        ctx = names()
        store_raw(ctx, unquote(Macro.escape(record)))

        log = capture_log(fn -> start(ctx) end)

        assert log =~ "the stored snapshot is malformed"
        assert Rooms.snapshot(ctx.name) == {:ok, @lobby_only}
        blue = room!(ctx, "Blue")
        assert {:ok, %{rooms: %{^blue => "Blue"}}} = Rooms.snapshot(ctx.name)
      end
    end
  end

  test "a file that is not a DETS file is created again" do
    ctx = names()
    File.mkdir_p!(Path.dirname(ctx.path))
    File.write!(ctx.path, "not a dets file")

    log = capture_log(fn -> send(self(), {:pid, start(ctx)}) end)
    assert_received {:pid, pid}

    assert log =~ "is not a DETS file"
    assert Rooms.snapshot(ctx.name) == {:ok, @lobby_only}
    blue = room!(ctx, "Blue")
    restart(ctx, pid)
    assert {:ok, %{rooms: %{^blue => "Blue"}}} = Rooms.snapshot(ctx.name)
  end

  test "a file that cannot be opened is left alone: lobby only, saves fail, sends go on" do
    ctx = names()
    # A real DETS file of another table type: open fails, and it is not junk.
    store_raw(ctx, {:kept, 1}, :bag)

    log = capture_log(fn -> start(ctx) end)

    assert log =~ "the store cannot be opened"
    assert Rooms.snapshot(ctx.name) == {:ok, @lobby_only}
    assert Rooms.same_room("a", "b", ctx.name) == :ok

    log = capture_log(fn -> send(self(), Rooms.create("Blue", ctx.name)) end)
    assert_received {:error, :rooms_unavailable}
    assert log =~ "was not saved"
    assert Rooms.snapshot(ctx.name) == {:ok, @lobby_only}

    {:ok, table} =
      :dets.open_file(:"#{ctx.name}_bag", file: String.to_charlist(ctx.path), type: :bag)

    assert :dets.lookup(table, :kept) == [{:kept, 1}]
    :ok = :dets.close(table)

    # Once the file can be opened, the next management request reopens it.
    File.rm!(ctx.path)
    blue = room!(ctx, "Blue")
    assert {:ok, %{rooms: %{^blue => "Blue"}}} = Rooms.snapshot(ctx.name)
  end

  for {label, failure} <- [
        {"sync returns an error", {:error, :enospc}},
        {"sync raises", :raise},
        {"sync exits", :exit}
      ] do
    test "a failed save (#{label}) fails that request only and keeps memory" do
      ctx = names()
      {flag, sync} = failing_sync(:real)
      pid = start(ctx, sync_fun: sync)
      blue = room!(ctx, "Blue")
      {:ok, _} = Rooms.change({:move, "a", blue}, ctx.name)
      {:ok, committed} = Rooms.snapshot(ctx.name)
      Agent.update(flag, fn _ -> unquote(Macro.escape(failure)) end)

      log = capture_log(fn -> send(self(), Rooms.change({:move, "b", blue}, ctx.name)) end)
      assert_received {:error, :rooms_unavailable}
      assert log =~ "was not saved"

      # The last committed memberships still decide who shares a room.
      assert Rooms.snapshot(ctx.name) == {:ok, committed}
      assert Rooms.same_room("a", "b", ctx.name) == {:error, :room_mismatch}
      assert Rooms.same_room("b", "c", ctx.name) == :ok

      # The next management request reopens the file once and saves.
      assert {:ok, %{moved: ["c"]}} = Rooms.change({:move, "c", blue}, ctx.name)
      restart(ctx, pid)
      assert {:ok, %{members: %{"a" => ^blue, "c" => ^blue}}} = Rooms.snapshot(ctx.name)
    end
  end

  test "a save on a lost table fails, and the next request reopens it" do
    ctx = names()
    pid = start(ctx)
    blue = room!(ctx, "Blue")
    # Closed by its owner behind the state's back: the insert itself fails.
    :sys.replace_state(pid, fn state ->
      :ok = :dets.close(state.name)
      state
    end)

    log = capture_log(fn -> send(self(), Rooms.change({:move, "a", blue}, ctx.name)) end)
    assert_received {:error, :rooms_unavailable}
    assert log =~ "was not saved"
    assert {:ok, %{members: %{}}} = Rooms.snapshot(ctx.name)

    assert {:ok, %{moved: ["a"]}} = Rooms.change({:move, "a", blue}, ctx.name)
    restart(ctx, pid)
    assert {:ok, %{members: %{"a" => ^blue}}} = Rooms.snapshot(ctx.name)
  end

  # Not a rollback guarantee: an insert that reached the file before the sync
  # failed is what a restart reads.
  test "a change whose sync failed can still be on disk after a restart" do
    ctx = names()
    {flag, sync} = failing_sync(:real)
    pid = start(ctx, sync_fun: sync)
    blue = room!(ctx, "Blue")
    Agent.update(flag, fn _ -> {:error, :enospc} end)

    capture_log(fn -> send(self(), Rooms.change({:move, "a", blue}, ctx.name)) end)
    assert_received {:error, :rooms_unavailable}
    assert {:ok, %{members: %{}}} = Rooms.snapshot(ctx.name)

    restart(ctx, pid)
    assert {:ok, %{members: %{"a" => ^blue}}} = Rooms.snapshot(ctx.name)
  end

  test "a store that does not answer: reads are unavailable, a save is unconfirmed" do
    ctx = names()
    pid = start(ctx)
    blue = room!(ctx, "Blue")
    :ok = :sys.suspend(pid)

    {read_us, read} = :timer.tc(fn -> Rooms.same_room("a", "b", ctx.name) end)
    assert read == {:error, :rooms_unavailable}
    assert Rooms.snapshot(ctx.name) == :unavailable
    assert Rooms.preview({:move, "a", blue}, ctx.name) == {:error, :rooms_unavailable}

    {save_us, save} = :timer.tc(fn -> Rooms.change({:move, "a", blue}, ctx.name) end)
    assert save == {:error, :room_change_unconfirmed}

    assert read_us in 450_000..1_500_000
    assert save_us in 1_900_000..4_000_000

    # The timed-out save was not cancelled: it is applied once the store runs.
    :ok = :sys.resume(pid)
    assert {:ok, %{members: %{"a" => ^blue}}} = Rooms.snapshot(ctx.name)
  end

  test "a store that is not running answers the same way" do
    assert Rooms.snapshot(:rooms_not_running) == :unavailable
    assert Rooms.same_room("a", "b", :rooms_not_running) == {:error, :rooms_unavailable}

    assert Rooms.change({:move, "a", "lobby"}, :rooms_not_running) ==
             {:error, :room_change_unconfirmed}
  end
end
