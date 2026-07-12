defmodule KaoiroServer.SessionPointers do
  @moduledoc """
  Restart-surviving store of each agent's most recent SDK `session_id`
  (ADR-0014 F1, issue #49). Persists only the pointer
  `agent_id => %{session_id, cwd}`, never conversation history — the
  history's source of truth is the wrapper host's JSONL (ADR-0014 A4).

  Backed by DETS (one on-disk file, no extra deps) since the data is tiny
  and losing a pointer only costs the default resume target; the runner
  can still enumerate candidates from JSONL (ADR-0014 F2). agent_id maps
  1:1 to its latest session_id (F3); the full 1:N session history is the
  runner's job, not this store's. The ADR tuple's `host` is implied by
  agent_id (bound to a fixed host/cwd, F3) and is not carried in the
  protocol, so only cwd is kept alongside session_id.

  An in-memory map mirrors DETS for fast reads; writes go through to disk
  only when a pointer actually changes, keeping the per-envelope ingest
  path cheap.
  """

  use GenServer

  require Logger

  @doc """
  Starts the store. `:path` overrides the DETS file and `:name` the
  registered name + DETS table (tests run isolated instances).
  """
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    path = Keyword.get(opts, :path, default_path())
    GenServer.start_link(__MODULE__, {name, path}, name: name)
  end

  @doc """
  Records `session_id` (and optional `cwd`) as the agent's latest pointer.
  Fire-and-forget so persistence never slows envelope ingest.
  """
  def record(agent_id, session_id, cwd \\ nil, engine \\ nil, server \\ __MODULE__) do
    GenServer.cast(server, {:record, agent_id, session_id, cwd, engine, nil})
  end

  @doc """
  Records the agent-scoped resolved snapshot (ADR-0014 F1 追補, phase-15 D8):
  a `ResolvedSnapshotExt`-shaped map of the last effective model /
  permission-axis settings, kept across session boundaries and purged only
  on agent delete. Split from `record/5` so envelope-ingest callers do not
  need to know about snapshots and vice versa; the two paths merge in
  DETS via the shared 5-tuple record. No-ops when the agent is not yet
  known (an envelope carrying the initial pointer must arrive first).
  """
  def record_snapshot(agent_id, snapshot, server \\ __MODULE__) do
    GenServer.cast(server, {:record_snapshot, agent_id, snapshot})
  end

  @doc "Latest pointer `%{session_id, cwd}` for the agent, or nil."
  def get(agent_id, server \\ __MODULE__) do
    GenServer.call(server, {:get, agent_id})
  end

  @doc "agent_id => %{session_id, cwd} for every known pointer."
  def all(server \\ __MODULE__) do
    GenServer.call(server, :all)
  end

  @doc """
  Removes the agent's pointer from memory + DETS. Idempotent — an unknown
  agent returns `:ok`. Synchronous so the operator-driven delete path in
  `agents_channel.ex` can wait for the purge before broadcasting
  `agent_deleted` (ADR-0030 D6).
  """
  def delete(agent_id, server \\ __MODULE__) do
    GenServer.call(server, {:delete, agent_id})
  end

  @doc """
  Explicitly nils out the agent's session_id while keeping cwd / engine /
  snapshot intact (ADR-0036 F4, phase-17 17-3). Distinct from `record/5`
  whose merge semantics interpret a nil session_id as "keep the existing
  session_id" so a session_id-bearing envelope without cwd cannot erase
  the cwd restore needs — that helper is the wrong tool for a fresh
  relaunch's explicit detach.

  Synchronous so the reset lifecycle (`KaoiroServer.SessionResets`) can
  await the detach before broadcasting `session_reset_completed`. Unknown
  agent = `:ok` no-op — a fresh spawn without a pointer never reaches
  this path in practice, but idempotence matches `delete/2`. Already-nil
  session_id is a no-op that does not rewrite DETS.
  """
  def detach_session(agent_id, server \\ __MODULE__) do
    GenServer.call(server, {:detach_session, agent_id})
  end

  @impl true
  def init({name, path}) do
    path |> Path.dirname() |> File.mkdir_p!()
    table = open_table(name, path)
    # Records carry cwd, which is sensitive (#46); keep the file owner-only
    # so the default /tmp location is not world-readable on a shared host.
    # Best-effort — chmod can fail on non-POSIX filesystems, not fatal.
    _ = File.chmod(path, 0o600)
    {:ok, %{table: table, pointers: load_pointers(table)}}
  end

  # A corrupt/unreadable DETS file must not crash-loop the supervisor: the
  # pointer store is recoverable (the runner re-enumerates, ADR-0014 F2). On
  # a failed open, drop the file and recreate it empty.
  defp open_table(name, path) do
    case :dets.open_file(name, file: String.to_charlist(path)) do
      {:ok, ^name} ->
        name

      {:error, reason} ->
        Logger.warning("session pointer store unreadable (#{inspect(reason)}); recreating")

        File.rm(path)
        {:ok, ^name} = :dets.open_file(name, file: String.to_charlist(path))
        name
    end
  end

  # Fold the table into the in-memory map; an error tuple (corrupt mid-read)
  # degrades to an empty map rather than crashing init.
  defp load_pointers(table) do
    case :dets.foldl(
           fn
             # 5-tuple with resolved snapshot (ADR-0014 F1 追補, phase-15 D8):
             # the agent-scoped "last effective" settings kept across session
             # boundaries. 4-tuple = pre-snapshot record, snapshot nil.
             # 3-tuple = pre-engine record (ADR-0032 F8), engine nil too.
             {agent_id, session_id, cwd, engine, snapshot}, acc ->
               Map.put(acc, agent_id, %{
                 session_id: session_id,
                 cwd: cwd,
                 engine: engine,
                 snapshot: snapshot
               })

             {agent_id, session_id, cwd, engine}, acc ->
               Map.put(acc, agent_id, %{
                 session_id: session_id,
                 cwd: cwd,
                 engine: engine,
                 snapshot: nil
               })

             {agent_id, session_id, cwd}, acc ->
               Map.put(acc, agent_id, %{
                 session_id: session_id,
                 cwd: cwd,
                 engine: nil,
                 snapshot: nil
               })
           end,
           %{},
           table
         ) do
      pointers when is_map(pointers) -> pointers
      {:error, _reason} -> %{}
    end
  end

  @impl true
  def handle_cast({:record, agent_id, session_id, cwd, engine, snapshot}, state) do
    existing = Map.get(state.pointers, agent_id, %{})
    # Keep a previously-recorded field when this record carries none (#22):
    # a session_id-bearing envelope without a statusline cwd (e.g. result /
    # log) must not clobber the cwd that restore needs, and a spawn-time cwd
    # seed (session_id nil) must not erase a known session_id. A non-nil value
    # always wins, so a real session_id / cwd / engine / snapshot still
    # updates. The snapshot (ADR-0014 F1 追補, phase-15 D8) is agent-scoped
    # and survives session boundaries — nil here means "keep whatever is
    # already stored", not "clear".
    session_id = session_id || Map.get(existing, :session_id)
    cwd = cwd || Map.get(existing, :cwd)
    engine = engine || Map.get(existing, :engine)
    snapshot = snapshot || Map.get(existing, :snapshot)
    pointer = %{session_id: session_id, cwd: cwd, engine: engine, snapshot: snapshot}

    if existing == pointer do
      {:noreply, state}
    else
      :ok = :dets.insert(state.table, {agent_id, session_id, cwd, engine, snapshot})
      {:noreply, %{state | pointers: Map.put(state.pointers, agent_id, pointer)}}
    end
  end

  def handle_cast({:record_snapshot, agent_id, snapshot}, state) do
    # Snapshot-only update: no-op unless the agent already has a pointer
    # (the initial pointer is seeded by an envelope-driven `record` call).
    case Map.get(state.pointers, agent_id) do
      nil ->
        {:noreply, state}

      existing ->
        new_pointer = Map.put(existing, :snapshot, snapshot)

        if existing == new_pointer do
          {:noreply, state}
        else
          :ok =
            :dets.insert(
              state.table,
              {agent_id, existing.session_id, existing.cwd, existing.engine, snapshot}
            )

          {:noreply, %{state | pointers: Map.put(state.pointers, agent_id, new_pointer)}}
        end
    end
  end

  @impl true
  def handle_call({:get, agent_id}, _from, state) do
    {:reply, Map.get(state.pointers, agent_id), state}
  end

  def handle_call(:all, _from, state) do
    {:reply, state.pointers, state}
  end

  def handle_call({:delete, agent_id}, _from, state) do
    :ok = :dets.delete(state.table, agent_id)
    {:reply, :ok, %{state | pointers: Map.delete(state.pointers, agent_id)}}
  end

  def handle_call({:detach_session, agent_id}, _from, state) do
    case Map.get(state.pointers, agent_id) do
      nil ->
        {:reply, :ok, state}

      %{session_id: nil} ->
        {:reply, :ok, state}

      existing ->
        new_pointer = %{existing | session_id: nil}

        :ok =
          :dets.insert(
            state.table,
            {agent_id, nil, existing.cwd, existing.engine, existing.snapshot}
          )

        {:reply, :ok, %{state | pointers: Map.put(state.pointers, agent_id, new_pointer)}}
    end
  end

  @impl true
  def terminate(_reason, state) do
    :dets.close(state.table)
  end

  defp default_path do
    Application.get_env(:kaoiro_server, :session_pointers_path) ||
      Path.join(System.tmp_dir!(), "kaoiro_session_pointers.dets")
  end
end
