defmodule KaoiroServer.AgentStates do
  @moduledoc """
  Holds the latest envelope per agent_id.

  State *derivation* happens in the wrapper; the server only stores and
  fans out, staying agent-agnostic (docs/specs/architecture.md). The map
  lets a late-joining client start from the current picture instead of
  waiting for the next state change.
  """

  use GenServer

  # Wrapper connections are unauthenticated until Phase 3, so cap the map to
  # keep fabricated agent_ids from growing memory without bound.
  @max_agents 1000

  def start_link(opts) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, %{}, name: name)
  end

  @doc """
  Stores `envelope` as the latest for its agent_id (synchronous).
  Returns `{:error, :too_many_agents}` when a new agent_id would exceed
  the cap; updates to known agent_ids always succeed.
  """
  def put(server \\ __MODULE__, %{"agent_id" => agent_id} = envelope) do
    GenServer.call(server, {:put, agent_id, envelope})
  end

  @doc "Returns the agent_id => latest envelope map."
  def snapshot(server \\ __MODULE__) do
    GenServer.call(server, :snapshot)
  end

  @impl true
  def init(state), do: {:ok, state}

  @impl true
  def handle_call({:put, agent_id, envelope}, _from, state) do
    if map_size(state) >= @max_agents and not Map.has_key?(state, agent_id) do
      {:reply, {:error, :too_many_agents}, state}
    else
      {:reply, :ok, Map.put(state, agent_id, envelope)}
    end
  end

  def handle_call(:snapshot, _from, state) do
    {:reply, state, state}
  end
end
