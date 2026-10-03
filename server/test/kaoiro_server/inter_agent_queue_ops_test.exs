defmodule KaoiroServer.InterAgentQueueOpsTest do
  use ExUnit.Case, async: true

  alias KaoiroServer.InterAgentQueueOps, as: Ops

  test "operation ids are positive decimal counters" do
    assert Ops.parse_id("1") == {:ok, 1}
    assert Ops.parse_id("42") == {:ok, 42}
    for bad <- ["0", "01", "-1", "1.0", "x", "", 1], do: assert(Ops.parse_id(bad) == :error)
  end

  test "an id above the high-water mark is new; at or below without a record is unknown" do
    ops = Ops.record_item_less(Ops.new(), 5, "d", %{ok: true})
    assert Ops.classify(ops, 6, "d", fn _ -> :queued end) == :new
    assert Ops.classify(ops, 4, "d", fn _ -> :queued end) == {:error, :unknown_operation}
  end

  test "an item-touching record replays, then supersedes, then expires" do
    ops =
      Ops.record_touching(Ops.new(), 1, "d", %{reply: 1}, [
        {10, :native_pending},
        {11, :native_pending}
      ])

    same = fn _ -> :native_pending end

    partly = fn
      10 -> :terminal
      11 -> :native_pending
    end

    gone = fn _ -> :terminal end

    assert Ops.classify(ops, 1, "d", same) == {:replay, %{reply: 1}}
    assert Ops.classify(ops, 1, "other", same) == {:error, :operation_payload_mismatch}

    assert Ops.classify(ops, 1, "d", partly) ==
             {:error, {:operation_superseded, [{10, :terminal}, {11, :native_pending}]}}

    assert ops |> Ops.prune(partly) |> Ops.classify(1, "d", partly) |> elem(0) == :error
    assert ops |> Ops.prune(gone) |> Ops.classify(1, "d", gone) == {:error, :unknown_operation}
  end

  test "a credit record lives until it is cleared" do
    ops = Ops.record_credit(Ops.new(), 3, "d", %{credit_revision: "1"})
    assert Ops.classify(ops, 3, "d", fn _ -> :queued end) == {:replay, %{credit_revision: "1"}}

    assert ops |> Ops.clear_credit() |> Ops.classify(3, "d", fn _ -> :queued end) ==
             {:error, :unknown_operation}
  end

  test "item-less records keep the most recent ones" do
    limit = Ops.item_less_limit()
    ops = Enum.reduce(1..(limit + 1), Ops.new(), &Ops.record_item_less(&2, &1, "d", %{n: &1}))

    assert Ops.classify(ops, 1, "d", fn _ -> :queued end) == {:error, :unknown_operation}
    assert Ops.classify(ops, 2, "d", fn _ -> :queued end) == {:replay, %{n: 2}}
    assert Ops.classify(ops, limit + 1, "d", fn _ -> :queued end) == {:replay, %{n: limit + 1}}
  end
end
