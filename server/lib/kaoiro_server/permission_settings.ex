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

  One DETS table, two key namespaces so a single physical file can hold
  both a deletable and a permanent concern (`KAOIRO_PERMISSION_SETTINGS_PATH`):

  - `{:settings, agent_id}` — the current `%{engine, control, next,
    prior_next}` record. Removed by `delete/2` (agent deletion, ADR-0030 D6).
  - `{:counter, agent_id}` — the agent's revision high-water mark.
    **Never removed by `delete/2`.** protocol.md: "Delete removes
    per-agent PermissionSettings (not the revision allocator or audit
    history)" — a revision number must never be reused, including after
    a deleted agent's agent_id is somehow reused, so the allocator
    outlives the settings it once produced.

  `control` describes the latest accepted request and its progress —
  shaped like `PermissionControlExt` (revision/requested/status/
  submitted/effective/last_effective/reason/rolled_back_to/constraints)
  plus `actor`/`at` for audit. `constraints` is fixed per engine and
  never changes across an agent's requests, but it is only ever LEARNED
  from a wrapper report (there is no server-side engine→constraints
  table to fall back on), so it is carried forward from the prior
  control on every operator-driven `submit_request/5` rather than
  recomputed. `next` is what the wrapper should apply at
  its *next* execution — normally identical to `control`'s revision/
  requested pair, except when the latest request's own outcome settles
  to a **pre-application** rejection (no `submitted` ever recorded for
  it): protocol.md requires `next` to fall back to the last selection
  that was still viable, not replay the rejected pair. `prior_next`
  holds that fallback (the `next` value in effect immediately before the
  current `control.revision` was accepted) so `record_observation/4` can
  restore it without a second lookup.

  A `record_observation/4` report is authoritative only for the
  `revision` it names. A report for an older, already-superseded
  revision (protocol.md's "revision B arrives while A runs") can still
  update `control.last_effective` as historical evidence when it
  confirms an applied policy, but never touches the current `control`/
  `next` — those are owned by the latest accepted revision until IT
  settles. A stale failure report is dropped (logged): a superseded
  revision's rejection is not actionable at the top.
  """

  use GenServer

  require Logger

  @max_safe_integer 9_007_199_254_740_991
  @sandbox_values ~w(read-only workspace-write danger-full-access)
  @approval_values ~w(untrusted on-request on-failure never)
  @enforcement_values ~w(os mode advisory)

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

  @doc """
  Projects a stored entry into the `{control, next}` pair a `permission_sync`
  join push sends (protocol.md, "Persistence, join synchronization, and
  resume"). `nil` in, `{nil, nil}` out.

  Applied ONLY at join time, unconditionally (not gated on "did the
  server actually restart" — that distinction is not reliably observable
  from a loaded entry, and the same caution applies to a same-process
  rejoin, protocol.md: "A same-process rejoin must not turn a cached
  observation into a fresh application"). `applying` / `applied` /
  `unknown` all round to `pending`: a join is a readiness barrier, not a
  fresh reconfirmation of a previous connection's observation. Presenting
  a stale `applied` as still current would also make a wrapper's own
  audit dedupe (keyed off a fresh `applied` transition) re-fire for a
  status it never freshly re-observed on THIS connection. `submitted`/`effective`
  are dropped on rounding — presenting them next to a rounded-down
  `pending` status would contradict it — but `last_effective` always
  survives the rounding (seeded from `effective` when the stored status
  was `applied`) so historical evidence is never lost. `failed` is
  never rounded: its `reason`/`rolled_back_to` are exactly what the
  operator needs to see, unchanged, on every rejoin.
  """
  def sync_view(nil), do: {nil, nil}

  def sync_view(%{control: control, next: next}) do
    if control.status in [:applying, :applied, :unknown] do
      {%{control | status: :pending, submitted: nil, effective: nil}, next}
    else
      {control, next}
    end
  end

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
  `merge_observation/4`'s own "a revision the server never allocated"
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
  # trustworthy counter to preserve anyway.
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
          {Map.put(settings, agent_id, entry), counters}

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
        do_submit_request(agent_id, engine, patch, actor, at, entry, state)
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
    {:reply, revision <= ceiling, state}
  end

  @impl true
  def handle_cast({:record_observation, agent_id, engine, permission_control}, state) do
    case sanitize_control(permission_control) do
      nil ->
        Logger.warning(
          "permission_control ingest rejected (agent_id=#{agent_id}, malformed shape)"
        )

        {:noreply, state}

      sanitized ->
        {:noreply, apply_observation(agent_id, engine, sanitized, state)}
    end
  end

  # ---- submit_request ------------------------------------------------

  defp do_submit_request(agent_id, engine, patch, actor, at, entry, state) do
    counter = Map.get(state.counters, agent_id, 0)

    if counter >= @max_safe_integer do
      {:reply, {:error, :revision_exhausted}, state}
    else
      new_revision = counter + 1
      requested = Map.merge(entry.next.requested, patch)

      new_entry = %{
        entry
        | engine: engine,
          control: %{
            revision: new_revision,
            requested: requested,
            status: :pending,
            submitted: nil,
            effective: nil,
            last_effective: entry.control.last_effective,
            reason: nil,
            rolled_back_to: nil,
            actor: actor,
            at: at,
            # Fixed per engine (protocol.md), not per-request: carried
            # forward unchanged from the prior control. seed_baseline/4
            # is the only place a fresh value ever enters.
            constraints: entry.control.constraints
          },
          next: %{revision: new_revision, requested: requested},
          prior_next: entry.next
      }

      persist_submit(agent_id, new_revision, new_entry, state)
    end
  end

  # Counter write first, settings write second (moduledoc): a raise on
  # the settings write after the counter already landed durably burns a
  # revision number rather than risking its reuse. Either raise is
  # caught here — DETS operations on a closed/unusable table raise
  # ArgumentError, they do not return an {:error, _} tuple (measured
  # against this OTP's :dets, 2026-09-06) — so a naive `:ok = insert`
  # would crash this GenServer instead of answering `persistence_failed`.
  defp persist_submit(agent_id, new_revision, new_entry, state) do
    try do
      :ok = :dets.insert(state.table, {{:counter, agent_id}, new_revision})
      counters = Map.put(state.counters, agent_id, new_revision)

      :ok = :dets.insert(state.table, {{:settings, agent_id}, new_entry})
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

  defp apply_observation(agent_id, engine, sanitized, state) do
    case Map.get(state.settings, agent_id) do
      nil ->
        seed_baseline(agent_id, engine, sanitized, state)

      %{engine: stored_engine} when stored_engine != engine ->
        # protocol.md: "an engine change must not replay another engine's
        # settings" — reset control/next, keep the counter (moduledoc).
        seed_baseline(agent_id, engine, sanitized, state)

      entry ->
        merge_observation(agent_id, entry, sanitized, state)
    end
  end

  defp seed_baseline(agent_id, engine, sanitized, state) do
    entry = %{
      engine: engine,
      control: %{
        revision: sanitized.revision,
        requested: sanitized.requested,
        status: sanitized.status,
        submitted: sanitized.submitted,
        effective: sanitized.effective,
        last_effective: sanitized.effective || sanitized.last_effective,
        reason: sanitized.reason,
        rolled_back_to: sanitized.rolled_back_to,
        actor: nil,
        at: nil,
        constraints: sanitized.constraints
      },
      next: %{revision: sanitized.revision, requested: sanitized.requested},
      prior_next: nil
    }

    write_settings(agent_id, entry, state)
  end

  defp merge_observation(agent_id, entry, sanitized, state) do
    cond do
      sanitized.revision == entry.control.revision ->
        merge_current_revision(agent_id, entry, sanitized, state)

      sanitized.revision < entry.control.revision ->
        merge_stale_revision(agent_id, entry, sanitized, state)

      true ->
        # A revision the server never allocated for this agent. Never
        # trust a wrapper-reported value past the server's own ledger
        # (protocol.md: "The server owns revision allocation").
        Logger.warning(
          "permission_control ingest dropped (agent_id=#{agent_id}, " <>
            "unknown revision #{sanitized.revision} > known #{entry.control.revision})"
        )

        state
    end
  end

  defp merge_current_revision(agent_id, entry, sanitized, state) do
    control = %{
      entry.control
      | status: sanitized.status,
        submitted: sanitized.submitted || entry.control.submitted,
        effective: sanitized.effective,
        last_effective: sanitized.effective || entry.control.last_effective,
        reason: sanitized.reason,
        rolled_back_to: sanitized.rolled_back_to
    }

    pre_application_rejection? = control.status == :failed and control.submitted == nil

    next = if pre_application_rejection?, do: entry.prior_next || entry.next, else: entry.next

    write_settings(agent_id, %{entry | control: control, next: next}, state)
  end

  # A delayed observation for an already-superseded revision may still
  # be real evidence (protocol.md: "A delayed observation for a finished
  # execution may update historical evidence, never the current
  # execution's badge") — but only when it actually confirms an applied
  # policy. A stale failure has no current-state effect.
  defp merge_stale_revision(agent_id, entry, sanitized, state) do
    if sanitized.status == :applied and sanitized.effective do
      control = %{entry.control | last_effective: sanitized.effective}
      write_settings(agent_id, %{entry | control: control}, state)
    else
      state
    end
  end

  defp write_settings(agent_id, entry, state) do
    :ok = :dets.insert(state.table, {{:settings, agent_id}, entry})
    %{state | settings: Map.put(state.settings, agent_id, entry)}
  end

  # ---- wire shape validation ------------------------------------------

  # Defensive, fail-soft sanitizer for the wrapper-reported
  # `ext.permission_control` map (string keys, as received off the
  # wire). Mirrors SessionPointers.sanitize_snapshot's stance: unknown or
  # malformed input is dropped, never trusted past a shape+enum check.
  # Nested submission/observation maps are kept opaque (not re-typed
  # field by field) — they are relayed back out verbatim to clients and
  # audit, and over-narrowing them here would silently drop legitimate
  # engine-observed fields (session_id, turn_id, execution_id, ...).
  defp sanitize_control(
         %{
           "revision" => revision,
           "requested" => %{"sandbox" => sandbox, "network_access" => network_access},
           "status" => status,
           "constraints" => %{"approval" => approval, "enforcement" => enforcement}
         } = raw
       )
       when is_integer(revision) and revision >= 0 and
              sandbox in @sandbox_values and is_boolean(network_access) and
              approval in @approval_values and enforcement in @enforcement_values do
    with {:ok, status_atom} <- sanitize_status(status) do
      %{
        revision: revision,
        requested: %{sandbox: sandbox, network_access: network_access},
        status: status_atom,
        constraints: %{approval: approval, enforcement: enforcement},
        submitted: Map.get(raw, "submitted"),
        effective: Map.get(raw, "effective"),
        last_effective: Map.get(raw, "last_effective"),
        reason: sanitize_string(Map.get(raw, "reason")),
        rolled_back_to: sanitize_rolled_back_to(Map.get(raw, "rolled_back_to"))
      }
    else
      _ -> nil
    end
  end

  defp sanitize_control(_other), do: nil

  @control_statuses ~w(pending applying applied failed unknown)
  defp sanitize_status(status) when status in @control_statuses,
    do: {:ok, String.to_existing_atom(status)}

  defp sanitize_status(_other), do: :error

  defp sanitize_string(value) when is_binary(value), do: value
  defp sanitize_string(_other), do: nil

  defp sanitize_rolled_back_to(%{"sandbox" => sandbox, "network_access" => network_access})
       when sandbox in @sandbox_values and is_boolean(network_access) do
    %{sandbox: sandbox, network_access: network_access}
  end

  defp sanitize_rolled_back_to(_other), do: nil

  @impl true
  def terminate(_reason, state) do
    :dets.close(state.table)
  end

  defp default_path do
    Application.get_env(:kaoiro_server, :permission_settings_path) ||
      KaoiroServer.DetsStorePath.default_path("permission_settings.dets")
  end
end
