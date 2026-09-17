defmodule KaoiroServer.DeliveryStates do
  @moduledoc """
  Durable, recipient-local observation ledger for inter-agent dispatch
  confirmation (issue #237). Negotiated recovery records explicit losses
  separately from dispatch; a resolved prefix is not proof of delivery.
  This ledger retains no payloads and never replays them.

  A wrapper process binds a random `delivery_generation` when it joins.  A
  rejoin with the same generation is a websocket reconnect and preserves an
  outstanding gap.  A different generation means the old process lost its
  local coordinator state, so its gap is explicitly abandoned (`acked` moves
  to `issued`) rather than being reported forever as a delivery failure.
  `transition_id` must not be used for this: runner crash relaunches can keep
  the same session-transition id while replacing the wrapper process.
  """
  use GenServer
  require Logger

  alias KaoiroServer.AgentStates
  alias KaoiroServer.TransportLimits

  @wire_projection_bytes TransportLimits.snapshot_payload_budget(
                           "delivery_snapshot",
                           "deliveries",
                           %{"snapshot_incomplete" => true}
                         )

  @type status :: %{
          issued_seq: non_neg_integer(),
          acked_seq: non_neg_integer(),
          pending_since: String.t() | nil
        }

  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    path = Keyword.get(opts, :path, default_path())
    GenServer.start_link(__MODULE__, {name, path}, name: name)
  end

  @doc "Binds an ack-capable wrapper process and returns its visible state."
  def bind(agent_id, generation, server \\ __MODULE__)
      when is_binary(agent_id) and is_binary(generation) and generation != "" do
    GenServer.call(server, {:bind, agent_id, generation})
  end

  @doc "Binds resynchronization to the current channel owner and process generation."
  def bind_resync(agent_id, generation, owner, server \\ __MODULE__) do
    GenServer.call(server, {:bind_resync, agent_id, generation, owner})
  end

  def acknowledge(agent_id, generation, owner, seq, server \\ __MODULE__) do
    GenServer.call(server, {:acknowledge, agent_id, generation, owner, seq})
  end

  def resync(agent_id, generation, owner, cutoff, ranges, server \\ __MODULE__) do
    GenServer.call(server, {:resync, agent_id, generation, owner, cutoff, ranges})
  end

  @doc "Disarms an old wrapper's projection; absence means unknown, not zero."
  def disarm(agent_id, server \\ __MODULE__) when is_binary(agent_id),
    do: GenServer.call(server, {:disarm, agent_id})

  @doc "Allocates one recipient-local delivery sequence when the capability is live."
  def issue(agent_id, server \\ __MODULE__) when is_binary(agent_id),
    do: GenServer.call(server, {:issue, agent_id})

  @doc "Advances a contiguous confirmation watermark. Invalid/future acks are no-ops."
  def ack(agent_id, seq, server \\ __MODULE__)

  def ack(agent_id, seq, server)
      when is_binary(agent_id) and is_integer(seq) and seq > 0,
      do: GenServer.call(server, {:ack, agent_id, seq})

  def ack(_agent_id, _seq, _server), do: :ignored

  def get(agent_id, server \\ __MODULE__) when is_binary(agent_id),
    do: GenServer.call(server, {:get, agent_id})

  def all(server \\ __MODULE__), do: GenServer.call(server, :all)

  @doc "A bounded join-time projection; the DETS-backed observation store is unchanged."
  def wire_projection, do: wire_projection(__MODULE__)

  def wire_projection(server) when not is_map(server) do
    wire_projection(all(server), AgentStates.connected_ids())
  end

  def wire_projection(deliveries) when is_map(deliveries) do
    wire_projection(deliveries, AgentStates.connected_ids())
  end

  @doc false
  def wire_projection(deliveries, connected_agent_ids)
      when is_map(deliveries) and is_struct(connected_agent_ids, MapSet) do
    {projected, incomplete?, _bytes} =
      deliveries
      |> Enum.sort_by(fn {agent_id, status} ->
        {if(priority_delivery?(agent_id, status, connected_agent_ids), do: 0, else: 1), agent_id}
      end)
      |> Enum.reduce({%{}, false, 0}, fn {agent_id, status}, {projected, incomplete?, bytes} ->
        entry_bytes = wire_entry_bytes(agent_id, status)

        cond do
          map_size(projected) >= TransportLimits.wire_projection_agents() ->
            {projected, true, bytes}

          bytes + entry_bytes + 1 <= @wire_projection_bytes ->
            {Map.put(projected, agent_id, status), incomplete?, bytes + entry_bytes}

          true ->
            {projected, true, bytes}
        end
      end)

    payload =
      if incomplete?,
        do: %{"deliveries" => projected, "snapshot_incomplete" => true},
        else: %{"deliveries" => projected}

    if TransportLimits.snapshot_frame_fits?("delivery_snapshot", payload) do
      {projected, incomplete?}
    else
      {%{}, true}
    end
  end

  def delete(agent_id, server \\ __MODULE__) when is_binary(agent_id),
    do: GenServer.call(server, {:delete, agent_id})

  @impl true
  def init({name, path}) do
    KaoiroServer.DetsStorePath.prepare_parent!(path)
    table = open_table(name, path)
    _ = File.chmod(path, 0o600)
    {:ok, %{table: table, entries: load_entries(table), owners: %{}}}
  end

  defp priority_delivery?(agent_id, status, connected_agent_ids) do
    MapSet.member?(connected_agent_ids, agent_id) or
      Map.get(status, :issued_seq, 0) > Map.get(status, :acked_seq, 0)
  end

  defp wire_entry_bytes(agent_id, status) do
    byte_size(Jason.encode!(agent_id)) + 1 + byte_size(Jason.encode!(status)) + 1
  end

  @impl true
  def handle_call({:bind, agent_id, generation}, _from, state) do
    {entry, changed?} =
      case Map.get(state.entries, agent_id) do
        %{generation: ^generation} = entry ->
          {entry, false}

        %{issued_seq: issued} = entry ->
          # A process replacement cannot ever ack deliveries addressed to the
          # old process. Close only that observational gap; the counter itself
          # remains monotonic for the recipient.
          {%{entry | generation: generation, acked_seq: issued, pending_since: nil}, true}

        nil ->
          {%{generation: generation, issued_seq: 0, acked_seq: 0, pending_since: nil}, true}
      end

    entry = if changed?, do: Map.merge(entry, recovery_defaults()), else: entry
    entry = Map.put(entry, :resync, false)
    persist(state.table, agent_id, entry)

    {:reply, public(entry),
     %{
       state
       | entries: Map.put(state.entries, agent_id, entry),
         owners: Map.delete(state.owners, agent_id)
     }}
  end

  def handle_call({:bind_resync, agent_id, generation, owner}, _from, state) do
    old = state.entries[agent_id]

    entry =
      if old != nil and old.generation == generation do
        Map.merge(recovery_defaults(), old)
      else
        issued = if old, do: old.issued_seq, else: 0

        Map.merge(recovery_defaults(), %{
          generation: generation,
          issued_seq: issued,
          acked_seq: issued,
          pending_since: nil
        })
      end
      |> Map.put(:resync, true)

    persist(state.table, agent_id, entry)

    {:reply, public(entry),
     %{
       state
       | entries: Map.put(state.entries, agent_id, entry),
         owners: Map.put(state.owners, agent_id, owner)
     }}
  end

  def handle_call({:acknowledge, agent_id, generation, owner, seq}, _from, state) do
    if owns_recovery?(state, agent_id, generation, owner) do
      acknowledge_entry(agent_id, seq, state)
    else
      {:reply, {:error, :stale_delivery_owner}, state}
    end
  end

  def handle_call({:resync, agent_id, generation, owner, cutoff, ranges}, _from, state) do
    entry = state.entries[agent_id]

    cond do
      not owns_recovery?(state, agent_id, generation, owner) ->
        {:reply, {:error, :stale_delivery_owner}, state}

      not valid_ranges?(ranges, cutoff, entry.issued_seq) ->
        {:reply, {:error, :invalid_delivery_resync}, state}

      true ->
        requested = for [first, last] <- ranges, seq <- first..last, do: seq
        previous = MapSet.new(entry.skipped)
        added = Enum.reject(requested, &(&1 <= entry.acked_seq or MapSet.member?(previous, &1)))

        next = %{
          entry
          | skipped: MapSet.union(previous, MapSet.new(added)) |> MapSet.to_list(),
            lost_count: entry.lost_count + length(added)
        }

        next =
          if added == [],
            do: next,
            else: %{
              next
              | last_loss: %{
                  at: DateTime.utc_now() |> DateTime.to_iso8601(),
                  first_seq: Enum.min(added),
                  last_seq: Enum.max(added),
                  count: length(added),
                  reason: "untraceable"
                }
            }

        next = advance_skipped(next)
        persist(state.table, agent_id, next)

        if added != [],
          do:
            Logger.warning(
              "inter-agent delivery loss recipient=#{agent_id} count=#{length(added)} first=#{Enum.min(added)} last=#{Enum.max(added)} reason=untraceable"
            )

        {:reply, {:ok, public(next)}, %{state | entries: Map.put(state.entries, agent_id, next)}}
    end
  end

  def handle_call({:disarm, agent_id}, _from, state) do
    if Map.has_key?(state.entries, agent_id) do
      :ok = :dets.delete(state.table, agent_id)
      :ok = :dets.sync(state.table)
    end

    {:reply, :ok,
     %{
       state
       | entries: Map.delete(state.entries, agent_id),
         owners: Map.delete(state.owners, agent_id)
     }}
  end

  def handle_call({:issue, agent_id}, _from, state) do
    case Map.get(state.entries, agent_id) do
      nil ->
        {:reply, nil, state}

      entry ->
        now = DateTime.utc_now() |> DateTime.to_iso8601()
        issued = entry.issued_seq + 1
        pending_since = entry.pending_since || now
        next = %{entry | issued_seq: issued, pending_since: pending_since}
        persist(state.table, agent_id, next)
        {:reply, issued, %{state | entries: Map.put(state.entries, agent_id, next)}}
    end
  end

  def handle_call({:ack, agent_id, seq}, _from, state) do
    if get_in(state.entries, [agent_id, :resync]) do
      {:reply, {:error, :stale_delivery_owner}, state}
    else
      acknowledge_entry(agent_id, seq, state)
    end
  end

  def handle_call({:get, agent_id}, _from, state),
    do: {:reply, state.entries[agent_id] && public(state.entries[agent_id]), state}

  def handle_call(:all, _from, state),
    do: {:reply, Map.new(state.entries, fn {id, entry} -> {id, public(entry)} end), state}

  def handle_call({:delete, agent_id}, _from, state) do
    :ok = :dets.delete(state.table, agent_id)
    :ok = :dets.sync(state.table)

    {:reply, :ok,
     %{
       state
       | entries: Map.delete(state.entries, agent_id),
         owners: Map.delete(state.owners, agent_id)
     }}
  end

  @impl true
  def terminate(_reason, state), do: :dets.close(state.table)

  defp acknowledge_entry(agent_id, seq, state) do
    case Map.get(state.entries, agent_id) do
      %{issued_seq: issued, acked_seq: acked} = entry
      when is_integer(seq) and seq > acked and seq <= issued ->
        next = %{
          entry
          | acked_seq: seq,
            pending_since: if(seq == issued, do: nil, else: entry.pending_since)
        }

        next = advance_skipped(next)
        persist(state.table, agent_id, next)
        {:reply, public(next), %{state | entries: Map.put(state.entries, agent_id, next)}}

      entry when is_map(entry) ->
        {:reply, public(entry), state}

      nil ->
        {:reply, nil, state}
    end
  end

  defp recovery_defaults, do: %{resync: false, skipped: [], lost_count: 0, last_loss: nil}

  defp owns_recovery?(state, id, generation, owner) do
    case state.entries[id] do
      %{generation: ^generation, resync: true} -> state.owners[id] == owner
      _ -> false
    end
  end

  defp valid_ranges?(ranges, cutoff, issued)
       when is_list(ranges) and is_integer(cutoff) and cutoff >= 0 and cutoff <= issued do
    length(ranges) in 1..256 and
      Enum.all?(ranges, fn
        [first, last] when is_integer(first) and is_integer(last) ->
          first > 0 and last >= first and last <= cutoff and last - first < 256

        _ ->
          false
      end) and
      Enum.reduce(ranges, 0, fn [first, last], count -> count + last - first + 1 end) <= 256 and
      Enum.reduce_while(ranges, 0, fn [first, last], previous ->
        if first > previous, do: {:cont, last}, else: {:halt, :invalid}
      end) != :invalid
  end

  defp valid_ranges?(_, _, _), do: false

  defp advance_skipped(entry) do
    skipped = MapSet.new(entry.skipped)
    acked = consume_skipped(entry.acked_seq, skipped)

    %{
      entry
      | acked_seq: acked,
        skipped: Enum.reject(entry.skipped, &(&1 <= acked)),
        pending_since: if(acked == entry.issued_seq, do: nil, else: entry.pending_since)
    }
  end

  defp consume_skipped(acked, skipped) do
    if MapSet.member?(skipped, acked + 1), do: consume_skipped(acked + 1, skipped), else: acked
  end

  defp public(%{issued_seq: issued, acked_seq: acked, pending_since: pending} = entry) do
    status = %{issued_seq: issued, acked_seq: acked, pending_since: pending}

    if entry.resync do
      Map.merge(status, %{lost_count: entry.lost_count, last_loss: entry.last_loss})
    else
      status
    end
  end

  defp persist(table, agent_id, %{generation: generation} = entry) do
    :ok =
      :dets.insert(
        table,
        {agent_id, generation, entry.issued_seq, entry.acked_seq, entry.pending_since,
         Map.take(entry, [:resync, :skipped, :lost_count, :last_loss])}
      )

    :ok = :dets.sync(table)
  end

  defp load_entries(table) do
    case :dets.foldl(
           fn
             {id, generation, issued, acked, pending, recovery}, acc when is_map(recovery) ->
               Map.put(
                 acc,
                 id,
                 Map.merge(
                   recovery_defaults(),
                   Map.merge(recovery, %{
                     generation: generation,
                     issued_seq: issued,
                     acked_seq: acked,
                     pending_since: pending
                   })
                 )
               )

             {id, generation, issued, acked, pending}, acc
             when is_binary(id) and is_binary(generation) and is_integer(issued) and issued >= 0 and
                    is_integer(acked) and acked >= 0 and acked <= issued and
                    (is_nil(pending) or is_binary(pending)) ->
               Map.put(
                 acc,
                 id,
                 Map.merge(recovery_defaults(), %{
                   generation: generation,
                   issued_seq: issued,
                   acked_seq: acked,
                   pending_since: pending
                 })
               )

             _, acc ->
               acc
           end,
           %{},
           table
         ) do
      entries when is_map(entries) -> entries
      _ -> %{}
    end
  end

  defp open_table(name, path) do
    case :dets.open_file(name, file: String.to_charlist(path)) do
      {:ok, ^name} ->
        name

      {:error, _reason} ->
        File.rm(path)
        {:ok, ^name} = :dets.open_file(name, file: String.to_charlist(path))
        name
    end
  end

  defp default_path do
    Application.get_env(:kaoiro_server, :delivery_states_path) ||
      KaoiroServer.DetsStorePath.default_path("delivery_states.dets")
  end
end
