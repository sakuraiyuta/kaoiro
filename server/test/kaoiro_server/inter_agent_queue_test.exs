defmodule KaoiroServer.InterAgentQueueTest do
  use ExUnit.Case, async: true

  alias KaoiroServer.InterAgentQueue, as: Q

  @policy %{batch_max_items: 3, backlog_max_items: 4, backlog_max_bytes: 100}

  defp queue(policy \\ @policy), do: Q.new(policy)

  defp enqueue(q, sender, opts \\ []) do
    ref = make_ref()
    kind = Keyword.get(opts, :kind, :ordinary)
    {:ok, q, _class} = Q.reserve(q, ref, kind, Keyword.get(opts, :bytes, 10))

    {:ok, q, id} =
      Q.commit(q, ref, %{
        sender: sender,
        conversation_id: Keyword.get(opts, :conversation, "c-" <> sender),
        turn_number: 1,
        early: Keyword.get(opts, :early, false)
      })

    {q, id}
  end

  defp ids(offer), do: Enum.map(offer.items, & &1.queue_id)

  describe "admission" do
    test "ordinary input is admitted while Q < P" do
      {q, _} = queue() |> enqueue("a")
      {q, _} = enqueue(q, "a")
      {q, _} = enqueue(q, "a")
      {q, _} = enqueue(q, "a")
      assert Q.reserve(q, make_ref(), :ordinary, 1) == {:error, :receiver_overloaded}
    end

    test "byte charge equal to M is accepted and one byte more is refused" do
      {q, _} = queue() |> enqueue("a", bytes: 60)
      assert {:ok, _q, :ordinary} = Q.reserve(q, make_ref(), :ordinary, 40)
      assert Q.reserve(q, make_ref(), :ordinary, 41) == {:error, :receiver_overloaded}
    end

    test "reservations count toward Q and E until cancelled" do
      ref = make_ref()
      {:ok, q, :ordinary} = Q.reserve(queue(), ref, :ordinary, 100)
      assert Q.reserve(q, make_ref(), :ordinary, 1) == {:error, :receiver_overloaded}
      assert {:ok, _q, :ordinary} = q |> Q.cancel(ref) |> Q.reserve(make_ref(), :ordinary, 1)
    end

    test "an oversized item is admitted only into an empty queue and blocks the next" do
      assert {:ok, q, :ordinary} = Q.reserve(queue(), make_ref(), :ordinary, 500)
      assert Q.reserve(q, make_ref(), :ordinary, 1) == {:error, :receiver_overloaded}

      {q, _} = queue() |> enqueue("a", bytes: 1)
      assert Q.reserve(q, make_ref(), :ordinary, 500) == {:error, :receiver_overloaded}
    end

    test "a waiter reply bypasses P and M" do
      q = Enum.reduce(1..4, queue(), fn _, q -> q |> enqueue("a", bytes: 25) |> elem(0) end)
      assert {:ok, _q, :waiter} = Q.reserve(q, make_ref(), :waiter, 1_000)
    end

    test "a notice uses ordinary capacity first, then the control allowance" do
      assert {:ok, _q, :ordinary} = Q.reserve(queue(), make_ref(), :notice, 1)

      full = Enum.reduce(1..4, queue(), fn _, q -> q |> enqueue("a") |> elem(0) end)

      q =
        Enum.reduce(1..Q.control_allowance(), full, fn _, q ->
          assert {:ok, q, :control} = Q.reserve(q, make_ref(), :notice, 10_000)
          q
        end)

      assert Q.reserve(q, make_ref(), :notice, 1) == {:error, :receiver_overloaded}
      assert Q.reserve(full, make_ref(), :ordinary, 1) == {:error, :receiver_overloaded}
    end

    test "commit assigns monotonic queue ids and needs a live reservation" do
      {q, first} = queue() |> enqueue("a")
      {q, second} = enqueue(q, "b")
      assert second == first + 1
      assert Q.commit(q, make_ref(), %{}) == {:error, :unknown_reservation}
    end
  end

  describe "root offers" do
    test "a root batch is one sender's FIFO prefix up to B, with consecutive sequences" do
      {q, a1} = queue(%{@policy | backlog_max_items: 10}) |> enqueue("a")
      {q, b1} = enqueue(q, "b")
      {q, a2} = enqueue(q, "a")
      {q, a3} = enqueue(q, "a")
      {q, a4} = enqueue(q, "a")

      assert {:ok, q, offer, 8} = Q.offer_root(q, 5)
      assert ids(offer) == [a1, a2, a3]
      assert Enum.map(offer.items, & &1.delivery_seq) == [5, 6, 7]
      assert offer.kind == :root

      assert Q.offer_root(q, 8) == {:error, :lease_slot_busy}
      {:ok, q, _} = Q.begin_native(q, offer.lease_id, ids(offer))

      assert {:ok, _q, next, 9} = Q.offer_root(q, 8)
      assert ids(next) == [b1]
      _ = a4
    end

    test "senders are served round robin" do
      {q, a1} = queue(%{@policy | batch_max_items: 1, backlog_max_items: 10}) |> enqueue("a")
      {q, a2} = enqueue(q, "a")
      {q, b1} = enqueue(q, "b")

      served =
        Enum.map_reduce(1..3, q, fn _, q ->
          {:ok, q, offer, _} = Q.offer_root(q, 1)
          {:ok, q, _} = Q.dispose(q, offer.lease_id, [{hd(ids(offer)), :observed}], "t")
          {hd(ids(offer)), q}
        end)
        |> elem(0)

      assert served == [a1, b1, a2]
    end

    test "queued waiter items ride the root batch first and count toward B" do
      {q, a1} = queue() |> enqueue("a")
      {q, a2} = enqueue(q, "a")
      {q, w} = enqueue(q, "b", kind: :waiter)

      {:ok, _q, offer, _} = Q.offer_root(q, 1)
      assert ids(offer) == [w, a1, a2]
    end

    test "a waiter offer takes its own lease and leaves the ordinary slot free" do
      {q, a} = queue() |> enqueue("a")
      {q, w} = enqueue(q, "b", kind: :waiter)

      assert {:ok, q, offer, 2} = Q.offer_waiter(q, w, 1)
      assert offer.kind == :waiter
      assert ids(offer) == [w]
      refute Q.lease_slot_busy?(q)

      assert {:ok, _q, root, _} = Q.offer_root(q, 2)
      assert ids(root) == [a]
      assert Q.offer_waiter(q, a, 3) == {:error, :unknown_queue_item}
    end

    test "an empty queue offers nothing" do
      assert Q.offer_root(queue(), 1) == :empty
    end

    test "a returned item keeps its place ahead of newer input and gets a new sequence" do
      {q, a1} = queue() |> enqueue("a")
      {:ok, q, offer, 2} = Q.offer_root(q, 1)
      {q, a2} = enqueue(q, "a")

      assert {:ok, q, [1]} = Q.return(q, offer.lease_id, [{a1, :format_budget}], "t")
      assert q.items[a1].last_return_reason == :format_budget

      {:ok, _q, again, 4} = Q.offer_root(q, 2)
      assert ids(again) == [a1, a2]
      assert hd(again.items).delivery_seq == 2
    end
  end

  describe "early offers" do
    test "fold offers the oldest early item even behind older ordinary input" do
      {q, _a1} = queue() |> enqueue("a")
      {q, e} = enqueue(q, "b", early: true)

      assert {:ok, _q, offer, 2} = Q.offer_early(q, :fold, "t", nil, 1)
      assert ids(offer) == [e]
      assert offer.kind == :early
    end

    test "an item declined under a turn is not offered again early in that turn" do
      {q, e} = queue() |> enqueue("b", early: true)
      {:ok, q, offer, _} = Q.offer_early(q, :fold, "t", nil, 1)
      {:ok, q, _} = Q.return(q, offer.lease_id, [{e, :early_ineligible}], "t")

      assert Q.offer_early(q, :fold, "t", nil, 2) == :empty
      assert {:ok, _q, again, _} = Q.offer_early(q, :fold, "t2", nil, 2)
      assert ids(again) == [e]

      assert {:ok, _q, root, _} = Q.offer_root(q, 2)
      assert ids(root) == [e]
    end

    test "a return from a root lease does not mark the item declined" do
      {q, e} = queue() |> enqueue("b", early: true)
      {:ok, q, offer, _} = Q.offer_root(q, 1)
      {:ok, q, _} = Q.return(q, offer.lease_id, [{e, :format_budget}], "t")
      assert {:ok, _q, _offer, _} = Q.offer_early(q, :fold, "t", nil, 2)
    end

    defp running(peers, conversations \\ []),
      do: %{peers: MapSet.new(peers), conversations: MapSet.new(conversations)}

    test "steer offers an outside peer's early item when nothing older blocks it" do
      {q, e} = queue() |> enqueue("z", early: true)
      assert {:ok, _q, offer, _} = Q.offer_early(q, :steer, "t", running([]), 1)
      assert ids(offer) == [e]
    end

    test "steer skips an early item that is not its sender's oldest" do
      {q, _} = queue() |> enqueue("z")
      {q, _} = enqueue(q, "z", early: true)
      assert Q.offer_early(q, :steer, "t", running([]), 1) == :empty
    end

    test "steer skips a peer whose root batch the turn is running" do
      {q, _} = queue() |> enqueue("z", early: true)
      assert Q.offer_early(q, :steer, "t", running(["z"]), 1) == :empty
    end

    test "steer skips a conversation with a root pending in the turn" do
      {q, _} = queue() |> enqueue("z", early: true, conversation: "c1")
      assert Q.offer_early(q, :steer, "t", running([], ["c1"]), 1) == :empty
    end

    test "older input of an outside peer blocks a steer, input of a running peer does not" do
      {q, _} = queue() |> enqueue("y")
      {q, e} = enqueue(q, "z", early: true)
      assert Q.offer_early(q, :steer, "t", running([]), 1) == :empty
      assert {:ok, _q, offer, _} = Q.offer_early(q, :steer, "t", running(["y"]), 1)
      assert ids(offer) == [e]
    end

    test "an early offer also needs the lease slot" do
      {q, _} = queue() |> enqueue("a")
      {q, _} = enqueue(q, "b", early: true)
      {:ok, q, _offer, _} = Q.offer_root(q, 1)
      assert Q.offer_early(q, :fold, "t", nil, 2) == {:error, :lease_slot_busy}
    end
  end

  describe "lease operations" do
    setup do
      {q, a1} = queue() |> enqueue("a", bytes: 30)
      {q, a2} = enqueue(q, "a", bytes: 20)
      {:ok, q, offer, _} = Q.offer_root(q, 1)
      %{q: q, lease: offer.lease_id, a1: a1, a2: a2}
    end

    test "begin_native permits only offered items of that lease", %{q: q, lease: lease, a1: a1} do
      assert Q.begin_native(q, lease + 1, [a1]) == {:error, :unknown_lease}
      assert Q.begin_native(q, lease, [a1 + 99]) == {:error, :unknown_queue_item}
      assert {:ok, q, [^a1]} = Q.begin_native(q, lease, [a1])
      assert q.items[a1].phase == :native_pending
      assert Q.begin_native(q, lease, [a1]) == {:error, :unknown_queue_item}
    end

    test "terminal outcomes remove items and release their charge", ctx do
      {:ok, q, _} = Q.begin_native(ctx.q, ctx.lease, [ctx.a1, ctx.a2])

      assert {:ok, q, result} =
               Q.dispose(q, ctx.lease, [{ctx.a1, :observed}, {ctx.a2, :unknown}], "t")

      assert result == %{disposed: [ctx.a1, ctx.a2], resolved: [1], uncertain: [2], returned: []}
      assert q.items == %{}
      assert Q.counts(q).charged_bytes == 0
    end

    test "definitely_unstarted returns the item and keeps its charge", ctx do
      assert {:ok, q, result} =
               Q.dispose(
                 ctx.q,
                 ctx.lease,
                 [{ctx.a1, :intentional_non_injection}, {ctx.a2, :definitely_unstarted}],
                 "t"
               )

      assert result.returned == [2]
      assert result.resolved == [1]
      assert q.items[ctx.a2].phase == :queued
      assert q.items[ctx.a2].last_return_reason == :definitely_unstarted
      assert Q.counts(q).charged_bytes == 20
    end

    test "a permitted item can still be returned", ctx do
      {:ok, q, _} = Q.begin_native(ctx.q, ctx.lease, [ctx.a1])
      assert {:ok, q, [1]} = Q.return(q, ctx.lease, [{ctx.a1, :host_rejected_before_start}], "t")
      assert q.items[ctx.a1].phase == :queued
    end

    test "invalid entries change nothing", ctx do
      assert Q.dispose(ctx.q, ctx.lease, [{ctx.a1, :lost}], "t") == {:error, :invalid_outcome}
      assert Q.dispose(ctx.q, ctx.lease, [], "t") == {:error, :invalid_queue_items}

      assert Q.return(ctx.q, ctx.lease, [{ctx.a1, :shutdown}, {ctx.a1, :shutdown}], "t") ==
               {:error, :invalid_queue_items}
    end
  end

  describe "generation and lifetime" do
    setup do
      {q, queued} = queue() |> enqueue("a")
      {:ok, q, first, _} = Q.offer_root(q, 1)
      {:ok, q, _} = Q.begin_native(q, first.lease_id, [queued])
      {q, offered} = enqueue(q, "b")
      {:ok, q, _second, _} = Q.offer_root(q, 2)
      {q, waiting} = enqueue(q, "c")
      %{q: q, pending: queued, offered: offered, waiting: waiting}
    end

    test "a replacement generation keeps queued items, returns offers, and resolves native-pending as unknown",
         ctx do
      {q, result} = Q.replace_generation(ctx.q)
      assert result == %{returned: [2], uncertain: [1], disposed: [ctx.pending]}
      assert q.items[ctx.offered].phase == :queued
      assert q.items[ctx.offered].last_return_reason == :epoch_changed
      assert q.items[ctx.waiting].phase == :queued
      refute Map.has_key?(q.items, ctx.pending)
      refute Q.lease_slot_busy?(q)
    end

    test "releasing sequences returns offers, resolves native-pending, ignores the rest", ctx do
      {q, result} = Q.release_sequences(ctx.q, [1, 2, 99], :shutdown)
      assert result == %{returned: [2], uncertain: [1], disposed: [ctx.pending]}
      assert q.items[ctx.offered].phase == :queued
      assert q.items[ctx.offered].last_return_reason == :shutdown
      refute Map.has_key?(q.items, ctx.pending)
      assert q.items[ctx.waiting].phase == :queued

      {same, none} = Q.release_sequences(ctx.q, [99], :shutdown)
      assert same == ctx.q
      assert none == %{returned: [], uncertain: [], disposed: []}
    end

    test "dropping everything loses unsubmitted items and marks native-pending unknown", ctx do
      {q, result} = Q.drop_all(ctx.q)
      assert Enum.map(result.lost, &elem(&1, 0)) == [ctx.offered, ctx.waiting]
      assert Enum.map(result.unknown, &elem(&1, 0)) == [ctx.pending]
      assert q.items == %{}
    end

    test "an unknown or malformed durable form fails closed", ctx do
      durable = Q.durable(ctx.q)
      assert durable.version == 1

      for bad <- [
            Map.put(durable, :version, 2),
            Map.delete(durable, :items),
            put_in(durable, [:items, ctx.pending, :phase], :lost),
            put_in(durable.items[ctx.pending + 100], %{phase: :queued})
          ] do
        assert_raise ArgumentError, fn -> Q.restore(bad) end
      end
    end

    test "the durable part survives a round trip without reservations", ctx do
      {:ok, q, _} = Q.reserve(ctx.q, make_ref(), :ordinary, 1)
      restored = q |> Q.durable() |> Q.restore()
      assert restored.items == q.items
      assert restored.reservations == %{}
      assert restored.next_index == q.next_index
    end
  end

  test "counts keep the phases disjoint and control a subset" do
    {q, _} = queue(%{@policy | backlog_max_items: 1}) |> enqueue("a")
    {:ok, q, :control} = Q.reserve(q, ref = make_ref(), :notice, 5)

    {:ok, q, _} =
      Q.commit(q, ref, %{sender: "server", conversation_id: nil, turn_number: 0, early: false})

    {q, _} = enqueue(q, "w", kind: :waiter)
    {:ok, q, offer, _} = Q.offer_root(q, 1)
    _ = offer

    counts = Q.counts(q)
    assert counts.waiter == 1
    assert counts.control == 1
    assert counts.queued + counts.offered + counts.native_pending == 2
    assert counts.charged_bytes == 25
    assert counts.policy == %{@policy | backlog_max_items: 1}
  end
end
