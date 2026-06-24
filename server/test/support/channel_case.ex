defmodule KaoiroServerWeb.ChannelCase do
  @moduledoc """
  Test case for channel tests: imports Phoenix.ChannelTest bound to the
  app endpoint.
  """

  use ExUnit.CaseTemplate

  using do
    quote do
      import Phoenix.ChannelTest
      import KaoiroServerWeb.ChannelCase

      @endpoint KaoiroServerWeb.Endpoint
    end
  end

  setup do
    # Reset the globally named AgentStates / HostRegistry between tests so
    # stored envelopes and host registrations cannot leak across cases
    # (tests run async: false).
    on_exit(fn ->
      Supervisor.terminate_child(KaoiroServer.Supervisor, KaoiroServer.AgentStates)
      Supervisor.restart_child(KaoiroServer.Supervisor, KaoiroServer.AgentStates)
      Supervisor.terminate_child(KaoiroServer.Supervisor, KaoiroServer.HostRegistry)
      Supervisor.restart_child(KaoiroServer.Supervisor, KaoiroServer.HostRegistry)
    end)

    :ok
  end
end
