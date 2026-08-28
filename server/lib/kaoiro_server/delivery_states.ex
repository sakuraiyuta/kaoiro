defmodule KaoiroServer.DeliveryStates do
  @moduledoc """
  Durable, recipient-local observation ledger for inter-agent dispatch
  confirmation (issue #247).  This is deliberately *not* a message queue:
  it keeps only monotonic watermarks and never replays payloads.

  A wrapper process binds a random `delivery_generation` when it joins.  A
  rejoin with the same generation is a websocket reconnect and preserves an
  outstanding gap.  A different generation means the old process lost its
  local coordinator state, so its gap is explicitly abandoned (`acked` moves
  to `issued`) rather than being reported forever as a delivery failure.
  `transition_id` must not be used for this: runner crash relaunches can keep
  the same session-transition id while replacing the wrapper process.
  """
  use GenServer

  alias KaoiroServer.TransportLimits

  @type status :: %{
          issued_seq: non_neg_integer(),
          acked_seq: non_neg_integer(),
          pending_since: String.t() | nil
        }

  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    path = Keyword.get(opts, :path, default_path())
    GenServer.start_link(__MODULE__, {name, path}, name: name)
  end

  @doc "Binds an ack-capable wrapper process and returns its visible state."
  def bind(agent_id, generation, server \\ __MODULE__)
      when is_binary(agent_id) and is_binary(generation) and generation != "" do
    GenServer.call(server, {:bind, agent_id, generation})
  end

  @doc "Disarms an old wrapper's projection; absence means unknown, not zero."
  def disarm(agent_id, server \\ __MODULE__) when is_binary(agent_id),
    do: GenServer.call(server, {:disarm, agent_id})

  @doc "Allocates one recipient-local delivery sequence when the capability is live."
  def issue(agent_id, server \\ __MODULE__) when is_binary(agent_id),
    do: GenServer.call(server, {:issue, agent_id})

  @doc "Advances a contiguous confirmation watermark. Invalid/future acks are no-ops."
  def ack(agent_id, seq, server \\ __MODULE__)

  def ack(agent_id, seq, server)
      when is_binary(agent_id) and is_integer(seq) and seq > 0,
      do: GenServer.call(server, {:ack, agent_id, seq})

  def ack(_agent_id, _seq, _server), do: :ignored

  def get(agent_id, server \\ __MODULE__) when is_binary(agent_id),
    do: GenServer.call(server, {:get, agent_id})

  def all(server \\ __MODULE__), do: GenServer.call(server, :all)

  @doc "A bounded join-time projection; the DETS-backed observation store is unchanged."
  def wire_projection(server \\ __MODULE__) do
    server
    |> all()
    |> Enum.sort_by(fn {agent_id, _status} -> agent_id end)
    |> Enum.reduce(%{}, fn {agent_id, status}, deliveries ->
      candidate = Map.put(deliveries, agent_id, status)

      if map_size(deliveries) < TransportLimits.wire_projection_agents() and
           TransportLimits.snapshot_frame_fits?("delivery_snapshot", %{"deliveries" => candidate}) do
        candidate
      else
        deliveries
      end
    end)
  end

  def delete(agent_id, server \\ __MODULE__) when is_binary(agent_id),
    do: GenServer.call(server, {:delete, agent_id})

  @impl true
  def init({name, path}) do
    path |> Path.dirname() |> File.mkdir_p!()
    table = open_table(name, path)
    _ = File.chmod(path, 0o600)
    {:ok, %{table: table, entries: load_entries(table)}}
  end

  @impl true
  def handle_call({:bind, agent_id, generation}, _from, state) do
    {entry, changed?} =
      case Map.get(state.entries, agent_id) do
        %{generation: ^generation} = entry ->
          {entry, false}

        %{issued_seq: issued} = entry ->
          # A process replacement cannot ever ack deliveries addressed to the
          # old process. Close only that observational gap; the counter itself
          # remains monotonic for the recipient.
          {%{entry | generation: generation, acked_seq: issued, pending_since: nil}, true}

        nil ->
          {%{generation: generation, issued_seq: 0, acked_seq: 0, pending_since: nil}, true}
      end

    if changed?, do: persist(state.table, agent_id, entry)
    {:reply, public(entry), %{state | entries: Map.put(state.entries, agent_id, entry)}}
  end

  def handle_call({:disarm, agent_id}, _from, state) do
    if Map.has_key?(state.entries, agent_id) do
      :ok = :dets.delete(state.table, agent_id)
      :ok = :dets.sync(state.table)
    end

    {:reply, :ok, %{state | entries: Map.delete(state.entries, agent_id)}}
  end

  def handle_call({:issue, agent_id}, _from, state) do
    case Map.get(state.entries, agent_id) do
      nil ->
        {:reply, nil, state}

      entry ->
        now = DateTime.utc_now() |> DateTime.to_iso8601()
        issued = entry.issued_seq + 1
        pending_since = entry.pending_since || now
        next = %{entry | issued_seq: issued, pending_since: pending_since}
        persist(state.table, agent_id, next)
        {:reply, issued, %{state | entries: Map.put(state.entries, agent_id, next)}}
    end
  end

  def handle_call({:ack, agent_id, seq}, _from, state) do
    case Map.get(state.entries, agent_id) do
      %{issued_seq: issued, acked_seq: acked} = entry when seq > acked and seq <= issued ->
        next = %{
          entry
          | acked_seq: seq,
            pending_since: if(seq == issued, do: nil, else: entry.pending_since)
        }

        persist(state.table, agent_id, next)
        {:reply, public(next), %{state | entries: Map.put(state.entries, agent_id, next)}}

      entry when is_map(entry) ->
        {:reply, public(entry), state}

      nil ->
        {:reply, nil, state}
    end
  end

  def handle_call({:get, agent_id}, _from, state),
    do: {:reply, state.entries[agent_id] && public(state.entries[agent_id]), state}

  def handle_call(:all, _from, state),
    do: {:reply, Map.new(state.entries, fn {id, entry} -> {id, public(entry)} end), state}

  def handle_call({:delete, agent_id}, _from, state) do
    :ok = :dets.delete(state.table, agent_id)
    :ok = :dets.sync(state.table)
    {:reply, :ok, %{state | entries: Map.delete(state.entries, agent_id)}}
  end

  @impl true
  def terminate(_reason, state), do: :dets.close(state.table)

  defp public(%{issued_seq: issued, acked_seq: acked, pending_since: pending}) do
    %{issued_seq: issued, acked_seq: acked, pending_since: pending}
  end

  defp persist(table, agent_id, %{generation: generation} = entry) do
    :ok =
      :dets.insert(
        table,
        {agent_id, generation, entry.issued_seq, entry.acked_seq, entry.pending_since}
      )

    :ok = :dets.sync(table)
  end

  defp load_entries(table) do
    case :dets.foldl(
           fn
             {id, generation, issued, acked, pending}, acc
             when is_binary(id) and is_binary(generation) and is_integer(issued) and issued >= 0 and
                    is_integer(acked) and acked >= 0 and acked <= issued and
                    (is_nil(pending) or is_binary(pending)) ->
               Map.put(acc, id, %{
                 generation: generation,
                 issued_seq: issued,
                 acked_seq: acked,
                 pending_since: pending
               })

             _, acc ->
               acc
           end,
           %{},
           table
         ) do
      entries when is_map(entries) -> entries
      _ -> %{}
    end
  end

  defp open_table(name, path) do
    case :dets.open_file(name, file: String.to_charlist(path)) do
      {:ok, ^name} ->
        name

      {:error, _reason} ->
        File.rm(path)
        {:ok, ^name} = :dets.open_file(name, file: String.to_charlist(path))
        name
    end
  end

  defp default_path do
    Application.get_env(:kaoiro_server, :delivery_states_path) ||
      Path.join(System.tmp_dir!(), "kaoiro_delivery_states.dets")
  end
end
