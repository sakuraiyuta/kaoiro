defmodule KaoiroServer.AgentStates do
  @moduledoc """
  Holds the latest envelope per agent_id.

  State *derivation* happens in the wrapper; the server only stores and
  fans out, staying agent-agnostic (docs/specs/architecture.md). The map
  lets a late-joining client start from the current picture instead of
  waiting for the next state change.

  Each entry also keeps an in-memory ring buffer of the agent's transcript
  (`log` / `result` envelopes, ADR-0012) so an operator that joins or
  reloads recovers the recent transcript, plus the agent's **per-pane
  inter-agent projection** (`ia`, ADR-0051 D3-1) keyed by the server
  ingress stamp. Both are memory-only and vanish on restart; the source of
  truth is the wrapper host's composite SSOT (engine transcript + IA
  sidecar) and a restarted server rebuilds them through the hydration
  handshake (D2). `put/2` updates the latest state without touching
  history; `append_log/2` appends a reply line and never changes the
  latest state; `upsert_ia/4` upserts one IA envelope into one pane.
  `clear_other_sessions/2` drops the history lines outside the agent's
  current session (issue #48), leaving the latest state untouched.
  `delete/1` removes a disconnected agent's entry entirely (issue #14).

  phase-17 chunk δ (17-7) adds `session_boundary` marker envelopes to
  the history (ADR-0036 F3). `append_boundary/2` (used for `new` mode)
  pushes a marker onto the history and, when the marker's to_session_id
  is nil (Codex lazy采番), stashes the request_id in
  `pending_boundary_patch` so `patch_boundary_to_session_id/2` can
  fill it in later when the fresh session's first envelope arrives at
  `WrapperChannel`. `/clear` mode drops every prior line and leaves the
  marker as the sole surviving entry via `clear_history_with_boundary/2`
  (ADR-0036 F3 復元, 2026-07-24); IA is hidden per-pane by
  `ClearWatermarks` at read time instead. Same nil-to_session_id
  stash behaviour applies. The pending-patch stash is per-agent; the
  SessionResets lock already prevents overlapping resets from racing
  here.

  ## Projection lifecycle (ADR-0051 D2 / D4)

  Two values live beside the agent map and share its lifetime, so that
  losing this process is indistinguishable from losing the projection:

  - `epoch` — an opaque id minted in `init/1`. It rides the operator
    `history` push so a stale dashboard tab can tell "the projection I
    merged against no longer exists" from "same projection, merge as
    usual" (D4). A restart-colliding counter or clock would not, hence
    a random id.
  - `hydration` — per agent, one of `:unhydrated` (absent from the map),
    `{:in_flight, replay_id, owner}` or `:hydrated`. `hydration_verdict/3`
    decides at wrapper join whether a replay is required and, when it is,
    mints the server-side `replay_id` both sides use for the whole
    attempt. `complete_hydration/4` is a CAS: only the attempt that is
    still recorded may flip to `:hydrated`, so a stale connection's
    completion cannot claim a newer attempt.

  The one server-derived exception is `disconnected` (specs/protocol.md):
  `disconnect/3` overlays it when the wrapper channel that wrote the
  latest envelope terminates. Each entry remembers its owner (channel
  pid) so a stale terminate arriving after a reconnect cannot clobber
  the new connection's state.
  """

  use GenServer

  require Logger

  # Wrapper connections may be unauthenticated (dev mode), so cap the map
  # to keep fabricated agent_ids from growing memory without bound.
  @max_agents 1000

  # Base envelope cap per agent (ADR-0012 history A). Newest-first in
  # storage; reversed to chronological order when served. ADR-0051 D6
  # drops the former `inter_agent_message` cap exemption (#105): IA now
  # lives in the per-pane projection below, and the FINAL merged
  # projection — not each source — is what carries the cap.
  @max_history 200

  # Per-pane IA projection cap. The merged projection is capped again at
  # read time (agents_channel `merged_histories/0`); this one only keeps a
  # single pane's map from growing without bound between merges.
  @max_ia 200

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
  Appends `envelope` (a `log` / `result` transcript line) to the agent's
  history ring buffer without touching its latest state. `:ok` when the
  agent is known, `:noop` otherwise (a reply before any state arrived).
  """
  def append_log(%{"agent_id" => agent_id} = envelope, opts \\ []) do
    server = Keyword.get(opts, :server, __MODULE__)
    GenServer.call(server, {:append_log, agent_id, envelope})
  end

  @doc """
  Per-pane inter-agent upsert (ADR-0051 D3-1). `pane_agent_id` is the
  agent whose transcript pane should show `envelope`; `stamp` is the
  server ingress order tuple allocated by `KaoiroServer.IngressOrder`.
  Identity is `{stamp, pane_agent_id}` — the sender and receiver copies of
  one message share a stamp and differ only by pane, and a replay retry
  lands on the same key, so both are idempotent.

  Deliberately NOT keyed by `conversation_id|turn_number`: server-
  synthesized notices are always `turn_number: 0` and can occur several
  times in the same conversation and pane, which would collide.

  `:ok` when the pane's agent is known, `:noop` otherwise.
  """
  def upsert_ia(pane_agent_id, {us, seq} = stamp, envelope, opts \\ [])
      when is_binary(pane_agent_id) and is_integer(us) and is_integer(seq) and is_map(envelope) do
    server = Keyword.get(opts, :server, __MODULE__)
    GenServer.call(server, {:upsert_ia, pane_agent_id, stamp, envelope})
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

  @doc "Reads the current non-empty session_id without mutating history."
  def current_session_id(agent_id, opts \\ []) do
    server = Keyword.get(opts, :server, __MODULE__)
    GenServer.call(server, {:current_session_id, agent_id})
  end

  @doc "CAS variant: clears only when the current session still equals `sid`."
  def clear_other_sessions(agent_id, sid, opts) when is_binary(sid) do
    server = Keyword.get(opts, :server, __MODULE__)
    GenServer.call(server, {:clear_other_sessions, agent_id, sid})
  end

  @doc """
  Drops the whole display projection — the replayable reply log AND the
  per-pane IA map — leaving the latest state untouched (issue #50,
  ADR-0014 phase-2). Before ADR-0051 the IA lines survived here because a
  durable server ledger owned them; now the wrapper's sidecar re-projects
  them through `replay_ia` in the same replay window, so keeping the old
  copies would double every restored bubble. `:ok` when the agent is
  known, `:noop` otherwise.
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
  `/clear` projection-reset primitive (ADR-0036 F3): drops ALL history and
  places a single `session_boundary` marker envelope as the sole line,
  atomically. `/new` keeps history and calls `append_boundary/3` instead.
  The per-pane IA map is not touched here — the reload path filters it via
  `ClearWatermarks`, which `SessionResets` records alongside this call.
  Same nil-to_session_id → pending stash behaviour as `append_boundary/2`.
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

  @doc """
  Returns the pane_agent_id => `[{stamp, envelope}]` IA projection
  (chronological by ingress stamp). Panes with no IA are omitted. The
  caller filters by `ClearWatermarks` in the same ordering domain and
  merges with `histories/1` (ADR-0051 D3-1 / D3-4).
  """
  def ia_projection(server \\ __MODULE__) do
    GenServer.call(server, :ia_projection)
  end

  @doc """
  The opaque id of this projection's lifetime (ADR-0051 D4). Changes on
  every `init/1`, so a container restart AND a lone crash of this process
  both invalidate a client's merge baseline.
  """
  def projection_epoch(server \\ __MODULE__) do
    GenServer.call(server, :projection_epoch)
  end

  @doc """
  Decides at wrapper join whether the agent's display projection needs a
  replay, and starts the attempt when it does (ADR-0051 D2).

  - `:hydrated` → `:not_required`; the wrapper skips the replay entirely,
    which is what keeps an ordinary reconnect against a live server from
    re-sending a transcript the server still holds.
  - anything else → mints a fresh `replay_id`, records
    `{:in_flight, replay_id, owner}` and returns `{:required, replay_id}`.
    `owner` is the joining channel pid; the CAS in `complete_hydration/4`
    and `release_hydration/3` compares against it.
  """
  def hydration_verdict(agent_id, owner, opts \\ []) when is_binary(agent_id) do
    server = Keyword.get(opts, :server, __MODULE__)
    GenServer.call(server, {:hydration_verdict, agent_id, owner})
  end

  @doc """
  True when `replay_id` + `owner` still name the recorded in-flight
  attempt. `replay_ia` uses it to refuse rows from a superseded attempt
  (ADR-0051 D3-3).
  """
  def hydration_in_flight?(agent_id, replay_id, owner, opts \\ []) do
    server = Keyword.get(opts, :server, __MODULE__)
    GenServer.call(server, {:hydration_in_flight?, agent_id, replay_id, owner})
  end

  @doc """
  CAS completion of a replay attempt (ADR-0051 D2). Flips to `:hydrated`
  only when `{replay_id, owner}` matches the recorded attempt; `:stale`
  otherwise, so a completion from an older connection cannot mark a newer
  attempt done.
  """
  def complete_hydration(agent_id, replay_id, owner, opts \\ []) do
    server = Keyword.get(opts, :server, __MODULE__)
    GenServer.call(server, {:complete_hydration, agent_id, replay_id, owner})
  end

  @doc """
  Wrapper channel teardown. An attempt still in flight for `owner` rolls
  back to `:unhydrated` so the next join re-requests it; a `:hydrated`
  projection stays hydrated (it is still on the server, and the wrapper
  that would have rebuilt it produced nothing while offline). A record
  owned by a different connection is left alone — the same stale-terminate
  guard `disconnect/3` applies to the latest state.
  """
  def release_hydration(agent_id, owner, opts \\ []) do
    server = Keyword.get(opts, :server, __MODULE__)
    GenServer.call(server, {:release_hydration, agent_id, owner})
  end

  @doc """
  Forces the agent back to `:unhydrated` (ADR-0051 D2 追補). Used by the
  operator paths that point a wrapper at a DIFFERENT session — `restore`
  with a resume target and `resume_session` — where the current projection
  belongs to the session being left and must be rebuilt from the resumed
  transcript. `/new` and `/clear` deliberately do NOT call this: ADR-0036
  F3 defines their display outcome (keep / marker-only) and a replay would
  overwrite it.
  """
  def invalidate_hydration(agent_id, opts \\ []) do
    server = Keyword.get(opts, :server, __MODULE__)
    GenServer.call(server, {:invalidate_hydration, agent_id})
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
  def init(_arg) do
    {:ok, %{agents: %{}, hydration: %{}, epoch: new_epoch()}}
  end

  @impl true
  def handle_call({:put, agent_id, envelope, owner}, _from, state) do
    agents = state.agents

    if map_size(agents) >= @max_agents and not Map.has_key?(agents, agent_id) do
      {:reply, {:error, :too_many_agents}, state}
    else
      existing = Map.get(agents, agent_id)

      entry = %{
        envelope: envelope,
        owner: owner,
        # Preserve any accumulated projection; put only refreshes latest state.
        history: entry_field(existing, :history, []),
        ia: entry_field(existing, :ia, %{}),
        # pending_boundary_patch preserved across puts so a state_change
        # arriving between reset acquire and its confirming envelope does
        # not clear the stash (put/2 is called on every state_change).
        pending_boundary_patch: entry_field(existing, :pending_boundary_patch, nil)
      }

      {:reply, :ok, put_agent(state, agent_id, entry)}
    end
  end

  def handle_call({:append_log, agent_id, envelope}, _from, state) do
    case state.agents do
      %{^agent_id => entry} ->
        # Newest-first, hard cap: IA no longer rides this list (ADR-0051
        # D3-1) so nothing here is exempt.
        history = Enum.take([envelope | entry.history], @max_history)
        {:reply, :ok, put_agent(state, agent_id, %{entry | history: history})}

      _ ->
        {:reply, :noop, state}
    end
  end

  def handle_call({:upsert_ia, pane_agent_id, stamp, envelope}, _from, state) do
    case state.agents do
      %{^pane_agent_id => entry} ->
        ia = entry.ia |> Map.put(stamp, envelope) |> cap_ia()
        {:reply, :ok, put_agent(state, pane_agent_id, %{entry | ia: ia})}

      _ ->
        {:reply, :noop, state}
    end
  end

  def handle_call({:disconnect, agent_id, owner, ts}, _from, state) do
    case state.agents do
      %{^agent_id => %{envelope: envelope, owner: ^owner} = entry} ->
        derived = disconnected_envelope(envelope, ts)
        {:reply, {:ok, derived}, put_agent(state, agent_id, %{entry | envelope: derived})}

      _ ->
        {:reply, :noop, state}
    end
  end

  def handle_call({:clear_other_sessions, agent_id}, _from, state) do
    with %{^agent_id => %{envelope: env, history: history} = entry} <- state.agents,
         sid when is_binary(sid) and sid != "" <- Map.get(env, "session_id") do
      kept = Enum.filter(history, &(Map.get(&1, "session_id") == sid))
      {:reply, {:ok, sid}, put_agent(state, agent_id, %{entry | history: kept})}
    else
      _ -> {:reply, :noop, state}
    end
  end

  def handle_call({:current_session_id, agent_id}, _from, state) do
    reply =
      with %{envelope: env} <- Map.get(state.agents, agent_id),
           sid when is_binary(sid) and sid != "" <- Map.get(env, "session_id") do
        {:ok, sid}
      else
        _ -> :noop
      end

    {:reply, reply, state}
  end

  def handle_call({:clear_other_sessions, agent_id, expected_sid}, _from, state) do
    with %{^agent_id => %{envelope: env, history: history} = entry} <- state.agents,
         ^expected_sid <- Map.get(env, "session_id") do
      kept = Enum.filter(history, &(Map.get(&1, "session_id") == expected_sid))
      {:reply, {:ok, expected_sid}, put_agent(state, agent_id, %{entry | history: kept})}
    else
      _ -> {:reply, :noop, state}
    end
  end

  def handle_call({:reset_history, agent_id}, _from, state) do
    case state.agents do
      %{^agent_id => entry} ->
        {:reply, :ok, put_agent(state, agent_id, %{entry | history: [], ia: %{}})}

      _ ->
        {:reply, :noop, state}
    end
  end

  def handle_call({:append_boundary, agent_id, marker}, _from, state) do
    case state.agents do
      %{^agent_id => entry} ->
        history = Enum.take([marker | entry.history], @max_history)
        pending = pending_patch_from(marker, entry.pending_boundary_patch)

        new_entry = %{entry | history: history, pending_boundary_patch: pending}
        {:reply, :ok, put_agent(state, agent_id, new_entry)}

      _ ->
        {:reply, :noop, state}
    end
  end

  def handle_call({:clear_history_with_boundary, agent_id, marker}, _from, state) do
    case state.agents do
      %{^agent_id => entry} ->
        pending = pending_patch_from(marker, entry.pending_boundary_patch)

        new_entry = %{entry | history: [marker], pending_boundary_patch: pending}
        {:reply, :ok, put_agent(state, agent_id, new_entry)}

      _ ->
        {:reply, :noop, state}
    end
  end

  def handle_call({:patch_boundary_to_session_id, agent_id, session_id}, _from, state) do
    with %{^agent_id => %{pending_boundary_patch: request_id} = entry} <- state.agents,
         true <- is_binary(request_id),
         true <- is_binary(session_id) do
      patched_history = Enum.map(entry.history, &patch_marker(&1, request_id, session_id))

      new_entry = %{
        entry
        | history: patched_history,
          pending_boundary_patch: nil
      }

      {:reply, :ok, put_agent(state, agent_id, new_entry)}
    else
      _ -> {:reply, :noop, state}
    end
  end

  def handle_call({:delete, agent_id}, _from, state) do
    case state.agents do
      %{^agent_id => %{envelope: %{"state" => "disconnected"}}} ->
        {:reply, :ok,
         %{
           state
           | agents: Map.delete(state.agents, agent_id),
             hydration: Map.delete(state.hydration, agent_id)
         }}

      %{^agent_id => _} ->
        {:reply, {:error, :not_disconnected}, state}

      _ ->
        {:reply, {:error, :unknown_agent}, state}
    end
  end

  def handle_call(:snapshot, _from, state) do
    {:reply, Map.new(state.agents, fn {id, %{envelope: env}} -> {id, env} end), state}
  end

  def handle_call(:histories, _from, state) do
    histories =
      for {id, %{history: h}} <- state.agents, h != [], into: %{}, do: {id, Enum.reverse(h)}

    {:reply, histories, state}
  end

  def handle_call(:ia_projection, _from, state) do
    projection =
      for {id, %{ia: ia}} <- state.agents,
          ia != %{},
          into: %{},
          do: {id, Enum.sort_by(ia, fn {stamp, _env} -> stamp end)}

    {:reply, projection, state}
  end

  def handle_call(:projection_epoch, _from, state) do
    {:reply, state.epoch, state}
  end

  def handle_call({:hydration_verdict, agent_id, owner}, _from, state) do
    case Map.get(state.hydration, agent_id) do
      :hydrated ->
        {:reply, :not_required, state}

      _ when map_size(state.hydration) >= @max_agents ->
        # Cap reached with no record of our own (dev mode admits arbitrary
        # agent_ids, so this map needs the same bound the agent map has).
        # Still ASK for the replay: `:not_required` would tell the wrapper
        # its projection is intact, which is a lie that leaves the timeline
        # empty for good. Without a recorded attempt the transcript replay
        # still lands (reset + `log` envelopes need no attempt), `replay_ia`
        # is refused as stale, and the completion CAS misses — so the next
        # join asks again instead of the agent being stuck.
        Logger.warning("hydration attempt not recorded for #{inspect(agent_id)}: tracker at cap")

        {:reply, {:required, new_replay_id()}, state}

      _ ->
        replay_id = new_replay_id()
        hydration = Map.put(state.hydration, agent_id, {:in_flight, replay_id, owner})
        {:reply, {:required, replay_id}, %{state | hydration: hydration}}
    end
  end

  def handle_call({:hydration_in_flight?, agent_id, replay_id, owner}, _from, state) do
    match =
      Map.get(state.hydration, agent_id) == {:in_flight, replay_id, owner}

    {:reply, match, state}
  end

  def handle_call({:complete_hydration, agent_id, replay_id, owner}, _from, state) do
    case Map.get(state.hydration, agent_id) do
      {:in_flight, ^replay_id, ^owner} ->
        {:reply, :ok, %{state | hydration: Map.put(state.hydration, agent_id, :hydrated)}}

      _ ->
        {:reply, :stale, state}
    end
  end

  def handle_call({:release_hydration, agent_id, owner}, _from, state) do
    case Map.get(state.hydration, agent_id) do
      {:in_flight, _replay_id, ^owner} ->
        {:reply, :ok, %{state | hydration: Map.delete(state.hydration, agent_id)}}

      _ ->
        {:reply, :ok, state}
    end
  end

  def handle_call({:invalidate_hydration, agent_id}, _from, state) do
    {:reply, :ok, %{state | hydration: Map.delete(state.hydration, agent_id)}}
  end

  def handle_call({:known?, agent_id}, _from, state) do
    {:reply, Map.has_key?(state.agents, agent_id), state}
  end

  def handle_call({:connected?, agent_id}, _from, state) do
    connected =
      case state.agents do
        %{^agent_id => %{owner: owner}} -> is_pid(owner) and Process.alive?(owner)
        _ -> false
      end

    {:reply, connected, state}
  end

  defp put_agent(state, agent_id, entry) do
    %{state | agents: Map.put(state.agents, agent_id, entry)}
  end

  # Entries created before a field existed cannot occur (the process holds
  # no state across restarts), but `put/2` also runs for a brand-new agent
  # where `existing` is nil.
  defp entry_field(nil, _key, default), do: default
  defp entry_field(entry, key, default), do: Map.get(entry, key, default)

  defp cap_ia(ia) when map_size(ia) <= @max_ia, do: ia

  defp cap_ia(ia) do
    ia
    |> Enum.sort_by(fn {stamp, _env} -> stamp end, :desc)
    |> Enum.take(@max_ia)
    |> Map.new()
  end

  # Opaque, restart-unique. A counter or a timestamp can repeat across
  # restarts, which is exactly the "projection was lost but the epoch says
  # otherwise" lie D4 forbids.
  defp new_epoch, do: random_id()
  defp new_replay_id, do: "hydr-" <> random_id()

  defp random_id, do: 16 |> :crypto.strong_rand_bytes() |> Base.url_encode64(padding: false)

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
