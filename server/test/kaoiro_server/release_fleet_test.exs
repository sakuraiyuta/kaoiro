defmodule KaoiroServer.ReleaseFleetTest do
  use ExUnit.Case, async: false

  alias KaoiroServer.{HostRegistry, ReleaseFleet, WrapperBuildInfos}

  test "the production stores expose only build fields from their current owners" do
    id = "fleet-#{System.unique_integer([:positive])}"
    revision = String.duplicate("a", 40)
    owner = self()

    attrs = %{
      build_revision: revision,
      build_dirty: false,
      build_version: "2026.10.09.2",
      build_channel: "dev",
      build_branch: "develop",
      cwd_allowlist: ["/secret"],
      in_flight_defaults: %{"codex" => true}
    }

    :ok = HostRegistry.register(id, attrs, owner)
    info = Map.new(attrs, fn {key, value} -> {Atom.to_string(key), value} end)
    :ok = WrapperBuildInfos.put(id, info, owner)

    on_exit(fn ->
      HostRegistry.drop(id, owner)
      WrapperBuildInfos.delete(id, owner)
    end)

    snapshot = Jason.decode!(ReleaseFleet.snapshot_json())
    assert snapshot["schema"] == 1

    for group <- ["hosts", "wrappers"] do
      entry = Enum.find(snapshot[group], &(&1["id"] == id))
      assert entry["build_revision"] == revision
      assert entry["build_version"] == "2026.10.09.2"
      assert entry["build_branch"] == "develop"

      assert Enum.sort(Map.keys(entry)) ==
               ~w(build_branch build_channel build_dirty build_revision build_version id)
    end
  end

  test "a wedged production HostRegistry refuses within its explicit RPC call timeout" do
    :ok = :sys.suspend(HostRegistry)

    try do
      started = System.monotonic_time(:millisecond)
      assert {:timeout, _} = catch_exit(ReleaseFleet.snapshot_json())
      assert System.monotonic_time(:millisecond) - started < 2_500
    after
      :sys.resume(HostRegistry)
    end
  end

  test "a wedged production WrapperBuildInfos also has an explicit timeout" do
    :ok = :sys.suspend(WrapperBuildInfos)

    try do
      assert {:timeout, _} = catch_exit(ReleaseFleet.snapshot_json())
    after
      :sys.resume(WrapperBuildInfos)
    end
  end
end
