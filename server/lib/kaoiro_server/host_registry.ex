defmodule KaoiroServer.HostRegistry do
  @moduledoc """
  Holds the live set of hosts and each host's persona trust policy + cwd
  allow-list (ADR-0023, ADR-0031, issue #67).

  Each host runs one resident runner that connects on `runner:<host_id>`,
  registers its host, and heartbeats to stay alive. The runner declares
  how much it trusts the server's persona catalog as a policy (ADR-0031):

    * `:accept_all` — every server-known persona is spawnable
    * `{:allowlist, MapSet.t()}` — only the listed ids
    * `{:blocklist, MapSet.t()}` — every server-known id EXCEPT the listed

  Store keeps the raw policy; the resolved spawnable list is computed at
  read time by intersecting the policy with a caller-supplied
  `personas_pool` (the server-authoritative set from
  `KaoiroServer.PersonaAssets.all_personas/0`). Callers pass the pool
  explicitly so tests can inject fixtures without touching the global
  PersonaAssets cache.

  Each entry remembers its owning runner pid so a stale terminate after a
  reconnect cannot drop the new connection's entry (same owner-fencing as
  AgentStates.disconnect/3). `register/4` overwrites the entry and takes
  ownership; `drop/3` removes it only while `runner_pid` still owns it.
  Host info is operator-only by policy (cwd allow-lists are sensitive,
  #46); the caller (channel) enforces the role gate.
  """

  use GenServer

  # Runner connections may be unauthenticated (dev mode), so cap the map
  # to keep fabricated host_ids from growing memory without bound. Mirrors
  # AgentStates' @max_agents discipline; hosts are far fewer than agents.
  @max_hosts 1000

  def start_link(opts) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, %{}, name: name)
  end

  @doc """
  Records the host's registration, overwriting any prior entry and taking
  `runner_pid` as the owner. `attrs` carries `:policy`, `:cwd_allowlist`
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

  @doc "Returns the host's raw entry map (with `:policy`), or nil when unknown."
  def get(host_id, server \\ __MODULE__) do
    GenServer.call(server, {:get, host_id})
  end

  @doc """
  Returns the host's operator-facing entry: personas computed by applying
  the host's policy to `personas_pool`, and the internal `runner_pid`
  stripped. The spawn / stop / restart resolver must read THIS, not
  `get/2`, so the persona set it resolves against matches what the
  operator UI saw via the `hosts` push. Returns nil when the host is
  unknown.
  """
  def get_public(host_id, personas_pool, server \\ __MODULE__) do
    GenServer.call(server, {:get_public, host_id, personas_pool})
  end

  @doc """
  Returns the host_id => operator-facing entry map for every registered
  host, with each host's `personas` computed from its policy and
  `personas_pool`. The internal `runner_pid` is stripped so the result is
  JSON-serialisable for the operator "hosts" push (a PID has no Jason
  encoder).
  """
  def snapshot(personas_pool, server \\ __MODULE__) do
    GenServer.call(server, {:snapshot, personas_pool})
  end

  @doc """
  Aggregated, de-duplicated list of personas across all hosts after each
  policy is applied to `personas_pool` (the set an operator can currently
  spawn somewhere). Order is not significant.
  """
  def personas(personas_pool, server \\ __MODULE__) do
    GenServer.call(server, {:personas, personas_pool})
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
        policy: Map.get(attrs, :policy, :accept_all),
        cwd_allowlist: Map.get(attrs, :cwd_allowlist, []),
        capabilities: Map.get(attrs, :capabilities, []),
        # Launch catalog per engine (ADR-0032 F4bc), flows to the operator
        # `hosts` push as-is (public_entry keeps it).
        engines: Map.get(attrs, :engines, []),
        # Build identity (issues #228/#288) — optional, nil for a legacy
        # runner build. Flows to the operator `hosts` push as-is.
        build_revision: Map.get(attrs, :build_revision),
        build_dirty: Map.get(attrs, :build_dirty),
        build_version: Map.get(attrs, :build_version),
        build_channel: Map.get(attrs, :build_channel),
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

  def handle_call({:get_public, host_id, pool}, _from, state) do
    case Map.get(state, host_id) do
      nil -> {:reply, nil, state}
      entry -> {:reply, public_entry(entry, pool), state}
    end
  end

  def handle_call({:snapshot, pool}, _from, state) do
    # Strip the internal runner_pid: the snapshot is pushed to operators
    # over JSON channels and a PID has no Jason encoder (it would crash the
    # serializer). Owner fencing in drop/3 reads the internal state, not
    # this view, so dropping the pid here is safe.
    public =
      Map.new(state, fn {host_id, entry} -> {host_id, public_entry(entry, pool)} end)

    {:reply, public, state}
  end

  def handle_call({:personas, pool}, _from, state) do
    personas =
      state
      |> Enum.flat_map(fn {_id, entry} -> apply_policy(entry.policy, pool) end)
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

  # The operator-facing slice of an entry: personas computed from the
  # policy applied to `pool`. The internal `runner_pid` and the raw
  # `:policy` (an `{atom, MapSet}` tuple) are stripped — the resolved
  # `:personas` list is what operators see, and Jason cannot encode a
  # tuple, so leaking `:policy` here crashes the `hosts` channel push.
  defp public_entry(entry, pool) do
    entry
    |> Map.drop([:runner_pid, :policy])
    |> Map.put(:personas, apply_policy(entry.policy, pool))
  end

  # Reduce the server-authoritative persona pool to the set the host's
  # policy admits. Order of `pool` is preserved so the operator UI sees a
  # stable listing (PersonaAssets sorts it: default first, then id-sorted).
  defp apply_policy(:accept_all, pool), do: pool

  defp apply_policy({:allowlist, ids}, pool) do
    Enum.filter(pool, fn persona -> MapSet.member?(ids, persona_id(persona)) end)
  end

  defp apply_policy({:blocklist, ids}, pool) do
    Enum.reject(pool, fn persona -> MapSet.member?(ids, persona_id(persona)) end)
  end

  defp persona_id(%{"id" => id}), do: id
  defp persona_id(%{id: id}), do: id
  defp persona_id(_), do: nil
end
