defmodule KaoiroServer.InterAgentHistory do
  @moduledoc """
  Restart-surviving store for structured `inter_agent_message` envelopes
  (issue #105). Unlike SDK log/result history, these messages cannot be
  reconstructed from an engine JSONL after the server process disappears.

  DETS is the durable source of truth for this envelope type. Entries are
  keyed by sender / receiver / conversation / turn so a retried wrapper send
  is idempotent. The newest 500 messages per sender are retained; no producer
  timestamp TTL is applied because envelope timestamps are not a server clock.
  """

  use GenServer

  require Logger

  @max_per_agent 500

  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    path = Keyword.get(opts, :path, default_path())
    max_per_agent = Keyword.get(opts, :max_per_agent, @max_per_agent)
    GenServer.start_link(__MODULE__, {name, path, max_per_agent}, name: name)
  end

  @doc "Persist one validated inter-agent envelope before its wrapper ack."
  def append(envelope, server \\ __MODULE__) do
    GenServer.call(server, {:append, envelope})
  end

  @doc "Chronological durable messages authored by `agent_id`."
  def list_for(agent_id, server \\ __MODULE__) do
    GenServer.call(server, {:list_for, agent_id})
  end

  @doc "Sender agent_id => chronological durable messages."
  def all(server \\ __MODULE__) do
    GenServer.call(server, :all)
  end

  @doc """
  Same as `all/1` but each entry is `{order, envelope}` where `order` is
  the server-ingress monotonic tuple stamped at `append/2` time
  (`{system_time_microsecond, unique_integer_positive_monotonic}`).
  Consumers (agents_channel `merged_histories/*`) compare that order
  against the same-domain `KaoiroServer.ClearWatermarks.get_order/2`
  cutoff to filter IA visibility — this is the single server-side
  ordering domain that closes the clock-owner / lexicographic-string
  compare gap between wrapper producer clocks and server clear ts
  (ふじ #109 M6 must-fix).
  """
  def all_with_order(server \\ __MODULE__) do
    GenServer.call(server, :all_with_order)
  end

  @doc "Purge messages sent by or addressed to a deleted agent."
  def delete_agent(agent_id, server \\ __MODULE__) do
    GenServer.call(server, {:delete_agent, agent_id})
  end

  @impl true
  def init({name, path, max_per_agent}) do
    path |> Path.dirname() |> File.mkdir_p!()
    table = open_table(name, path)
    _ = File.chmod(path, 0o600)
    {entries, overflow_keys} = load_entries(table, max_per_agent)
    Enum.each(overflow_keys, &:dets.delete(table, &1))
    if overflow_keys != [], do: :ok = :dets.sync(table)
    {:ok, %{table: table, entries: entries, max_per_agent: max_per_agent}}
  end

  @impl true
  def handle_call({:append, envelope}, _from, state) do
    with {:ok, agent_id, key} <- envelope_key(envelope) do
      authored = Map.get(state.entries, agent_id, %{})

      if Map.has_key?(authored, key) do
        {:reply, :ok, state}
      else
        order = {System.system_time(:microsecond), System.unique_integer([:positive, :monotonic])}
        :ok = :dets.insert(state.table, {key, order, envelope})
        authored = Map.put(authored, key, {order, envelope})
        {authored, overflow_keys} = cap_entries(authored, state.max_per_agent)
        Enum.each(overflow_keys, &:dets.delete(state.table, &1))
        :ok = :dets.sync(state.table)

        {:reply, :ok, %{state | entries: Map.put(state.entries, agent_id, authored)}}
      end
    else
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:list_for, agent_id}, _from, state) do
    {:reply, chronological(Map.get(state.entries, agent_id, %{})), state}
  end

  def handle_call(:all, _from, state) do
    histories =
      for {agent_id, authored} <- state.entries,
          authored != %{},
          into: %{},
          do: {agent_id, chronological(authored)}

    {:reply, histories, state}
  end

  def handle_call(:all_with_order, _from, state) do
    histories =
      for {agent_id, authored} <- state.entries,
          authored != %{},
          into: %{},
          do: {agent_id, chronological_with_order(authored)}

    {:reply, histories, state}
  end

  def handle_call({:delete_agent, agent_id}, _from, state) do
    {entries, deleted_keys} =
      Enum.reduce(state.entries, {%{}, []}, fn {sender, authored}, {acc, deleted} ->
        {kept, removed} =
          Enum.split_with(authored, fn {_key, {_order, envelope}} ->
            sender != agent_id and get_in(envelope, ["payload", "to"]) != agent_id
          end)

        kept = Map.new(kept)
        acc = if kept == %{}, do: acc, else: Map.put(acc, sender, kept)
        {acc, Enum.map(removed, &elem(&1, 0)) ++ deleted}
      end)

    Enum.each(deleted_keys, &:dets.delete(state.table, &1))
    if deleted_keys != [], do: :ok = :dets.sync(state.table)
    {:reply, :ok, %{state | entries: entries}}
  end

  @impl true
  def terminate(_reason, state) do
    :dets.close(state.table)
  end

  defp envelope_key(%{
         "agent_id" => agent_id,
         "type" => "inter_agent_message",
         "payload" => %{
           "to" => to,
           "conversation_id" => conversation_id,
           "turn_number" => turn_number
         }
       })
       when is_binary(agent_id) and is_binary(to) and is_binary(conversation_id) and
              is_integer(turn_number) do
    {:ok, agent_id, {agent_id, to, conversation_id, turn_number}}
  end

  defp envelope_key(_envelope), do: {:error, :invalid_inter_agent_envelope}

  defp load_entries(table, max_per_agent) do
    loaded =
      case :dets.foldl(
             fn
               {key, order, %{"agent_id" => agent_id} = envelope}, acc
               when is_tuple(key) and is_tuple(order) and is_binary(agent_id) ->
                 update_in(acc, [Access.key(agent_id, %{})], &Map.put(&1, key, {order, envelope}))

               _malformed, acc ->
                 acc
             end,
             %{},
             table
           ) do
        entries when is_map(entries) -> entries
        {:error, _reason} -> %{}
      end

    Enum.reduce(loaded, {%{}, []}, fn {agent_id, authored}, {acc, overflow} ->
      {kept, keys} = cap_entries(authored, max_per_agent)
      {Map.put(acc, agent_id, kept), keys ++ overflow}
    end)
  end

  defp cap_entries(authored, max_per_agent) do
    ordered = Enum.sort_by(authored, fn {_key, {order, _envelope}} -> order end, :desc)
    {kept, overflow} = Enum.split(ordered, max_per_agent)
    {Map.new(kept), Enum.map(overflow, &elem(&1, 0))}
  end

  defp chronological(authored) do
    authored
    |> Enum.sort_by(fn {_key, {order, _envelope}} -> order end)
    |> Enum.map(fn {_key, {_order, envelope}} -> envelope end)
  end

  defp chronological_with_order(authored) do
    authored
    |> Enum.sort_by(fn {_key, {order, _envelope}} -> order end)
    |> Enum.map(fn {_key, {order, envelope}} -> {order, envelope} end)
  end

  defp open_table(name, path) do
    case :dets.open_file(name, file: String.to_charlist(path)) do
      {:ok, ^name} ->
        name

      {:error, reason} ->
        Logger.warning("inter-agent history store unreadable (#{inspect(reason)}); recreating")
        File.rm(path)
        {:ok, ^name} = :dets.open_file(name, file: String.to_charlist(path))
        name
    end
  end

  defp default_path do
    Application.get_env(:kaoiro_server, :inter_agent_history_path) ||
      Path.join(System.tmp_dir!(), "kaoiro_inter_agent_history.dets")
  end
end
