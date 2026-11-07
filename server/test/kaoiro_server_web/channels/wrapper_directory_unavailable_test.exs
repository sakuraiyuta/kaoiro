defmodule KaoiroServerWeb.WrapperDirectoryUnavailableTest do
  use KaoiroServerWeb.ChannelCase, async: false

  alias KaoiroServer.{AgentActivity, AgentDirectory}

  for {label, store, payload} <- [
        {"self", AgentDirectory, %{"scope" => "self"}},
        {"ordinary", AgentActivity, %{}}
      ] do
    @store store
    @payload payload
    test "#{label} request survives a directory store exit and succeeds after restart" do
      id = "test.directory-unavailable.#{System.unique_integer([:positive])}"

      {:ok, _, socket} =
        KaoiroServerWeb.WrapperSocket
        |> socket(nil, %{})
        |> subscribe_and_join(KaoiroServerWeb.WrapperChannel, "wrapper:" <> id, %{
          "persona_id" => "default"
        })

      monitor = Process.monitor(socket.channel_pid)
      assert :ok = Supervisor.terminate_child(KaoiroServer.Supervisor, @store)
      on_exit(fn -> Supervisor.restart_child(KaoiroServer.Supervisor, @store) end)

      ref = push(socket, "directory_request", @payload)
      assert_reply(ref, :error, %{reason: "directory_unavailable"})
      refute_receive {:DOWN, ^monitor, :process, _, _}, 0

      assert {:ok, _} = Supervisor.restart_child(KaoiroServer.Supervisor, @store)
      ref = push(socket, "directory_request", @payload)
      assert_reply(ref, :ok, reply)

      if @payload == %{},
        do: assert(Map.has_key?(reply, "agents")),
        else: assert(reply["self"]["agent_id"] == id)
    end
  end
end
