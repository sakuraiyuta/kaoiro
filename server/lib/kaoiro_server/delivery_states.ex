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

  def retire(agent_id, generation, owner, cutoff, ranges, server \\ __MODULE__),
    do: GenServer.call(server, {:retire, agent_id, generation, owner, cutoff, ranges})

  @doc "Reserves capacity before conversation accounting; reservations never issue a sequence."
  def reserve(agent_id, owner, server \\ __MODULE__),
    do: GenServer.call(server, {:reserve, agent_id, owner})

  def release(reservation, server \\ __MODULE__),
    do: GenServer.call(server, {:release, reservation})

  def issue_reserved(agent_id, reservation, descriptor, server \\ __MODULE__),
    do: GenServer.call(server, {:issue_reserved, agent_id, reservation, descriptor})

  def issue_synthetic(agent_id, descriptor, server \\ __MODULE__),
    do: GenServer.call(server, {:issue_synthetic, agent_id, descriptor})

  def pending_losses(server \\ __MODULE__), do: GenServer.call(server, :pending_losses)

  def complete_loss(loss_id, revision, server \\ __MODULE__),
    do: GenServer.call(server, {:complete_loss, loss_id, revision})

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

    {:ok,
     %{
       table: table,
       entries: load_entries(table),
       owners: %{},
       reservations: %{},
       losses: load_losses(table)
     }}
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
    state = retire_generation(state, agent_id, nil)

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

    entry =
      if entry.resync,
        do: %{entry | acked_seq: entry.issued_seq, pending_since: nil, skipped: []},
        else: entry

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
    state = retire_generation(state, agent_id, generation)
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

  def handle_call({operation, agent_id, generation, owner, cutoff, ranges}, _from, state)
      when operation in [:resync, :retire] do
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

        loss_reason =
          cond do
            operation == :retire -> "interrupted"
            Enum.all?(added, &Map.has_key?(entry.metadata, &1)) -> "delivery_lost"
            true -> "untraceable"
          end

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
                  reason: loss_reason
                }
            }

        {next, state} =
          record_losses(
            agent_id,
            next,
            added,
            if(operation == :retire, do: "interrupted", else: "delivery_lost"),
            state
          )

        next = advance_skipped(next)
        persist_with_losses(state, agent_id, next)

        if added != [],
          do:
            Logger.warning(
              "inter-agent delivery loss recipient=#{agent_id} count=#{length(added)} first=#{Enum.min(added)} last=#{Enum.max(added)} reason=#{loss_reason}"
            )

        {:reply, {:ok, public(next)}, %{state | entries: Map.put(state.entries, agent_id, next)}}
    end
  end

  def handle_call({:disarm, agent_id}, _from, state) do
    state = retire_generation(state, agent_id, nil)

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

  def handle_call({:reserve, agent_id, owner}, _from, state) do
    entry = state.entries[agent_id]
    used = Enum.count(state.reservations, fn {_, r} -> r.agent_id == agent_id end)

    cond do
      entry == nil or not entry.resync ->
        {:reply, {:ok, nil}, state}

      map_size(entry.metadata) + used >= 1000 ->
        {:reply, {:error, :delivery_backlog}, state}

      true ->
        token = make_ref()
        reservation = %{agent_id: agent_id, owner: owner, monitor: Process.monitor(owner)}

        {:reply, {:ok, token},
         %{state | reservations: Map.put(state.reservations, token, reservation)}}
    end
  end

  def handle_call({:release, token}, _from, state),
    do: {:reply, :ok, release_reservation(state, token)}

  def handle_call({:issue_reserved, agent_id, token, descriptor}, {owner, _}, state) do
    case state.reservations[token] do
      %{agent_id: ^agent_id, owner: ^owner} ->
        issue_with_metadata(agent_id, descriptor, release_reservation(state, token))

      nil when is_nil(token) ->
        issue_with_metadata(agent_id, nil, state)

      _ ->
        {:reply, {:error, :invalid_delivery_reservation}, state}
    end
  end

  def handle_call({:issue_synthetic, agent_id, descriptor}, _from, state),
    do: issue_with_metadata(agent_id, descriptor, state)

  def handle_call(:pending_losses, _from, state), do: {:reply, Map.values(state.losses), state}

  def handle_call({:complete_loss, id, revision}, _from, state) do
    # Delivery can race a new retirement of the recovery notice itself.
    # Completing an older attempt must not delete that newer obligation.
    case state.losses[id] do
      %{revision: ^revision} ->
        :ok = :dets.delete(state.table, {:loss, id})
        :ok = :dets.sync(state.table)
        {:reply, :ok, %{state | losses: Map.delete(state.losses, id)}}

      _ ->
        {:reply, :stale, state}
    end
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
    state = retire_generation(state, agent_id, nil)
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
  def handle_info({:DOWN, ref, :process, _pid, _reason}, state) do
    reservations = Map.reject(state.reservations, fn {_, r} -> r.monitor == ref end)
    {:noreply, %{state | reservations: reservations}}
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

        next = %{
          next
          | metadata: Map.reject(next.metadata, fn {seq, _} -> seq <= next.acked_seq end)
        }

        persist(state.table, agent_id, next)
        {:reply, public(next), %{state | entries: Map.put(state.entries, agent_id, next)}}

      entry when is_map(entry) ->
        {:reply, public(entry), state}

      nil ->
        {:reply, nil, state}
    end
  end

  defp issue_with_metadata(agent_id, descriptor, state) do
    case state.entries[agent_id] do
      nil ->
        {:reply, nil, state}

      entry ->
        seq = entry.issued_seq + 1

        metadata =
          if entry.resync and is_map(descriptor),
            do: Map.put(entry.metadata, seq, descriptor),
            else: entry.metadata

        next = %{
          entry
          | issued_seq: seq,
            metadata: metadata,
            pending_since: entry.pending_since || DateTime.to_iso8601(DateTime.utc_now())
        }

        persist(state.table, agent_id, next)
        {:reply, seq, %{state | entries: Map.put(state.entries, agent_id, next)}}
    end
  end

  defp release_reservation(state, token) do
    case Map.pop(state.reservations, token) do
      {nil, _} ->
        state

      {reservation, rest} ->
        Process.demonitor(reservation.monitor, [:flush])
        %{state | reservations: rest}
    end
  end

  defp retire_generation(state, agent_id, generation) do
    case state.entries[agent_id] do
      %{generation: old} = entry when old != generation ->
        {next, state} =
          record_losses(agent_id, entry, Map.keys(entry.metadata), "interrupted", state)

        persist_with_losses(state, agent_id, next)
        %{state | entries: Map.put(state.entries, agent_id, next)}

      _ ->
        state
    end
  end

  defp record_losses(agent_id, entry, seqs, reason, state) do
    losses =
      Enum.reduce(seqs, state.losses, fn seq, acc ->
        case entry.metadata[seq] do
          nil ->
            acc

          descriptor ->
            generated_id =
              :crypto.hash(
                :sha256,
                :erlang.term_to_binary({agent_id, entry.incarnation, entry.generation, seq})
              )
              |> Base.url_encode64(padding: false)

            id = descriptor[:loss_id] || generated_id

            intent = %{
              id: id,
              revision: generated_id,
              recipient: agent_id,
              generation: entry.generation,
              seq: seq,
              descriptor: descriptor,
              reason: reason
            }

            Map.put(acc, id, intent)
        end
      end)

    {%{entry | metadata: Map.drop(entry.metadata, seqs)}, %{state | losses: losses}}
  end

  defp persist_with_losses(state, agent_id, entry) do
    # The retirement and its notification intent share one DETS insertion.
    records = Enum.map(state.losses, fn {id, loss} -> {{:loss, id}, loss} end)
    :ok = :dets.insert(state.table, [entry_record(agent_id, entry) | records])
    :ok = :dets.sync(state.table)
  end

  defp load_losses(table) do
    :dets.foldl(
      fn
        {{:loss, id}, loss}, acc when is_binary(id) and is_map(loss) -> Map.put(acc, id, loss)
        _, acc -> acc
      end,
      %{},
      table
    )
  end

  defp recovery_defaults do
    %{
      schema_version: 1,
      incarnation: Base.url_encode64(:crypto.strong_rand_bytes(16), padding: false),
      metadata: %{},
      resync: false,
      skipped: [],
      lost_count: 0,
      last_loss: nil
    }
  end

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

  defp entry_record(agent_id, entry) do
    {agent_id, entry.generation, entry.issued_seq, entry.acked_seq, entry.pending_since,
     Map.take(entry, [
       :schema_version,
       :incarnation,
       :metadata,
       :resync,
       :skipped,
       :lost_count,
       :last_loss
     ])}
  end

  defp persist(table, agent_id, entry) do
    :ok = :dets.insert(table, entry_record(agent_id, entry))
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
