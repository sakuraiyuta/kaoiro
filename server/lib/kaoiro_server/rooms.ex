defmodule KaoiroServer.Rooms do
  @moduledoc """
  Rooms and the single room each agent belongs to (issue #537 Phase 0,
  ADR-0072, docs/reference/inter-agent/rooms.md).

  The lobby (`"lobby"`) always exists and cannot be deleted; its name is `nil`
  until an operator renames it. An agent with no stored membership is in the
  lobby, so only non-lobby memberships are stored.

  ## Storage

  One DETS object, `{:rooms_v1, rooms, members}` (`rooms`: id => name,
  `members`: agent_id => room id), replaced whole on every change. A change
  becomes visible in memory only after both the insert and the sync returned
  `:ok`.

  A failed save fails that one request with `:rooms_unavailable` and keeps the
  last committed memory, which the same-room check goes on using. The next
  create, rename, move, delete or purge closes and reopens the file once and
  saves its own candidate from memory; the file is never read back while this
  process runs. Reads never reopen it.

  At start, a file that cannot be opened or read leaves everyone in the lobby
  with a warning instead of stopping the server. Only a file that is not a
  DETS file is removed and created again. A stored room or membership that is
  malformed, or a membership naming a room that does not exist, is dropped
  with a warning, which puts that agent in the lobby.

  ## Callers

  `move` and `delete` change who shares a room, so they are reached only
  through `KaoiroServer.ConversationStates.apply_room_change/2`, which also
  closes the conversations the change splits. Call timeouts: 500 ms for a
  read, 2,000 ms for a save. An exit of the call itself (no process,
  timeout) is `:unavailable` / `:rooms_unavailable` for a read and
  `:room_change_unconfirmed` for a save, whose outcome is then unknown.
  """

  use GenServer

  require Logger

  alias KaoiroServer.DetsStorePath

  @lobby "lobby"
  @read_timeout 500
  @save_timeout 2_000

  @type snapshot :: %{
          rooms: %{String.t() => String.t() | nil},
          members: %{String.t() => String.t()}
        }
  @type command :: {:move, String.t(), String.t()} | {:delete, String.t()}

  def lobby_id, do: @lobby

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc "The committed rooms and memberships, or `:unavailable`."
  @spec snapshot(GenServer.server()) :: {:ok, snapshot()} | :unavailable
  def snapshot(server \\ __MODULE__), do: read(server, :snapshot)

  @doc "The room id `agent_id` is in according to `snapshot`."
  @spec room_of(snapshot(), String.t()) :: String.t()
  def room_of(%{members: members}, agent_id), do: Map.get(members, agent_id, @lobby)

  @doc "A room as the wire carries it; an unrenamed lobby has `name: null`."
  @spec wire(snapshot(), String.t()) :: %{String.t() => String.t() | nil}
  def wire(%{rooms: rooms}, room_id), do: %{"id" => room_id, "name" => Map.get(rooms, room_id)}

  @doc "Whether two agents share a room right now, read in one call."
  @spec same_room(String.t(), String.t(), GenServer.server()) ::
          :ok | {:error, :room_mismatch | :rooms_unavailable}
  def same_room(from, to, server \\ __MODULE__) do
    case read(server, {:rooms_of, from, to}) do
      {:ok, {room, room}} -> :ok
      {:ok, _different} -> {:error, :room_mismatch}
      :unavailable -> {:error, :rooms_unavailable}
    end
  end

  @doc "What `change/2` would do, without saving anything."
  def preview(command, server \\ __MODULE__) do
    case read(server, {:preview, command}) do
      :unavailable -> {:error, :rooms_unavailable}
      reply -> reply
    end
  end

  @doc """
  Creates a room. The caller validates the name. Like `rename/3`, returns the
  rooms and memberships as saved, with the room's id under `:room_id`.
  """
  def create(name, server \\ __MODULE__) when is_binary(name) and name != "",
    do: save(server, {:create, name})

  @doc "Renames a room; the lobby can be renamed."
  def rename(room_id, name, server \\ __MODULE__) when is_binary(name) and name != "",
    do: save(server, {:rename, room_id, name})

  @doc """
  Moves one agent, or deletes a room and returns its members to the lobby.
  Returns `%{moved: agent_ids, rooms: rooms, members: members}` with the
  memberships as saved. Only `ConversationStates` calls this (see the
  moduledoc).
  """
  @spec change(command(), GenServer.server()) :: {:ok, map()} | {:error, atom()}
  def change(command, server \\ __MODULE__), do: save(server, command)

  @doc "Drops a deleted agent's membership."
  def purge(agent_id, server \\ __MODULE__) do
    with {:ok, _change} <- save(server, {:purge, agent_id}), do: :ok
  end

  @doc "A fresh UUID (version 4), as used for room ids."
  def new_id do
    <<a::48, _::4, b::12, _::2, c::62>> = :crypto.strong_rand_bytes(16)

    <<p1::binary-size(8), p2::binary-size(4), p3::binary-size(4), p4::binary-size(4), p5::binary>> =
      Base.encode16(<<a::48, 4::4, b::12, 2::2, c::62>>, case: :lower)

    Enum.join([p1, p2, p3, p4, p5], "-")
  end

  # Only the exit of the call itself is mapped, as in AgentStatusLines.
  defp read(server, request) do
    GenServer.call(server, request, @read_timeout)
  catch
    :exit, {_reason, {GenServer, :call, _args}} -> :unavailable
  end

  defp save(server, request) do
    GenServer.call(server, {:save, request}, @save_timeout)
  catch
    :exit, {_reason, {GenServer, :call, _args}} -> {:error, :room_change_unconfirmed}
  end

  ## Server

  @impl true
  def init(opts) do
    name = Keyword.get(opts, :name, __MODULE__)

    state = %{
      name: name,
      path: Keyword.get(opts, :path) || default_path(),
      sync_fun: Keyword.get(opts, :sync_fun, &:dets.sync/1),
      stored?: false,
      rooms: %{@lobby => nil},
      members: %{}
    }

    case open(state) do
      :ok ->
        {:ok, load(%{state | stored?: true})}

      {:error, reason} ->
        Logger.warning(
          "rooms: the store cannot be opened (#{brief(reason)}); " <>
            "every agent is in the lobby until a room change is saved"
        )

        {:ok, state}
    end
  end

  @impl true
  def handle_call(:snapshot, _from, state), do: {:reply, {:ok, view(state)}, state}

  def handle_call({:rooms_of, from, to}, _from, state) do
    {:reply, {:ok, {room_of(state, from), room_of(state, to)}}, state}
  end

  def handle_call({:preview, command}, _from, state) do
    reply =
      case plan(state, command) do
        {:error, _reason} = error -> error
        {_ok_or_noop, change} -> {:ok, change}
      end

    {:reply, reply, state}
  end

  def handle_call({:save, command}, _from, state) do
    case plan(state, command) do
      {:error, _reason} = error ->
        {:reply, error, state}

      {:noop, change} ->
        {:reply, {:ok, change}, state}

      {:ok, change} ->
        case persist(state, change) do
          {:ok, state} -> {:reply, {:ok, change}, state}
          {:error, state} -> {:reply, {:error, :rooms_unavailable}, state}
        end
    end
  end

  @impl true
  def terminate(_reason, state), do: :dets.close(state.name)

  ## Planning: pure, shared by preview and save.

  defp plan(state, {:create, name}), do: plan(state, {:put, new_id(), name})

  defp plan(state, {:rename, room_id, name}) do
    if Map.has_key?(state.rooms, room_id),
      do: plan(state, {:put, room_id, name}),
      else: {:error, :unknown_room}
  end

  defp plan(state, {:put, room_id, name}) do
    {:ok, planned(state, [], rooms: Map.put(state.rooms, room_id, name), room_id: room_id)}
  end

  defp plan(state, {:move, agent_id, room_id}) do
    cond do
      not Map.has_key?(state.rooms, room_id) ->
        {:error, :unknown_room}

      room_of(state, agent_id) == room_id ->
        {:noop, planned(state, [], [])}

      room_id == @lobby ->
        {:ok, planned(state, [agent_id], members: Map.delete(state.members, agent_id))}

      true ->
        {:ok, planned(state, [agent_id], members: Map.put(state.members, agent_id, room_id))}
    end
  end

  defp plan(_state, {:delete, @lobby}), do: {:error, :lobby_protected}

  defp plan(state, {:delete, room_id}) do
    if Map.has_key?(state.rooms, room_id) do
      moved = for {agent_id, ^room_id} <- state.members, do: agent_id

      {:ok,
       planned(state, moved,
         rooms: Map.delete(state.rooms, room_id),
         members: Map.drop(state.members, moved)
       )}
    else
      {:error, :unknown_room}
    end
  end

  defp plan(state, {:purge, agent_id}) do
    if Map.has_key?(state.members, agent_id),
      do: {:ok, planned(state, [], members: Map.delete(state.members, agent_id))},
      else: {:noop, planned(state, [], [])}
  end

  defp planned(state, moved, updates) do
    state |> view() |> Map.merge(Map.new(updates)) |> Map.put(:moved, moved)
  end

  defp view(state), do: Map.take(state, [:rooms, :members])

  ## Storage

  # A failed `{:error, _}` result, a raise and an exit from a DETS step all
  # take the same road: the request fails and memory stays as committed.
  defp persist(state, change) do
    state = reopen(state)

    with :ok <- if(state.stored?, do: :ok, else: {:error, :not_open}),
         :ok <- :dets.insert(state.name, {:rooms_v1, change.rooms, change.members}),
         :ok <- state.sync_fun.(state.name) do
      {:ok, Map.merge(state, Map.take(change, [:rooms, :members]))}
    else
      failure -> {:error, save_failed(state, failure)}
    end
  rescue
    error -> {:error, save_failed(state, {:raised, error.__struct__})}
  catch
    kind, reason -> {:error, save_failed(state, {kind, reason})}
  end

  defp save_failed(state, reason) do
    Logger.warning(
      "rooms: a room change was not saved (#{brief(reason)}); " <>
        "memory keeps the last saved rooms and memberships"
    )

    %{state | stored?: false}
  end

  # One reopen per management request after a storage failure. Memory is not
  # reloaded: the caller saves its candidate over whatever the file holds.
  defp reopen(%{stored?: true} = state), do: state

  defp reopen(state) do
    _ = :dets.close(state.name)
    %{state | stored?: open(state) == :ok}
  end

  defp open(state) do
    DetsStorePath.prepare_parent!(state.path)

    with {:error, {:not_a_dets_file, _path}} <- open_file(state) do
      Logger.warning("rooms: #{state.path} is not a DETS file; creating it again")
      _ = File.rm(state.path)
      open_file(state)
    end
  rescue
    error -> {:error, {:raised, error.__struct__}}
  end

  defp open_file(state) do
    with {:ok, _table} <-
           :dets.open_file(state.name, file: String.to_charlist(state.path), type: :set) do
      # DETS has no creation-mode option; the parent directory is owner-only.
      _ = File.chmod(state.path, 0o600)
      :ok
    end
  end

  defp load(state) do
    case :dets.lookup(state.name, :rooms_v1) do
      [] ->
        state

      [{:rooms_v1, rooms, members}] when is_map(rooms) and is_map(members) ->
        rooms = normalize_rooms(rooms)
        %{state | rooms: rooms, members: normalize_members(members, rooms)}

      [_unknown_shape] ->
        Logger.warning("rooms: the stored snapshot is malformed; every agent is in the lobby")
        state

      {:error, reason} ->
        Logger.warning(
          "rooms: the store cannot be read (#{brief(reason)}); every agent is in the lobby"
        )

        %{state | stored?: false}
    end
  end

  defp normalize_rooms(rooms) do
    kept = for {id, name} <- rooms, valid_room?(id, name), into: %{}, do: {id, name}
    warn_dropped(map_size(rooms) - map_size(kept), "room record(s)")
    Map.put_new(kept, @lobby, nil)
  end

  defp valid_room?(@lobby, nil), do: true
  defp valid_room?(id, name), do: text?(id) and text?(name)

  defp normalize_members(members, rooms) do
    kept =
      for {agent_id, room_id} <- members,
          text?(agent_id),
          room_id != @lobby,
          Map.has_key?(rooms, room_id),
          into: %{},
          do: {agent_id, room_id}

    warn_dropped(
      map_size(members) - map_size(kept),
      "membership(s); those agents are in the lobby"
    )

    kept
  end

  defp text?(value), do: is_binary(value) and value != "" and String.valid?(value)

  defp warn_dropped(0, _what), do: :ok
  defp warn_dropped(count, what), do: Logger.warning("rooms: dropped #{count} malformed #{what}")

  # Never the stored record: the failure kind only.
  defp brief(reason), do: inspect(reason, limit: 5, printable_limit: 120)

  defp default_path do
    Application.get_env(:kaoiro_server, :rooms_path) || DetsStorePath.default_path("rooms.dets")
  end
end
