defmodule KaoiroServer.DeliveryMetadataTest do
  use ExUnit.Case, async: false
  alias KaoiroServer.DeliveryStates

  setup do
    name = :"delivery_metadata_#{System.unique_integer([:positive])}"
    dir = Path.join(System.tmp_dir!(), "fuji-354-metadata-#{name}")
    path = Path.join(dir, "delivery.dets")
    start_supervised!({DeliveryStates, name: name, path: path})
    on_exit(fn -> File.rm_rf!(dir) end)
    %{name: name, path: path}
  end

  defp descriptor do
    %{sender: "sender", conversation_id: "conversation", turn_number: 1, kind: "request"}
  end

  defp issue(name) do
    {:ok, token} = DeliveryStates.reserve("recipient", self(), name)
    DeliveryStates.issue_reserved("recipient", token, descriptor(), name)
  end

  test "concurrent senders cannot reserve the 1001st normal slot", %{name: name} do
    DeliveryStates.bind_resync("recipient", "generation", self(), name)
    owner = self()

    results =
      1..1001
      |> Task.async_stream(fn _ -> DeliveryStates.reserve("recipient", owner, name) end,
        max_concurrency: 32
      )
      |> Enum.map(fn {:ok, value} -> value end)

    assert Enum.count(results, &match?({:ok, _}, &1)) == 1000
    assert Enum.count(results, &(&1 == {:error, :delivery_backlog})) == 1
    for {:ok, token} <- results, do: DeliveryStates.release(token, name)
  end

  test "reservations bound allocation and release without issuing", %{name: name} do
    DeliveryStates.bind_resync("recipient", "generation", self(), name)
    before = DeliveryStates.get("recipient", name)

    reservations =
      for _ <- 1..1000 do
        assert {:ok, token} = DeliveryStates.reserve("recipient", self(), name)
        token
      end

    assert {:error, :delivery_backlog} = DeliveryStates.reserve("recipient", self(), name)
    assert before == DeliveryStates.get("recipient", name)
    [token | remaining] = reservations
    :ok = DeliveryStates.release(token, name)
    assert 1 == issue(name)
    assert {:error, :delivery_backlog} = DeliveryStates.reserve("recipient", self(), name)
    for reservation <- remaining, do: DeliveryStates.release(reservation, name)
    assert map_size(:sys.get_state(name).entries["recipient"].metadata) == 1
    assert map_size(:sys.get_state(name).reservations) == 0
    DeliveryStates.acknowledge("recipient", "generation", self(), 1, name)
    assert :sys.get_state(name).entries["recipient"].metadata == %{}
  end

  test "skip persists one intent and a recreated ledger cannot reuse its loss id", %{
    name: name,
    path: path
  } do
    DeliveryStates.bind_resync("recipient", "generation", self(), name)
    assert 1 == issue(name)

    assert {:ok, %{acked_seq: 1}} =
             DeliveryStates.resync("recipient", "generation", self(), 1, [[1, 1]], name)

    assert [loss] = DeliveryStates.pending_losses(name)
    assert loss.descriptor == descriptor()
    assert :sys.get_state(name).entries["recipient"].metadata == %{}
    DeliveryStates.resync("recipient", "generation", self(), 1, [[1, 1]], name)
    assert [^loss] = DeliveryStates.pending_losses(name)
    :ok = stop_supervised(DeliveryStates)
    start_supervised!({DeliveryStates, name: name, path: path})
    assert [^loss] = DeliveryStates.pending_losses(name)
    DeliveryStates.delete("recipient", name)
    assert [^loss] = DeliveryStates.pending_losses(name)
    DeliveryStates.bind_resync("recipient", "generation", self(), name)
    assert 1 == issue(name)
    DeliveryStates.resync("recipient", "generation", self(), 1, [[1, 1]], name)
    losses = DeliveryStates.pending_losses(name)
    assert length(losses) == 2
    assert length(Enum.uniq_by(losses, & &1.id)) == 2
    for pending <- losses, do: DeliveryStates.complete_loss(pending.id, pending.revision, name)
    assert [] == DeliveryStates.pending_losses(name)
  end

  test "deleting an active ledger keeps the notification intent and synthetic bypasses capacity",
       %{name: name} do
    DeliveryStates.bind_resync("recipient", "generation", self(), name)

    tokens =
      for _ <- 1..1000 do
        {:ok, token} = DeliveryStates.reserve("recipient", self(), name)
        token
      end

    assert 1 ==
             DeliveryStates.issue_synthetic(
               "recipient",
               %{synthetic: true, kind: "inform", conversation_id: "cid"},
               name
             )

    assert {:error, :delivery_backlog} = DeliveryStates.reserve("recipient", self(), name)
    for token <- tokens, do: DeliveryStates.release(token, name)
    DeliveryStates.delete("recipient", name)
    assert DeliveryStates.get("recipient", name) == nil

    assert [%{descriptor: %{synthetic: true}, reason: "interrupted"}] =
             DeliveryStates.pending_losses(name)
  end

  test "a legacy capability downgrade reclaims v2 metadata even with the same generation", %{
    name: name
  } do
    DeliveryStates.bind_resync("recipient", "generation", self(), name)
    issue(name)
    assert %{acked_seq: 1, issued_seq: 1} = DeliveryStates.bind("recipient", "generation", name)
    assert :sys.get_state(name).entries["recipient"].metadata == %{}
    assert [%{reason: "interrupted"}] = DeliveryStates.pending_losses(name)
  end

  test "completing an older notification cannot erase its concurrently lost recovery", %{
    name: name
  } do
    DeliveryStates.bind_resync("recipient", "generation", self(), name)
    issue(name)
    DeliveryStates.resync("recipient", "generation", self(), 1, [[1, 1]], name)
    [original] = DeliveryStates.pending_losses(name)
    DeliveryStates.bind_resync("sender", "sender-generation", self(), name)

    DeliveryStates.issue_synthetic(
      "sender",
      %{synthetic: true, kind: "inform", conversation_id: "conversation", loss_id: original.id},
      name
    )

    DeliveryStates.resync("sender", "sender-generation", self(), 1, [[1, 1]], name)
    [recovery] = DeliveryStates.pending_losses(name)
    assert recovery.id == original.id
    refute recovery.revision == original.revision
    assert :stale = DeliveryStates.complete_loss(original.id, original.revision, name)
    assert [^recovery] = DeliveryStates.pending_losses(name)
    assert :ok = DeliveryStates.complete_loss(recovery.id, recovery.revision, name)
    assert [] == DeliveryStates.pending_losses(name)
  end

  test "generation and disarm retire metadata while legacy stays uncapped", %{name: name} do
    DeliveryStates.bind_resync("recipient", "generation", self(), name)
    issue(name)
    DeliveryStates.bind_resync("recipient", "next", self(), name)
    assert :sys.get_state(name).entries["recipient"].metadata == %{}
    assert [%{reason: "interrupted"}] = DeliveryStates.pending_losses(name)
    issue(name)
    DeliveryStates.disarm("recipient", name)
    assert length(DeliveryStates.pending_losses(name)) == 2
    assert DeliveryStates.get("recipient", name) == nil
    DeliveryStates.bind("recipient", "legacy", name)
    for _ <- 1..1001, do: assert({:ok, nil} = DeliveryStates.reserve("recipient", self(), name))
    assert :sys.get_state(name).reservations == %{}
  end
end
