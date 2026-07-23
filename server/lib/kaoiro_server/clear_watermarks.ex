defmodule KaoiroServer.ClearWatermarks do
  @moduledoc """
  Restart-surviving per-agent **IA visibility watermark** (issue #109).
  `clear_history` alone records this cutoff by adopting the independently
  persisted `SessionStarts` record; session transitions never alter it. On
  subsequent history-merge paths, IA envelopes whose server-side
  order is `<= boundary_order` are hidden from `agent_id`'s
  transcript pane. Peer agents' panes are unaffected — their own
  boundary controls what they see — and the shared `InterAgentHistory`
  DETS ledger itself is untouched.

  `advance_transition/*` and sid adoption remain private legacy helpers for
  loading existing 5/4/3/2-field DETS rows; production transition callers
  use `SessionStarts` instead.

  **Ordering domain** (ふじ #109 M6 must-fix, 2026-07-23 + R5 must-fix
  same date): the order tuple is allocated by `KaoiroServer.IngressOrder`,
  the single serialized allocator both this store and
  `InterAgentHistory.append/2` share. The tuple shape is `{us, seq}`
  where `us` is a wall-clock-rollback-clamped microsecond reading and
  `seq` is a persistent counter that bumps within the same `us` —
  strict monotonic across the fleet's whole `us` range AND across VM
  restarts (the pre-R5 inline
  `{System.system_time(:microsecond), System.unique_integer([:positive,
  :monotonic])}` pair reset its `unique_integer` half on every BEAM
  start and had no restart-safe monotonic guarantee). Neither wire ISO
  timestamps nor wrapper producer clocks feed the compare, so
  host-clock skew between a session transition and a wrapper's IA
  emit can no longer misclassify a message as "before" or "after"
  the boundary.

  **Legacy ISO-mode fallback** (ふじ R2 must-fix, 2026-07-23): a DETS
  record laid down before M6 has no tuple, only a display ISO. Loading
  it as `{{0, 0}, iso}` would render the watermark inert — every real
  ingress order dominates `{0, 0}`, so a redeploy would re-expose every
  IA that a pre-M6 clear had hidden. Instead legacy records load as
  `{:iso_only, iso}` and the filter path (`all_filter_bounds/1`) tags
  them so callers compare each envelope's wire `ts` against `iso`,
  preserving the exact pre-M6 visibility until the next real clear
  promotes the entry to a real order tuple.

  Storage: DETS with in-memory mirror. Writes are **synchronous +
  fsync-gated** (`GenServer.call` + `:dets.sync/1` before reply), so
  `history_cleared` never fires ahead of disk persistence and a crash inside
  the persist window cannot silently drop the cutoff (M7-a must-fix,
  same policy `KaoiroServer.TokenDenylist` adopted for #72 revocation).

  Record shape: `agent_id => {order_tuple, display_iso, transition_sid | nil,
  pending_from_sid | nil}` for post-R1 records. `pending_from_sid` is set
  only for a Trigger 1 Codex lazy transition (`sid=nil`) and durably binds
  that pending boundary to the old pointer sid; it distinguishes a genuine
  pending reset from legacy pre-M3 nil-sid records after a crash/restart.
  Pre-R1 post-M3 records load with `pending_from_sid = nil`
  (ふじ 検収 2 fix-round must-fix M3, 2026-07-23),
  or `agent_id => {:iso_only, display_iso}` for legacy pre-M6 records
  loaded from DETS (ふじ R2 must-fix). The `transition_sid` is the
  target `session_id` of the transition that seeded this boundary —
  the transition-identity token that makes retries idempotent. Codex
  lazy 采番 stores nil transiently until `adopt_sid/2` patches it on
  the first envelope carrying a real sid. Pre-M3 records loaded from
  DETS get `sid = nil` and are patched by whichever transition first
  observes a durable session_id for that agent.

  Accessor invariant: `get_order/2` returns the tuple only for tuple
  records (nil for `:iso_only`); the filter hot-path uses
  `all_filter_bounds/1` which tags both shapes. `get_display/2`
  returns the ISO in both shapes. `get/2` hides the internal pending
  identity and returns the stable shape
  (`{tuple, iso, sid} | {:iso_only, iso} | nil`) — kept
  server-internal (the wire never sees this shape; the operator client
  only ever receives `clear_watermarks: %{agent_id => iso}` via
  `all_displays/1`).
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
  Records `order` (an `InterAgentHistory`-domain tuple) as the agent's
  boundary, alongside `display_ts` (ISO-8601 UTC) for the audit trail.
  Sid defaults to nil (legacy tests + non-transition callers); genuine
  session-transition callers should use `advance_transition/3`
  instead, which atomically allocates the order AND records the sid
  for retry idempotence.

  **Synchronous + fsync-gated** so any follow-up broadcast is safe
  against an in-flight crash (M7-a must-fix). Monotonically advances:
  a call with an `order` at or below the current entry is a no-op.
  """
  def record(agent_id, {us, seq} = order, display_ts, server \\ __MODULE__)
      when is_integer(us) and is_integer(seq) and is_binary(display_ts) do
    GenServer.call(server, {:record, agent_id, order, display_ts, nil})
  end

  @doc """
  **Deprecated compatibility API.** Production session transitions use
  `SessionStarts`; this remains only to read and exercise historical DETS
  record shapes during the migration.

  Atomically advances A's boundary for a genuine session transition
  identified by `sid_opt` (Codex lazy passes `nil`; Trigger 2 external
  switch passes the new sid; Trigger 1 SessionResets confirm_connection
  passes `joined_session_id` or `lock.to_session_id`). ふじ 検収 2
  fix-round must-fix M3 (2026-07-23): the sid is the transition
  identity, so a retry of the same transition (crash / duplicate) is a
  no-op and returns the existing record unchanged — the pre-M3 code
  monotonically-advanced but was NOT idempotent, so a re-report of the
  same transition after a crash between advance and pointer update
  double-advanced the boundary.

  Returns `{:ok, {order, display, sid_opt}}` (new or existing record).
  Fsync-gated. Called inside the boundary GenServer so allocation +
  record are a single serialized decision.
  """
  def advance_transition(agent_id, sid_opt, server \\ __MODULE__)
      when is_binary(agent_id) and (is_nil(sid_opt) or is_binary(sid_opt)) do
    GenServer.call(server, {:advance_transition, agent_id, sid_opt, nil})
  end

  @doc """
  Trigger 1 variant for a Codex lazy transition. `previous_sid` is persisted
  only while `sid_opt` is nil, so a restart with the old SessionPointers sid
  can adopt the first real sid without allocating a second boundary (R1).
  """
  def advance_transition(agent_id, sid_opt, previous_sid, server)
      when is_binary(agent_id) and (is_nil(sid_opt) or is_binary(sid_opt)) and
             (is_nil(previous_sid) or is_binary(previous_sid)) do
    GenServer.call(server, {:advance_transition, agent_id, sid_opt, previous_sid})
  end

  @doc """
  **Deprecated compatibility API.** Codex lazy sid adopt (ふじ 検収 2 fix-round M3, 2026-07-23): patches
  an existing tuple record whose `sid` is nil so it now carries the
  real `sid`. No-op if the record is missing, already has a sid, or
  is `:iso_only`. Does NOT allocate a new order — the boundary itself
  is unchanged; only its transition identity token is filled in so a
  future retry of the same transition matches idempotently.
  """
  def adopt_sid(agent_id, sid, server \\ __MODULE__)
      when is_binary(agent_id) and is_binary(sid) do
    GenServer.call(server, {:adopt_sid, agent_id, sid})
  end

  @doc """
  **Deprecated compatibility API.** Atomically adopts a lazy Trigger 1 sid only when the persisted pending
  transition was created from `previous_sid`. Legacy nil-sid records have no
  pending identity and return `:noop`, allowing Trigger 2 to advance as a
  genuine external switch instead (R1).
  """
  def adopt_pending_sid(agent_id, sid, previous_sid, server \\ __MODULE__)
      when is_binary(agent_id) and is_binary(sid) and is_binary(previous_sid) do
    GenServer.call(server, {:adopt_pending_sid, agent_id, sid, previous_sid})
  end

  @doc """
  Stable record view: `{{us, seq}, display_iso, sid | nil}` for tuple
  records, `{:iso_only, display_iso}` for pre-M6 legacy, `nil` when
  unknown. The R1-only pending transition identity remains private to
  the store. Production callers use the accessors below.
  """
  def get(agent_id, server \\ __MODULE__) do
    GenServer.call(server, {:get, agent_id})
  end

  @doc """
  Latest tuple order for the agent, or nil for legacy ISO-only entries
  (they have no comparable tuple — filter callers that need the ISO
  fallback too must use `all_filter_bounds/1`, which returns the
  tagged shape for both post-M6 tuple records and pre-M6 ISO records).
  Nil when unknown.
  """
  def get_order(agent_id, server \\ __MODULE__) do
    case get(agent_id, server) do
      {{_us, _seq} = order, _display, _sid} -> order
      _ -> nil
    end
  end

  @doc "Latest display ISO ts for the agent, or nil (broadcast helper)."
  def get_display(agent_id, server \\ __MODULE__) do
    case get(agent_id, server) do
      {{_us, _seq}, display, _sid} -> display
      {:iso_only, display} -> display
      _ -> nil
    end
  end

  @doc """
  Transition identity sid for the agent's current boundary, or nil
  when unknown / iso_only / not yet adopted (Codex lazy). Used by
  transition-idempotence checks (ふじ 検収 2 fix-round M3).
  """
  def get_sid(agent_id, server \\ __MODULE__) do
    case get(agent_id, server) do
      {{_us, _seq}, _display, sid} -> sid
      _ -> nil
    end
  end

  @doc """
  agent_id => order_tuple for every known clear. Legacy ISO-only entries
  are OMITTED — they have no tuple to compare against. Callers on the
  filter hot-path (agents_channel `merged_histories/*`) should use
  `all_filter_bounds/1` instead so they also see the ISO-mode fallback.
  Kept as a helper for tests and callers that specifically care about
  tuple-domain entries.
  """
  def all_orders(server \\ __MODULE__) do
    GenServer.call(server, :all_orders)
  end

  @doc """
  Compatibility accessor for callers that need the display ISO.
  """
  def display_for_broadcast(agent_id, server \\ __MODULE__) do
    get_display(agent_id, server)
  end

  @doc """
  agent_id => tagged filter bound for every known clear:
  `{:order, {us, seq}}` for tuple entries, `{:iso, display_iso}` for
  legacy pre-M6 entries. Consumers must handle both — the `:order` case
  compares against the envelope's server ingress order tuple, the `:iso`
  case falls back to comparing the envelope's wire `ts` string against
  `display_iso` (ふじ R2 must-fix, 2026-07-23). Absent agent = never
  cleared → no filter applies.
  """
  def all_filter_bounds(server \\ __MODULE__) do
    GenServer.call(server, :all_filter_bounds)
  end

  @doc "agent_id => display_iso for every known clear (audit helper)."
  def all_displays(server \\ __MODULE__) do
    GenServer.call(server, :all_displays)
  end

  @doc "Full record map for tests / debug."
  def all(server \\ __MODULE__) do
    GenServer.call(server, :all)
  end

  @doc """
  Removes the agent's watermark from memory + DETS. Idempotent — unknown
  agent returns `:ok`. Synchronous so the operator-driven `delete_agent`
  path in `agents_channel.ex` can wait for the purge before broadcasting
  `agent_deleted` (ADR-0030 D6, privacy: no lingering watermark trace
  after the agent identity is gone).
  """
  def delete(agent_id, server \\ __MODULE__) do
    GenServer.call(server, {:delete, agent_id})
  end

  @impl true
  def init({name, path}) do
    path |> Path.dirname() |> File.mkdir_p!()
    table = open_table(name, path)
    # Watermarks are not personally sensitive on their own, but the file
    # sits alongside the other agent DETS stores; keep the chmod symmetric
    # so a shared /tmp cannot become the weak link.
    _ = File.chmod(path, 0o600)
    {:ok, %{table: table, watermarks: load_watermarks(table)}}
  end

  # A corrupt / unreadable DETS file must not crash-loop the supervisor.
  # Losing boundaries re-exposes at most a pre-transition IA slice a
  # single time; the next SessionResets or external switch will seed a
  # fresh boundary. Same fallback pattern as PermissionModes /
  # SessionPointers.
  defp open_table(name, path) do
    case :dets.open_file(name, file: String.to_charlist(path)) do
      {:ok, ^name} ->
        name

      {:error, reason} ->
        Logger.warning("session boundary store unreadable (#{inspect(reason)}); recreating")

        File.rm(path)
        {:ok, ^name} = :dets.open_file(name, file: String.to_charlist(path))
        name
    end
  end

  defp load_watermarks(table) do
    case :dets.foldl(
           fn
             # R1 current record: previous sid is a durable identity for a
             # Codex lazy Trigger 1 boundary and is never inferred for old
             # records (otherwise an old nil sid would mask a real switch).
             {agent_id, {us, seq}, display, sid, pending_from_sid}, acc
             when is_integer(us) and is_integer(seq) and is_binary(display) and
                    (is_nil(sid) or is_binary(sid)) and
                    (is_nil(pending_from_sid) or is_binary(pending_from_sid)) ->
               Map.put(acc, agent_id, {{us, seq}, display, sid, pending_from_sid})

             # Current 4-tuple record (ふじ 検収 2 fix-round M3,
             # 2026-07-23): agent_id, order tuple, display ISO,
             # transition sid (nil until adopted for Codex lazy).
             {agent_id, {us, seq}, display, sid}, acc
             when is_integer(us) and is_integer(seq) and is_binary(display) and
                    (is_nil(sid) or is_binary(sid)) ->
               Map.put(acc, agent_id, {{us, seq}, display, sid, nil})

             # Pre-M3 3-tuple record (post-M6, pre-transition-idempotence):
             # sid unavailable; load as nil so `adopt_sid/2` can patch on
             # the next matching envelope.
             {agent_id, {us, seq}, display}, acc
             when is_integer(us) and is_integer(seq) and is_binary(display) ->
               Map.put(acc, agent_id, {{us, seq}, display, nil, nil})

             # Legacy 2-tuple record (pre-M6, ISO-only): keep it in
             # ISO-mode so the filter path (`all_filter_bounds/1` →
             # agents_channel `hidden_by?/3`) compares each envelope's
             # wire `ts` string against `display`. Rewriting these to
             # `{{0, 0}, display}` (the earlier fix) would render them
             # inert — every real ingress order dominates `{0, 0}`, so a
             # redeploy would re-expose every IA the pre-M6 clear had
             # hidden. ふじ R2 must-fix (2026-07-23). Any subsequent
             # `record/4` call for this agent promotes the entry to the
             # new tuple domain via the wildcard `current` branch of
             # `handle_call({:record, …})`.
             {agent_id, display}, acc when is_binary(display) ->
               Map.put(acc, agent_id, {:iso_only, display})

             _malformed, acc ->
               acc
           end,
           %{},
           table
         ) do
      watermarks when is_map(watermarks) -> watermarks
      {:error, _reason} -> %{}
    end
  end

  @impl true
  def handle_call({:record, agent_id, {us, seq} = order, display, sid}, _from, state) do
    # Monotonically advance: same-or-older order is a no-op. Compare on
    # the tuple (BEAM's term ordering handles integers pairwise), so
    # this cannot regress even under wall-clock rollback or a VM
    # restart — every tuple is allocated by `KaoiroServer.IngressOrder`,
    # which clamps `us` to at least `last_us` and bumps `seq` when
    # `us` did not advance (ふじ R5 must-fix, 2026-07-23; pre-R5 the
    # second half was `System.unique_integer/1` which reset on each
    # BEAM start).
    #
    # A legacy `{:iso_only, iso}` entry has no comparable order and is
    # always overwritten — the new tuple is monotonically newer than any
    # pre-M6 clear by construction (the pre-M6 clear was ISO-mode and
    # ran with wall-clock time we cannot reconcile against the new
    # ingress domain).
    current = Map.get(state.watermarks, agent_id)

    cond do
      match?({{^us, ^seq}, _, _, _}, current) ->
        {:reply, :ok, state}

      match?({{_, _}, _, _, _}, current) and elem(current, 0) > order ->
        {:reply, :ok, state}

      true ->
        write_record(state.table, agent_id, order, display, sid, nil)

        {:reply, :ok,
         %{state | watermarks: Map.put(state.watermarks, agent_id, {order, display, sid, nil})}}
    end
  end

  # ふじ 検収 2 fix-round M3 (2026-07-23): atomic allocate + record with
  # transition idempotence by sid. Retry of same transition returns the
  # existing record without allocating a new order — pre-M3 the caller
  # allocated first and then called record, so a crashing retry
  # double-advanced. See docstring on `advance_transition/3` for the
  # scenario.
  def handle_call({:advance_transition, agent_id, sid_opt, previous_sid}, _from, state) do
    current = Map.get(state.watermarks, agent_id)

    case current do
      {{_, _} = order, display, existing_sid, _pending_from_sid}
      when is_binary(sid_opt) and is_binary(existing_sid) and existing_sid == sid_opt ->
        # Same transition retry — no-op.
        {:reply, {:ok, {order, display, existing_sid}}, state}

      _ ->
        order = KaoiroServer.IngressOrder.allocate()
        display = DateTime.utc_now() |> DateTime.to_iso8601()

        pending_from_sid =
          if is_nil(sid_opt) and is_binary(previous_sid), do: previous_sid, else: nil

        write_record(state.table, agent_id, order, display, sid_opt, pending_from_sid)
        new_rec = {order, display, sid_opt, pending_from_sid}

        {:reply, {:ok, {order, display, sid_opt}},
         %{state | watermarks: Map.put(state.watermarks, agent_id, new_rec)}}
    end
  end

  # ふじ 検収 2 fix-round M3 (2026-07-23): Codex lazy 采番 adopt. Only
  # patches records whose sid is nil; established sid / iso_only /
  # missing → no-op.
  def handle_call({:adopt_sid, agent_id, sid}, _from, state) do
    case Map.get(state.watermarks, agent_id) do
      {{_, _} = order, display, nil, pending_from_sid} ->
        write_record(state.table, agent_id, order, display, sid, pending_from_sid)
        updated = {order, display, sid, pending_from_sid}

        {:reply, {:ok, {order, display, sid}},
         %{state | watermarks: Map.put(state.watermarks, agent_id, updated)}}

      _ ->
        {:reply, :noop, state}
    end
  end

  def handle_call({:adopt_pending_sid, agent_id, sid, previous_sid}, _from, state) do
    case Map.get(state.watermarks, agent_id) do
      {{_, _} = order, display, nil, ^previous_sid} ->
        write_record(state.table, agent_id, order, display, sid, previous_sid)
        updated = {order, display, sid, previous_sid}

        {:reply, {:ok, {order, display, sid}},
         %{state | watermarks: Map.put(state.watermarks, agent_id, updated)}}

      _ ->
        {:reply, :noop, state}
    end
  end

  def handle_call({:get, agent_id}, _from, state) do
    record =
      case Map.get(state.watermarks, agent_id) do
        {order, display, sid, _pending_from_sid} -> {order, display, sid}
        other -> other
      end

    {:reply, record, state}
  end

  def handle_call(:all, _from, state) do
    {:reply, state.watermarks, state}
  end

  def handle_call(:all_orders, _from, state) do
    orders =
      for {id, {{_us, _seq} = order, _display, _sid, _pending_from_sid}} <- state.watermarks,
          into: %{},
          do: {id, order}

    {:reply, orders, state}
  end

  def handle_call(:all_filter_bounds, _from, state) do
    bounds =
      Map.new(state.watermarks, fn
        {id, {{_us, _seq} = order, _display, _sid, _pending_from_sid}} -> {id, {:order, order}}
        {id, {:iso_only, display}} -> {id, {:iso, display}}
      end)

    {:reply, bounds, state}
  end

  def handle_call(:all_displays, _from, state) do
    displays =
      Map.new(state.watermarks, fn
        {id, {{_us, _seq}, display, _sid, _pending_from_sid}} -> {id, display}
        {id, {:iso_only, display}} -> {id, display}
      end)

    {:reply, displays, state}
  end

  def handle_call({:delete, agent_id}, _from, state) do
    :ok = :dets.delete(state.table, agent_id)
    # fsync so `purge_agent_records` (which calls this synchronously) is
    # durable before the `agent_deleted` broadcast fires; same rule as
    # the record path above.
    :ok = :dets.sync(state.table)
    {:reply, :ok, %{state | watermarks: Map.delete(state.watermarks, agent_id)}}
  end

  @impl true
  def terminate(_reason, state) do
    :dets.close(state.table)
  end

  # DETS write path: 5-tuple `{agent_id, order, display, sid,
  # pending_from_sid}` (R1). fsync BEFORE reply — same
  # M7-a policy as the pre-M3 record path. `open_table/2` may have
  # loaded pre-M3 3-tuple records (with sid inferred as nil); on the
  # first write for such a key, the 3-tuple in DETS is replaced by the
  # 5-tuple (:dets uses key equality on the first element).
  defp write_record(table, agent_id, order, display, sid, pending_from_sid) do
    :ok = :dets.insert(table, {agent_id, order, display, sid, pending_from_sid})
    :ok = :dets.sync(table)
  end

  defp default_path do
    Application.get_env(:kaoiro_server, :clear_watermarks_path) ||
      Path.join(System.tmp_dir!(), "kaoiro_clear_watermarks.dets")
  end
end
