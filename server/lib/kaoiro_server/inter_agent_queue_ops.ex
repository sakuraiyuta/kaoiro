defmodule KaoiroServer.InterAgentQueueOps do
  @moduledoc """
  Operation records for `delivery_queue_control` idempotency, one per
  recipient and generation (docs/reference/protocol/channels.md,
  "Idempotency"). Pure; the queue owner keeps it in memory only.

  Operation ids are decimal counters that increase within a generation, so
  an id above the high-water mark is new, and an id at or below it without
  a record is `unknown_operation`, whether it expired or never existed.

  - Item-touching operations (`begin_native`, `return`, `dispose`) keep the
    phase each touched item entered. A retry gets the original reply while
    every touched item is still in that phase, `operation_superseded` once
    some moved on, and the record goes when all of them moved on.
  - A `credit` record lives while that credit is outstanding.
  - Other operations keep the 64 most recent records.
  """

  @item_less_limit 64

  def item_less_limit, do: @item_less_limit

  def new, do: %{high_water: 0, touching: %{}, credit: nil, item_less: %{}, order: []}

  @doc "Parses a wire operation id: a positive decimal integer without leading zeros."
  def parse_id(id) when is_binary(id) do
    case Integer.parse(id) do
      {n, ""} when n > 0 -> if Integer.to_string(n) == id, do: {:ok, n}, else: :error
      _ -> :error
    end
  end

  def parse_id(_id), do: :error

  @doc """
  Classifies an incoming operation. `phase_of` maps a queue id to its
  current phase (`:terminal` when gone). Returns `:new`, `{:replay, reply}`
  or `{:error, reason}` with reason `:operation_payload_mismatch`,
  `{:operation_superseded, phases}` or `:unknown_operation`.
  """
  def classify(ops, id, digest, phase_of) do
    cond do
      id > ops.high_water -> :new
      record = ops.touching[id] -> classify_touching(record, digest, phase_of)
      match?(%{id: ^id}, ops.credit) -> replay(ops.credit, digest)
      record = ops.item_less[id] -> replay(record, digest)
      true -> {:error, :unknown_operation}
    end
  end

  defp classify_touching(record, digest, phase_of) do
    if record.digest != digest do
      {:error, :operation_payload_mismatch}
    else
      current = for {queue_id, _phase} <- record.touched, do: {queue_id, phase_of.(queue_id)}

      if current == record.touched,
        do: {:replay, record.reply},
        else: {:error, {:operation_superseded, current}}
    end
  end

  defp replay(record, digest) do
    if record.digest == digest,
      do: {:replay, record.reply},
      else: {:error, :operation_payload_mismatch}
  end

  @doc "Records an item-touching operation with the phase each item entered."
  def record_touching(ops, id, digest, reply, touched),
    do: %{
      bump(ops, id)
      | touching: Map.put(ops.touching, id, %{digest: digest, reply: reply, touched: touched})
    }

  @doc "Records the outstanding credit; it replaces the previous one."
  def record_credit(ops, id, digest, reply),
    do: %{bump(ops, id) | credit: %{id: id, digest: digest, reply: reply}}

  @doc "The credit is consumed, withdrawn or superseded: its record goes."
  def clear_credit(ops), do: %{ops | credit: nil}

  def record_item_less(ops, id, digest, reply) do
    ops = bump(ops, id)
    order = ops.order ++ [id]
    {evicted, order} = Enum.split(order, max(length(order) - @item_less_limit, 0))

    item_less =
      ops.item_less
      |> Map.put(id, %{digest: digest, reply: reply})
      |> Map.drop(evicted)

    %{ops | item_less: item_less, order: order}
  end

  @doc "Drops item-touching records whose items have all left their phase."
  def prune(ops, phase_of) do
    touching =
      Map.reject(ops.touching, fn {_id, record} ->
        Enum.all?(record.touched, fn {queue_id, phase} -> phase_of.(queue_id) != phase end)
      end)

    %{ops | touching: touching}
  end

  defp bump(ops, id), do: %{ops | high_water: max(ops.high_water, id)}
end
