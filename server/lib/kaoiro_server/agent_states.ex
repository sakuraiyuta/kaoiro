defmodule KaoiroServer.AgentStates do
  @moduledoc """
  Holds the latest envelope per agent_id.

  State *derivation* happens in the wrapper; the server only stores and
  fans out, staying agent-agnostic (docs/specs/architecture.md). The map
  lets a late-joining client start from the current picture instead of
  waiting for the next state change.

  Each entry also keeps an in-memory ring buffer of the agent's reply
  log (`log` / `result` envelopes, ADR-0012) so an operator that joins
  or reloads recovers the recent transcript. History is memory-only and
  vanishes on restart (disk persistence is issue #24). `put/2` updates
  the latest state without touching history; `append_log/2` appends a
  reply line and never changes the latest state.
  `clear_other_sessions/2` drops the history lines outside the agent's
  current session (issue #48), leaving the latest state untouched.
  `delete/1` removes a disconnected agent's entry entirely (issue #14).

  The one server-derived exception is `disconnected` (specs/protocol.md):
  `disconnect/3` overlays it when the wrapper channel that wrote the
  latest envelope terminates. Each entry remembers its owner (channel
  pid) so a stale terminate arriving after a reconnect cannot clobber
  the new connection's state.
  """

  use GenServer

  # Wrapper connections may be unauthenticated (dev mode), so cap the map
  # to keep fabricated agent_ids from growing memory without bound.
  @max_agents 1000

  # Reply-log lines kept per agent (ADR-0012 history A). Newest-first in
  # storage; reversed to chronological order when served.
  @max_history 200

  def start_link(opts) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, %{}, name: name)
  end

  @doc """
  Stores `envelope` as the latest for its agent_id (synchronous).
  `opts[:owner]` records the writing channel pid (used by `disconnect/3`);
  `opts[:server]` overrides the GenServer (tests). Returns
  `{:error, :too_many_agents}` when a new agent_id would exceed the cap;
  updates to known agent_ids always succeed.
  """
  def put(%{"agent_id" => agent_id} = envelope, opts \\ []) do
    server = Keyword.get(opts, :server, __MODULE__)
    owner = Keyword.get(opts, :owner)
    GenServer.call(server, {:put, agent_id, envelope, owner})
  end

  @doc """
  Appends `envelope` (a `log` / `result` reply line) to the agent's
  history ring buffer without touching its latest state. `:ok` when the
  agent is known, `:noop` otherwise (a reply before any state arrived).
  """
  def append_log(%{"agent_id" => agent_id} = envelope, opts \\ []) do
    server = Keyword.get(opts, :server, __MODULE__)
    GenServer.call(server, {:append_log, agent_id, envelope})
  end

  @doc """
  Overlays `disconnected` onto `agent_id`'s latest envelope, but only
  when `owner` still owns the entry (reconnect-race guard). Returns
  `{:ok, envelope}` with the derived envelope to broadcast, or `:noop`.
  """
  def disconnect(agent_id, owner, ts, opts \\ []) do
    server = Keyword.get(opts, :server, __MODULE__)
    GenServer.call(server, {:disconnect, agent_id, owner, ts})
  end

  @doc """
  Drops the agent's history lines that do NOT belong to its current
  session — the `session_id` of its latest state envelope. Lines tagged
  with a different session_id (or with none) are removed; the current
  ones stay (issue #48). Returns `{:ok, session_id}` with the surviving
  session for the caller to broadcast, or `:noop` when the agent is
  unknown or its current session_id is not known yet. Touches history
  only; the latest state is left intact.
  """
  def clear_other_sessions(agent_id, opts \\ []) do
    server = Keyword.get(opts, :server, __MODULE__)
    GenServer.call(server, {:clear_other_sessions, agent_id})
  end

  @doc """
  Removes a `disconnected` agent's entry entirely (issue #14). Only
  deletes when the latest state is `disconnected` so a live agent cannot
  be dropped from under its wrapper; returns `{:error, :not_disconnected}`
  otherwise and `{:error, :unknown_agent}` when absent.
  """
  def delete(agent_id, opts \\ []) do
    server = Keyword.get(opts, :server, __MODULE__)
    GenServer.call(server, {:delete, agent_id})
  end

  @doc "Returns the agent_id => latest envelope map."
  def snapshot(server \\ __MODULE__) do
    GenServer.call(server, :snapshot)
  end

  @doc """
  Returns the agent_id => reply-log list map (chronological, oldest
  first). Agents with no history are omitted. Operator-only by policy;
  the caller (channel) enforces the role gate.
  """
  def histories(server \\ __MODULE__) do
    GenServer.call(server, :histories)
  end

  @doc "Membership check without copying the whole map (relay guard)."
  def known?(agent_id, opts \\ []) do
    server = Keyword.get(opts, :server, __MODULE__)
    GenServer.call(server, {:known?, agent_id})
  end

  @impl true
  def init(state), do: {:ok, state}

  @impl true
  def handle_call({:put, agent_id, envelope, owner}, _from, state) do
    if map_size(state) >= @max_agents and not Map.has_key?(state, agent_id) do
      {:reply, {:error, :too_many_agents}, state}
    else
      # Preserve any accumulated history; put only refreshes latest state.
      history =
        case state do
          %{^agent_id => %{history: h}} -> h
          _ -> []
        end

      entry = %{envelope: envelope, owner: owner, history: history}
      {:reply, :ok, Map.put(state, agent_id, entry)}
    end
  end

  def handle_call({:append_log, agent_id, envelope}, _from, state) do
    case state do
      %{^agent_id => entry} ->
        # Newest-first; cap drops the oldest line past @max_history.
        history = Enum.take([envelope | entry.history], @max_history)
        {:reply, :ok, Map.put(state, agent_id, %{entry | history: history})}

      _ ->
        {:reply, :noop, state}
    end
  end

  def handle_call({:disconnect, agent_id, owner, ts}, _from, state) do
    case state do
      %{^agent_id => %{envelope: envelope, owner: ^owner} = entry} ->
        derived = disconnected_envelope(envelope, ts)
        {:reply, {:ok, derived}, Map.put(state, agent_id, %{entry | envelope: derived})}

      _ ->
        {:reply, :noop, state}
    end
  end

  def handle_call({:clear_other_sessions, agent_id}, _from, state) do
    with %{^agent_id => %{envelope: env, history: history} = entry} <- state,
         sid when is_binary(sid) and sid != "" <- Map.get(env, "session_id") do
      kept = Enum.filter(history, &(Map.get(&1, "session_id") == sid))
      {:reply, {:ok, sid}, Map.put(state, agent_id, %{entry | history: kept})}
    else
      _ -> {:reply, :noop, state}
    end
  end

  def handle_call({:delete, agent_id}, _from, state) do
    case state do
      %{^agent_id => %{envelope: %{"state" => "disconnected"}}} ->
        {:reply, :ok, Map.delete(state, agent_id)}

      %{^agent_id => _} ->
        {:reply, {:error, :not_disconnected}, state}

      _ ->
        {:reply, {:error, :unknown_agent}, state}
    end
  end

  def handle_call(:snapshot, _from, state) do
    {:reply, Map.new(state, fn {id, %{envelope: env}} -> {id, env} end), state}
  end

  def handle_call(:histories, _from, state) do
    histories =
      for {id, %{history: h}} <- state, h != [], into: %{}, do: {id, Enum.reverse(h)}

    {:reply, histories, state}
  end

  def handle_call({:known?, agent_id}, _from, state) do
    {:reply, Map.has_key?(state, agent_id), state}
  end

  # Server-derived envelope: keep identity (persona) and session_id so a
  # disconnected agent still reports its current session (issue #48); drop
  # seq — seq is the wrapper's series (specs/protocol.md).
  defp disconnected_envelope(envelope, ts) do
    envelope
    |> Map.take(["version", "agent_id", "persona", "session_id"])
    |> Map.merge(%{
      "ts" => ts,
      "type" => "state_change",
      "state" => "disconnected",
      "payload" => %{},
      "ext" => %{}
    })
  end
end
