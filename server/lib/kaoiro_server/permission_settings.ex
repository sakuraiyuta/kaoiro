defmodule KaoiroServer.PermissionSettings do
  @moduledoc """
  Restart-surviving per-agent Codex sandbox/network_access request state
  (issue #305, ADR-0033 F3/F4). Mirrors the `SessionPointers` /
  `PermissionModes` shape (DETS-backed, in-memory mirror), but unlike
  those fire-and-forget stores, `submit_request/5` is a **synchronous**
  operation: `set_permission` must persist the accepted request and
  return its assigned revision to the caller before the server relays to
  the wrapper and acknowledges the client (docs/specs/protocol.md,
  "Permission changes at an execution boundary").

  This module is deliberately a thin I/O shell (director round-2
  correction, 2026-09-06: "pure State module, GenServer does only
  input/output"): it owns the GenServer callbacks, the DETS table, and
  deciding WHEN to persist — every decision about WHAT the new state
  should be (`submit`/`observe` transitions, ledger pruning, wire
  projection, wire-shape validation) lives in the pure
  `KaoiroServer.PermissionSettings.State` module. See that module's
  moduledoc for the entry shape (`%{engine, control, next, ledger}`) and
  its own docs for the M1/M2/M3 transition rules.

  One DETS table, two key namespaces so a single physical file can hold
  both a deletable and a permanent concern (`KAOIRO_PERMISSION_SETTINGS_PATH`):

  - `{:settings, agent_id}` — the current entry. Removed by `delete/2`
    (agent deletion, ADR-0030 D6).
  - `{:counter, agent_id}` — the agent's revision high-water mark.
    **Never removed by `delete/2`.** protocol.md: "Delete removes
    per-agent PermissionSettings (not the revision allocator or audit
    history)" — a revision number must never be reused, including after
    a deleted agent's agent_id is somehow reused, so the allocator
    outlives the settings it once produced.
  """

  use GenServer

  require Logger

  alias KaoiroServer.PermissionSettings.State

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
  Merges `patch` (`%{sandbox: ...}`, `%{network_access: ...}`, or both)
  into the agent's latest next-execution raw pair, allocates the next
  revision, and persists both in one serialized GenServer call before
  returning — the caller relays/acks only after this returns `:ok`.

  `patch` must already be validated by the caller (closed sandbox enum,
  strict boolean network_access, at least one key) — this function
  trusts its shape. Returns:

  - `{:ok, revision, requested}` — persisted; `requested` is the full
    merged pair (both axes), not just the patched one(s).
  - `{:error, :permission_not_ready}` — no baseline recorded yet for
    this agent (the wrapper has not reported its initial
    `ext.permission_control`); nothing to merge the patch onto.
  - `{:error, :revision_exhausted}` — the agent's counter is already at
    the safe-integer ceiling.
  - `{:error, :persistence_failed}` — the DETS write raised; no
    in-memory state past the counter (if it already advanced,
    see moduledoc) is changed, so the caller must not relay/ack.
  """
  def submit_request(agent_id, engine, patch, actor, at, server \\ __MODULE__)
      when is_binary(agent_id) and is_binary(engine) and is_map(patch) and
             is_map(actor) and is_binary(at) do
    GenServer.call(server, {:submit_request, agent_id, engine, patch, actor, at})
  end

  @doc """
  Field-level, revision-checked ingestion of a wrapper-reported
  `ext.permission_control` map (string-keyed, as received off the wire).
  Fire-and-forget (matches `record_snapshot_from_ext`'s call shape) —
  malformed shapes and stale/newer-than-known revisions are dropped
  (logged), never raised, and always return `:ok`.

  When no settings exist yet for `agent_id` (or the stored `engine`
  differs from this report's), this call *seeds* a fresh baseline from
  the report rather than rejecting it — this is how the wrapper's
  post-join initial `ext.permission_control` (protocol.md's revision-0
  baseline) enters the store. Seeding never touches the counter.
  """
  def record_observation(agent_id, engine, permission_control, server \\ __MODULE__)
      when is_binary(agent_id) and is_binary(engine) do
    GenServer.cast(server, {:record_observation, agent_id, engine, permission_control})
    :ok
  end

  @doc "The agent's current `%{engine, control, next}` record, or `nil`."
  def get(agent_id, server \\ __MODULE__) when is_binary(agent_id) do
    GenServer.call(server, {:get, agent_id})
  end

  @doc "See `KaoiroServer.PermissionSettings.State.sync_view/1`."
  defdelegate sync_view(entry), to: State

  @doc "See `KaoiroServer.PermissionSettings.State.control_wire/1`."
  defdelegate control_wire(control), to: State

  @doc """
  Removes the agent's settings (not its revision counter — see
  moduledoc). Idempotent — an unknown agent returns `:ok`.
  """
  def delete(agent_id, server \\ __MODULE__) when is_binary(agent_id) do
    GenServer.call(server, {:delete, agent_id})
  end

  @doc """
  `true` when `revision` is within the agent's allocated range: 0 (the
  launch baseline, always legitimate even before any operator request)
  or at most the agent's current counter high-water mark. Mirrors
  `State.observe/4`'s own "a revision the server never allocated"
  rejection (issue #305 S1) so a wrapper-reported
  `permission_applied`/`permission_failed` AUDIT event is held to the
  same provenance rule `record_observation/4` already applies to live
  STATE — `wrapper_channel.ex` calls this before
  `SessionLifecycleEvents.record_permission_event/5` so a forged
  revision is rejected before it ever reaches the audit trail, not only
  kept out of `control`/`next`.

  Uses the COUNTER (survives `delete/2` and an engine-mismatch reset,
  moduledoc), not the current `control.revision` — the latter can be
  LOWER right after an engine change, and a residual report from the
  previous engine context that the counter genuinely once allocated
  should not be misclassified as forged.
  """
  def known_revision?(agent_id, revision, server \\ __MODULE__)
      when is_binary(agent_id) and is_integer(revision) and revision >= 0 do
    GenServer.call(server, {:known_revision?, agent_id, revision})
  end

  @impl true
  def init({name, path}) do
    KaoiroServer.DetsStorePath.prepare_parent!(path)
    table = open_table(name, path)
    _ = File.chmod(path, 0o600)
    {settings, counters} = load(table)
    {:ok, %{table: table, settings: settings, counters: counters}}
  end

  # A corrupt/unreadable DETS file must not crash-loop the supervisor —
  # same recovery as PermissionModes/SessionPointers: drop and recreate
  # empty. Losing settings here costs at most one re-selection; losing
  # the counter risks a revision reuse, but a corrupt file has no
  # trustworthy counter to preserve anyway. One further cost specific to
  # this store (クロエ round 2): resetting the counter to 0 also makes
  # `known_revision?/3` reject wrapper-reported audit events for every
  # revision this agent legitimately held before the corruption, until a
  # fresh `submit_request/6` re-advances the counter past them — a
  # fail-closed audit gap, not a fail-open one, and the intended
  # trade-off given the counter cannot be trusted to be correct either.
  defp open_table(name, path) do
    case :dets.open_file(name, file: String.to_charlist(path)) do
      {:ok, ^name} ->
        name

      {:error, reason} ->
        Logger.warning("permission settings store unreadable (#{inspect(reason)}); recreating")

        File.rm(path)
        {:ok, ^name} = :dets.open_file(name, file: String.to_charlist(path))
        name
    end
  end

  defp load(table) do
    :dets.foldl(
      fn
        {{:settings, agent_id}, entry}, {settings, counters} ->
          {Map.put(settings, agent_id, State.sanitize_loaded_entry(entry)), counters}

        {{:counter, agent_id}, revision}, {settings, counters} ->
          {settings, Map.put(counters, agent_id, revision)}

        _other, acc ->
          acc
      end,
      {%{}, %{}},
      table
    )
  end

  @impl true
  def handle_call({:submit_request, agent_id, engine, patch, actor, at}, _from, state) do
    case Map.get(state.settings, agent_id) do
      nil ->
        {:reply, {:error, :permission_not_ready}, state}

      entry ->
        counter = Map.get(state.counters, agent_id, 0)

        case State.submit(entry, counter, engine, patch, actor, at) do
          {:ok, new_revision, new_entry} ->
            persist_submit(agent_id, new_revision, new_entry, state)

          {:error, :revision_exhausted} ->
            {:reply, {:error, :revision_exhausted}, state}
        end
    end
  end

  def handle_call({:get, agent_id}, _from, state) do
    {:reply, Map.get(state.settings, agent_id), state}
  end

  def handle_call({:delete, agent_id}, _from, state) do
    :ok = :dets.delete(state.table, {:settings, agent_id})
    {:reply, :ok, %{state | settings: Map.delete(state.settings, agent_id)}}
  end

  def handle_call({:known_revision?, agent_id, revision}, _from, state) do
    ceiling = Map.get(state.counters, agent_id, 0)
    {:reply, State.known_revision?(ceiling, revision), state}
  end

  @impl true
  def handle_cast({:record_observation, agent_id, engine, permission_control}, state) do
    case State.sanitize_control(permission_control) do
      nil ->
        Logger.warning(
          "permission_control ingest rejected (agent_id=#{agent_id}, malformed shape)"
        )

        {:noreply, state}

      sanitized ->
        entry = Map.get(state.settings, agent_id)
        counter = Map.get(state.counters, agent_id, 0)
        {:noreply, apply_observation(agent_id, entry, engine, sanitized, counter, state)}
    end
  end

  # ---- submit_request ------------------------------------------------

  # Counter write first, settings write second (moduledoc): a raise on
  # the settings write after the counter already landed durably burns a
  # revision number rather than risking its reuse. Either raise is
  # caught here — DETS operations on a closed/unusable table raise
  # ArgumentError, they do not return an {:error, _} tuple (measured
  # against this OTP's :dets, 2026-09-06) — so a naive `:ok = insert`
  # would crash this GenServer instead of answering `persistence_failed`.
  defp persist_submit(agent_id, new_revision, new_entry, state) do
    try do
      # issue #305 M2 (ふじ round 1, real SIGKILL probe
      # /tmp/fuji305b-r1-evidence/fuji305b-r1-durability.log): a bare
      # `:dets.insert` only writes DETS's own buffer, which the OS
      # process can lose entirely on a crash before the next periodic
      # `:auto_save` (default 3 minutes) — so `submit_request/6` could
      # reply `:ok` (telling the caller to relay/ack) for a revision that
      # a crash moments later erases. `:dets.sync/1` after EACH insert
      # forces it to durable storage before this function ever replies,
      # matching this store's own "the caller relays/acks only after
      # this returns :ok" contract (module doc). Synced right after its
      # own insert (not once at the end) for the same reason the counter
      # is written before settings at all: a raise/crash between the two
      # inserts must still leave the counter durably advanced.
      :ok = :dets.insert(state.table, {{:counter, agent_id}, new_revision})
      :ok = :dets.sync(state.table)
      counters = Map.put(state.counters, agent_id, new_revision)

      :ok = :dets.insert(state.table, {{:settings, agent_id}, new_entry})
      :ok = :dets.sync(state.table)
      settings = Map.put(state.settings, agent_id, new_entry)

      {:reply, {:ok, new_revision, new_entry.next.requested},
       %{
         state
         | settings: settings,
           counters: counters
       }}
    rescue
      _error ->
        # The counter row may have been durably written before the raise
        # (settings insert failing after a successful counter insert).
        # Advance the in-memory counter to match whatever DETS now holds
        # so a later successful call can never allocate this number
        # again; the in-memory `settings` map is left untouched so the
        # caller-visible `next` does not move on a failed request.
        counters = Map.put(state.counters, agent_id, new_revision)
        {:reply, {:error, :persistence_failed}, %{state | counters: counters}}
    end
  end

  # ---- record_observation --------------------------------------------

  defp apply_observation(agent_id, entry, engine, sanitized, counter, state) do
    case State.observe(entry, engine, sanitized, counter) do
      {:ok, new_entry} ->
        write_settings(agent_id, new_entry, state)

      {:reject, :unallocated_seed, revision, known_counter} ->
        Logger.warning(
          "permission_control seed dropped (agent_id=#{agent_id}, " <>
            "unallocated baseline revision #{revision} > known #{known_counter})"
        )

        state

      {:reject, :unknown_revision, revision, known_revision} ->
        # A revision the server never allocated for this agent. Never
        # trust a wrapper-reported value past the server's own ledger
        # (protocol.md: "The server owns revision allocation").
        Logger.warning(
          "permission_control ingest dropped (agent_id=#{agent_id}, " <>
            "unknown revision #{revision} > known #{known_revision})"
        )

        state

      :no_change ->
        state
    end
  end

  defp write_settings(agent_id, entry, state) do
    :ok = :dets.insert(state.table, {{:settings, agent_id}, entry})
    %{state | settings: Map.put(state.settings, agent_id, entry)}
  end

  @impl true
  def terminate(_reason, state) do
    :dets.close(state.table)
  end

  defp default_path do
    Application.get_env(:kaoiro_server, :permission_settings_path) ||
      KaoiroServer.DetsStorePath.default_path("permission_settings.dets")
  end
end
