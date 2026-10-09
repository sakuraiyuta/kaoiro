defmodule KaoiroServerWeb.BuildIdentityBridgeTest do
  use KaoiroServerWeb.ChannelCase, async: false

  test "a modern runner register retains its branch in the actual hosts broadcast" do
    host_id = "bridge-#{System.unique_integer([:positive])}"
    @endpoint.subscribe("agents:lobby")

    {:ok, _, socket} =
      KaoiroServerWeb.RunnerSocket
      |> socket(nil, %{})
      |> subscribe_and_join(KaoiroServerWeb.RunnerChannel, "runner:" <> host_id)

    payload = %{
      "cwd_allowlist" => [],
      "build_revision" => String.duplicate("a", 40),
      "build_dirty" => false,
      "build_version" => "2026.10.09.2",
      "build_channel" => "dev",
      "build_branch" => "develop"
    }

    assert_reply push(socket, "register", payload), :ok
    assert_broadcast "hosts", %{"hosts" => hosts}
    assert hosts[host_id][:build_branch] == "develop"
    assert hosts[host_id][:build_version] == "2026.10.09.2"

    for rejected <- [
          Map.delete(payload, "build_branch"),
          Map.put(payload, "build_branch", nil),
          Map.put(payload, "build_version", "2026.02.30.1"),
          Map.put(payload, "build_dirty", true)
        ] do
      assert_reply push(socket, "register", rejected), :error
      assert KaoiroServer.HostRegistry.get(host_id).build_branch == "develop"
    end
  end

  test "the modern wrapper report reaches the actual store and broadcast with its branch" do
    agent_id = "bridge.wrapper-#{System.unique_integer([:positive])}"
    @endpoint.subscribe("agents:lobby")

    {:ok, _, socket} =
      KaoiroServerWeb.WrapperSocket
      |> socket(nil, %{})
      |> subscribe_and_join(KaoiroServerWeb.WrapperChannel, "wrapper:" <> agent_id, %{
        "persona_id" => "default"
      })

    payload = %{
      "version" => "0",
      "build_revision" => String.duplicate("b", 40),
      "build_dirty" => false,
      "build_version" => "2026.10.09.3",
      "build_channel" => "dev",
      "build_branch" => "develop"
    }

    assert_reply push(socket, "wrapper_build_info", payload), :ok
    assert_broadcast "wrapper_build_info", %{"agent_id" => ^agent_id, "build_branch" => "develop"}
    assert KaoiroServer.WrapperBuildInfos.snapshot()[agent_id]["build_branch"] == "develop"
  end
end
