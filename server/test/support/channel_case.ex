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
    # Reset the globally named AgentStates / HostRegistry / TaskStates
    # between tests so stored envelopes, host registrations, and active
    # tasks cannot leak across cases (tests run async: false). TaskStates
    # addition: M4 fix-round (2026-08-09, ふじ review) — tests that
    # exercised the default-named TaskStates singleton via a real channel
    # join (not an isolated `server: name` instance) leaked leftover
    # tasks into whichever test ran next, an order-dependent flake
    # (reproduced with --seed 114834).
    on_exit(fn ->
      Supervisor.terminate_child(KaoiroServer.Supervisor, KaoiroServer.AgentStates)
      Supervisor.restart_child(KaoiroServer.Supervisor, KaoiroServer.AgentStates)
      Supervisor.terminate_child(KaoiroServer.Supervisor, KaoiroServer.HostRegistry)
      Supervisor.restart_child(KaoiroServer.Supervisor, KaoiroServer.HostRegistry)
      Supervisor.terminate_child(KaoiroServer.Supervisor, KaoiroServer.TaskStates)
      Supervisor.restart_child(KaoiroServer.Supervisor, KaoiroServer.TaskStates)
      Supervisor.terminate_child(KaoiroServer.Supervisor, KaoiroServer.PlannedDisconnects)
      Supervisor.restart_child(KaoiroServer.Supervisor, KaoiroServer.PlannedDisconnects)
    end)

    :ok
  end
end
