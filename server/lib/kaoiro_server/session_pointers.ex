defmodule KaoiroServer.SessionPointers do
  @moduledoc """
  Restart-surviving store of each agent's most recent SDK `session_id`
  (ADR-0014 F1, issue #49). Persists only the pointer
  `agent_id => %{session_id, cwd}`, never conversation history — the
  history's source of truth is the wrapper host's JSONL (ADR-0014 A4).

  Backed by DETS (one on-disk file, no extra deps) since the data is tiny
  and losing a pointer only costs the default resume target; the runner
  can still enumerate candidates from JSONL (ADR-0014 F2). agent_id maps
  1:1 to its latest session_id (F3); the full 1:N session history is the
  runner's job, not this store's. The ADR tuple's `host` is implied by
  agent_id (bound to a fixed host/cwd, F3) and is not carried in the
  protocol, so only cwd is kept alongside session_id.

  An in-memory map mirrors DETS for fast reads; writes go through to disk
  only when a pointer actually changes, keeping the per-envelope ingest
  path cheap.
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
  Records `session_id` (and optional `cwd`) as the agent's latest pointer.
  Fire-and-forget so persistence never slows envelope ingest.
  """
  def record(agent_id, session_id, cwd \\ nil, server \\ __MODULE__) do
    GenServer.cast(server, {:record, agent_id, session_id, cwd})
  end

  @doc "Latest pointer `%{session_id, cwd}` for the agent, or nil."
  def get(agent_id, server \\ __MODULE__) do
    GenServer.call(server, {:get, agent_id})
  end

  @doc "agent_id => %{session_id, cwd} for every known pointer."
  def all(server \\ __MODULE__) do
    GenServer.call(server, :all)
  end

  @impl true
  def init({name, path}) do
    path |> Path.dirname() |> File.mkdir_p!()
    table = open_table(name, path)
    # Records carry cwd, which is sensitive (#46); keep the file owner-only
    # so the default /tmp location is not world-readable on a shared host.
    # Best-effort — chmod can fail on non-POSIX filesystems, not fatal.
    _ = File.chmod(path, 0o600)
    {:ok, %{table: table, pointers: load_pointers(table)}}
  end

  # A corrupt/unreadable DETS file must not crash-loop the supervisor: the
  # pointer store is recoverable (the runner re-enumerates, ADR-0014 F2). On
  # a failed open, drop the file and recreate it empty.
  defp open_table(name, path) do
    case :dets.open_file(name, file: String.to_charlist(path)) do
      {:ok, ^name} ->
        name

      {:error, reason} ->
        Logger.warning("session pointer store unreadable (#{inspect(reason)}); recreating")

        File.rm(path)
        {:ok, ^name} = :dets.open_file(name, file: String.to_charlist(path))
        name
    end
  end

  # Fold the table into the in-memory map; an error tuple (corrupt mid-read)
  # degrades to an empty map rather than crashing init.
  defp load_pointers(table) do
    case :dets.foldl(
           fn {agent_id, session_id, cwd}, acc ->
             Map.put(acc, agent_id, %{session_id: session_id, cwd: cwd})
           end,
           %{},
           table
         ) do
      pointers when is_map(pointers) -> pointers
      {:error, _reason} -> %{}
    end
  end

  @impl true
  def handle_cast({:record, agent_id, session_id, cwd}, state) do
    pointer = %{session_id: session_id, cwd: cwd}

    if Map.get(state.pointers, agent_id) == pointer do
      {:noreply, state}
    else
      :ok = :dets.insert(state.table, {agent_id, session_id, cwd})
      {:noreply, %{state | pointers: Map.put(state.pointers, agent_id, pointer)}}
    end
  end

  @impl true
  def handle_call({:get, agent_id}, _from, state) do
    {:reply, Map.get(state.pointers, agent_id), state}
  end

  def handle_call(:all, _from, state) do
    {:reply, state.pointers, state}
  end

  @impl true
  def terminate(_reason, state) do
    :dets.close(state.table)
  end

  defp default_path do
    Application.get_env(:kaoiro_server, :session_pointers_path) ||
      Path.join(System.tmp_dir!(), "kaoiro_session_pointers.dets")
  end
end
