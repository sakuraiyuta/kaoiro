defmodule KaoiroServer.AgentStates do
  @moduledoc """
  Holds the latest envelope per agent_id.

  State *derivation* happens in the wrapper; the server only stores and
  fans out, staying agent-agnostic (docs/specs/architecture.md). The map
  lets a late-joining client start from the current picture instead of
  waiting for the next state change.

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
  Overlays `disconnected` onto `agent_id`'s latest envelope, but only
  when `owner` still owns the entry (reconnect-race guard). Returns
  `{:ok, envelope}` with the derived envelope to broadcast, or `:noop`.
  """
  def disconnect(agent_id, owner, ts, opts \\ []) do
    server = Keyword.get(opts, :server, __MODULE__)
    GenServer.call(server, {:disconnect, agent_id, owner, ts})
  end

  @doc "Returns the agent_id => latest envelope map."
  def snapshot(server \\ __MODULE__) do
    GenServer.call(server, :snapshot)
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
      entry = %{envelope: envelope, owner: owner}
      {:reply, :ok, Map.put(state, agent_id, entry)}
    end
  end

  def handle_call({:disconnect, agent_id, owner, ts}, _from, state) do
    case state do
      %{^agent_id => %{envelope: envelope, owner: ^owner}} ->
        derived = disconnected_envelope(envelope, ts)
        entry = %{envelope: derived, owner: owner}
        {:reply, {:ok, derived}, Map.put(state, agent_id, entry)}

      _ ->
        {:reply, :noop, state}
    end
  end

  def handle_call(:snapshot, _from, state) do
    {:reply, Map.new(state, fn {id, %{envelope: env}} -> {id, env} end), state}
  end

  def handle_call({:known?, agent_id}, _from, state) do
    {:reply, Map.has_key?(state, agent_id), state}
  end

  # Server-derived envelope: keep identity (persona), drop seq — seq is
  # the wrapper's series (specs/protocol.md).
  defp disconnected_envelope(envelope, ts) do
    envelope
    |> Map.take(["version", "agent_id", "persona"])
    |> Map.merge(%{
      "ts" => ts,
      "type" => "state_change",
      "state" => "disconnected",
      "payload" => %{},
      "ext" => %{}
    })
  end
end
