defmodule KaoiroServer.AgentStates do
  @moduledoc """
  Holds the latest envelope per agent_id.

  State *derivation* happens in the wrapper; the server only stores and
  fans out, staying agent-agnostic (docs/specs/architecture.md). The map
  lets a late-joining client start from the current picture instead of
  waiting for the next state change.

  Each entry also keeps an in-memory ring buffer of the agent's transcript
  (`log` / `result` / `inter_agent_message` envelopes, ADR-0012, #105) so an
  operator that joins or reloads recovers the recent transcript. History keeps
  the newest 200 envelopes plus every older structured inter-agent message;
  those messages are cap-exempt because the SDK transcript cannot reconstruct
  them. History is memory-only and vanishes on restart (disk persistence is
  issue #24). `put/2` updates
  the latest state without touching history; `append_log/2` appends a
  reply line and never changes the latest state.
  `clear_other_sessions/2` drops the history lines outside the agent's
  current session (issue #48), leaving the latest state untouched.
  `delete/1` removes a disconnected agent's entry entirely (issue #14).

  phase-17 chunk δ (17-7) adds `session_boundary` marker envelopes to
  the history (ADR-0036 F3). `append_boundary/2` (used for `new` mode)
  pushes a marker onto the history and, when the marker's to_session_id
  is nil (Codex lazy采番), stashes the request_id in
  `pending_boundary_patch` so `patch_boundary_to_session_id/2` can
  fill it in later when the fresh session's first envelope arrives at
  `WrapperChannel`. `clear_history_with_boundary/2` (used for `clear`
  mode) atomically drops all history and places the marker as the sole
  line. The pending-patch stash is per-agent; the SessionResets lock
  already prevents overlapping resets from racing here.

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

  # Base envelope cap per agent (ADR-0012 history A). Older
  # inter_agent_message entries are exempt (#105). Newest-first in storage;
  # reversed to chronological order when served.
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
  Appends `envelope` (a `log` / `result` / `inter_agent_message` transcript
  line) to the agent's history ring buffer without touching its latest state.
  `:ok` when the agent is known, `:noop` otherwise (a reply before any state
  arrived).
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
  Drops the JSONL-replayable reply-log history (issue #50, ADR-0014 phase-2),
  leaving the latest state and `inter_agent_message` lines untouched. The
  latter cannot be reconstructed from the SDK transcript, so deleting them
  here would make a server-surviving resume lose peer conversation (#105).
  `:ok` when the agent is known, `:noop` otherwise.
  """
  def reset_history(agent_id, opts \\ []) do
    server = Keyword.get(opts, :server, __MODULE__)
    GenServer.call(server, {:reset_history, agent_id})
  end

  @doc """
  Appends a `session_boundary` marker envelope onto the agent's history
  (ADR-0036 F3, phase-17 17-7). Used for the `new` reset mode: the
  existing display log survives, the marker is added at the end. When
  the marker's `payload.to_session_id` is nil (Codex lazy采番) the
  request_id is stashed in `pending_boundary_patch` so
  `patch_boundary_to_session_id/2` can fill it in on the fresh session's
  first envelope. `:ok` when the agent is known, `:noop` otherwise.
  """
  def append_boundary(agent_id, marker_envelope, opts \\ []) do
    server = Keyword.get(opts, :server, __MODULE__)
    GenServer.call(server, {:append_boundary, agent_id, marker_envelope})
  end

  @doc """
  Drops ALL history and places a single `session_boundary` marker
  envelope as the sole line, atomically (ADR-0036 F3, phase-17 17-7).
  Used for the `clear` reset mode. Same nil-to_session_id → pending
  stash behaviour as `append_boundary/2`.
  """
  def clear_history_with_boundary(agent_id, marker_envelope, opts \\ []) do
    server = Keyword.get(opts, :server, __MODULE__)
    GenServer.call(server, {:clear_history_with_boundary, agent_id, marker_envelope})
  end

  @doc """
  Fills the boundary marker's `to_session_id` for a Codex lazy采番 reset
  (ADR-0036 F3, phase-17 17-7). Called from `WrapperChannel` on every
  envelope carrying a `session_id`; no-op unless a pending patch is
  stashed (normal restart / no reset in flight) so the extra call is
  cheap on the hot path. Finds the boundary marker whose payload
  request_id matches the stash, overwrites its `to_session_id`, clears
  the stash. `:ok` on patch, `:noop` when no pending stash / no
  matching marker.
  """
  def patch_boundary_to_session_id(agent_id, session_id, opts \\ []) do
    server = Keyword.get(opts, :server, __MODULE__)
    GenServer.call(server, {:patch_boundary_to_session_id, agent_id, session_id})
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

  @doc """
  True when `agent_id` has an entry whose owning channel is still alive —
  i.e. a wrapper is currently connected for it (ADR-0024 D5). Used at
  wrapper join to reject a second, concurrent connection for the same
  agent_id rather than silently last-write-wins clobbering the live one.
  A disconnected agent's owner pid is dead (its terminate already ran), so
  this returns false and a genuine reconnect is allowed.
  """
  def connected?(agent_id, opts \\ []) do
    server = Keyword.get(opts, :server, __MODULE__)
    GenServer.call(server, {:connected?, agent_id})
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

      # pending_boundary_patch preserved across puts so a state_change
      # arriving between reset acquire and its confirming envelope does
      # not clear the stash (put/2 is called on every state_change).
      pending =
        case state do
          %{^agent_id => %{pending_boundary_patch: p}} -> p
          _ -> nil
        end

      entry = %{
        envelope: envelope,
        owner: owner,
        history: history,
        pending_boundary_patch: pending
      }

      {:reply, :ok, Map.put(state, agent_id, entry)}
    end
  end

  def handle_call({:append_log, agent_id, envelope}, _from, state) do
    case state do
      %{^agent_id => entry} ->
        # Newest-first; ordinary lines cap at @max_history while structured
        # inter-agent messages survive because no SDK replay can rebuild them.
        history = cap_history_preserving_ia([envelope | entry.history], @max_history)
        {:reply, :ok, Map.put(state, agent_id, %{entry | history: history})}

      _ ->
        {:reply, :noop, state}
    end
  end

  defp cap_history_preserving_ia(entries, max) do
    if length(entries) <= max do
      entries
    else
      {newer, older} = Enum.split(entries, max)
      newer ++ Enum.filter(older, &(Map.get(&1, "type") == "inter_agent_message"))
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

  def handle_call({:reset_history, agent_id}, _from, state) do
    case state do
      %{^agent_id => entry} ->
        retained = Enum.filter(entry.history, &(Map.get(&1, "type") == "inter_agent_message"))
        {:reply, :ok, Map.put(state, agent_id, %{entry | history: retained})}

      _ ->
        {:reply, :noop, state}
    end
  end

  def handle_call({:append_boundary, agent_id, marker}, _from, state) do
    case state do
      %{^agent_id => entry} ->
        history = Enum.take([marker | entry.history], @max_history)
        pending = pending_patch_from(marker, entry.pending_boundary_patch)

        new_entry = %{entry | history: history, pending_boundary_patch: pending}
        {:reply, :ok, Map.put(state, agent_id, new_entry)}

      _ ->
        {:reply, :noop, state}
    end
  end

  def handle_call({:clear_history_with_boundary, agent_id, marker}, _from, state) do
    case state do
      %{^agent_id => entry} ->
        pending = pending_patch_from(marker, entry.pending_boundary_patch)

        new_entry = %{entry | history: [marker], pending_boundary_patch: pending}
        {:reply, :ok, Map.put(state, agent_id, new_entry)}

      _ ->
        {:reply, :noop, state}
    end
  end

  def handle_call({:patch_boundary_to_session_id, agent_id, session_id}, _from, state) do
    with %{^agent_id => %{pending_boundary_patch: request_id} = entry} <- state,
         true <- is_binary(request_id),
         true <- is_binary(session_id) do
      patched_history = Enum.map(entry.history, &patch_marker(&1, request_id, session_id))

      new_entry = %{
        entry
        | history: patched_history,
          pending_boundary_patch: nil
      }

      {:reply, :ok, Map.put(state, agent_id, new_entry)}
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

  def handle_call({:connected?, agent_id}, _from, state) do
    connected =
      case state do
        %{^agent_id => %{owner: owner}} -> is_pid(owner) and Process.alive?(owner)
        _ -> false
      end

    {:reply, connected, state}
  end

  # phase-17 17-7: a boundary marker with to_session_id=nil (Codex lazy
  # 采番) stashes its request_id so the fresh session's first envelope
  # can patch it. A marker with a bound to_session_id needs no patch;
  # in that case keep whatever stash was already there (defensive:
  # append_boundary is only called from SessionResets after a lock
  # release, so a residual stash would be a bug — but not overwriting
  # it here is safer than silently clearing it).
  defp pending_patch_from(marker, current_pending) do
    payload = Map.get(marker, "payload") || %{}
    to_sid = Map.get(payload, "to_session_id")
    request_id = Map.get(payload, "request_id")

    cond do
      is_binary(to_sid) -> current_pending
      is_binary(request_id) -> request_id
      true -> current_pending
    end
  end

  defp patch_marker(
         %{"type" => "session_boundary", "payload" => payload} = env,
         request_id,
         session_id
       )
       when is_binary(request_id) do
    case payload do
      %{"request_id" => ^request_id} ->
        %{env | "payload" => Map.put(payload, "to_session_id", session_id)}

      _ ->
        env
    end
  end

  defp patch_marker(env, _request_id, _session_id), do: env

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
