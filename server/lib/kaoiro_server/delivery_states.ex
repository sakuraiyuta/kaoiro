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

  ## Retirement and loss intents

  A retirement writes its loss intents first, one DETS object each, and the
  recipient entry last. An intent alone cannot rebuild the retirement
  (`skipped`, `lost_count`, `last_loss`, the advanced prefix), so a crash
  between the two leaves an intent whose retirement never committed. `init/1`
  detects that intent by the entry still holding the sequence's metadata
  under the same incarnation and generation, and deletes it.

  Dropping it loses no notification only because the retirement runs again:
  the wrapper resends its pending resync on join, a bind under another
  generation retires the old one, and a disarm retires before it deletes.
  Each rebuilds the same intent from the metadata the entry still holds.

  Residual: an entry persisted before `incarnation` existed gets a fresh one
  on every load until it is next written, so an uncommitted intent for it is
  not recognised and can still be dispatched.
  """
  use GenServer
  require Logger

  alias KaoiroServer.AgentStates
  alias KaoiroServer.TransportLimits

  @early_release_stages ~w(submitted settled unknown lost)

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

  @doc "Retires every unresolved sequence owned by one live wrapper generation."
  def retire_owned_generation(agent_id, generation, owner, server \\ __MODULE__),
    do: GenServer.call(server, {:retire_owned_generation, agent_id, generation, owner})

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

  def incarnation(agent_id, server \\ __MODULE__) when is_binary(agent_id),
    do: GenServer.call(server, {:incarnation, agent_id})

  def report_stage(agent_id, generation, owner, report, server \\ __MODULE__),
    do: GenServer.call(server, {:report_stage, agent_id, generation, owner, report})

  def message_status(sender, conversation_id, turn_number, server \\ __MODULE__),
    do: GenServer.call(server, {:message_status, sender, conversation_id, turn_number})

  def pending_early(sender, recipient, server \\ __MODULE__),
    do: GenServer.call(server, {:pending_early, sender, recipient})

  def reserve_early(
        sender,
        recipient,
        reservation,
        pair_limit,
        recipient_limit,
        server \\ __MODULE__
      ),
      do:
        GenServer.call(
          server,
          {:reserve_early, sender, recipient, reservation, pair_limit, recipient_limit}
        )

  def unresolved_count(recipient, server \\ __MODULE__),
    do: GenServer.call(server, {:unresolved_count, recipient})

  def owns_delivery?(agent_id, generation, owner, incarnation, server \\ __MODULE__),
    do: GenServer.call(server, {:owns_delivery, agent_id, generation, owner, incarnation})

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

    entries = load_entries(table)

    stages =
      Enum.reduce(entries, %{}, fn {_, entry}, acc ->
        Map.merge(acc, entry.stage_history)
      end)

    {:ok,
     %{
       table: table,
       entries: entries,
       stages: stages,
       owners: %{},
       reservations: %{},
       losses: table |> load_losses() |> drop_uncommitted_losses(entries, table)
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
        do: %{entry | acked_seq: entry.issued_seq, pending_since: nil, skipped: [], resolved: []},
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
          pending_since: nil,
          stage_history: if(old, do: old.stage_history, else: %{}),
          uncertain_count: if(old, do: old.uncertain_count, else: 0),
          last_uncertain: if(old, do: old.last_uncertain, else: nil)
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
        resolved = MapSet.new(entry.resolved)

        added =
          Enum.reject(
            requested,
            &(&1 <= entry.acked_seq or MapSet.member?(previous, &1) or
                MapSet.member?(resolved, &1))
          )

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

        {next, state, intents} =
          record_losses(
            agent_id,
            next,
            added,
            if(operation == :retire, do: "interrupted", else: "delivery_lost"),
            state
          )

        next = advance_skipped(next)
        persist_with_losses(state, agent_id, next, intents)

        if added != [],
          do:
            Logger.warning(
              "inter-agent delivery loss recipient=#{agent_id} count=#{length(added)} first=#{Enum.min(added)} last=#{Enum.max(added)} reason=#{loss_reason}"
            )

        {:reply, {:ok, public(next)}, %{state | entries: Map.put(state.entries, agent_id, next)}}
    end
  end

  def handle_call({:retire_owned_generation, agent_id, generation, owner}, _from, state) do
    if owns_recovery?(state, agent_id, generation, owner) do
      entry = state.entries[agent_id]
      already_skipped = MapSet.new(entry.skipped)
      resolved = MapSet.new(entry.resolved)

      unresolved =
        if entry.acked_seq < entry.issued_seq do
          Enum.reject(
            (entry.acked_seq + 1)..entry.issued_seq,
            &(MapSet.member?(already_skipped, &1) or MapSet.member?(resolved, &1))
          )
        else
          []
        end

      next = %{
        entry
        | skipped: MapSet.union(already_skipped, MapSet.new(unresolved)) |> MapSet.to_list(),
          lost_count: entry.lost_count + length(unresolved)
      }

      next =
        if unresolved == [] do
          next
        else
          %{
            next
            | last_loss: %{
                at: DateTime.utc_now() |> DateTime.to_iso8601(),
                first_seq: Enum.min(unresolved),
                last_seq: Enum.max(unresolved),
                count: length(unresolved),
                reason: "interrupted"
              }
          }
        end

      {next, state, intents} = record_losses(agent_id, next, unresolved, "interrupted", state)
      next = advance_skipped(next)
      persist_with_losses(state, agent_id, next, intents)

      {:reply, {:ok, public(next)}, %{state | entries: Map.put(state.entries, agent_id, next)}}
    else
      {:reply, {:error, :stale_delivery_owner}, state}
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
         owners: Map.delete(state.owners, agent_id),
         stages: drop_agent_stages(state.stages, agent_id)
     }}
  end

  def handle_call({:reserve, agent_id, owner}, _from, state) do
    entry = state.entries[agent_id]
    used = Enum.count(state.reservations, fn {_, r} -> r.agent_id == agent_id end)

    cond do
      entry == nil or not entry.resync ->
        {:reply, {:ok, nil}, state}

      map_size(entry.metadata) + length(entry.resolved) + used >= 1000 ->
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

  def handle_call(
        {:reserve_early, sender, recipient, token, pair_limit, recipient_limit},
        {owner, _},
        state
      ) do
    reservation = state.reservations[token]
    {pair, total} = early_counts(state, sender, recipient)

    cond do
      reservation == nil or reservation.agent_id != recipient or reservation.owner != owner ->
        {:reply, {:error, :invalid_delivery_reservation}, state}

      reservation[:early_sender] == sender ->
        {:reply, :ok, state}

      reservation[:early_sender] != nil ->
        {:reply, {:error, :invalid_delivery_reservation}, state}

      pair >= pair_limit or total >= recipient_limit ->
        {:reply, {:error, :early_quota}, state}

      true ->
        next = Map.put(reservation, :early_sender, sender)

        {:reply, :ok, %{state | reservations: Map.put(state.reservations, token, next)}}
    end
  end

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

  def handle_call({:owns_delivery, agent_id, generation, owner, incarnation}, _from, state) do
    entry = state.entries[agent_id]

    result =
      owns_recovery?(state, agent_id, generation, owner) and
        entry.incarnation == incarnation

    {:reply, result, state}
  end

  def handle_call({:message_status, sender, cid, turn}, _from, state) do
    state = prune_stages(state)

    record =
      Enum.find_value(state.stages, fn {_key, by_seq} ->
        Enum.find_value(by_seq, fn {_seq, stage} ->
          if (is_nil(sender) or stage.sender == sender) and stage.conversation_id == cid and
               stage.turn_number == turn,
             do: stage
        end)
      end)

    {:reply,
     if(record, do: {:ok, Map.delete(record, :last_stage)}, else: {:ok, %{status: "expired"}}),
     state}
  end

  def handle_call({:pending_early, sender, recipient}, _from, state) do
    {:reply, early_counts(state, sender, recipient), state}
  end

  def handle_call({:unresolved_count, recipient}, _from, state) do
    count =
      case state.entries[recipient] do
        nil ->
          0

        entry ->
          max(
            0,
            entry.issued_seq - entry.acked_seq - length(entry.resolved) - length(entry.skipped)
          )
      end

    {:reply, count, state}
  end

  def handle_call({:report_stage, agent_id, generation, owner, report}, _from, state) do
    entry = state.entries[agent_id]
    seq = report["delivery_seq"]
    key = if entry, do: {agent_id, entry.incarnation}
    stage = if key, do: get_in(state.stages, [key, seq])
    disposition = report["yield_disposition"]
    uncertainty = phase3_uncertainty(stage, report)

    cond do
      entry != nil and report["incarnation"] != entry.incarnation ->
        {:reply, {:error, :stale_channel}, state}

      not owns_recovery?(state, agent_id, generation, owner) ->
        {:reply, {:error, :invalid_delivery_stage}, state}

      report["generation"] != generation or
        not is_integer(seq) or seq <= 0 or seq > entry.issued_seq or stage == nil ->
        {:reply, {:error, :invalid_delivery_stage}, state}

      report["stage"] not in ~w(queued submitted included settled unknown) ->
        {:reply, {:error, :invalid_delivery_stage}, state}

      not valid_stage_report?(report) ->
        {:reply, {:error, :invalid_delivery_stage}, state}

      uncertainty == :invalid ->
        {:reply, {:error, :invalid_delivery_stage}, state}

      uncertainty == :duplicate ->
        {:reply, :ok, state}

      stage[:yield_disposition] != nil and disposition != nil and
          disposition != stage.yield_disposition ->
        {:reply, {:error, :invalid_delivery_stage}, state}

      true ->
        at = report["at"] || DateTime.utc_now() |> DateTime.to_iso8601()
        stages = Map.put_new(stage.stages, report["stage"], at)

        next_stage =
          stage
          |> Map.put(:stages, stages)
          |> Map.put(:changed_at, at)
          |> Map.put(:last_stage, report["stage"])
          |> maybe_put(:yield_disposition, disposition)
          |> maybe_put(:mode, report["mode"])
          |> maybe_put(:handoff, report["handoff"])
          |> maybe_put(:evidence, report["evidence"])
          |> maybe_put(:reason, report["reason"])
          |> maybe_put(:uncertainty_qualified, if(uncertainty in [:resolve, :count], do: true))

        histories =
          entry.stage_history
          |> Map.put(key, Map.put(entry.stage_history[key] || %{}, seq, next_stage))
          |> bound_stage_histories()

        resolving? =
          (report["stage"] == "submitted" or uncertainty == :resolve) and
            seq > entry.acked_seq and
            seq not in entry.resolved and seq not in entry.skipped

        next_entry = %{entry | stage_history: histories}

        next_entry =
          if report["stage"] in @early_release_stages,
            do: %{next_entry | early_pending: Map.delete(entry.early_pending, seq)},
            else: next_entry

        next_entry =
          if resolving?,
            do: %{
              next_entry
              | metadata: Map.delete(entry.metadata, seq),
                resolved: [seq | entry.resolved]
            },
            else: next_entry

        next_entry =
          if uncertainty in [:resolve, :count],
            do: %{
              next_entry
              | uncertain_count: entry.uncertain_count + 1,
                last_uncertain: %{
                  at: at,
                  incarnation: entry.incarnation,
                  generation: generation,
                  delivery_seq: seq,
                  reason: report["reason"]
                }
            },
            else: next_entry

        with :ok <- :dets.insert(state.table, entry_record(agent_id, next_entry)),
             :ok <- :dets.sync(state.table) do
          {:reply, :ok,
           %{
             state
             | entries: Map.put(state.entries, agent_id, next_entry),
               stages: replace_agent_stages(state.stages, agent_id, histories)
           }}
        else
          error -> {:reply, {:error, error}, state}
        end
    end
  end

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

  def handle_call({:incarnation, agent_id}, _from, state),
    do: {:reply, get_in(state.entries, [agent_id, :incarnation]), state}

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
            early_pending:
              if(is_map(descriptor) and descriptor[:mode] == "early",
                do: Map.put(entry.early_pending, seq, descriptor[:sender]),
                else: entry.early_pending
              ),
            pending_since: entry.pending_since || DateTime.to_iso8601(DateTime.utc_now())
        }

        key = {agent_id, next.incarnation}

        histories =
          if is_map(descriptor) do
            at = DateTime.utc_now() |> DateTime.to_iso8601()

            stage = %{
              sender: descriptor[:sender],
              conversation_id: descriptor[:conversation_id],
              turn_number: descriptor[:turn_number],
              recipient: agent_id,
              incarnation: next.incarnation,
              generation: next.generation,
              delivery_seq: seq,
              stages: %{"accepted" => at},
              changed_at: at,
              last_stage: "accepted",
              mode: descriptor[:mode]
            }

            Map.update(entry.stage_history, key, %{seq => stage}, &Map.put(&1, seq, stage))
          else
            entry.stage_history
          end

        histories = bound_stage_histories(histories)
        next = %{next | stage_history: histories}
        :ok = :dets.insert(state.table, entry_record(agent_id, next))
        :ok = :dets.sync(state.table)

        {:reply, seq,
         %{
           state
           | entries: Map.put(state.entries, agent_id, next),
             stages: replace_agent_stages(state.stages, agent_id, histories)
         }}
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

  defp early_counts(state, sender, recipient) do
    entry = state.entries[recipient]
    accepted = if entry, do: Map.values(entry.early_pending), else: []

    held =
      for {_token, reservation} <- state.reservations,
          reservation.agent_id == recipient and is_binary(reservation[:early_sender]),
          do: reservation.early_sender

    pending = accepted ++ held
    {Enum.count(pending, &(&1 == sender)), length(pending)}
  end

  defp retire_generation(state, agent_id, generation) do
    case state.entries[agent_id] do
      %{generation: old} = entry when old != generation ->
        {next, state, intents} =
          record_losses(agent_id, entry, Map.keys(entry.metadata), "interrupted", state)

        persist_with_losses(state, agent_id, next, intents)
        %{state | entries: Map.put(state.entries, agent_id, next)}

      _ ->
        state
    end
  end

  defp record_losses(agent_id, entry, seqs, reason, state) do
    at = DateTime.utc_now() |> DateTime.to_iso8601()
    key = {agent_id, entry.incarnation}
    by_seq = entry.stage_history[key] || %{}

    by_seq =
      Enum.reduce(seqs, by_seq, fn seq, records ->
        Map.update(records, seq, nil, fn record ->
          Map.merge(record, %{
            stages: Map.put_new(record.stages, "lost", at),
            changed_at: at,
            last_stage: "lost"
          })
        end)
      end)

    by_seq = Map.reject(by_seq, fn {_seq, record} -> is_nil(record) end)

    histories =
      entry.stage_history
      |> Map.put(key, by_seq)
      |> bound_stage_histories()

    state = %{state | stages: replace_agent_stages(state.stages, agent_id, histories)}

    intents =
      for seq <- seqs, descriptor = entry.metadata[seq], descriptor != nil do
        revision = loss_revision(agent_id, entry.incarnation, entry.generation, seq)

        %{
          id: descriptor[:loss_id] || revision,
          revision: revision,
          recipient: agent_id,
          generation: entry.generation,
          seq: seq,
          descriptor: descriptor,
          reason: reason
        }
      end

    losses = Enum.reduce(intents, state.losses, &Map.put(&2, &1.id, &1))

    {%{
       entry
       | metadata: Map.drop(entry.metadata, seqs),
         early_pending: Map.drop(entry.early_pending, seqs),
         stage_history: histories
     }, %{state | losses: losses}, intents}
  end

  defp loss_revision(agent_id, incarnation, generation, seq) do
    :crypto.hash(:sha256, :erlang.term_to_binary({agent_id, incarnation, generation, seq}))
    |> Base.url_encode64(padding: false)
  end

  # Intents before the entry, one object each: see "Retirement and loss
  # intents" in the moduledoc for why this order is the recoverable one.
  defp persist_with_losses(state, agent_id, entry, intents) do
    Enum.each(intents, fn intent -> :ok = :dets.insert(state.table, loss_record(intent)) end)
    if intents != [], do: :ok = :dets.sync(state.table)

    :ok = :dets.insert(state.table, entry_record(agent_id, entry))
    :ok = :dets.sync(state.table)
  end

  defp loss_record(intent) do
    {{:loss, intent.id}, intent}
  end

  defp drop_uncommitted_losses(losses, entries, table) do
    {uncommitted, committed} =
      Enum.split_with(losses, fn {_id, loss} -> uncommitted_loss?(loss, entries) end)

    Enum.each(uncommitted, fn {id, loss} ->
      :ok = :dets.delete(table, {:loss, id})

      Logger.warning(
        "inter-agent delivery loss intent dropped: retirement never committed recipient=#{loss.recipient} seq=#{loss.seq}"
      )
    end)

    if uncommitted != [], do: :ok = :dets.sync(table)
    Map.new(committed)
  end

  # A committed retirement has already dropped the sequence's metadata, so an
  # entry that still holds it under the intent's own revision never retired it.
  defp uncommitted_loss?(%{recipient: recipient, seq: seq, revision: revision}, entries) do
    case entries[recipient] do
      %{metadata: metadata, incarnation: incarnation, generation: generation}
      when is_map_key(metadata, seq) ->
        loss_revision(recipient, incarnation, generation, seq) == revision

      _ ->
        false
    end
  end

  defp uncommitted_loss?(_loss, _entries), do: false

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

  defp valid_stage_report?(report) do
    valid_time?(report["at"]) and
      (report["mode"] == nil or report["mode"] in ~w(normal early yield)) and
      (report["handoff"] == nil or
         report["handoff"] in ~w(prompt_hook fold_hook exec_input_written turn_start_accepted tool_result turn_steer_accepted turn_steer_item_observed turn_steer_write_uncertain)) and
      (report["evidence"] == nil or report["evidence"] == "ticket_used") and
      (report["reason"] == nil or is_binary(report["reason"])) and
      (report["stage"] != "submitted" or is_binary(report["handoff"])) and
      (report["stage"] != "included" or report["evidence"] == "ticket_used") and
      valid_yield_disposition?(report["yield_disposition"])
  end

  @write_uncertain_reasons ~w(turn_steer_timeout turn_steer_disconnected turn_steer_invalid_response turn_steer_item_conflict)
  @post_submit_reasons ~w(turn_steer_not_observed turn_steer_no_valid_response turn_steer_item_conflict)

  defp phase3_uncertainty(nil, _report), do: :none

  defp phase3_uncertainty(%{uncertainty_qualified: true} = stage, report) do
    if report["stage"] == "unknown" and stage.last_stage == "unknown" and
         stage.reason == report["reason"] and report["mode"] == "early" and
         (report["handoff"] == nil or report["handoff"] == stage[:handoff]),
       do: :duplicate,
       else: :invalid
  end

  defp phase3_uncertainty(stage, %{"stage" => "unknown", "reason" => reason} = report)
       when reason in @write_uncertain_reasons or reason in @post_submit_reasons do
    cond do
      stage[:mode] != "early" or report["mode"] != "early" or
          Map.has_key?(stage.stages, "unknown") ->
        :invalid

      report["handoff"] == "turn_steer_write_uncertain" ->
        if reason in @write_uncertain_reasons and stage.last_stage in ~w(accepted queued) and
             not Map.has_key?(stage.stages, "submitted"),
           do: :resolve,
           else: :invalid

      report["handoff"] == nil and
          stage[:handoff] in ~w(turn_steer_accepted turn_steer_item_observed) ->
        if reason in @post_submit_reasons and stage.last_stage in ~w(submitted included) and
             Map.has_key?(stage.stages, "submitted"),
           do: :count,
           else: :invalid

      true ->
        :invalid
    end
  end

  defp phase3_uncertainty(_stage, %{"handoff" => "turn_steer_write_uncertain"}), do: :invalid
  defp phase3_uncertainty(_stage, _report), do: :none

  defp valid_yield_disposition?(nil), do: true

  defp valid_yield_disposition?(%{"outcome" => outcome, "at" => at} = value)
       when outcome in ~w(cut downgraded) do
    valid_time?(at) and (value["reason"] == nil or is_binary(value["reason"]))
  end

  defp valid_yield_disposition?(_), do: false

  defp valid_time?(value) when is_binary(value),
    do: match?({:ok, _, _}, DateTime.from_iso8601(value))

  defp valid_time?(_), do: false

  defp bound_stage_histories(histories) do
    config = Application.get_env(:kaoiro_server, :delivery_intent, [])
    now = System.system_time(:millisecond)
    max_age = Keyword.get(config, :delivery_stage_max_age_ms, 86_400_000)
    settled_age = Keyword.get(config, :delivery_stage_retention_ms, 3_600_000)
    max_records = Keyword.get(config, :delivery_stage_max_records, 2_000)

    live =
      histories
      |> Enum.flat_map(fn {key, by_seq} ->
        Enum.map(by_seq, fn {seq, record} -> {key, seq, record} end)
      end)
      |> Enum.reject(fn {_key, _seq, record} ->
        changed = stage_time_ms(record.changed_at)
        now - changed > if(terminal_record?(record), do: settled_age, else: max_age)
      end)

    overflow = max(length(live) - max_records, 0)

    live
    |> Enum.sort_by(fn {_key, _seq, record} ->
      {if(terminal_record?(record), do: 0, else: 1), stage_time_ms(record.changed_at)}
    end)
    |> Enum.drop(overflow)
    |> Enum.reduce(%{}, fn {key, seq, record}, acc ->
      Map.update(acc, key, %{seq => record}, &Map.put(&1, seq, record))
    end)
  end

  # The wrapper stops tracking a delivery once it reports `unknown`, so a record
  # whose latest report is `unknown` is as final as a settled one. Records
  # persisted before `last_stage` existed keep the settled/lost rule until
  # their next report gives them one.
  defp terminal_record?(record) do
    Map.has_key?(record.stages, "settled") or Map.has_key?(record.stages, "lost") or
      Map.get(record, :last_stage) == "unknown"
  end

  defp stage_time_ms(at) do
    case DateTime.from_iso8601(at) do
      {:ok, time, _offset} -> DateTime.to_unix(time, :millisecond)
      _ -> 0
    end
  end

  defp prune_stages(state) do
    entries =
      Map.new(state.entries, fn {agent_id, entry} ->
        histories = bound_stage_histories(entry.stage_history)

        if histories != entry.stage_history do
          entry = %{entry | stage_history: histories}
          persist(state.table, agent_id, entry)
          {agent_id, entry}
        else
          {agent_id, entry}
        end
      end)

    stages =
      Enum.reduce(entries, %{}, fn {_, entry}, acc ->
        Map.merge(acc, entry.stage_history)
      end)

    %{state | entries: entries, stages: stages}
  end

  defp drop_agent_stages(stages, agent_id),
    do: Map.reject(stages, fn {{id, _incarnation}, _by_seq} -> id == agent_id end)

  defp replace_agent_stages(stages, agent_id, histories),
    do: Map.merge(drop_agent_stages(stages, agent_id), histories)

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp recovery_defaults do
    %{
      schema_version: 1,
      incarnation: Base.url_encode64(:crypto.strong_rand_bytes(16), padding: false),
      metadata: %{},
      early_pending: %{},
      stage_history: %{},
      resync: false,
      skipped: [],
      resolved: [],
      lost_count: 0,
      last_loss: nil,
      uncertain_count: 0,
      last_uncertain: nil
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
    resolved = MapSet.new(entry.resolved)
    acked = consume_skipped(entry.acked_seq, MapSet.union(skipped, resolved))

    %{
      entry
      | acked_seq: acked,
        skipped: Enum.reject(entry.skipped, &(&1 <= acked)),
        resolved: Enum.reject(entry.resolved, &(&1 <= acked)),
        pending_since: if(acked == entry.issued_seq, do: nil, else: entry.pending_since)
    }
  end

  defp consume_skipped(acked, skipped) do
    if MapSet.member?(skipped, acked + 1), do: consume_skipped(acked + 1, skipped), else: acked
  end

  defp public(%{issued_seq: issued, acked_seq: acked, pending_since: pending} = entry) do
    status = %{issued_seq: issued, acked_seq: acked, pending_since: pending}

    if entry.resync do
      Map.merge(status, %{
        lost_count: entry.lost_count,
        last_loss: entry.last_loss,
        uncertain_count: entry.uncertain_count,
        last_uncertain: entry.last_uncertain
      })
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
       :early_pending,
       :stage_history,
       :resync,
       :skipped,
       :resolved,
       :lost_count,
       :last_loss,
       :uncertain_count,
       :last_uncertain
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
               entry =
                 Map.merge(
                   recovery_defaults(),
                   Map.merge(recovery, %{
                     generation: generation,
                     issued_seq: issued,
                     acked_seq: acked,
                     pending_since: pending
                   })
                 )

               entry =
                 if Map.has_key?(recovery, :early_pending),
                   do: entry,
                   else: %{entry | early_pending: legacy_early_pending(id, entry)}

               Map.put(acc, id, entry)

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

  defp legacy_early_pending(id, entry) do
    pending =
      Enum.reduce(entry.metadata, %{}, fn {seq, descriptor}, acc ->
        if descriptor[:mode] == "early" and is_binary(descriptor[:sender]),
          do: Map.put(acc, seq, descriptor[:sender]),
          else: acc
      end)

    entry.stage_history
    |> Map.get({id, entry.incarnation}, %{})
    |> Enum.reduce(pending, fn {seq, record}, acc ->
      if record[:mode] == "early" and is_binary(record[:sender]) do
        if Enum.any?(@early_release_stages, &Map.has_key?(record[:stages] || %{}, &1)),
          do: Map.delete(acc, seq),
          else: Map.put(acc, seq, record[:sender])
      else
        acc
      end
    end)
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
