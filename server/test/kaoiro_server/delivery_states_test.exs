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
end
