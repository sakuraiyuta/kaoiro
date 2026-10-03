defmodule KaoiroServer.InterAgentQueue do
  @moduledoc """
  Pure per-recipient queue reducer for the server-owned inter-agent queue
  (`credit-v1`, docs/reference/protocol/channels.md). It holds descriptors
  only: bodies, credit and channel ownership belong to the owning actor
  (`KaoiroServer.DeliveryStates`), which also persists the durable part
  (`durable/1`) and allocates delivery sequences.

  Items are identified by a monotonic queue index. A sequence is attached
  only when an item is offered; a returned item keeps its index, class and
  byte charge, so it keeps its place in its sender's FIFO.

  Accounting: Q counts reservations and every live item (queued, offered,
  native-pending, any class); E sums their byte charges. Ordinary admission
  needs Q < P and E + bytes <= M, except that an oversized item is admitted
  into an empty queue. Waiter replies bypass both. A server notice uses
  ordinary capacity first and only then the control allowance.
  """

  @control_allowance 16
  @lease_kinds [:root, :early, :recovery]
  @terminal_outcomes [:observed, :intentional_non_injection, :unknown]

  @type queue_id :: pos_integer()
  @type class :: :ordinary | :waiter | :control
  @type phase :: :queued | :offered | :native_pending

  def control_allowance, do: @control_allowance

  @doc "An empty queue under the given policy."
  def new(policy) do
    %{
      policy: policy,
      next_index: 1,
      next_lease: 1,
      items: %{},
      reservations: %{},
      cursor: nil
    }
  end

  @doc "The part the owner persists. Reservations and the cursor are not durable."
  def durable(q), do: Map.take(q, [:policy, :next_index, :next_lease, :items])

  def restore(durable), do: Map.merge(%{reservations: %{}, cursor: nil}, durable)

  ## Admission

  @doc """
  Reserves capacity for one input. `kind` is `:ordinary`, `:waiter` or
  `:notice` (a genuine server-generated notice). Returns the class the item
  will carry.
  """
  def reserve(q, ref, kind, bytes)
      when kind in [:ordinary, :waiter, :notice] and is_integer(bytes) and bytes >= 0 do
    cond do
      Map.has_key?(q.reservations, ref) ->
        {:error, :duplicate_reservation}

      kind == :waiter ->
        {:ok, put_reservation(q, ref, :waiter, bytes), :waiter}

      ordinary_fits?(q, bytes) ->
        {:ok, put_reservation(q, ref, :ordinary, bytes), :ordinary}

      kind == :notice and control_count(q) < @control_allowance ->
        {:ok, put_reservation(q, ref, :control, bytes), :control}

      true ->
        {:error, :receiver_overloaded}
    end
  end

  defp ordinary_fits?(q, bytes) do
    count = live_count(q)

    count < q.policy.backlog_max_items and
      (charged_bytes(q) + bytes <= q.policy.backlog_max_bytes or count == 0)
  end

  defp put_reservation(q, ref, class, bytes),
    do: put_in(q.reservations[ref], %{class: class, bytes: bytes})

  @doc "Releases a reservation that was never committed."
  def cancel(q, ref), do: %{q | reservations: Map.delete(q.reservations, ref)}

  @doc """
  Commits a reservation as a queued item. `descriptor` carries at least
  `:sender`, `:conversation_id`, `:turn_number` and `:early` (whether the
  input was granted early delivery). The whole descriptor is kept for the
  owner's loss notifications; scheduling reads only those fields.
  """
  def commit(q, ref, descriptor) do
    case Map.pop(q.reservations, ref) do
      {nil, _} ->
        {:error, :unknown_reservation}

      {reservation, reservations} ->
        id = q.next_index

        item =
          descriptor
          |> Map.take([:sender, :conversation_id, :turn_number])
          |> Map.merge(%{
            early: descriptor[:early] == true,
            descriptor: descriptor,
            class: reservation.class,
            bytes: reservation.bytes,
            phase: :queued,
            attempt: 0,
            lease: nil,
            delivery_seq: nil,
            declined_turn: nil,
            last_return_reason: nil
          })

        {:ok,
         %{q | reservations: reservations, next_index: id + 1, items: Map.put(q.items, id, item)},
         id}
    end
  end

  ## Offers

  @doc "True while an ordinary lease still has an item awaiting `begin_native`."
  def lease_slot_busy?(q), do: Enum.any?(q.items, fn {_id, item} -> item.phase == :offered end)

  @doc """
  Offers a root batch: queued waiter items first, then the next sender's
  FIFO prefix in round-robin order, up to the policy's batch size. Returns
  `{:ok, q, offer, next_seq}`, `:empty` or `{:error, :lease_slot_busy}`.
  """
  def offer_root(q, next_seq) do
    cond do
      lease_slot_busy?(q) ->
        {:error, :lease_slot_busy}

      true ->
        queued = queued_in_order(q)
        waiters = for {id, item} <- queued, item.class == :waiter, do: id
        room = q.policy.batch_max_items - length(waiters)

        {sender, prefix} = next_sender_prefix(q, queued, max(room, 0))
        ids = Enum.take(waiters, q.policy.batch_max_items) ++ prefix

        if ids == [] do
          :empty
        else
          q = if sender == nil, do: q, else: %{q | cursor: sender}
          issue_lease(q, :root, ids, next_seq)
        end
    end
  end

  defp next_sender_prefix(_q, _queued, 0), do: {nil, []}

  defp next_sender_prefix(q, queued, room) do
    ordinary = for {id, item} <- queued, item.class != :waiter, do: {id, item}

    senders =
      ordinary |> Enum.map(fn {_id, item} -> item.sender end) |> Enum.uniq() |> Enum.sort()

    case senders do
      [] ->
        {nil, []}

      _ ->
        sender = Enum.find(senders, hd(senders), &(q.cursor == nil or &1 > q.cursor))
        ids = for {id, item} <- ordinary, item.sender == sender, do: id
        {sender, Enum.take(ids, room)}
    end
  end

  @doc """
  Offers one early item under `fold` or `steer` credit for native turn
  `turn`. For `steer`, `running` gives the peers and conversations of the
  root batch that turn is running (empty for a turn with no IA root).
  """
  def offer_early(q, mechanism, turn, running, next_seq) when mechanism in [:fold, :steer] do
    if lease_slot_busy?(q) do
      {:error, :lease_slot_busy}
    else
      queued = queued_in_order(q)

      candidate =
        case mechanism do
          :fold -> Enum.find(queued, fn {_id, item} -> early_candidate?(item, turn) end)
          :steer -> steer_candidate(queued, turn, running)
        end

      case candidate do
        nil -> :empty
        {id, _item} -> issue_lease(q, :early, [id], next_seq)
      end
    end
  end

  defp early_candidate?(item, turn),
    do: item.early == true and item.class == :ordinary and item.declined_turn != turn

  # r8b B3: the oldest early item E of a peer outside the running root batch,
  # that is its sender's oldest queued item, whose conversation has no root
  # pending in the turn, and that no older item of another outside peer blocks.
  defp steer_candidate(queued, turn, running) do
    non_waiter = for {id, item} <- queued, item.class != :waiter, do: {id, item}

    non_waiter
    |> Enum.with_index()
    |> Enum.find_value(fn {{id, item}, position} ->
      older = Enum.take(non_waiter, position)

      if early_candidate?(item, turn) and
           not MapSet.member?(running.peers, item.sender) and
           not MapSet.member?(running.conversations, item.conversation_id) and
           not Enum.any?(older, fn {_id, other} -> other.sender == item.sender end) and
           not Enum.any?(older, fn {_id, other} ->
             not MapSet.member?(running.peers, other.sender)
           end),
         do: {id, item}
    end)
  end

  @doc "Offers a recovery claim: the given queued items, as one lease."
  def offer_recovery(q, ids, next_seq) do
    cond do
      lease_slot_busy?(q) -> {:error, :lease_slot_busy}
      ids == [] -> :empty
      not Enum.all?(ids, &match?(%{phase: :queued}, q.items[&1])) -> {:error, :unknown_queue_item}
      true -> issue_lease(q, :recovery, ids, next_seq)
    end
  end

  defp issue_lease(q, kind, ids, next_seq) when kind in @lease_kinds do
    lease_id = q.next_lease

    {items, offered, next_seq} =
      Enum.reduce(ids, {q.items, [], next_seq}, fn id, {items, offered, seq} ->
        item = %{
          items[id]
          | phase: :offered,
            attempt: items[id].attempt + 1,
            lease: {lease_id, kind},
            delivery_seq: seq
        }

        {Map.put(items, id, item),
         [%{queue_id: id, delivery_seq: seq, class: item.class} | offered], seq + 1}
      end)

    offer = %{lease_id: lease_id, kind: kind, items: Enum.reverse(offered)}
    {:ok, %{q | items: items, next_lease: lease_id + 1}, offer, next_seq}
  end

  ## Lease operations

  @doc "Moves offered items of a lease to native-pending. All or nothing."
  def begin_native(q, lease_id, ids) do
    with :ok <- check_lease(q, lease_id, ids, [:offered]) do
      {:ok, update_items(q, ids, &%{&1 | phase: :native_pending}), ids}
    end
  end

  @doc """
  Returns lease items to their queue position. `entries` is a list of
  `{queue_id, reason}`. An item returned from an early lease is not offered
  again under early credit for the same native turn (`turn`).
  """
  def return(q, lease_id, entries, turn) do
    ids = Enum.map(entries, &elem(&1, 0))

    with :ok <- check_lease(q, lease_id, ids, [:offered, :native_pending]) do
      returned = Enum.sort(for id <- ids, do: q.items[id].delivery_seq)

      items =
        Enum.reduce(entries, q.items, fn {id, reason}, items ->
          Map.update!(items, id, fn %{lease: {_lease, kind}} = item ->
            %{
              item
              | phase: :queued,
                lease: nil,
                delivery_seq: nil,
                last_return_reason: reason,
                declined_turn: if(kind == :early, do: turn, else: item.declined_turn)
            }
          end)
        end)

      {:ok, %{q | items: items}, returned}
    end
  end

  @doc """
  Applies per-item outcomes. `entries` is a list of `{queue_id, outcome}`
  with outcome `:observed`, `:intentional_non_injection`, `:unknown` or
  `:definitely_unstarted`. Terminal outcomes remove the item and release
  its charge; `:definitely_unstarted` returns it like `return/4`.
  """
  def dispose(q, lease_id, entries, turn) do
    ids = Enum.map(entries, &elem(&1, 0))

    with :ok <- check_outcomes(entries),
         :ok <- check_lease(q, lease_id, ids, [:offered, :native_pending]) do
      {terminal, unstarted} =
        Enum.split_with(entries, fn {_id, outcome} -> outcome in @terminal_outcomes end)

      resolution =
        Enum.reduce(terminal, %{resolved: [], uncertain: [], disposed: []}, fn {id, outcome},
                                                                               acc ->
          seq = q.items[id].delivery_seq
          bucket = if outcome == :unknown, do: :uncertain, else: :resolved
          %{acc | bucket => [seq | acc[bucket]], disposed: [id | acc.disposed]}
        end)

      q = %{q | items: Map.drop(q.items, resolution.disposed)}

      {:ok, q, returned} =
        case unstarted do
          [] ->
            {:ok, q, []}

          _ ->
            return(
              q,
              lease_id,
              Enum.map(unstarted, fn {id, _} -> {id, :definitely_unstarted} end),
              turn
            )
        end

      {:ok, q,
       %{
         disposed: Enum.sort(resolution.disposed),
         resolved: Enum.sort(resolution.resolved),
         uncertain: Enum.sort(resolution.uncertain),
         returned: returned
       }}
    end
  end

  defp check_outcomes(entries) do
    if Enum.all?(entries, fn {_id, outcome} ->
         outcome in [:definitely_unstarted | @terminal_outcomes]
       end),
       do: :ok,
       else: {:error, :invalid_outcome}
  end

  defp check_lease(q, lease_id, ids, phases) do
    cond do
      ids == [] or length(Enum.uniq(ids)) != length(ids) ->
        {:error, :invalid_queue_items}

      not Enum.any?(q.items, fn {_id, item} -> match?({^lease_id, _}, item.lease) end) ->
        {:error, :unknown_lease}

      not Enum.all?(ids, fn id ->
        match?(%{lease: {^lease_id, _}}, q.items[id]) and q.items[id].phase in phases
      end) ->
        {:error, :unknown_queue_item}

      true ->
        :ok
    end
  end

  defp update_items(q, ids, fun),
    do: %{q | items: Enum.reduce(ids, q.items, fn id, items -> Map.update!(items, id, fun) end)}

  ## Generation and lifetime

  @doc """
  A replacement wrapper generation for the same agent (r8b B6): queued items
  stay, un-permitted offers are returned with `epoch_changed`, native-pending
  items become unknown.
  """
  def replace_generation(q) do
    offered = for {id, %{phase: :offered}} <- q.items, do: id
    pending = for {id, %{phase: :native_pending}} <- q.items, do: id

    returned = for id <- offered, do: q.items[id].delivery_seq
    uncertain = for id <- pending, do: q.items[id].delivery_seq

    q =
      update_items(q, offered, fn item ->
        %{
          item
          | phase: :queued,
            lease: nil,
            delivery_seq: nil,
            last_return_reason: :epoch_changed
        }
      end)

    {%{q | items: Map.drop(q.items, pending)},
     %{
       returned: Enum.sort(returned),
       uncertain: Enum.sort(uncertain),
       disposed: Enum.sort(pending)
     }}
  end

  @doc """
  Every live item is gone with its body (owner restart, recipient deletion):
  never-submitted items are lost, native-pending items unknown. Returns the
  emptied queue and the descriptors for notification.
  """
  def drop_all(q) do
    {pending, rest} =
      Enum.split_with(q.items, fn {_id, item} -> item.phase == :native_pending end)

    {%{q | items: %{}, reservations: %{}},
     %{lost: Enum.sort_by(rest, &elem(&1, 0)), unknown: Enum.sort_by(pending, &elem(&1, 0))}}
  end

  ## Counts

  @doc "Wire `queue` counts (channels.md, queue counts)."
  def counts(q) do
    live = Map.values(q.items)

    %{
      queued: Enum.count(live, &(&1.phase == :queued and &1.class != :waiter)),
      offered: Enum.count(live, &(&1.phase == :offered and &1.class != :waiter)),
      native_pending: Enum.count(live, &(&1.phase == :native_pending and &1.class != :waiter)),
      waiter: Enum.count(live, &(&1.class == :waiter)),
      control: Enum.count(live, &(&1.class == :control)),
      charged_bytes: charged_bytes(q),
      policy: q.policy
    }
  end

  defp live_count(q), do: map_size(q.items) + map_size(q.reservations)

  defp charged_bytes(q) do
    Enum.sum_by(Map.values(q.items), & &1.bytes) +
      Enum.sum_by(Map.values(q.reservations), & &1.bytes)
  end

  defp control_count(q) do
    Enum.count(Map.values(q.items), &(&1.class == :control)) +
      Enum.count(Map.values(q.reservations), &(&1.class == :control))
  end

  defp queued_in_order(q) do
    q.items
    |> Enum.filter(fn {_id, item} -> item.phase == :queued end)
    |> Enum.sort_by(&elem(&1, 0))
  end
end
