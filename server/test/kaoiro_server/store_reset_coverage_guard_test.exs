defmodule KaoiroServer.StoreResetCoverageGuardTest do
  # Coverage check for KaoiroServer.TestStores.dets_singletons/0 (issue 554).
  #
  # The enumeration is over open DETS tables, not supervisor children: a table
  # opened by a process outside the application's supervisor is still seen,
  # and a table named differently from its owner is still seen under its own
  # name. Only tables in the test DETS directory count, so tables that a test
  # opens under its own scratch path are ignored.
  #
  # Two directions are checked. A table open in the test directory but not
  # listed is a leak that the reset would miss. A listed store that is not
  # running is a reset that cannot work. The control tests show that the
  # comparison reports each direction.
  use ExUnit.Case, async: false

  alias KaoiroServer.{PersistencePaths, StrayDetsStore, TestStores}

  test "every DETS table in the test directory is listed, and every listed store runs" do
    listed = Enum.sort(TestStores.dets_singletons())

    assert {[], []} == diff(open_test_tables(), listed)

    for store <- listed do
      assert is_pid(Process.whereis(store)), "#{inspect(store)} is not running"
    end
  end

  # The reset order is a contract. A store that reads another at start must be
  # reset after it, and IngressOrder after both of its seed sources. The
  # isolation fixture cannot observe the first pair, because the reset empties
  # AgentStatusLines' rows before it restarts, so this test pins the order.
  test "readers at start are reset after the stores they read" do
    order = TestStores.dets_singletons()

    assert position(order, KaoiroServer.TokenDenylist) <
             position(order, KaoiroServer.AgentStatusLines)

    assert position(order, KaoiroServer.ClearWatermarks) <
             position(order, KaoiroServer.IngressOrder)

    assert position(order, KaoiroServer.SessionStarts) <
             position(order, KaoiroServer.IngressOrder)
  end

  test "the reset list matches the deployment manifest of persisted stores" do
    manifest =
      PersistencePaths.manifest()
      |> Enum.map(&Module.concat(KaoiroServer, Macro.camelize(&1.store)))
      |> Enum.sort()

    assert manifest == Enum.sort(TestStores.dets_singletons())
  end

  test "control: a listed store that is missing from the list is reported" do
    listed = Enum.sort(TestStores.dets_singletons())

    assert {[KaoiroServer.Users], []} ==
             diff(open_test_tables(), List.delete(listed, KaoiroServer.Users))
  end

  test "control: an unlisted DETS table in the test directory is reported" do
    name = :"kaoiro_guard_stray_#{System.unique_integer([:positive])}"
    path = Path.join(test_dir(), "#{name}.dets")
    spec = %{id: name, start: {StrayDetsStore, :start_link, [{name, path}]}, restart: :temporary}
    {:ok, _pid} = Supervisor.start_child(KaoiroServer.Supervisor, spec)

    try do
      assert {[name], []} == diff(open_test_tables(), Enum.sort(TestStores.dets_singletons()))
    after
      :ok = Supervisor.terminate_child(KaoiroServer.Supervisor, name)
      _ = File.rm(path)
    end
  end

  defp test_dir, do: Path.dirname(Application.fetch_env!(:kaoiro_server, :delivery_states_path))

  defp open_test_tables do
    dir = test_dir()
    for table <- :dets.all(), in_dir?(table, dir), do: table
  end

  defp in_dir?(table, dir) do
    Path.dirname(to_string(:dets.info(table, :filename))) == dir
  end

  # {open but not listed, listed but not open}
  defp diff(open, listed), do: {Enum.sort(open -- listed), Enum.sort(listed -- open)}

  defp position(order, store), do: Enum.find_index(order, &(&1 == store))
end
