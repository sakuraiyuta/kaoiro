defmodule KaoiroServer.StrayDetsStore do
  @moduledoc """
  Test-only: a supervised process that opens one DETS table and nothing else.
  `KaoiroServer.StoreResetCoverageGuardTest` starts it under the application
  supervisor as a negative control: the guard must see a table that the reset
  list does not name.
  """

  use GenServer

  def start_link({name, path}), do: GenServer.start_link(__MODULE__, {name, path})

  @impl true
  def init({name, path}) do
    Process.flag(:trap_exit, true)
    {:ok, ^name} = :dets.open_file(name, file: String.to_charlist(path))
    {:ok, name}
  end

  @impl true
  def terminate(_reason, name), do: :dets.close(name)
end
