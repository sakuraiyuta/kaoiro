defmodule KaoiroServer.HostRegistry do
  @moduledoc """
  Holds the live set of hosts and the personas/cwds each can run
  (ADR-0023, issue #67).

  Each host runs one resident runner that connects on `runner:<host_id>`,
  registers its host (spawnable personas + selectable cwd allow-list,
  issue #22), and heartbeats to stay alive. The server aggregates these
  so an operator UI can see what every host can launch and which runner
  to address for a spawn/stop/restart. Like AgentStates, derivation lives
  outside the server: this store only records what the runner declares
  and stays host/agent-agnostic.

  Each entry remembers its owning runner pid so a stale terminate after a
  reconnect cannot drop the new connection's entry (same owner-fencing as
  AgentStates.disconnect/3). `register/4` overwrites the entry and takes
  ownership; `drop/3` removes it only while `runner_pid` still owns it.
  Host info is operator-only by policy (cwd allow-lists are sensitive,
  #46); the caller (channel) enforces the role gate.

  `snapshot/1` injects the reserved `default` persona at the head of each
  host's personas list (#35, personas.md). The store itself keeps the
  runner's raw declaration; only the operator-facing view is normalised.
  """

  use GenServer

  # Runner connections may be unauthenticated (dev mode), so cap the map
  # to keep fabricated host_ids from growing memory without bound. Mirrors
  # AgentStates' @max_agents discipline; hosts are far fewer than agents.
  @max_hosts 1000

  # Reserved persona that the operator UI must always see as a spawn choice
  # (personas.md「デフォルトペルソナ」, #35). sprite_set "default" is a
  # reserved value with no bundled pack under server/priv/personas/, so the
  # client falls back to the CSS face (expression.ts / AgentCard).
  @default_persona %{
    "id" => "default",
    "name" => "デフォルト",
    "sprite_set" => "default"
  }

  def start_link(opts) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, %{}, name: name)
  end

  @doc """
  Records the host's registration, overwriting any prior entry and taking
  `runner_pid` as the owner. `attrs` carries `:personas`, `:cwd_allowlist`
  and optional `:capabilities`. Returns `:ok`, or
  `{:error, :too_many_hosts}` when a new host_id would exceed the cap
  (re-registration of a known host always succeeds).
  """
  def register(host_id, attrs, runner_pid, server \\ __MODULE__) do
    GenServer.call(server, {:register, host_id, attrs, runner_pid})
  end

  @doc """
  Refreshes the host's `last_heartbeat`. `:ok` when the host is known,
  `:noop` otherwise (a heartbeat before/after registration).
  """
  def heartbeat(host_id, server \\ __MODULE__) do
    GenServer.call(server, {:heartbeat, host_id})
  end

  @doc "Returns the host's entry map, or nil when unknown."
  def get(host_id, server \\ __MODULE__) do
    GenServer.call(server, {:get, host_id})
  end

  @doc """
  Returns the host's operator-facing entry: personas normalised with the
  reserved `default` (#35) and the internal `runner_pid` stripped, the same
  view a single host would have under `snapshot/1`. The spawn / stop /
  restart resolver must read THIS, not `get/2`, so the persona set it
  resolves against matches what the operator UI saw via the `hosts` push --
  otherwise an operator picking `default` would hit `unknown_persona`.
  Returns nil when the host is unknown.
  """
  def get_public(host_id, server \\ __MODULE__) do
    GenServer.call(server, {:get_public, host_id})
  end

  @doc """
  Returns the host_id => entry map for every registered host, with the
  internal `runner_pid` stripped so the result is JSON-serialisable for
  the operator "hosts" push (a PID has no Jason encoder).
  """
  def snapshot(server \\ __MODULE__) do
    GenServer.call(server, :snapshot)
  end

  @doc """
  Aggregated, de-duplicated list of personas across all hosts (the set an
  operator can currently spawn). Order is not significant.
  """
  def personas(server \\ __MODULE__) do
    GenServer.call(server, :personas)
  end

  @doc """
  Removes the host's entry, but only while `runner_pid` still owns it
  (reconnect-race guard, mirrors AgentStates.disconnect/3). Returns `:ok`
  when dropped, `:noop` when absent or owned by a newer runner.
  """
  def drop(host_id, runner_pid, server \\ __MODULE__) do
    GenServer.call(server, {:drop, host_id, runner_pid})
  end

  @impl true
  def init(state), do: {:ok, state}

  @impl true
  def handle_call({:register, host_id, attrs, runner_pid}, _from, state) do
    if map_size(state) >= @max_hosts and not Map.has_key?(state, host_id) do
      {:reply, {:error, :too_many_hosts}, state}
    else
      now = DateTime.utc_now() |> DateTime.to_iso8601()

      entry = %{
        personas: Map.get(attrs, :personas, []),
        cwd_allowlist: Map.get(attrs, :cwd_allowlist, []),
        capabilities: Map.get(attrs, :capabilities, []),
        runner_pid: runner_pid,
        registered_at: now,
        last_heartbeat: now
      }

      {:reply, :ok, Map.put(state, host_id, entry)}
    end
  end

  def handle_call({:heartbeat, host_id}, _from, state) do
    case state do
      %{^host_id => entry} ->
        now = DateTime.utc_now() |> DateTime.to_iso8601()
        {:reply, :ok, Map.put(state, host_id, %{entry | last_heartbeat: now})}

      _ ->
        {:reply, :noop, state}
    end
  end

  def handle_call({:get, host_id}, _from, state) do
    {:reply, Map.get(state, host_id), state}
  end

  def handle_call({:get_public, host_id}, _from, state) do
    case Map.get(state, host_id) do
      nil -> {:reply, nil, state}
      entry -> {:reply, public_entry(entry), state}
    end
  end

  def handle_call(:snapshot, _from, state) do
    # Strip the internal runner_pid: the snapshot is pushed to operators
    # over JSON channels and a PID has no Jason encoder (it would crash the
    # serializer). Owner fencing in drop/3 reads the internal state, not
    # this view, so dropping the pid here is safe.
    #
    # Inject the reserved `default` persona at the head of each host's
    # personas (#35); a runner-declared `default` is replaced by the
    # server-side standard so the entry's name/sprite_set stay canonical.
    public = Map.new(state, fn {host_id, entry} -> {host_id, public_entry(entry)} end)
    {:reply, public, state}
  end

  def handle_call(:personas, _from, state) do
    personas =
      state
      |> Enum.flat_map(fn {_id, %{personas: personas}} -> personas end)
      |> Enum.uniq()

    {:reply, personas, state}
  end

  def handle_call({:drop, host_id, runner_pid}, _from, state) do
    case state do
      %{^host_id => %{runner_pid: ^runner_pid}} ->
        {:reply, :ok, Map.delete(state, host_id)}

      _ ->
        {:reply, :noop, state}
    end
  end

  # The operator-facing slice of an entry: personas normalised with the
  # reserved `default` and the internal `runner_pid` stripped (it has no
  # Jason encoder, and `drop/3` fences via the in-state map directly).
  defp public_entry(entry) do
    entry
    |> Map.delete(:runner_pid)
    |> Map.put(:personas, inject_default(entry.personas))
  end

  # Drop any runner-declared `default` so the server-side standard wins,
  # then place it at the head so the operator UI sees a stable lead entry.
  defp inject_default(personas) do
    filtered = Enum.reject(personas, &(persona_id(&1) == "default"))
    [@default_persona | filtered]
  end

  defp persona_id(%{"id" => id}), do: id
  defp persona_id(%{id: id}), do: id
  defp persona_id(_), do: nil
end
