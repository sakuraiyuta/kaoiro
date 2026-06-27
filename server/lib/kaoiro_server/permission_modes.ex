defmodule KaoiroServer.PermissionModes do
  @moduledoc """
  Restart-surviving store of the most recent operator-picked
  `permission_mode` for each agent_id (issue #58). Mirrors the
  `SessionPointers` store: tiny payload, DETS-backed, in-memory mirror
  for fast reads, fire-and-forget writes.

  The store records only what the operator most recently picked; it does
  NOT decide the SDK's eventual mode. On wrapper join the channel pushes
  the persisted value (if any) so the wrapper starts the session in that
  mode; on a dashboard `set_permission_mode` op the value is relayed AND
  persisted so the next start restores it.
  """

  use GenServer

  require Logger

  @doc """
  Starts the store. `:path` overrides the DETS file and `:name` the
  registered name + DETS table (tests run isolated instances).
  """
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    path = Keyword.get(opts, :path, default_path())
    GenServer.start_link(__MODULE__, {name, path}, name: name)
  end

  @doc """
  Records `mode` as the agent's latest permission-mode pick.
  Fire-and-forget so persistence never slows the relay path.
  """
  def record(agent_id, mode, server \\ __MODULE__) do
    GenServer.cast(server, {:record, agent_id, mode})
  end

  @doc "Latest persisted mode for the agent, or nil."
  def get(agent_id, server \\ __MODULE__) do
    GenServer.call(server, {:get, agent_id})
  end

  @doc "agent_id => mode for every known pick."
  def all(server \\ __MODULE__) do
    GenServer.call(server, :all)
  end

  @impl true
  def init({name, path}) do
    path |> Path.dirname() |> File.mkdir_p!()
    table = open_table(name, path)
    # mode is not personally sensitive, but the file lives next to the
    # session-pointer DETS — keep the chmod symmetric with SessionPointers.
    _ = File.chmod(path, 0o600)
    {:ok, %{table: table, modes: load_modes(table)}}
  end

  # A corrupt/unreadable DETS file must not crash-loop the supervisor.
  # On a failed open, drop the file and recreate it empty — losing a few
  # picks costs the operator at most one re-selection.
  defp open_table(name, path) do
    case :dets.open_file(name, file: String.to_charlist(path)) do
      {:ok, ^name} ->
        name

      {:error, reason} ->
        Logger.warning("permission mode store unreadable (#{inspect(reason)}); recreating")

        File.rm(path)
        {:ok, ^name} = :dets.open_file(name, file: String.to_charlist(path))
        name
    end
  end

  defp load_modes(table) do
    case :dets.foldl(
           fn {agent_id, mode}, acc -> Map.put(acc, agent_id, mode) end,
           %{},
           table
         ) do
      modes when is_map(modes) -> modes
      {:error, _reason} -> %{}
    end
  end

  @impl true
  def handle_cast({:record, agent_id, mode}, state) do
    if Map.get(state.modes, agent_id) == mode do
      {:noreply, state}
    else
      :ok = :dets.insert(state.table, {agent_id, mode})
      {:noreply, %{state | modes: Map.put(state.modes, agent_id, mode)}}
    end
  end

  @impl true
  def handle_call({:get, agent_id}, _from, state) do
    {:reply, Map.get(state.modes, agent_id), state}
  end

  def handle_call(:all, _from, state) do
    {:reply, state.modes, state}
  end

  @impl true
  def terminate(_reason, state) do
    :dets.close(state.table)
  end

  defp default_path do
    Application.get_env(:kaoiro_server, :permission_modes_path) ||
      Path.join(System.tmp_dir!(), "kaoiro_permission_modes.dets")
  end
end
