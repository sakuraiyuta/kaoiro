defmodule KaoiroServer.DeliveryStatesTest do
  use ExUnit.Case, async: false

  import KaoiroServer.TestTeardown

  alias KaoiroServer.DeliveryStates

  setup do
    name = :"delivery_states_#{System.unique_integer([:positive])}"
    path = Path.join(System.tmp_dir!(), "#{name}.dets")
    File.rm(path)
    {:ok, _} = DeliveryStates.start_link(name: name, path: path)

    on_exit(fn ->
      stop_quietly(name)
      File.rm(path)
    end)

    %{name: name, path: path}
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
