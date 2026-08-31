defmodule KaoiroServer.WrapperBuildInfos do
  @moduledoc """
  Keeps the latest build identity for each connected wrapper.

  The owner pid fences disconnect cleanup, so a late terminate from an older
  channel cannot erase a newer connection's identity. This state is live-only;
  a reconnect reports its artifact again and a server restart starts empty.
  """

  use GenServer

  alias KaoiroServer.BuildIdentity

  @max_infos 1000
  @info_keys ~w(build_revision build_dirty build_version build_channel)

  def start_link(opts) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, %{}, name: name)
  end

  @doc "Stores a validated wrapper identity owned by `owner`."
  def put(agent_id, info, owner, server \\ __MODULE__) do
    GenServer.call(server, {:put, agent_id, info, owner})
  end

  @doc "Removes an identity only while `owner` still owns the entry."
  def delete(agent_id, owner, server \\ __MODULE__) do
    GenServer.call(server, {:delete, agent_id, owner})
  end

  @doc "Returns the JSON-safe agent_id => wrapper identity map."
  def snapshot(server \\ __MODULE__) do
    GenServer.call(server, :snapshot)
  end

  @doc "Returns the canonical flat identity, or an invalid-payload error."
  def canonical_info(%{
        "build_revision" => revision,
        "build_dirty" => dirty,
        "build_version" => version,
        "build_channel" => channel
      }) do
    if BuildIdentity.valid_identity?(revision, dirty, version, channel) do
      {:ok,
       Map.take(
         %{
           "build_revision" => revision,
           "build_dirty" => dirty,
           "build_version" => version,
           "build_channel" => channel
         },
         @info_keys
       )}
    else
      {:error, :invalid_build_info}
    end
  end

  def canonical_info(_), do: {:error, :invalid_build_info}

  @doc "Validates the flat wrapper_build_info payload before storage."
  def valid_info?(info), do: match?({:ok, _}, canonical_info(info))

  @impl true
  def init(state), do: {:ok, state}

  @impl true
  def handle_call({:put, agent_id, info, owner}, _from, state)
      when is_binary(agent_id) and is_pid(owner) do
    case canonical_info(info) do
      {:ok, canonical} ->
        if map_size(state) >= @max_infos and not Map.has_key?(state, agent_id) do
          {:reply, {:error, :too_many_infos}, state}
        else
          {:reply, :ok, Map.put(state, agent_id, %{owner: owner, info: canonical})}
        end

      {:error, reason} ->
        {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:put, _agent_id, _info, _owner}, _from, state) do
    {:reply, {:error, :invalid_build_info}, state}
  end

  @impl true
  def handle_call({:delete, agent_id, owner}, _from, state) do
    case state do
      %{^agent_id => %{owner: ^owner, info: info}} ->
        {:reply, {:ok, info}, Map.delete(state, agent_id)}

      _ ->
        {:reply, :noop, state}
    end
  end

  @impl true
  def handle_call(:snapshot, _from, state) do
    {:reply, Map.new(state, fn {agent_id, %{info: info}} -> {agent_id, info} end), state}
  end
end
