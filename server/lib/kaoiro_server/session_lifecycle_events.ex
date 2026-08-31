defmodule KaoiroServer.SessionLifecycleEvents do
  @moduledoc """
  Restart-surviving per-agent timeline of `session_lifecycle` events
  (ADR-0055, phase-33 Stage B): wrapper-observed compaction/resume/threshold
  transitions merged with server-known disconnect/reconnect/session_reset.
  Recording only — appending here never notifies peers.

  One DETS record per agent, holding that agent's WHOLE event list (newest
  first), capped at `SESSION_LIFECYCLE_MAX_EVENTS_PER_AGENT` (default
  10,000) with the oldest entries discarded first — the same
  prepend-and-truncate shape `KaoiroServer.AgentStates` uses for its
  in-memory `@max_history`, made durable. Chosen over one DETS record per
  event: `session_lifecycle` events are low-frequency (compaction/reset,
  minutes-to-hours apart), so rewriting the whole capped list on every
  append is cheap, and it avoids a second index for eviction.
  """

  use GenServer

  require Logger

  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    path = Keyword.get(opts, :path, default_path())
    cap = Keyword.get(opts, :cap, default_cap())
    GenServer.start_link(__MODULE__, {name, path, cap}, name: name)
  end

  @doc """
  Appends one event to `agent_id`'s timeline. `kind` is required; `trigger`
  is `nil` when the caller has none. Both a fresh `agent_id` and a config
  read failure below are non-fatal here — the caller (a live channel event
  or a wrapper report) must not crash over a recording side effect.
  """
  def append(agent_id, kind, trigger, at, server \\ __MODULE__)
      when is_binary(agent_id) and is_binary(kind) and
             (is_nil(trigger) or is_binary(trigger)) and is_binary(at) do
    GenServer.call(server, {:append, agent_id, kind, trigger, at})
  end

  @doc "Returns `agent_id`'s events, newest first, or `[]` if none recorded."
  def list_for_agent(agent_id, server \\ __MODULE__) when is_binary(agent_id) do
    GenServer.call(server, {:list_for_agent, agent_id})
  end

  @impl true
  def init({name, path, cap}) do
    KaoiroServer.DetsStorePath.prepare_parent!(path)
    table = open_table(name, path)
    _ = File.chmod(path, 0o600)
    {:ok, %{table: table, events: load_events(table), cap: cap}}
  end

  @impl true
  def handle_call({:append, agent_id, kind, trigger, at}, _from, state) do
    event = %{kind: kind, trigger: trigger, at: at}
    existing = Map.get(state.events, agent_id, [])
    updated = Enum.take([event | existing], state.cap)
    write_record(state.table, agent_id, updated)
    {:reply, :ok, %{state | events: Map.put(state.events, agent_id, updated)}}
  end

  def handle_call({:list_for_agent, agent_id}, _from, state) do
    {:reply, Map.get(state.events, agent_id, []), state}
  end

  @impl true
  def terminate(_reason, state), do: :dets.close(state.table)

  defp load_events(table) do
    case :dets.foldl(
           fn
             {agent_id, events}, acc when is_binary(agent_id) and is_list(events) ->
               Map.put(acc, agent_id, events)

             _, acc ->
               acc
           end,
           %{},
           table
         ) do
      events when is_map(events) -> events
      {:error, _} -> %{}
    end
  end

  defp write_record(table, agent_id, events) do
    :ok = :dets.insert(table, {agent_id, events})
    :ok = :dets.sync(table)
  end

  defp open_table(name, path) do
    case :dets.open_file(name, file: String.to_charlist(path)) do
      {:ok, ^name} ->
        name

      {:error, reason} ->
        Logger.warning(
          "session lifecycle event store unreadable (#{inspect(reason)}); recreating"
        )

        File.rm(path)
        {:ok, ^name} = :dets.open_file(name, file: String.to_charlist(path))
        name
    end
  end

  defp default_path do
    Application.get_env(:kaoiro_server, :session_lifecycle_events_path) ||
      KaoiroServer.DetsStorePath.default_path("session_lifecycle_events.dets")
  end

  # Single scalar, so a bare Application env key is enough (unlike
  # ConversationStates.load_limits/0's grouped :inter_agent keyword list,
  # which covers five related values) — same "read with a default" shape,
  # a smaller container.
  defp default_cap do
    Application.get_env(:kaoiro_server, :session_lifecycle_max_events_per_agent, 10_000)
  end
end
