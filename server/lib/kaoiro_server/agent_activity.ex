defmodule KaoiroServer.AgentActivity do
  @moduledoc """
  In-memory activity projection for peer-directory metadata.

  This deliberately does not share `AgentStates`' latest-envelope store.  It
  owns the small amount of history-derived state needed by the directory:
  connection ownership, session boundaries, turn count, and a pending
  transition transaction.  Envelope recording is a cast; lifecycle hooks are
  calls so a command cannot overtake creation or activation of its pending
  transition.
  """

  use GenServer

  @max_agents 1000
  @default_pending_ttl_ms 60_000

  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @doc """
  Records an accepted envelope. `received_at` MUST be captured by the caller
  that accepted the envelope, rather than when this cast is eventually read.
  """
  def record_envelope(%{"agent_id" => agent_id} = envelope, owner, received_at, opts \\ [])
      when is_pid(owner) and is_binary(received_at) do
    server = Keyword.get(opts, :server, __MODULE__)
    GenServer.cast(server, {:record_envelope, agent_id, envelope, owner, received_at})
  end

  @doc """
  Starts (or supersedes) a pending lifecycle transition. Pending transactions
  do not consume the active-entry cap.
  """
  def begin_transition(agent_id, transition_id, kind, started_at, opts \\ [])
      when is_binary(agent_id) and is_binary(transition_id) and
             kind in [:spawn, :reset, :restore] and is_binary(started_at) do
    server = Keyword.get(opts, :server, __MODULE__)
    GenServer.call(server, {:begin_transition, agent_id, transition_id, kind, started_at})
  end

  @doc """
  Binds a joining channel to an activity generation. A matching transition id
  commits the pending transaction. `:mismatch` and `:legacy_absent` are the
  SessionResets L2 decisions and force projection suppression; `:noop` uses
  the ordinary L1/L3 pending CAS rules.
  """
  def activate_or_rebind(agent_id, owner, transition_id, opts \\ [])
      when is_binary(agent_id) and is_pid(owner) do
    server = Keyword.get(opts, :server, __MODULE__)
    reset_result = Keyword.get(opts, :reset_result, :noop)

    GenServer.call(server, {:activate_or_rebind, agent_id, owner, transition_id, reset_result})
  end

  @doc """
  Resolves a runner outcome by transition-id CAS. Successful outcomes leave
  activation to the matching wrapper join; failed outcomes discard only the
  matching pending transaction.
  """
  def resolve_transition(agent_id, transition_id, ok?, opts \\ [])
      when is_binary(agent_id) and is_boolean(ok?) do
    server = Keyword.get(opts, :server, __MODULE__)
    GenServer.call(server, {:resolve_transition, agent_id, transition_id, ok?})
  end

  @doc "Returns the active entry (without internal timer references), or nil."
  def get(agent_id, server \\ __MODULE__) do
    GenServer.call(server, {:get, agent_id})
  end

  @doc "Returns the active-entry projection map for a directory snapshot."
  def snapshot(server \\ __MODULE__), do: GenServer.call(server, :snapshot)

  @doc "Removes both the active entry and its pending transaction."
  def delete(agent_id, server \\ __MODULE__), do: GenServer.call(server, {:delete, agent_id})

  @impl true
  def init(opts) do
    {:ok,
     %{
       entries: %{},
       pending: %{},
       pending_ttl_ms: Keyword.get(opts, :pending_ttl_ms, @default_pending_ttl_ms)
     }}
  end

  @impl true
  def handle_cast({:record_envelope, agent_id, envelope, owner, received_at}, state) do
    case Map.get(state.entries, agent_id) do
      nil ->
        if map_size(state.entries) >= @max_agents do
          {:noreply, state}
        else
          entry =
            base_entry(owner, envelope_session_id(envelope), false, received_at)
            |> count_and_touch(envelope, received_at)

          {:noreply, put_entry(state, agent_id, entry)}
        end

      %{owner: ^owner} = entry ->
        entry
        |> transition_from_envelope(envelope, received_at)
        |> count_and_touch(envelope, received_at)
        |> then(&{:noreply, put_entry(state, agent_id, &1)})

      _old_owner ->
        # An old wrapper can still have casts in the mailbox after a new
        # generation activated. Never let it alter turns, sid, or activity.
        {:noreply, state}
    end
  end

  @impl true
  def handle_call({:begin_transition, agent_id, id, kind, started_at}, _from, state) do
    state = discard_pending(state, agent_id)
    ref = Process.send_after(self(), {:pending_ttl, agent_id, id}, state.pending_ttl_ms)

    pending = %{
      id: id,
      started_at: started_at,
      kind: kind,
      created_at: started_at,
      timer_ref: ref
    }

    {:reply, :ok, %{state | pending: Map.put(state.pending, agent_id, pending)}}
  end

  def handle_call({:activate_or_rebind, agent_id, owner, id, reset_result}, _from, state) do
    pending = Map.get(state.pending, agent_id)

    cond do
      reset_result in [:mismatch, :legacy_absent] ->
        {:reply, :rebound, rebind(state, agent_id, owner, true)}

      reset_result == :matched and matching_pending?(pending, id) ->
        if new_entry_at_cap?(state, agent_id) do
          {:reply, :capped, state}
        else
          {:reply, :activated, activate(state, agent_id, owner, pending)}
        end

      reset_result == :noop and matching_pending?(pending, id) ->
        if new_entry_at_cap?(state, agent_id) do
          {:reply, :capped, state}
        else
          {:reply, :activated, activate(state, agent_id, owner, pending)}
        end

      reset_result == :noop and pending != nil ->
        {:reply, :rebound, rebind(state, agent_id, owner, true)}

      true ->
        {:reply, :rebound, rebind(state, agent_id, owner, false)}
    end
  end

  def handle_call({:resolve_transition, agent_id, id, ok?}, _from, state) do
    case Map.get(state.pending, agent_id) do
      %{id: ^id} when ok? ->
        # A runner's success is not a commit signal. The matching wrapper join
        # owns activation, which prevents old connections from adopting it.
        {:reply, :ok, state}

      %{id: ^id, kind: :spawn} when not ok? ->
        {:reply, :aborted, state |> discard_pending(agent_id) |> delete_entry(agent_id)}

      %{id: ^id, kind: _kind} when not ok? ->
        {:reply, :aborted, discard_pending(state, agent_id)}

      _ ->
        {:reply, :noop, state}
    end
  end

  def handle_call({:get, agent_id}, _from, state) do
    {:reply, Map.get(state.entries, agent_id), state}
  end

  def handle_call(:snapshot, _from, state), do: {:reply, state.entries, state}

  def handle_call({:delete, agent_id}, _from, state) do
    {:reply, :ok, state |> discard_pending(agent_id) |> delete_entry(agent_id)}
  end

  @impl true
  def handle_info({:pending_ttl, agent_id, id}, state) do
    state =
      case Map.get(state.pending, agent_id) do
        %{id: ^id} -> %{state | pending: Map.delete(state.pending, agent_id)}
        _ -> state
      end

    {:noreply, state}
  end

  defp base_entry(owner, sid, observed?, started_at) do
    %{
      owner: owner,
      session_id: sid,
      session_started_at: if(observed?, do: started_at, else: nil),
      session_start_observed: observed?,
      awaiting_sid: false,
      turns: 0,
      last_activity_at: nil,
      projection_suppressed: false
    }
  end

  # L4 and L5 must happen before the envelope's result increment. In
  # particular, a new session whose first envelope is a result has turns=1.
  defp transition_from_envelope(entry, envelope, received_at) do
    sid = envelope_session_id(envelope)

    cond do
      entry.awaiting_sid and is_binary(sid) ->
        %{entry | session_id: sid, awaiting_sid: false}

      is_binary(entry.session_id) and is_binary(sid) and entry.session_id != sid ->
        base_entry(entry.owner, sid, true, received_at)

      true ->
        entry
    end
  end

  defp count_and_touch(entry, envelope, received_at) do
    turns = if Map.get(envelope, "type") == "result", do: entry.turns + 1, else: entry.turns

    %{entry | turns: turns, last_activity_at: latest_time(entry.last_activity_at, received_at)}
  end

  defp activate(state, agent_id, owner, pending) do
    state
    |> discard_pending(agent_id)
    |> put_entry(agent_id, %{
      owner: owner,
      session_id: nil,
      session_started_at: pending.started_at,
      session_start_observed: true,
      awaiting_sid: true,
      turns: 0,
      last_activity_at: nil,
      projection_suppressed: false
    })
  end

  defp rebind(state, agent_id, owner, suppress?) do
    case Map.get(state.entries, agent_id) do
      nil ->
        # A reconnect before its first accepted envelope has nothing to
        # project yet, but binding the owner makes L6 deterministic.
        if new_entry_at_cap?(state, agent_id) do
          state
        else
          entry = %{base_entry(owner, nil, false, nil) | projection_suppressed: suppress?}
          put_entry(state, agent_id, entry)
        end

      entry ->
        put_entry(state, agent_id, %{
          entry
          | owner: owner,
            projection_suppressed: entry.projection_suppressed or suppress?
        })
    end
  end

  defp matching_pending?(%{id: id}, id) when is_binary(id) and id != "", do: true
  defp matching_pending?(_, _), do: false

  defp envelope_session_id(%{"session_id" => sid}) when is_binary(sid) and sid != "", do: sid
  defp envelope_session_id(_), do: nil

  defp latest_time(nil, incoming), do: incoming

  defp latest_time(current, incoming) do
    case {DateTime.from_iso8601(current), DateTime.from_iso8601(incoming)} do
      {{:ok, current_dt, _}, {:ok, incoming_dt, _}} ->
        if DateTime.compare(incoming_dt, current_dt) == :gt, do: incoming, else: current

      _ ->
        max(current, incoming)
    end
  end

  defp put_entry(state, agent_id, entry),
    do: %{state | entries: Map.put(state.entries, agent_id, entry)}

  defp delete_entry(state, agent_id), do: %{state | entries: Map.delete(state.entries, agent_id)}

  defp discard_pending(state, agent_id) do
    case Map.pop(state.pending, agent_id) do
      {nil, _} ->
        state

      {%{timer_ref: ref}, pending} ->
        _ = Process.cancel_timer(ref)
        %{state | pending: pending}
    end
  end

  defp new_entry_at_cap?(state, agent_id) do
    not Map.has_key?(state.entries, agent_id) and map_size(state.entries) >= @max_agents
  end
end
