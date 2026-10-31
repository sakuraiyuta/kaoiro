defmodule KaoiroServer.DeviceAuthFixture do
  @moduledoc """
  Swaps the application's `KaoiroServer.DeviceAuth` for one on a test
  clock, under the same name, so requests through the endpoint can poll
  without waiting out the real interval. The bare application child comes
  back after the test. Callers must be `async: false`.
  """

  alias KaoiroServer.DeviceAuth

  @doc """
  Starts the swap. Returns the clock; move it with `advance/2`. `opts`
  go to `DeviceAuth.init/1` (`:node_list`).
  """
  @spec use_test_clock!(keyword()) :: pid()
  def use_test_clock!(opts \\ []) do
    :ok = Supervisor.terminate_child(KaoiroServer.Supervisor, DeviceAuth)
    t0 = System.system_time(:millisecond)
    {:ok, clock} = Agent.start(fn -> t0 end)

    {:ok, store} =
      GenServer.start(DeviceAuth, [clock: fn -> Agent.get(clock, & &1) end] ++ opts,
        name: DeviceAuth
      )

    ExUnit.Callbacks.on_exit(fn ->
      for pid <- [store, clock] do
        ref = Process.monitor(pid)
        Process.exit(pid, :kill)
        receive do: ({:DOWN, ^ref, :process, ^pid, _reason} -> :ok)
      end

      {:ok, _pid} = Supervisor.restart_child(KaoiroServer.Supervisor, DeviceAuth)
    end)

    clock
  end

  @doc "Moves the test clock forward by `ms`."
  @spec advance(pid(), non_neg_integer()) :: :ok
  def advance(clock, ms), do: Agent.update(clock, &(&1 + ms))
end
