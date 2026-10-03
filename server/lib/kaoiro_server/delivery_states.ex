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
  alias KaoiroServer.InterAgentQueue
  alias KaoiroServer.InterAgentQueueOps
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

  @doc """
  `bind_resync/4` for a `credit-v1` wrapper, binding its queue policy to the
  process generation. A rejoin under the same generation must declare the
  stored policy; otherwise nothing is bound and `{:error,
  :generation_mismatch}` is returned.
  """
  def bind_queue(agent_id, generation, owner, policy, server \\ __MODULE__)
      when is_map(policy),
      do: GenServer.call(server, {:bind_queue, agent_id, generation, owner, policy})

  @doc "Opaque identity of this queue owner's start; changes on every restart."
  def queue_epoch(server \\ __MODULE__), do: GenServer.call(server, :queue_epoch)

  @doc """
  Reserves queue capacity for one input to `agent_id`, monitored by the
  calling process. `kind` is `:ordinary`, `:waiter` or `:notice`. Returns
  `{:ok, token, class}`, `{:error, :receiver_overloaded}` or
  `{:error, :queue_unavailable}` when the recipient has no queue.
  """
  def queue_reserve(agent_id, kind, bytes, server \\ __MODULE__),
    do: GenServer.call(server, {:queue_reserve, agent_id, kind, bytes})

  @doc """
  Commits a reservation as a queued item and installs its body, in one
  call, so no offer can see one without the other. Only the reserving
  process may commit.
  """
  def queue_commit(agent_id, token, descriptor, body, server \\ __MODULE__),
    do: GenServer.call(server, {:queue_commit, agent_id, token, descriptor, body})

  def queue_cancel(token, server \\ __MODULE__),
    do: GenServer.call(server, {:queue_cancel, token})

  @doc """
  Offers queued items to the recipient's current delivery owner and
  allocates their sequences. `request` is `:root`, `{:early, :fold | :steer,
  native_turn, running}` (running: `%{peers:, conversations:}` MapSets) or
  `{:recovery, queue_ids}`. Returns `{:ok, offer}` with each item's body,
  `:empty`, or `{:error, reason}`.
  """
  def queue_offer(agent_id, generation, owner, request, server \\ __MODULE__),
    do: GenServer.call(server, {:queue_offer, agent_id, generation, owner, request})

  @doc "Permits native submission of offered lease items."
  def queue_begin_native(agent_id, generation, owner, lease_id, queue_ids, server \\ __MODULE__),
    do:
      GenServer.call(
        server,
        {:queue_lease, :begin_native, agent_id, generation, owner, lease_id, queue_ids, nil}
      )

  @doc "Returns lease items to their queue position: `entries` is `[{queue_id, reason}]`."
  def queue_return(agent_id, generation, owner, lease_id, entries, turn, server \\ __MODULE__),
    do:
      GenServer.call(
        server,
        {:queue_lease, :return, agent_id, generation, owner, lease_id, entries, turn}
      )

  @doc "Applies per-item outcomes: `entries` is `[{queue_id, outcome}]`."
  def queue_dispose(agent_id, generation, owner, lease_id, entries, turn, server \\ __MODULE__),
    do:
      GenServer.call(
        server,
        {:queue_lease, :dispose, agent_id, generation, owner, lease_id, entries, turn}
      )

  @doc """
  Applies one `delivery_queue_control` operation from the recipient's
  delivery owner. `request` is the parsed op (see `queue_control_op/4`).
  Returns `{:ok, reply}` or `{:error, reason}`; reasons are the wire
  control errors. An offer the operation makes possible is sent to the
  owner as `{:inter_agent_queue_batch, payload}`.
  """
  def queue_control(agent_id, generation, owner, operation_id, request, server \\ __MODULE__),
    do:
      GenServer.call(server, {:queue_control, agent_id, generation, owner, operation_id, request})

  @doc """
  Claims `agent_id`'s queued input from `peer` on conversation `cid` for a
  `stale_reply_basis` refusal (r8 §6.3): oldest first, ordinary input only,
  at most 10 items and 16384 bytes of body charge, as one recovery
  lease that takes the ordinary lease slot. Returns the wire
  `queue_recovery` map, or nil when nothing can be claimed.
  """
  def queue_claim_recovery(agent_id, generation, owner, peer, cid, server \\ __MODULE__),
    do: GenServer.call(server, {:queue_claim_recovery, agent_id, generation, owner, peer, cid})

  @doc """
  Installs `agent_id`'s waiter registration for a waiting send to `peer` on
  `cid` (r8 §6.1), replacing an unclaimed one on the same conversation.
  `registration` carries `:peer`, `:cid`, `:turn`, `:token`, `:call_token`
  and `:expires_in_ms`. Returns `{:ok, registration_id}`.
  """
  def queue_register_waiter(agent_id, generation, owner, registration, server \\ __MODULE__),
    do:
      GenServer.call(server, {:queue_register_waiter, agent_id, generation, owner, registration})

  @doc "Removes an unclaimed registration after its send was refused."
  def queue_unregister_waiter(agent_id, registration_id, server \\ __MODULE__),
    do: GenServer.call(server, {:queue_unregister_waiter, agent_id, registration_id})

  @doc """
  `queue_reserve/4` for a reply from `sender` on `cid`: when it matches a
  live registration of the recipient, the registration is claimed and the
  reply is admitted as a waiter item outside P and M; otherwise it is an
  ordinary reservation. Returns `{:ok, token, class}` or an error.
  """
  def queue_reserve_reply(agent_id, sender, cid, bytes, server \\ __MODULE__),
    do: GenServer.call(server, {:queue_reserve_reply, agent_id, sender, cid, bytes})

  @doc "Whether the recipient's current generation must `resume` before new credit."
  def queue_resume_required?(agent_id, server \\ __MODULE__),
    do: GenServer.call(server, {:queue_resume_required, agent_id})

  @doc "Wire queue counts for a recipient, or nil when it has no queue."
  def queue_counts(agent_id, server \\ __MODULE__),
    do: GenServer.call(server, {:queue_counts, agent_id})

  def acknowledge(agent_id, generation, owner, seq, server \\ __MODULE__) do
    GenServer.call(server, {:acknowledge, agent_id, generation, owner, seq})
  end

  def resync(agent_id, generation, owner, cutoff, ranges, server \\ __MODULE__),
    do:
      without_queue(resync_detailed(:resync, agent_id, generation, owner, cutoff, ranges, server))

  def retire(agent_id, generation, owner, cutoff, ranges, server \\ __MODULE__),
    do:
      without_queue(resync_detailed(:retire, agent_id, generation, owner, cutoff, ranges, server))

  @doc """
  `resync/6` or `retire/6` that also reports what happened to queue-origin
  sequences in the ranges: `{:ok, status, %{returned:, uncertain:,
  skipped:}}`, each a list of `[first, last]` ranges; `skipped` is the
  request without the queue-origin sequences, which are never recorded as
  losses.
  """
  def resync_detailed(
        operation,
        agent_id,
        generation,
        owner,
        cutoff,
        ranges,
        server \\ __MODULE__
      )
      when operation in [:resync, :retire],
      do: GenServer.call(server, {operation, agent_id, generation, owner, cutoff, ranges})

  defp without_queue({:ok, status, _queue}), do: {:ok, status}
  defp without_queue(other), do: other

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

  @doc """
  Queue items resolved as unknown, with their descriptors, kept until the
  sender is told that delivery may have happened (r8 §7). Includes those of
  recipients whose record has since been removed.
  """
  def pending_queue_uncertain(server \\ __MODULE__),
    do: GenServer.call(server, :pending_queue_uncertain)

  @doc "Removes one uncertain obligation once its sender notice was accepted."
  def complete_queue_uncertain(recipient, queue_id, server \\ __MODULE__),
    do: GenServer.call(server, {:complete_queue_uncertain, recipient, queue_id})

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
    losses = table |> load_losses() |> drop_uncommitted_losses(entries, table)

    # Bodies live only in memory, so every retained item is gone with them.
    {entries, losses} =
      Enum.reduce(entries, {entries, losses}, fn {agent_id, entry}, {entries, losses} ->
        case drop_queue(agent_id, entry, losses, "server_restart") do
          {_entry, _losses, []} ->
            {entries, losses}

          {entry, losses, intents} ->
            persist_with_losses(%{table: table}, agent_id, entry, intents)
            {Map.put(entries, agent_id, entry), losses}
        end
      end)

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
       losses: losses,
       orphan_uncertain: load_orphan_uncertain(table),
       queue_epoch: Base.url_encode64(:crypto.strong_rand_bytes(16), padding: false),
       queue_reservations: %{},
       bodies: %{},
       queue_controls: %{}
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
    state =
      case state.entries[agent_id] do
        %{generation: old, resync: resync} when old != generation or resync ->
          release_leases(state, agent_id, "epoch_changed")

        _ ->
          state
      end

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

    entry =
      if changed?,
        do:
          Map.merge(entry, %{
            recovery_defaults()
            | queue: Map.get(entry, :queue),
              queue_uncertain: Map.get(entry, :queue_uncertain, [])
          }),
        else: entry

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
    {entry, state} = bind_resync_entry(state, agent_id, generation, owner, & &1)
    {:reply, public(entry), state}
  end

  def handle_call({:bind_queue, agent_id, generation, owner, policy}, _from, state) do
    case state.entries[agent_id] do
      %{generation: ^generation, queue_policy: bound} when bound not in [nil, policy] ->
        {:reply, {:error, :generation_mismatch}, state}

      _ ->
        {entry, state} =
          bind_resync_entry(state, agent_id, generation, owner, fn entry ->
            # A lower policy never evicts admitted items; it only gates
            # later admission. Bound before the control state below.
            queue =
              if entry.queue,
                do: %{entry.queue | policy: policy},
                else: InterAgentQueue.new(policy)

            %{entry | queue_policy: policy, queue: queue}
          end)

        {:reply, {:ok, public(entry)}, bind_queue_control(state, agent_id, entry)}
    end
  end

  def handle_call(:queue_epoch, _from, state), do: {:reply, state.queue_epoch, state}

  def handle_call({:queue_claim_recovery, agent_id, generation, owner, peer, cid}, _from, state) do
    with {:ok, entry} <- queue_owner_entry(state, agent_id, generation, owner),
         %{frozen: false, resume_required: false} <- state.queue_controls[agent_id],
         [_ | _] = ids <- recovery_candidates(entry.queue, peer, cid),
         {:ok, queue, offer, next_seq} <-
           InterAgentQueue.offer_recovery(entry.queue, ids, entry.issued_seq + 1) do
      {entry, state} = commit_offer(state, agent_id, entry, queue, offer, next_seq)
      payload = batch_payload(state, agent_id, entry, %{kind: :recovery, revision: nil}, offer)

      {:reply, %{"lease_id" => payload["lease_id"], "items" => payload["items"]}, state}
    else
      _ -> {:reply, nil, state}
    end
  end

  def handle_call({:queue_resume_required, agent_id}, _from, state),
    do: {:reply, get_in(state.queue_controls, [agent_id, :resume_required]) == true, state}

  def handle_call(
        {:queue_control, agent_id, generation, owner, operation_id, request},
        _from,
        state
      ) do
    with {:ok, entry} <- queue_owner_entry(state, agent_id, generation, owner),
         %{generation: ^generation} = control <- state.queue_controls[agent_id],
         {:ok, id} <- control_operation_id(operation_id) do
      digest = :crypto.hash(:sha256, :erlang.term_to_binary(request))

      case InterAgentQueueOps.classify(
             control.ops,
             id,
             digest,
             &queue_attempt_phase(entry.queue, &1)
           ) do
        {:replay, reply} ->
          {:reply, {:ok, reply}, state}

        {:error, {:operation_superseded, phases}} ->
          wire = for {queue_id, phase} <- phases, do: {queue_id, plain_phase(phase)}
          {:reply, {:error, {:operation_superseded, wire}}, state}

        {:error, _} = error ->
          {:reply, error, state}

        :new ->
          case run_queue_control(state, agent_id, entry, control, request) do
            {:ok, state, reply, record} ->
              state = record_queue_control(state, agent_id, id, digest, reply, record)
              {:reply, {:ok, reply}, maybe_offer(state, agent_id)}

            {:error, _} = error ->
              {:reply, error, state}
          end
      end
    else
      {:error, _} = error -> {:reply, error, state}
      :error -> {:reply, {:error, {:invalid_queue_control, "operation_id"}}, state}
      _ -> {:reply, {:error, :stale_channel}, state}
    end
  end

  def handle_call(
        {:queue_register_waiter, agent_id, generation, owner, registration},
        _from,
        state
      ) do
    with {:ok, entry} <- queue_owner_entry(state, agent_id, generation, owner),
         %{generation: ^generation} = control <- state.queue_controls[agent_id] do
      id = Integer.to_string(control.next_waiter)

      waiter = %{
        id: id,
        peer: registration.peer,
        turn: registration.turn,
        call_token: registration.call_token,
        token_hash: :crypto.hash(:sha256, registration.token),
        expires_at: System.monotonic_time(:millisecond) + registration.expires_in_ms,
        claimed: nil
      }

      waiters =
        control.waiters
        |> Map.reject(fn {_cid, waiter} -> settled_waiter?(waiter, entry.queue) end)
        |> Map.update(registration.cid, waiter, fn
          %{claimed: nil} -> waiter
          claimed -> claimed
        end)

      control = %{control | waiters: waiters, next_waiter: control.next_waiter + 1}

      if waiters[registration.cid].id == id,
        do: {:reply, {:ok, id}, put_in(state.queue_controls[agent_id], control)},
        else: {:reply, {:error, :waiter_claimed}, state}
    else
      {:error, _} = error -> {:reply, error, state}
      _ -> {:reply, {:error, :stale_channel}, state}
    end
  end

  def handle_call({:queue_unregister_waiter, agent_id, registration_id}, _from, state) do
    case state.queue_controls[agent_id] do
      nil ->
        {:reply, :ok, state}

      control ->
        waiters =
          Map.reject(control.waiters, fn {_cid, waiter} ->
            waiter.id == registration_id and waiter.claimed == nil
          end)

        {:reply, :ok, put_in(state.queue_controls[agent_id], %{control | waiters: waiters})}
    end
  end

  def handle_call({:queue_reserve_reply, agent_id, sender, cid, bytes}, {owner, _}, state) do
    now = System.monotonic_time(:millisecond)

    case get_in(state.queue_controls, [agent_id, :waiters, cid]) do
      %{peer: ^sender, claimed: nil, expires_at: expires_at} = waiter when expires_at > now ->
        case reserve_in_queue(state, agent_id, owner, :waiter, bytes) do
          {:ok, token, class, state} ->
            state =
              state
              |> put_in([:queue_controls, agent_id, :waiters, cid, :claimed], {:reserved, token})
              |> put_in([:queue_reservations, token, :waiter], {cid, waiter.id})

            {:reply, {:ok, token, class}, state}

          {:error, _} = error ->
            {:reply, error, state}
        end

      _ ->
        handle_call({:queue_reserve, agent_id, :ordinary, bytes}, {owner, nil}, state)
    end
  end

  def handle_call({:queue_reserve, agent_id, kind, bytes}, {owner, _}, state) do
    case reserve_in_queue(state, agent_id, owner, kind, bytes) do
      {:ok, token, class, state} -> {:reply, {:ok, token, class}, state}
      {:error, _} = error -> {:reply, error, state}
    end
  end

  def handle_call({:queue_commit, agent_id, token, descriptor, body}, {owner, _}, state) do
    with %{agent_id: ^agent_id, owner: ^owner} = reservation <- state.queue_reservations[token],
         %{queue: %{} = queue} = entry <- state.entries[agent_id],
         {:ok, queue, queue_id} <- InterAgentQueue.commit(queue, token, descriptor) do
      Process.demonitor(reservation.monitor, [:flush])
      entry = %{entry | queue: queue}
      persist(state.table, agent_id, entry)

      state = %{
        state
        | entries: Map.put(state.entries, agent_id, entry),
          queue_reservations: Map.delete(state.queue_reservations, token),
          bodies: Map.put(state.bodies, {agent_id, queue_id}, body)
      }

      state =
        case reservation[:waiter] do
          {cid, registration_id} ->
            offer_matched_waiter(state, agent_id, cid, registration_id, queue_id)

          nil ->
            maybe_offer(state, agent_id)
        end

      {:reply, {:ok, queue_id}, state}
    else
      _ -> {:reply, {:error, :invalid_queue_reservation}, state}
    end
  end

  def handle_call({:queue_cancel, token}, _from, state),
    do: {:reply, :ok, cancel_queue_reservation(state, token)}

  def handle_call({:queue_counts, agent_id}, _from, state) do
    case state.entries[agent_id] do
      %{queue: %{} = queue} -> {:reply, InterAgentQueue.counts(queue), state}
      _ -> {:reply, nil, state}
    end
  end

  def handle_call({:queue_offer, agent_id, generation, owner, request}, _from, state) do
    with {:ok, entry} <- queue_owner_entry(state, agent_id, generation, owner),
         {:ok, queue, offer, next_seq} <- offer(entry.queue, request, entry.issued_seq + 1) do
      {entry, state} = commit_offer(state, agent_id, entry, queue, offer, next_seq)

      items =
        Enum.map(offer.items, fn item ->
          Map.merge(item, %{
            attempt: queue.items[item.queue_id].attempt,
            byte_charge: queue.items[item.queue_id].bytes,
            body: state.bodies[{agent_id, item.queue_id}]
          })
        end)

      _ = entry
      {:reply, {:ok, %{offer | items: items}}, state}
    else
      :empty -> {:reply, :empty, state}
      {:error, _} = error -> {:reply, error, state}
    end
  end

  def handle_call(
        {:queue_lease, op, agent_id, generation, owner, lease_id, entries, turn},
        _from,
        state
      ) do
    with {:ok, entry} <- queue_owner_entry(state, agent_id, generation, owner),
         {:ok, state, _entry, result} <-
           apply_lease_op(state, agent_id, entry, op, lease_id, entries, turn) do
      {:reply, {:ok, result}, state}
    else
      {:error, _} = error -> {:reply, error, state}
    end
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

      get_in(state.queue_controls, [agent_id, :resume_required]) == true ->
        {:reply, {:error, :queue_resume_required}, state}

      true ->
        requested = for [first, last] <- ranges, seq <- first..last, do: seq

        # Queue-origin sequences resolve as returned or uncertain, never as
        # losses; resolving them first keeps them out of `added` below.
        {state, entry, queue_result} =
          release_queue_sequences(state, agent_id, entry, requested, "delivery_resync")

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

        queue_seqs = queue_result.returned ++ queue_result.uncertain

        {:reply,
         {:ok, public(next),
          %{
            returned: ranges(queue_result.returned),
            uncertain: ranges(queue_result.uncertain),
            skipped: if(queue_seqs == [], do: ranges, else: ranges(requested -- queue_seqs))
          }}, %{state | entries: Map.put(state.entries, agent_id, next)}}
    end
  end

  def handle_call({:retire_owned_generation, agent_id, generation, owner}, _from, state) do
    if owns_recovery?(state, agent_id, generation, owner) do
      entry = state.entries[agent_id]

      # A stopped recipient keeps its queue (r8b B6): its outstanding
      # offers go back, native-pending items become unknown.
      {state, entry, _queue_result} =
        release_queue_sequences(
          state,
          agent_id,
          entry,
          leased_sequences(entry.queue),
          "shutdown"
        )

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
    state = state |> retire_generation(agent_id, nil) |> retire_queue(agent_id)

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
     if(record,
       do: {:ok, Map.drop(record, [:last_stage, :origin])},
       else: {:ok, %{status: "expired"}}
     ), state}
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
          # Queued items have no sequence yet, so they are added on top.
          max(
            0,
            entry.issued_seq - entry.acked_seq - length(entry.resolved) - length(entry.skipped)
          ) + queued_count(entry.queue)
      end

    {:reply, count, state}
  end

  def handle_call({:report_stage, agent_id, generation, owner, report}, _from, state) do
    entry = state.entries[agent_id]
    seq = report["delivery_seq"]
    key = if entry, do: {agent_id, entry.incarnation}
    stage = if key, do: get_in(state.stages, [key, seq])
    disposition = report["yield_disposition"]
    # A queue item is settled only by its own lease operations.
    queue_origin? = stage[:origin] == :queue
    uncertainty = if queue_origin?, do: :none, else: phase3_uncertainty(stage, report)

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
            seq not in entry.resolved and seq not in entry.skipped and
            not queue_origin?

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

  def handle_call(:pending_queue_uncertain, _from, state) do
    held =
      for {agent_id, entry} <- state.entries,
          obligation <- entry.queue_uncertain,
          do: Map.put(obligation, :recipient, agent_id)

    {:reply, held ++ Map.values(state.orphan_uncertain), state}
  end

  def handle_call({:complete_queue_uncertain, recipient, queue_id}, _from, state) do
    orphan = "#{recipient}:#{queue_id}"

    state =
      cond do
        Map.has_key?(state.orphan_uncertain, orphan) ->
          :ok = :dets.delete(state.table, {:queue_uncertain, orphan})
          :ok = :dets.sync(state.table)
          %{state | orphan_uncertain: Map.delete(state.orphan_uncertain, orphan)}

        entry = state.entries[recipient] ->
          kept = Enum.reject(entry.queue_uncertain, &(&1.queue_id == queue_id))

          if kept == entry.queue_uncertain do
            state
          else
            entry = %{entry | queue_uncertain: kept}
            persist(state.table, recipient, entry)
            %{state | entries: Map.put(state.entries, recipient, entry)}
          end

        true ->
          state
      end

    {:reply, :ok, state}
  end

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
    state = state |> retire_generation(agent_id, nil) |> retire_queue(agent_id)
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

    state =
      state.queue_reservations
      |> Enum.filter(fn {_token, r} -> r.monitor == ref end)
      |> Enum.reduce(%{state | reservations: reservations}, fn {token, _}, state ->
        cancel_queue_reservation(state, token)
      end)

    {:noreply, state}
  end

  @impl true
  def terminate(_reason, state), do: :dets.close(state.table)

  defp acknowledge_entry(agent_id, seq, state) do
    case Map.get(state.entries, agent_id) do
      %{issued_seq: issued, acked_seq: acked} = entry
      when is_integer(seq) and seq > acked and seq <= issued ->
        acknowledge_entry_below_queue(agent_id, entry, seq, state)

      entry when is_map(entry) ->
        {:reply, public(entry), state}

      nil ->
        {:reply, nil, state}
    end
  end

  # A cumulative acknowledgement never resolves a queue-origin sequence,
  # which only return, dispose and resync resolve; it stops below the oldest
  # one still pending.
  defp acknowledge_entry_below_queue(agent_id, entry, seq, state) do
    seq =
      case oldest_pending_queue_seq(entry.queue) do
        nil -> seq
        oldest -> min(seq, oldest - 1)
      end

    if seq > entry.acked_seq do
      next = %{
        entry
        | acked_seq: seq,
          pending_since: if(seq == entry.issued_seq, do: nil, else: entry.pending_since)
      }

      next = advance_skipped(next)

      next = %{
        next
        | metadata: Map.reject(next.metadata, fn {seq, _} -> seq <= next.acked_seq end)
      }

      persist(state.table, agent_id, next)
      {:reply, public(next), %{state | entries: Map.put(state.entries, agent_id, next)}}
    else
      {:reply, public(entry), state}
    end
  end

  defp release_queue_sequences(state, _agent_id, %{queue: nil} = entry, _seqs, _reason),
    do: {state, entry, %{returned: [], uncertain: [], disposed: []}}

  defp release_queue_sequences(state, agent_id, entry, seqs, reason) do
    {queue, result} = InterAgentQueue.release_sequences(entry.queue, seqs, reason)
    entry = resolve_queue_sequences(%{entry | queue: queue}, result, fn _ -> reason end)
    bodies = Map.drop(state.bodies, Enum.map(result.disposed, &{agent_id, &1}))

    {%{state | entries: Map.put(state.entries, agent_id, entry), bodies: bodies}, entry, result}
  end

  defp release_leases(state, agent_id, reason) do
    entry = state.entries[agent_id]

    {state, _entry, _result} =
      release_queue_sequences(state, agent_id, entry, leased_sequences(entry.queue), reason)

    state
  end

  defp leased_sequences(nil), do: []

  defp leased_sequences(queue),
    do: for({_id, %{delivery_seq: seq}} <- queue.items, seq != nil, do: seq)

  defp oldest_pending_queue_seq(nil), do: nil

  defp oldest_pending_queue_seq(queue) do
    queue.items
    |> Map.values()
    |> Enum.flat_map(fn item -> if item.delivery_seq, do: [item.delivery_seq], else: [] end)
    |> Enum.min(fn -> nil end)
  end

  # Every offer's ledger side: sequences issued, and a stage record per item
  # so stage reports are kept as history (they never resolve a queue item).
  defp commit_offer(state, agent_id, entry, queue, offer, next_seq) do
    at = DateTime.utc_now() |> DateTime.to_iso8601()
    key = {agent_id, entry.incarnation}

    by_seq =
      Enum.reduce(offer.items, entry.stage_history[key] || %{}, fn item, acc ->
        queued = queue.items[item.queue_id]

        Map.put(acc, item.delivery_seq, %{
          sender: queued.sender,
          conversation_id: queued.conversation_id,
          turn_number: queued.turn_number,
          recipient: agent_id,
          incarnation: entry.incarnation,
          generation: entry.generation,
          delivery_seq: item.delivery_seq,
          stages: %{"accepted" => at},
          changed_at: at,
          last_stage: "accepted",
          mode: if(offer.kind == :early, do: "early", else: "normal"),
          origin: :queue
        })
      end)

    histories = entry.stage_history |> Map.put(key, by_seq) |> bound_stage_histories()

    entry = %{
      entry
      | queue: queue,
        issued_seq: next_seq - 1,
        pending_since: entry.pending_since || at,
        stage_history: histories
    }

    persist(state.table, agent_id, entry)

    {entry,
     %{
       state
       | entries: Map.put(state.entries, agent_id, entry),
         stages: replace_agent_stages(state.stages, agent_id, histories)
     }}
  end

  @doc false
  # The one guarantee for the ledger (r8 §7): a sequence held by a live
  # queue item is resolved only by the queue's own transitions, which take
  # the item out first. Every durable write passes here, so no other path
  # (ack, resync, retire, stage, bind, restart) can store it as acked,
  # skipped or resolved.
  def queue_ledger_violation(entry) do
    live = live_queue_seqs(entry.queue)
    skipped = MapSet.new(entry.skipped)
    resolved = MapSet.new(entry.resolved)

    Enum.find(live, fn seq ->
      seq <= entry.acked_seq or MapSet.member?(skipped, seq) or MapSet.member?(resolved, seq)
    end)
  end

  defp live_queue_seqs(nil), do: MapSet.new()

  defp live_queue_seqs(queue) do
    for {_id, %{delivery_seq: seq}} <- queue.items, seq != nil, into: MapSet.new(), do: seq
  end

  defp queue_owner_entry(state, agent_id, generation, owner) do
    case state.entries[agent_id] do
      %{queue: %{}} = entry ->
        if owns_recovery?(state, agent_id, generation, owner),
          do: {:ok, entry},
          else: {:error, :stale_delivery_owner}

      _ ->
        {:error, :queue_unavailable}
    end
  end

  defp offer(queue, :root, next_seq), do: InterAgentQueue.offer_root(queue, next_seq)

  defp offer(queue, {:early, mechanism, turn, running}, next_seq),
    do: InterAgentQueue.offer_early(queue, mechanism, turn, running, next_seq)

  defp offer(queue, {:recovery, ids}, next_seq),
    do: InterAgentQueue.offer_recovery(queue, ids, next_seq)

  defp lease_op(queue, :begin_native, lease_id, ids, _turn) do
    with {:ok, queue, permitted} <- InterAgentQueue.begin_native(queue, lease_id, ids),
         do: {:ok, queue, %{permitted: permitted}}
  end

  defp lease_op(queue, :return, lease_id, entries, turn) do
    with {:ok, queue, returned} <- InterAgentQueue.return(queue, lease_id, entries, turn),
         do: {:ok, queue, %{returned: returned}}
  end

  defp lease_op(queue, :dispose, lease_id, entries, turn),
    do: InterAgentQueue.dispose(queue, lease_id, entries, turn)

  # Returned, resolved and uncertain queue-origin sequences all leave the
  # unresolved range. An unknown item also leaves its descriptor as an
  # obligation, so the sender can be told that delivery may have happened.
  defp resolve_queue_sequences(entry, result, reason_of) do
    seqs = Enum.flat_map([:returned, :resolved, :uncertain], &Map.get(result, &1, []))

    %{entry | resolved: Enum.uniq(entry.resolved ++ seqs)}
    |> record_unknown(Map.get(result, :unknown_items, []), reason_of)
    |> advance_skipped()
  end

  defp record_unknown(entry, [], _reason_of), do: entry

  defp record_unknown(entry, items, reason_of) do
    at = DateTime.utc_now() |> DateTime.to_iso8601()

    obligations =
      for {queue_id, item} <- items do
        %{
          queue_id: queue_id,
          delivery_seq: item.delivery_seq,
          descriptor: item.descriptor,
          reason: reason_of.(queue_id),
          at: at
        }
      end

    last = List.last(obligations)

    %{
      entry
      | uncertain_count: entry.uncertain_count + length(items),
        last_uncertain: %{
          at: at,
          incarnation: entry.incarnation,
          generation: entry.generation,
          delivery_seq: last.delivery_seq,
          reason: last.reason
        },
        queue_uncertain: entry.queue_uncertain ++ obligations
    }
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

    # An early item in the queue holds its quota slot until it is handed off
    # natively, as an issued one does until its `submitted` stage.
    queued =
      case entry do
        %{queue: %{} = queue} ->
          for {_id, %{early: true, sender: early_sender, phase: phase}} <- queue.items,
              phase in [:queued, :offered],
              do: early_sender

        _ ->
          []
      end

    pending = accepted ++ held ++ queued
    {Enum.count(pending, &(&1 == sender)), length(pending)}
  end

  defp bind_resync_entry(state, agent_id, generation, owner, update) do
    # r8b B6: a new generation gets the queued items, not the old leases.
    state =
      case state.entries[agent_id] do
        %{generation: old} when old != generation ->
          release_leases(state, agent_id, "epoch_changed")

        _ ->
          state
      end

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
          last_uncertain: if(old, do: old.last_uncertain, else: nil),
          # Retained across a same-agent replacement (r8b B6).
          queue: if(old, do: old.queue, else: nil),
          queue_uncertain: if(old, do: old.queue_uncertain, else: [])
        })
      end
      |> Map.put(:resync, true)
      |> update.()

    persist(state.table, agent_id, entry)

    {entry,
     %{
       state
       | entries: Map.put(state.entries, agent_id, entry),
         owners: Map.put(state.owners, agent_id, owner)
     }}
  end

  ## Queue control

  # Credit and channel ownership are ephemeral: a rejoin drops the credit.
  # A same-generation rejoin keeps operation records and must resume while
  # a lease is outstanding; a new generation starts afresh.
  defp bind_queue_control(state, agent_id, entry) do
    leased? = Enum.any?(entry.queue.items, fn {_id, item} -> item.lease != nil end)

    control =
      case state.queue_controls[agent_id] do
        %{generation: generation} = control when generation == entry.generation ->
          %{
            control
            | credit: nil,
              ops: InterAgentQueueOps.clear_credit(control.ops),
              resume_required: leased?
          }

        _ ->
          %{
            generation: entry.generation,
            ops: InterAgentQueueOps.new(),
            credit: nil,
            next_revision: 1,
            frozen: false,
            resume_required: leased?,
            lease_tokens: %{},
            waiters: %{},
            next_waiter: 1
          }
      end

    put_in(state.queue_controls[agent_id], control)
  end

  defp control_operation_id(operation_id) do
    case InterAgentQueueOps.parse_id(operation_id) do
      {:ok, id} -> {:ok, id}
      :error -> :error
    end
  end

  defp run_queue_control(state, agent_id, entry, control, request) do
    case request do
      %{op: :credit} = credit ->
        grant_credit(state, agent_id, entry, control, credit)

      %{op: :withdraw, revision: revision} ->
        withdraw_credit(state, agent_id, control, revision)

      %{op: :begin_native} = op ->
        lease_control(state, agent_id, entry, control, op)

      %{op: :return} = op ->
        lease_control(state, agent_id, entry, control, op)

      %{op: :dispose} = op ->
        lease_control(state, agent_id, entry, control, op)

      %{op: :waiter_close, registration_id: id} ->
        waiter_close(state, agent_id, entry, control, id)

      %{op: :resume, leases: leases, registration_ids: registration_ids} ->
        resume_control(state, agent_id, entry, control, leases, registration_ids)

      %{op: :freeze} ->
        freeze_control(state, agent_id, entry, control)
    end
  end

  defp reply(entry, fields), do: Map.put(fields, :queue, InterAgentQueue.counts(entry.queue))

  defp grant_credit(state, agent_id, entry, control, credit) do
    cond do
      control.frozen ->
        {:error, :queue_frozen}

      control.resume_required ->
        {:error, :queue_resume_required}

      credit.kind == :root and previous_root_pending?(entry.queue) ->
        Logger.warning(
          "inter-agent queue invariant violation: root credit while a previous root is native-pending recipient=#{agent_id}"
        )

        {:error, :previous_root_pending}

      true ->
        revision = Integer.to_string(control.next_revision)

        control = %{
          control
          | credit: Map.merge(credit, %{revision: revision, consumed_by: nil}),
            next_revision: control.next_revision + 1
        }

        {:ok, put_in(state.queue_controls[agent_id], control),
         reply(entry, %{credit_revision: revision}), :credit}
    end
  end

  defp previous_root_pending?(queue) do
    Enum.any?(queue.items, fn {_id, item} ->
      item.phase == :native_pending and match?({_, :root}, item.lease)
    end)
  end

  defp withdraw_credit(state, agent_id, control, revision) do
    entry = state.entries[agent_id]

    case control.credit do
      %{revision: ^revision, consumed_by: nil} ->
        control = %{control | credit: nil, ops: InterAgentQueueOps.clear_credit(control.ops)}

        {:ok, put_in(state.queue_controls[agent_id], control), reply(entry, %{withdrawn: true}),
         :item_less}

      _ ->
        {:ok, state, reply(entry, %{withdrawn: false}), :item_less}
    end
  end

  defp lease_control(state, agent_id, entry, control, %{op: op, lease_id: lease_id} = request) do
    turn = control.lease_tokens[lease_id]

    cond do
      op == :begin_native and control.frozen ->
        {:error, :queue_frozen}

      op == :begin_native and control.resume_required ->
        {:error, :queue_resume_required}

      # The permit is bound to the native turn the lease was offered for.
      op == :begin_native and turn != nil and request.token != turn ->
        {:error, {:invalid_queue_control, "native_turn_token"}}

      true ->
        argument =
          case op do
            :begin_native -> request.queue_ids
            _ -> request.items
          end

        with {:ok, state, entry, result} <-
               apply_lease_op(state, agent_id, entry, op, lease_id, argument, turn) do
          touched =
            for id <- touched_ids(op, argument), do: {id, queue_attempt_phase(entry.queue, id)}

          control = restore_declined_credit(control, op, lease_id)
          state = put_in(state.queue_controls[agent_id], control)

          {:ok, state, reply(entry, lease_reply(op, result)), {:touching, touched}}
        end
    end
  end

  defp touched_ids(:begin_native, ids), do: ids
  defp touched_ids(_op, entries), do: Enum.map(entries, &elem(&1, 0))

  # One path for every lease operation's ledger side, whoever calls it.
  # Entries may carry a third element (a dispose reason or witness) that is
  # logged and kept with an unknown obligation; the reducer sees pairs.
  defp apply_lease_op(state, agent_id, entry, op, lease_id, argument, turn) do
    {reducer_argument, details} =
      case op do
        :begin_native ->
          {argument, %{}}

        _ ->
          {Enum.map(argument, &{elem(&1, 0), elem(&1, 1)}),
           Map.new(argument, fn
             {id, _outcome, detail} -> {id, detail}
             {id, reason} when op == :return -> {id, reason}
             {id, _outcome} -> {id, nil}
           end)}
      end

    before = entry.queue

    with {:ok, queue, result} <- lease_op(before, op, lease_id, reducer_argument, turn) do
      log_lease_op(agent_id, op, before, reducer_argument, details)

      entry =
        resolve_queue_sequences(%{entry | queue: queue}, result, fn queue_id ->
          details[queue_id] || "unknown"
        end)

      persist(state.table, agent_id, entry)

      bodies =
        case result do
          %{disposed: disposed} -> Map.drop(state.bodies, Enum.map(disposed, &{agent_id, &1}))
          _ -> state.bodies
        end

      {:ok, %{state | entries: Map.put(state.entries, agent_id, entry), bodies: bodies}, entry,
       result}
    end
  end

  # r8 §5.2 (K7): one line per returned or disposed item.
  defp log_lease_op(_agent_id, :begin_native, _queue, _entries, _details), do: :ok

  defp log_lease_op(agent_id, op, queue, entries, details) do
    Enum.each(entries, fn {queue_id, outcome} ->
      seq = get_in(queue.items, [queue_id, :delivery_seq])

      Logger.info(
        "inter-agent queue #{op} recipient=#{agent_id} queue_id=#{queue_id} seq=#{seq} " <>
          "outcome=#{outcome} reason=#{details[queue_id]}"
      )
    end)
  end

  # Touched records also carry the attempt, so an item that leaves a phase
  # and comes back under a new offer is never mistaken for the old one.
  defp plain_phase({_attempt, phase}), do: phase
  defp plain_phase(phase), do: phase

  defp queue_attempt_phase(queue, queue_id) do
    case queue.items[queue_id] do
      nil -> :terminal
      item -> {item.attempt, item.phase}
    end
  end

  defp lease_reply(:begin_native, %{permitted: ids}), do: %{permitted_queue_ids: ids}
  defp lease_reply(:return, %{returned: seqs}), do: %{returned_ranges: ranges(seqs)}

  defp lease_reply(:dispose, result),
    do: %{
      disposed: result.disposed,
      resolved_ranges: ranges(result.resolved ++ result.uncertain),
      returned_ranges: ranges(result.returned)
    }

  # r8b B4: a declined early item does not use up the early credit.
  defp restore_declined_credit(control, :return, lease_id) do
    case control.credit do
      %{kind: :early, consumed_by: ^lease_id} = credit ->
        %{control | credit: %{credit | consumed_by: nil}}

      _ ->
        control
    end
  end

  defp restore_declined_credit(control, _op, _lease_id), do: control

  # A lease the wrapper does not name never reached it (its batch was lost
  # with the old channel): its un-permitted items go back to the queue and
  # its native-pending ones become unknown, so it cannot hold the slot.
  defp resume_control(state, agent_id, entry, control, named, registration_ids) do
    named_ids = MapSet.new(named, &elem(&1, 0))

    unseen =
      for {_id, %{lease: {lease_id, _}, delivery_seq: seq}} <- entry.queue.items,
          not MapSet.member?(named_ids, lease_id),
          do: seq

    {state, entry, _result} =
      release_queue_sequences(state, agent_id, entry, unseen, "lease_unseen")

    persist(state.table, agent_id, entry)

    leases =
      for {lease_id, queue_ids} <- named do
        items =
          for queue_id <- queue_ids do
            phase =
              case entry.queue.items[queue_id] do
                nil -> :terminal
                %{lease: {^lease_id, _}, phase: phase} -> phase
                _ -> :queued
              end

            %{queue_id: queue_id, phase: phase}
          end

        %{lease_id: lease_id, items: items}
      end

    control = %{control | resume_required: false}

    {:ok, put_in(state.queue_controls[agent_id], control),
     reply(entry, %{
       leases: leases,
       registrations:
         for id <- registration_ids do
           %{registration_id: id, active: live_waiter?(control, entry.queue, id)}
         end
     }), :item_less}
  end

  defp freeze_control(state, agent_id, entry, control) do
    control = %{
      control
      | frozen: true,
        credit: nil,
        ops: InterAgentQueueOps.clear_credit(control.ops)
    }

    {:ok, put_in(state.queue_controls[agent_id], control), reply(entry, %{frozen: true}),
     :item_less}
  end

  defp record_queue_control(state, agent_id, id, digest, reply, record) do
    update_in(state.queue_controls[agent_id], fn control ->
      queue = state.entries[agent_id].queue

      ops =
        case record do
          :credit ->
            InterAgentQueueOps.record_credit(control.ops, id, digest, reply)

          :item_less ->
            InterAgentQueueOps.record_item_less(control.ops, id, digest, reply)

          {:touching, touched} ->
            InterAgentQueueOps.record_touching(control.ops, id, digest, reply, touched)
        end

      %{control | ops: InterAgentQueueOps.prune(ops, &queue_attempt_phase(queue, &1))}
    end)
  end

  # Serves an outstanding credit when the lease slot is free and the
  # owner's channel is live; the batch goes to that channel only.
  defp maybe_offer(state, agent_id) do
    with %{credit: %{consumed_by: nil} = credit, frozen: false, resume_required: false} = control <-
           state.queue_controls[agent_id],
         owner when is_pid(owner) <- state.owners[agent_id],
         %{queue: %{} = queue} = entry <- state.entries[agent_id],
         # A root credit stands for an idle host: once a root batch is
         # submitted, an older or superseding root credit is not served.
         false <- credit.kind == :root and previous_root_pending?(queue),
         {:ok, queue, offer, next_seq} <-
           offer(queue, credit_request(credit, queue, control), entry.issued_seq + 1) do
      {entry, state} = commit_offer(state, agent_id, entry, queue, offer, next_seq)

      control = %{
        control
        | credit: %{credit | consumed_by: offer.lease_id},
          ops: InterAgentQueueOps.clear_credit(control.ops),
          lease_tokens: Map.put(control.lease_tokens, offer.lease_id, credit.token)
      }

      send(
        owner,
        {:inter_agent_queue_batch, batch_payload(state, agent_id, entry, credit, offer)}
      )

      %{
        state
        | queue_controls: Map.put(state.queue_controls, agent_id, control)
      }
    else
      _ -> state
    end
  end

  @recovery_max_items 10
  @recovery_max_bytes 16_384

  defp recovery_candidates(queue, peer, cid) do
    queue.items
    |> Enum.filter(fn {_id, item} ->
      item.phase == :queued and item.class == :ordinary and item.sender == peer and
        item.conversation_id == cid and item.descriptor[:notice_type] == nil
    end)
    |> Enum.sort_by(&elem(&1, 0))
    |> Enum.reduce_while({[], 0}, fn {id, item}, {ids, bytes} ->
      if length(ids) < @recovery_max_items and bytes + item.bytes <= @recovery_max_bytes,
        do: {:cont, {[id | ids], bytes + item.bytes}},
        else: {:halt, {ids, bytes}}
    end)
    |> elem(0)
    |> Enum.reverse()
  end

  defp credit_request(%{kind: :root}, _queue, _control), do: :root

  defp credit_request(%{kind: :early, mechanism: :fold, token: token}, _queue, _control),
    do: {:early, :fold, token, nil}

  # R(T): the peers and conversations of the root batch the credit's native
  # turn is running.
  defp credit_request(%{kind: :early, mechanism: :steer, token: token}, queue, control) do
    root =
      for {_id, %{lease: {lease_id, :root}} = item} <- queue.items,
          control.lease_tokens[lease_id] == token,
          do: item

    {:early, :steer, token,
     %{
       peers: MapSet.new(root, & &1.sender),
       conversations: MapSet.new(root, & &1.conversation_id)
     }}
  end

  defp batch_payload(state, agent_id, entry, credit, offer) do
    %{
      "version" => "0",
      "queue_epoch" => state.queue_epoch,
      "incarnation" => entry.incarnation,
      "generation" => entry.generation,
      "lease_id" => Integer.to_string(offer.lease_id),
      "kind" => Atom.to_string(credit.kind),
      "credit_revision" => credit.revision,
      "items" =>
        for item <- offer.items do
          queued = entry.queue.items[item.queue_id]

          %{
            "queue_id" => Integer.to_string(item.queue_id),
            "attempt_id" => "#{item.queue_id}.#{queued.attempt}",
            "delivery_seq" => item.delivery_seq,
            "class" => Atom.to_string(item.class),
            "byte_charge" => queued.bytes,
            "envelope" => state.bodies[{agent_id, item.queue_id}]
          }
        end
    }
  end

  defp ranges(seqs) do
    seqs
    |> Enum.sort()
    |> Enum.chunk_while(
      nil,
      fn
        seq, nil -> {:cont, [seq, seq]}
        seq, [first, last] when seq == last + 1 -> {:cont, [first, seq]}
        seq, range -> {:cont, range, [seq, seq]}
      end,
      fn
        nil -> {:cont, nil}
        range -> {:cont, range, nil}
      end
    )
    |> Enum.reject(&is_nil/1)
  end

  defp reserve_in_queue(state, agent_id, owner, kind, bytes) do
    case state.entries[agent_id] do
      %{queue: %{} = queue} = entry ->
        token = make_ref()

        with {:ok, queue, class} <- InterAgentQueue.reserve(queue, token, kind, bytes) do
          reservation = %{agent_id: agent_id, owner: owner, monitor: Process.monitor(owner)}

          {:ok, token, class,
           %{
             state
             | entries: Map.put(state.entries, agent_id, %{entry | queue: queue}),
               queue_reservations: Map.put(state.queue_reservations, token, reservation)
           }}
        end

      _ ->
        {:error, :queue_unavailable}
    end
  end

  # A matched reply is offered as W at once, independent of credit (r8 §6.1).
  defp offer_matched_waiter(state, agent_id, cid, registration_id, queue_id) do
    state =
      put_in(state, [:queue_controls, agent_id, :waiters, cid, :claimed], {:queued, queue_id})

    entry = state.entries[agent_id]

    with owner when is_pid(owner) <- state.owners[agent_id],
         {:ok, queue, offer, next_seq} <-
           InterAgentQueue.offer_waiter(entry.queue, queue_id, entry.issued_seq + 1) do
      {entry, state} = commit_offer(state, agent_id, entry, queue, offer, next_seq)

      payload =
        batch_payload(state, agent_id, entry, %{kind: :waiter, revision: nil}, offer)
        |> Map.delete("credit_revision")
        |> Map.put("registration_id", registration_id)

      send(owner, {:inter_agent_queue_batch, payload})
      state
    else
      _ -> state
    end
  end

  defp waiter_close(state, agent_id, entry, control, id) do
    case Enum.find(control.waiters, fn {_cid, waiter} -> waiter.id == id end) do
      {cid, %{claimed: nil}} ->
        control = %{control | waiters: Map.delete(control.waiters, cid)}

        {:ok, put_in(state.queue_controls[agent_id], control),
         reply(entry, %{closed: true, claimed: false}), :item_less}

      {_cid, _claimed} ->
        {:ok, state, reply(entry, %{closed: false, claimed: true}), :item_less}

      nil ->
        {:ok, state, reply(entry, %{closed: false, claimed: false}), :item_less}
    end
  end

  defp live_waiter?(control, queue, id) do
    now = System.monotonic_time(:millisecond)

    Enum.any?(control.waiters, fn {_cid, waiter} ->
      waiter.id == id and not settled_waiter?(waiter, queue) and
        (waiter.claimed != nil or waiter.expires_at > now)
    end)
  end

  # A claimed registration is done once its W item has left the queue.
  defp settled_waiter?(%{claimed: {:queued, queue_id}}, queue),
    do: not Map.has_key?(queue.items, queue_id)

  defp settled_waiter?(_waiter, _queue), do: false

  defp cancel_queue_reservation(state, token) do
    case Map.pop(state.queue_reservations, token) do
      {nil, _} ->
        state

      {reservation, rest} ->
        Process.demonitor(reservation.monitor, [:flush])

        state =
          case reservation[:waiter] do
            {cid, _id} ->
              update_in(state, [:queue_controls, reservation.agent_id], fn control ->
                update_in(control, [:waiters, Access.key(cid, nil)], fn
                  %{claimed: {:reserved, ^token}} = waiter -> %{waiter | claimed: nil}
                  other -> other
                end)
              end)

            nil ->
              state
          end

        entries =
          case state.entries[reservation.agent_id] do
            %{queue: %{} = queue} = entry ->
              Map.put(state.entries, reservation.agent_id, %{
                entry
                | queue: InterAgentQueue.cancel(queue, token)
              })

            _ ->
              state.entries
          end

        %{state | entries: entries, queue_reservations: rest}
    end
  end

  # Before the record goes: every retained item becomes a loss obligation.
  # Before the record goes, its uncertain obligations are written as their
  # own objects, so they outlive it like loss intents do.
  defp retire_queue(state, agent_id) do
    case state.entries[agent_id] do
      %{} = entry ->
        {entry, losses, intents} = drop_queue(agent_id, entry, state.losses, "recipient_removed")
        persist_with_losses(state, agent_id, entry, intents)

        orphans =
          Map.new(entry.queue_uncertain, fn obligation ->
            {"#{agent_id}:#{obligation.queue_id}", Map.put(obligation, :recipient, agent_id)}
          end)

        Enum.each(orphans, fn {id, obligation} ->
          :ok = :dets.insert(state.table, {{:queue_uncertain, id}, obligation})
        end)

        if orphans != %{}, do: :ok = :dets.sync(state.table)

        %{
          state
          | entries: Map.put(state.entries, agent_id, %{entry | queue_uncertain: []}),
            losses: losses,
            orphan_uncertain: Map.merge(state.orphan_uncertain, orphans),
            bodies: Map.reject(state.bodies, fn {{id, _}, _} -> id == agent_id end)
        }

      nil ->
        state
    end
  end

  defp load_orphan_uncertain(table) do
    :dets.foldl(
      fn
        {{:queue_uncertain, id}, obligation}, acc when is_map(obligation) ->
          Map.put(acc, id, obligation)

        _, acc ->
          acc
      end,
      %{},
      table
    )
  end

  # Unsubmitted items become loss intents; native-pending items resolve as
  # uncertain, since delivery may have happened.
  defp drop_queue(agent_id, %{queue: %{items: items} = queue} = entry, losses, reason)
       when map_size(items) > 0 do
    {queue, %{lost: lost, unknown: unknown}} = InterAgentQueue.drop_all(queue)

    intents =
      for {queue_id, item} <- lost do
        revision = queue_loss_revision(agent_id, entry.incarnation, queue_id)

        %{
          id: item.descriptor[:loss_id] || revision,
          revision: revision,
          recipient: agent_id,
          generation: entry.generation,
          seq: nil,
          queue_id: queue_id,
          descriptor: item.descriptor,
          reason: "delivery_lost"
        }
      end

    # Their sequences leave the ledger here, so no later resync can record
    # them a second time.
    dropped_seqs =
      for {_id, %{delivery_seq: seq}} <- lost ++ unknown, seq != nil, do: seq

    entry =
      %{entry | queue: queue, resolved: Enum.uniq(entry.resolved ++ dropped_seqs)}
      |> record_unknown(unknown, fn _ -> reason end)
      |> advance_skipped()

    {entry, Enum.reduce(intents, losses, &Map.put(&2, &1.id, &1)), intents}
  end

  defp drop_queue(_agent_id, entry, losses, _reason), do: {entry, losses, []}

  defp queue_loss_revision(agent_id, incarnation, queue_id) do
    :crypto.hash(:sha256, :erlang.term_to_binary({agent_id, incarnation, :queue, queue_id}))
    |> Base.url_encode64(padding: false)
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
      last_uncertain: nil,
      queue_policy: nil,
      queue: nil,
      queue_uncertain: []
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

    status =
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

    case entry do
      %{queue: %{} = queue} -> Map.put(status, :queue, InterAgentQueue.counts(queue))
      _ -> status
    end
  end

  defp queued_count(nil), do: 0

  defp queued_count(queue),
    do: Enum.count(queue.items, fn {_id, item} -> item.phase == :queued end)

  defp entry_record(agent_id, entry) do
    if seq = queue_ledger_violation(entry) do
      raise ArgumentError,
            "queue-origin sequence #{seq} of #{agent_id} resolved outside the queue"
    end

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
       :last_uncertain,
       :queue_policy,
       :queue_uncertain
     ])
     |> Map.put(:queue, entry.queue && InterAgentQueue.durable(entry.queue))}
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

               entry = %{entry | queue: entry.queue && InterAgentQueue.restore(entry.queue)}

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
