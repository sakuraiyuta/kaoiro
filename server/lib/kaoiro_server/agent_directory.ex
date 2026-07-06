defmodule KaoiroServer.AgentDirectory do
  @moduledoc """
  Restart-surviving identity ledger — `agent_id => %{persona, last_seen}`
  (ADR-0030). Persists the persona map so operator-driven restore
  (`agents_channel.ex agent_persona/1`) still works after a server restart
  when `AgentStates` is empty. Mirrors the `SessionPointers` /
  `PermissionModes` shape: tiny payload, DETS-backed, in-memory mirror for
  fast reads, fire-and-forget writes.

  Only `persona` is written to disk. `last_seen` is a memory-only unix
  seconds hint the client uses to grade "recently online" vs "long
  offline" — losing it on restart is fine (all reloaded entries look
  offline until the wrapper reconnects and touches them). Persisting
  every envelope's timestamp would put the ingest path on the disk write
  budget for no additional recovery value.
  """

  use GenServer

  require Logger

  @doc """
  Starts the ledger. `:path` overrides the DETS file and `:name` the
  registered name + DETS table (tests run isolated instances).
  """
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    path = Keyword.get(opts, :path, default_path())
    GenServer.start_link(__MODULE__, {name, path}, name: name)
  end

  @doc """
  Records `persona` (a map with at least `"id"`, `"name"`, `"sprite_set"`)
  as the agent's identity. Fire-and-forget so persistence never slows the
  spawn broadcast path.
  """
  def record(agent_id, persona, server \\ __MODULE__) when is_map(persona) do
    GenServer.cast(server, {:record, agent_id, persona})
  end

  @doc """
  Marks the agent as seen right now in the memory-only `last_seen` hint.
  No disk write — the timestamp is a hint for the client's live/offline
  merge, not persisted state (ADR-0030 A5).
  """
  def touch(agent_id, server \\ __MODULE__) do
    GenServer.cast(server, {:touch, agent_id, System.system_time(:second)})
  end

  @doc """
  Latest entry `%{persona, last_seen}` for the agent, or nil. `last_seen`
  is nil until the wrapper's first envelope after the current process
  start (fresh load / restart).
  """
  def get(agent_id, server \\ __MODULE__) do
    GenServer.call(server, {:get, agent_id})
  end

  @doc "agent_id => %{persona, last_seen} for every known entry."
  def all(server \\ __MODULE__) do
    GenServer.call(server, :all)
  end

  @impl true
  def init({name, path}) do
    path |> Path.dirname() |> File.mkdir_p!()
    table = open_table(name, path)
    # Records may carry a custom name the operator picked. Keep the file
    # owner-only so the default /tmp location is not world-readable on a
    # shared host — matches SessionPointers' chmod discipline.
    _ = File.chmod(path, 0o600)
    {:ok, %{table: table, entries: load_entries(table)}}
  end

  # A corrupt/unreadable DETS file must not crash-loop the supervisor.
  # On a failed open, drop the file and recreate it empty — losing entries
  # only costs the operator the ability to restore agents that spawned
  # before the corruption, and forces a fresh spawn per agent to seed
  # again.
  defp open_table(name, path) do
    case :dets.open_file(name, file: String.to_charlist(path)) do
      {:ok, ^name} ->
        name

      {:error, reason} ->
        Logger.warning("agent directory store unreadable (#{inspect(reason)}); recreating")

        File.rm(path)
        {:ok, ^name} = :dets.open_file(name, file: String.to_charlist(path))
        name
    end
  end

  defp load_entries(table) do
    case :dets.foldl(
           fn {agent_id, persona}, acc ->
             Map.put(acc, agent_id, %{persona: persona, last_seen: nil})
           end,
           %{},
           table
         ) do
      entries when is_map(entries) -> entries
      {:error, _reason} -> %{}
    end
  end

  @impl true
  def handle_cast({:record, agent_id, persona}, state) do
    existing = Map.get(state.entries, agent_id)
    stored_persona = existing && Map.get(existing, :persona)

    if stored_persona == persona do
      {:noreply, state}
    else
      :ok = :dets.insert(state.table, {agent_id, persona})
      last_seen = existing && Map.get(existing, :last_seen)
      entry = %{persona: persona, last_seen: last_seen}
      {:noreply, %{state | entries: Map.put(state.entries, agent_id, entry)}}
    end
  end

  def handle_cast({:touch, agent_id, ts}, state) do
    case Map.get(state.entries, agent_id) do
      nil ->
        # No persona recorded yet (envelope from a wrapper that pre-dates
        # the AgentDirectory rollout, or a race where envelope arrives
        # before the spawn cast). Skip — restore needs persona first, and
        # the next spawn (or the wrapper's next envelope carrying persona)
        # will seed it.
        {:noreply, state}

      entry ->
        {:noreply, %{state | entries: Map.put(state.entries, agent_id, %{entry | last_seen: ts})}}
    end
  end

  @impl true
  def handle_call({:get, agent_id}, _from, state) do
    {:reply, Map.get(state.entries, agent_id), state}
  end

  def handle_call(:all, _from, state) do
    {:reply, state.entries, state}
  end

  @impl true
  def terminate(_reason, state) do
    :dets.close(state.table)
  end

  defp default_path do
    Application.get_env(:kaoiro_server, :agent_directory_path) ||
      Path.join(System.tmp_dir!(), "kaoiro_agent_directory.dets")
  end
end
