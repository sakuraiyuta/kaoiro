defmodule KaoiroServer.DeliveryStatesTest do
  use ExUnit.Case, async: false

  import KaoiroServer.TestTeardown

  alias KaoiroServer.DeliveryStates

  setup do
    name = :"delivery_states_#{System.unique_integer([:positive])}"
    path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "#{name}.dets"])
    File.rm(path)
    {:ok, _} = DeliveryStates.start_link(name: name, path: path)

    on_exit(fn ->
      stop_quietly(name)
      File.rm(path)
    end)

    %{name: name, path: path}
  end

  test "legacy DETS watermarks migrate without inventing sender information", %{
    name: name,
    path: path
  } do
    GenServer.stop(Process.whereis(name))
    {:ok, table} = :dets.open_file(name, file: String.to_charlist(path))
    :ok = :dets.insert(table, {"recipient", "generation", 3, 1, "2026-09-18T00:00:00Z"})
    :ok = :dets.close(table)
    start_supervised!({DeliveryStates, name: name, path: path})

    assert %{issued_seq: 3, acked_seq: 1} =
             DeliveryStates.bind_resync("recipient", "generation", self(), name)

    assert {:ok, %{acked_seq: 3, lost_count: 2, last_loss: %{reason: "untraceable"}}} =
             DeliveryStates.resync("recipient", "generation", self(), 3, [[2, 3]], name)
  end

  test "retiring the first missing sequence immediately releases the prefix", %{name: name} do
    DeliveryStates.bind_resync("recipient", "generation", self(), name)
    for _ <- 1..3, do: DeliveryStates.issue("recipient", name)

    assert {:ok, %{acked_seq: 1, lost_count: 1}} =
             DeliveryStates.resync("recipient", "generation", self(), 3, [[1, 1]], name)

    assert %{acked_seq: 3, pending_since: nil} =
             DeliveryStates.acknowledge("recipient", "generation", self(), 3, name)
  end

  test "skip advances only a resolved prefix and persists idempotent loss", %{
    name: name,
    path: path
  } do
    DeliveryStates.bind_resync("recipient", "generation", self(), name)
    for _ <- 1..3, do: DeliveryStates.issue("recipient", name)

    assert {:ok, %{acked_seq: 0, lost_count: 1}} =
             DeliveryStates.resync("recipient", "generation", self(), 3, [[2, 2]], name)

    assert {:ok, %{acked_seq: 0, lost_count: 1}} =
             DeliveryStates.resync("recipient", "generation", self(), 3, [[2, 2]], name)

    GenServer.stop(Process.whereis(name))
    start_supervised!({DeliveryStates, name: name, path: path})

    assert {:error, :stale_delivery_owner} =
             DeliveryStates.resync("recipient", "generation", self(), 3, [[2, 2]], name)

    DeliveryStates.bind_resync("recipient", "generation", self(), name)

    assert %{acked_seq: 2, lost_count: 1} =
             DeliveryStates.acknowledge("recipient", "generation", self(), 1, name)

    assert %{acked_seq: 3, pending_since: nil, last_loss: %{reason: "untraceable"}} =
             DeliveryStates.acknowledge("recipient", "generation", self(), 3, name)
  end

  test "recovery rejects stale owners, generations, unnegotiated and invalid ranges", %{
    name: name
  } do
    DeliveryStates.bind_resync("recipient", "generation", self(), name)
    DeliveryStates.issue("recipient", name)

    for ranges <- [[], [[0, 1]], [[1, 2]], [[1, 1], [1, 1]], [[1, 1.5]], "bad"] do
      assert {:error, :invalid_delivery_resync} =
               DeliveryStates.resync("recipient", "generation", self(), 1, ranges, name)
    end

    assert {:error, :stale_delivery_owner} =
             DeliveryStates.resync("recipient", "old", self(), 1, [[1, 1]], name)

    assert {:error, :stale_delivery_owner} =
             DeliveryStates.resync("recipient", "generation", :wrong_owner, 1, [[1, 1]], name)

    assert {:error, :stale_delivery_owner} = DeliveryStates.ack("recipient", 1, name)
    assert %{acked_seq: 0, lost_count: 0} = DeliveryStates.get("recipient", name)
    DeliveryStates.bind_resync("recipient", "new", self(), name)

    assert {:error, :stale_delivery_owner} =
             DeliveryStates.acknowledge("recipient", "generation", self(), 1, name)

    assert %{acked_seq: 1, lost_count: 0} = DeliveryStates.get("recipient", name)
    DeliveryStates.bind("legacy", "generation", name)
    DeliveryStates.issue("legacy", name)

    assert {:error, :stale_delivery_owner} =
             DeliveryStates.resync("legacy", "generation", self(), 1, [[1, 1]], name)

    refute Map.has_key?(DeliveryStates.get("legacy", name), :lost_count)
  end

  test "whole-generation retirement is owner and generation fenced", %{name: name} do
    owner = self()
    DeliveryStates.bind_resync("recipient", "generation", owner, name)

    assert 1 =
             DeliveryStates.issue_synthetic(
               "recipient",
               %{sender: "sender", conversation_id: "cid", turn_number: 1, kind: "request"},
               name
             )

    assert 2 = DeliveryStates.issue("recipient", name)

    assert {:error, :stale_delivery_owner} =
             DeliveryStates.retire_owned_generation("recipient", "old", owner, name)

    assert {:error, :stale_delivery_owner} =
             DeliveryStates.retire_owned_generation("recipient", "generation", :stale, name)

    assert %{acked_seq: 0, lost_count: 0} = DeliveryStates.get("recipient", name)

    assert {:ok,
            %{acked_seq: 2, issued_seq: 2, pending_since: nil, lost_count: 2, last_loss: loss}} =
             DeliveryStates.retire_owned_generation("recipient", "generation", owner, name)

    assert loss.reason == "interrupted"

    assert [%{reason: "interrupted", recipient: "recipient"}] =
             DeliveryStates.pending_losses(name)
  end

  test "same generation reconnect retains a real gap; new process generation abandons it", %{
    name: name
  } do
    assert %{issued_seq: 0, acked_seq: 0, pending_since: nil} =
             DeliveryStates.bind("momo", "generation-a", name)

    assert 1 = DeliveryStates.issue("momo", name)

    assert %{issued_seq: 1, acked_seq: 0, pending_since: pending} =
             DeliveryStates.get("momo", name)

    assert %{issued_seq: 1, acked_seq: 0, pending_since: ^pending} =
             DeliveryStates.bind("momo", "generation-a", name)

    assert %{issued_seq: 1, acked_seq: 1, pending_since: nil} =
             DeliveryStates.bind("momo", "generation-b", name)
  end

  test "ack is bounded and does not slide first pending timestamp", %{name: name} do
    DeliveryStates.bind("momo", "generation-a", name)
    assert 1 = DeliveryStates.issue("momo", name)
    assert %{pending_since: pending} = DeliveryStates.get("momo", name)
    assert 2 = DeliveryStates.issue("momo", name)

    assert %{issued_seq: 2, acked_seq: 1, pending_since: ^pending} =
             DeliveryStates.ack("momo", 1, name)

    assert %{issued_seq: 2, acked_seq: 1, pending_since: ^pending} =
             DeliveryStates.ack("momo", 99, name)

    assert %{issued_seq: 2, acked_seq: 2, pending_since: nil} =
             DeliveryStates.ack("momo", 2, name)
  end

  test "restart preserves a pending observation instead of turning it into healthy", %{
    name: name,
    path: path
  } do
    DeliveryStates.bind("momo", "generation-a", name)
    assert 1 = DeliveryStates.issue("momo", name)
    assert %{pending_since: pending} = DeliveryStates.get("momo", name)

    GenServer.stop(Process.whereis(name))
    {:ok, _} = DeliveryStates.start_link(name: name, path: path)

    assert %{issued_seq: 1, acked_seq: 0, pending_since: ^pending} =
             DeliveryStates.get("momo", name)
  end

  test "wire projection は store を変えずに実運用上限へ収める", %{name: name} do
    for n <- 1..201 do
      id = "agent-#{String.pad_leading(Integer.to_string(n), 3, "0")}"
      assert %{issued_seq: 0} = DeliveryStates.bind(id, "generation-#{n}", name)
    end

    {projection, incomplete?} = DeliveryStates.wire_projection(name)

    assert map_size(DeliveryStates.all(name)) == 201
    assert incomplete?
    assert map_size(projection) == 200
    assert Map.has_key?(projection, "agent-001")
    refute Map.has_key?(projection, "agent-201")
  end

  test "wire projection は接続中または未確認 gap の delivery を優先し、省略を明示する" do
    historical =
      Map.new(1..200, fn n ->
        id = "agent-#{String.pad_leading(Integer.to_string(n), 3, "0")}"
        {id, %{issued_seq: 4, acked_seq: 4, pending_since: nil}}
      end)

    deliveries =
      historical
      |> Map.put("z-live", %{issued_seq: 2, acked_seq: 2, pending_since: nil})
      |> Map.put("z-gap", %{issued_seq: 3, acked_seq: 2, pending_since: "2026-08-28T00:00:00Z"})

    {projection, incomplete?} =
      DeliveryStates.wire_projection(deliveries, MapSet.new(["z-live"]))

    assert incomplete?
    assert map_size(projection) == 200
    assert Map.has_key?(projection, "z-live")
    assert Map.has_key?(projection, "z-gap")
    refute Map.has_key?(projection, "agent-200")
  end
end
