defmodule KaoiroServer.WrapperBuildInfosTest do
  use ExUnit.Case, async: true

  alias KaoiroServer.WrapperBuildInfos

  @info %{
    "build_revision" => "0123456789012345678901234567890123456789",
    "build_dirty" => false,
    "build_version" => "2026.9.0",
    "build_channel" => "dev"
  }

  setup do
    name = String.to_atom("wrapper_build_infos_#{System.unique_integer([:positive])}")
    %{store: start_supervised!({WrapperBuildInfos, name: name})}
  end

  test "stores a validated identity and exposes a JSON-safe snapshot", %{store: store} do
    assert :ok = WrapperBuildInfos.put("agent-a", @info, self(), store)
    assert WrapperBuildInfos.snapshot(store) == %{"agent-a" => @info}
    assert {:ok, _} = Jason.encode(%{"builds" => WrapperBuildInfos.snapshot(store)})
  end

  test "rejects malformed identities without changing the snapshot", %{store: store} do
    assert {:error, :invalid_build_info} =
             WrapperBuildInfos.put("agent-a", %{@info | "build_dirty" => "false"}, self(), store)

    assert WrapperBuildInfos.snapshot(store) == %{}
  end

  test "owner fencing keeps a newer connection's identity", %{store: store} do
    old_owner = spawn(fn -> Process.sleep(100) end)
    new_owner = spawn(fn -> Process.sleep(100) end)
    assert :ok = WrapperBuildInfos.put("agent-a", @info, old_owner, store)

    assert :ok =
             WrapperBuildInfos.put("agent-a", %{@info | "build_dirty" => true}, new_owner, store)

    assert :noop = WrapperBuildInfos.delete("agent-a", old_owner, store)
    assert WrapperBuildInfos.snapshot(store)["agent-a"]["build_dirty"]
    assert {:ok, _} = WrapperBuildInfos.delete("agent-a", new_owner, store)
    assert WrapperBuildInfos.snapshot(store) == %{}
  end
end
