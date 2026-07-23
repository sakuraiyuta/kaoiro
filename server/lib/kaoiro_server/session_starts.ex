defmodule KaoiroServer.SessionStarts do
  @moduledoc """
  Restart-surviving record of each agent's current session start (issue #109).

  This is deliberately separate from `ClearWatermarks`: a session transition
  records a start here but never changes display visibility.  `clear_history`
  is the only operation that copies this record into the visibility watermark.
  The record carries the transition identity and pending old sid needed by the
  Codex lazy-session crash recovery path.
  """

  use GenServer

  require Logger

  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    path = Keyword.get(opts, :path, default_path())
    GenServer.start_link(__MODULE__, {name, path}, name: name)
  end

  def advance_transition(agent_id, sid_opt, server \\ __MODULE__)
      when is_binary(agent_id) and (is_nil(sid_opt) or is_binary(sid_opt)) do
    GenServer.call(server, {:advance_transition, agent_id, sid_opt, nil})
  end

  def advance_transition(agent_id, sid_opt, previous_sid, server)
      when is_binary(agent_id) and (is_nil(sid_opt) or is_binary(sid_opt)) and
             (is_nil(previous_sid) or is_binary(previous_sid)) do
    GenServer.call(server, {:advance_transition, agent_id, sid_opt, previous_sid})
  end

  def adopt_sid(agent_id, sid, server \\ __MODULE__) when is_binary(agent_id) and is_binary(sid),
    do: GenServer.call(server, {:adopt_sid, agent_id, sid})

  def adopt_pending_sid(agent_id, sid, previous_sid, server \\ __MODULE__)
      when is_binary(agent_id) and is_binary(sid) and is_binary(previous_sid),
      do: GenServer.call(server, {:adopt_pending_sid, agent_id, sid, previous_sid})

  @doc "Returns `{order, display, sid}` or nil; pending identity stays private."
  def get(agent_id, server \\ __MODULE__), do: GenServer.call(server, {:get, agent_id})

  def all_orders(server \\ __MODULE__), do: GenServer.call(server, :all_orders)

  def delete(agent_id, server \\ __MODULE__), do: GenServer.call(server, {:delete, agent_id})

  @impl true
  def init({name, path}) do
    path |> Path.dirname() |> File.mkdir_p!()
    table = open_table(name, path)
    _ = File.chmod(path, 0o600)
    {:ok, %{table: table, starts: load_starts(table)}}
  end

  @impl true
  def handle_call({:advance_transition, agent_id, sid_opt, previous_sid}, _from, state) do
    case Map.get(state.starts, agent_id) do
      {order, display, ^sid_opt, _pending} when is_binary(sid_opt) ->
        {:reply, {:ok, {order, display, sid_opt}}, state}

      _ ->
        order = KaoiroServer.IngressOrder.allocate()
        display = DateTime.utc_now() |> DateTime.to_iso8601()
        pending = if is_nil(sid_opt) and is_binary(previous_sid), do: previous_sid, else: nil
        write_record(state.table, agent_id, order, display, sid_opt, pending)
        record = {order, display, sid_opt, pending}

        {:reply, {:ok, {order, display, sid_opt}},
         %{state | starts: Map.put(state.starts, agent_id, record)}}
    end
  end

  def handle_call({:adopt_sid, agent_id, sid}, _from, state) do
    case Map.get(state.starts, agent_id) do
      {order, display, nil, pending} ->
        write_record(state.table, agent_id, order, display, sid, pending)

        {:reply, {:ok, {order, display, sid}},
         %{state | starts: Map.put(state.starts, agent_id, {order, display, sid, pending})}}

      _ ->
        {:reply, :noop, state}
    end
  end

  def handle_call({:adopt_pending_sid, agent_id, sid, previous_sid}, _from, state) do
    case Map.get(state.starts, agent_id) do
      {order, display, nil, ^previous_sid} ->
        write_record(state.table, agent_id, order, display, sid, previous_sid)

        {:reply, {:ok, {order, display, sid}},
         %{state | starts: Map.put(state.starts, agent_id, {order, display, sid, previous_sid})}}

      _ ->
        {:reply, :noop, state}
    end
  end

  def handle_call({:get, agent_id}, _from, state) do
    reply =
      case Map.get(state.starts, agent_id) do
        {order, display, sid, _pending} -> {order, display, sid}
        nil -> nil
      end

    {:reply, reply, state}
  end

  def handle_call(:all_orders, _from, state) do
    {:reply, Map.new(state.starts, fn {id, {order, _display, _sid, _pending}} -> {id, order} end),
     state}
  end

  def handle_call({:delete, agent_id}, _from, state) do
    :ok = :dets.delete(state.table, agent_id)
    :ok = :dets.sync(state.table)
    {:reply, :ok, %{state | starts: Map.delete(state.starts, agent_id)}}
  end

  @impl true
  def terminate(_reason, state), do: :dets.close(state.table)

  defp load_starts(table) do
    case :dets.foldl(
           fn
             {agent_id, {us, seq}, display, sid, pending}, acc
             when is_binary(agent_id) and is_integer(us) and is_integer(seq) and
                    is_binary(display) and
                    (is_nil(sid) or is_binary(sid)) and (is_nil(pending) or is_binary(pending)) ->
               Map.put(acc, agent_id, {{us, seq}, display, sid, pending})

             _, acc ->
               acc
           end,
           %{},
           table
         ) do
      starts when is_map(starts) -> starts
      {:error, _} -> %{}
    end
  end

  defp write_record(table, agent_id, order, display, sid, pending) do
    :ok = :dets.insert(table, {agent_id, order, display, sid, pending})
    :ok = :dets.sync(table)
  end

  defp open_table(name, path) do
    case :dets.open_file(name, file: String.to_charlist(path)) do
      {:ok, ^name} ->
        name

      {:error, reason} ->
        Logger.warning("session start store unreadable (#{inspect(reason)}); recreating")
        File.rm(path)
        {:ok, ^name} = :dets.open_file(name, file: String.to_charlist(path))
        name
    end
  end

  defp default_path do
    Application.get_env(:kaoiro_server, :session_starts_path) ||
      Path.join(System.tmp_dir!(), "kaoiro_session_starts.dets")
  end
end
