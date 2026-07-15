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

  The snapshot is sanitized before persistence (write-side validation,
  藤 D2, resume-privilege-restoration): only the known 7 `ResolvedSnapshotExt`
  fields survive, with closed-enum guards on `sandbox` / `permission_mode` /
  `*_source` and a boolean guard on `network_access`. Unknown or
  malformed fields are dropped with a `Logger.warning` — a compromised
  wrapper cannot land an invalid enum through this door (though it can
  still stamp valid `danger-full-access` on its own, the trust boundary
  documented in ADR-0014 F1 追補「resume 時の privilege 三軸再適用」).
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
    case sanitize_snapshot(snapshot) do
      nil ->
        # Non-map snapshot: defensive drop (fail-closed). The wrapper_channel
        # ingest already gates non-maps, but repeating the invariant here
        # keeps future callers from bypassing it.
        {:noreply, state}

      sanitized ->
        # Snapshot-only update: no-op unless the agent already has a pointer
        # (the initial pointer is seeded by an envelope-driven `record` call).
        case Map.get(state.pointers, agent_id) do
          nil ->
            {:noreply, state}

          existing ->
            new_pointer = Map.put(existing, :snapshot, sanitized)

            if existing == new_pointer do
              {:noreply, state}
            else
              :ok =
                :dets.insert(
                  state.table,
                  {agent_id, existing.session_id, existing.cwd, existing.engine, sanitized}
                )

              {:noreply, %{state | pointers: Map.put(state.pointers, agent_id, new_pointer)}}
            end
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

  # Snapshot sanitizer (ADR-0014 F1 追補, resume-privilege-restoration 藤 D2).
  # Keeps only the known 7 ResolvedSnapshotExt fields whose values pass their
  # closed-enum / boolean / non-empty-string guard. Unknown or malformed
  # entries are dropped with a warn so `record_snapshot`'s downstream
  # relay (`build_restore_payload` / `switch_payload` / reset broadcast)
  # cannot leak an invalid enum onto the wire. Non-map input returns nil,
  # letting the caller no-op instead of persisting garbage.
  #
  # Key normalization (phase-22 藤 R1): output uses the CANONICAL string
  # key (wire form). Input may arrive atom-keyed (unit tests) or string-
  # keyed (JSON envelope ingest); the sanitizer walks the known fields
  # in a fixed order and, for each field, prefers the string-keyed value
  # (canonical) over the atom-keyed value (test convenience). If BOTH
  # keys exist and their values differ, the string key wins and a warn
  # names the conflict. This closes the "Phoenix JSON relay collapses
  # atom+string into one key with an indeterminate winner" hole 藤 flagged.
  # (Priority is string-first regardless of validity: an invalid string
  # value drops the field even when an atom-keyed value would have passed
  # — test-pinned to keep behavior deterministic.)
  @snapshot_known_fields ~w(model model_source effort effort_source
                            permission_mode sandbox network_access)a
  @snapshot_sandbox_values ~w(read-only workspace-write danger-full-access)
  @snapshot_permission_mode_values ~w(default acceptEdits bypassPermissions
                                       plan dontAsk auto)
  @snapshot_model_source_values ~w(launch env config default)

  defp sanitize_snapshot(snapshot) when is_map(snapshot) do
    {out, seen_keys} =
      Enum.reduce(
        @snapshot_known_fields,
        {%{}, MapSet.new()},
        &normalize_snapshot_field(&1, snapshot, &2)
      )

    # Warn once per remaining unknown / unrecognized key. Iterating the
    # input map here (not inside the field loop) so a duplicate atom /
    # string pair for a known field counts as ONE known field, not two
    # unknowns.
    for {k, _v} <- snapshot, not MapSet.member?(seen_keys, k) do
      Logger.warning("SessionPointers: dropped unknown snapshot field #{inspect(k)}")
    end

    out
  end

  defp sanitize_snapshot(_), do: nil

  defp normalize_snapshot_field(field, snapshot, {acc, seen}) do
    string_key = Atom.to_string(field)
    string_present = Map.has_key?(snapshot, string_key)
    atom_present = Map.has_key?(snapshot, field)

    cond do
      string_present and atom_present ->
        string_value = Map.get(snapshot, string_key)
        atom_value = Map.get(snapshot, field)

        if string_value != atom_value do
          Logger.warning(
            "SessionPointers: duplicate snapshot field " <>
              "#{inspect(string_key)} with divergent values: " <>
              "string=#{inspect(string_value)} vs atom=#{inspect(atom_value)}; " <>
              "keeping string (wire canonical)"
          )
        end

        acc = put_valid_snapshot_field(acc, field, string_key, string_value)
        {acc, seen |> MapSet.put(string_key) |> MapSet.put(field)}

      string_present ->
        value = Map.get(snapshot, string_key)
        acc = put_valid_snapshot_field(acc, field, string_key, value)
        {acc, MapSet.put(seen, string_key)}

      atom_present ->
        value = Map.get(snapshot, field)
        acc = put_valid_snapshot_field(acc, field, string_key, value)
        {acc, MapSet.put(seen, field)}

      true ->
        {acc, seen}
    end
  end

  defp put_valid_snapshot_field(acc, field, string_key, value) do
    if snapshot_field_valid?(field, value) do
      Map.put(acc, string_key, value)
    else
      Logger.warning(
        "SessionPointers: dropped invalid snapshot field " <>
          "#{inspect(string_key)}=#{inspect(value)}"
      )

      acc
    end
  end

  defp snapshot_field_valid?(:sandbox, value),
    do: is_binary(value) and value in @snapshot_sandbox_values

  defp snapshot_field_valid?(:permission_mode, value),
    do: is_binary(value) and value in @snapshot_permission_mode_values

  defp snapshot_field_valid?(:model_source, value),
    do: is_binary(value) and value in @snapshot_model_source_values

  defp snapshot_field_valid?(:effort_source, value),
    do: is_binary(value) and value in @snapshot_model_source_values

  defp snapshot_field_valid?(:network_access, value), do: is_boolean(value)

  defp snapshot_field_valid?(:model, value),
    do: is_binary(value) and value != ""

  defp snapshot_field_valid?(:effort, value),
    do: is_binary(value) and value != ""
end
