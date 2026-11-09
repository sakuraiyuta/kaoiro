defmodule KaoiroServer.ConversationStatesRoomsTest do
  # The same-room rule at the record, and room changes that close the
  # conversations they split (issue #537). One isolated Rooms store and one
  # isolated tracker per test; nothing here touches the application's own.
  use ExUnit.Case, async: true

  import ExUnit.CaptureLog

  alias KaoiroServer.{ConversationStates, Rooms, TestTeardown}

  setup do
    n = System.unique_integer([:positive])
    path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "cs_rooms_#{n}.dets"])
    File.rm(path)
    {:ok, flag} = Agent.start_link(fn -> :real end)

    sync = fn table ->
      case Agent.get_and_update(flag, &{&1, :real}) do
        :real -> :dets.sync(table)
        error -> error
      end
    end

    {:ok, rooms} = Rooms.start_link(name: :"cs_rooms_#{n}", path: path, sync_fun: sync)
    {:ok, cs} = ConversationStates.start_link(name: :"cs_rooms_cs_#{n}", rooms: rooms)

    on_exit(fn ->
      TestTeardown.stop_quietly(cs)
      TestTeardown.stop_quietly(rooms)
      File.rm(path)
    end)

    {:ok, %{room_id: blue}} = Rooms.create("Blue", rooms)
    %{rooms: rooms, cs: cs, blue: blue, fail_next_sync: flag}
  end

  defp record(cs, cid, from, to, turn \\ 1, new? \\ true),
    do:
      ConversationStates.record_bound_message(cid, from, to, "hi", turn, false, new?, :legacy, cs)

  defp preview(cs, cid, from, to),
    do: ConversationStates.preview_bound_message(cid, from, to, "hi", 1, false, true, :legacy, cs)

  defp move(cs, agent, room), do: ConversationStates.apply_room_change({:move, agent, room}, cs)
  defp status(cs, cid), do: ConversationStates.get(cid, cs)[:status]

  test "a record or a preview across rooms is refused and records nothing", ctx do
    {:ok, _} = move(ctx.cs, "a", ctx.blue)

    assert record(ctx.cs, "c1", "a", "b") == {:error, :room_mismatch}
    assert record(ctx.cs, "c1", "b", "a") == {:error, :room_mismatch}
    assert preview(ctx.cs, "c1", "a", "b") == {:error, :room_mismatch}
    assert ConversationStates.get("c1", ctx.cs) == nil

    {:ok, _} = move(ctx.cs, "b", ctx.blue)
    assert preview(ctx.cs, "c1", "a", "b") == :ok
    assert record(ctx.cs, "c1", "a", "b") == :ok
    assert record(ctx.cs, "c2", "c", "d") == :ok
  end

  test "moving one agent closes only the conversations it splits", ctx do
    assert record(ctx.cs, "ab", "a", "b") == :ok
    assert record(ctx.cs, "bc", "b", "c") == :ok

    assert {:ok, %{closed: [], moved: []}} = move(ctx.cs, "a", "lobby")
    assert status(ctx.cs, "ab") == :open

    assert {:ok, change} = move(ctx.cs, "a", ctx.blue)
    assert [{"ab", participants}] = change.closed
    assert Enum.sort(participants) == ["a", "b"]
    assert change.reason == :room_changed
    assert change.moved == ["a"]

    assert %{status: :closed, reason: :room_changed} = ConversationStates.get("ab", ctx.cs)
    assert status(ctx.cs, "bc") == :open
    assert record(ctx.cs, "ab", "a", "b", 2, false) == {:error, :room_mismatch}

    # Back together: the closed conversation stays closed, a new one opens.
    assert {:ok, %{closed: []}} = move(ctx.cs, "a", "lobby")
    assert record(ctx.cs, "ab", "a", "b", 2, false) == {:error, :conversation_closed}
    assert record(ctx.cs, "ab2", "a", "b") == :ok
    assert status(ctx.cs, "ab2") == :open
  end

  test "deleting a room returns its members together, so their conversation stays", ctx do
    {:ok, _} = move(ctx.cs, "a", ctx.blue)
    {:ok, _} = move(ctx.cs, "b", ctx.blue)
    assert record(ctx.cs, "ab", "a", "b") == :ok

    assert {:ok, change} = ConversationStates.apply_room_change({:delete, ctx.blue}, ctx.cs)
    assert Enum.sort(change.moved) == ["a", "b"]
    assert change.closed == []
    assert change.reason == :room_deleted
    assert status(ctx.cs, "ab") == :open
    assert record(ctx.cs, "ac", "a", "c") == :ok
  end

  test "a preview reports what would close and changes nothing", ctx do
    assert record(ctx.cs, "ab", "a", "b") == :ok

    assert {:ok, %{closed: [{"ab", _}], moved: ["a"]}} =
             ConversationStates.preview_room_change({:move, "a", ctx.blue}, ctx.cs)

    assert status(ctx.cs, "ab") == :open
    assert Rooms.same_room("a", "b", ctx.rooms) == :ok

    assert ConversationStates.preview_room_change({:delete, "lobby"}, ctx.cs) ==
             {:error, :lobby_protected}
  end

  test "a failed save moves nobody and closes nothing; sends go on", ctx do
    assert record(ctx.cs, "ab", "a", "b") == :ok
    Agent.update(ctx.fail_next_sync, fn _ -> {:error, :enospc} end)

    capture_log(fn -> send(self(), move(ctx.cs, "a", ctx.blue)) end)
    assert_received {:error, :rooms_unavailable}

    assert status(ctx.cs, "ab") == :open
    assert record(ctx.cs, "ab", "b", "a", 2, false) == :ok
    assert record(ctx.cs, "cd", "c", "d") == :ok
  end

  test "an unreadable Rooms fails that record only; the tracker lives on", ctx do
    assert record(ctx.cs, "ab", "a", "b") == :ok
    :ok = :sys.suspend(ctx.rooms)

    {us, result} = :timer.tc(fn -> record(ctx.cs, "ab", "b", "a", 2, false) end)
    assert result == {:error, :rooms_unavailable}
    assert us in 450_000..1_500_000
    assert status(ctx.cs, "ab") == :open

    :ok = :sys.resume(ctx.rooms)
    assert record(ctx.cs, "ab", "b", "a", 2, false) == :ok
  end

  # The inner save timed out, so this call cannot know the outcome and closes
  # nothing. The save is applied late; the same-room rule then refuses sends
  # on the leftover conversation, and an operator close is what removes it.
  test "a save that does not answer in time is unconfirmed and closes nothing", ctx do
    assert record(ctx.cs, "ab", "a", "b") == :ok
    :ok = :sys.suspend(ctx.rooms)

    {us, result} = :timer.tc(fn -> move(ctx.cs, "a", ctx.blue) end)
    assert result == {:error, :room_change_unconfirmed}
    assert us in 1_900_000..4_000_000

    # Answered while Rooms is still suspended: the tracker is not stuck.
    assert status(ctx.cs, "ab") == :open

    :ok = :sys.resume(ctx.rooms)
    assert {:ok, %{members: %{"a" => blue}}} = Rooms.snapshot(ctx.rooms)
    assert blue == ctx.blue
    assert status(ctx.cs, "ab") == :open
    assert record(ctx.cs, "ab", "a", "b", 2, false) == {:error, :room_mismatch}

    assert {:ok, %{closed: [], moved: []}} = move(ctx.cs, "a", ctx.blue)
    assert status(ctx.cs, "ab") == :open
    assert {:ok, _participants} = ConversationStates.close_by_operator("ab", ctx.cs)
  end

  # Only the caller gives up after 5,000 ms; the tracker still runs the
  # change, saves it and closes the conversation.
  test "a tracker that does not answer in time is unconfirmed, and still applies", ctx do
    assert record(ctx.cs, "ab", "a", "b") == :ok
    :ok = :sys.suspend(ctx.cs)

    {us, result} = :timer.tc(fn -> move(ctx.cs, "a", ctx.blue) end)
    assert result == {:error, :room_change_unconfirmed}
    assert us in 4_900_000..8_000_000

    :ok = :sys.resume(ctx.cs)
    assert %{status: :closed, reason: :room_changed} = ConversationStates.get("ab", ctx.cs)
    assert Rooms.same_room("a", "b", ctx.rooms) == {:error, :room_mismatch}
  end

  test "a Rooms that is gone fails records until it is back", ctx do
    n = System.unique_integer([:positive])
    {:ok, cs} = ConversationStates.start_link(name: :"cs_norooms_#{n}", rooms: :"gone_#{n}")
    on_exit(fn -> TestTeardown.stop_quietly(cs) end)

    assert record(cs, "ab", "a", "b") == {:error, :rooms_unavailable}
    assert move(cs, "a", ctx.blue) == {:error, :room_change_unconfirmed}
    assert ConversationStates.get("ab", cs) == nil
  end
end
