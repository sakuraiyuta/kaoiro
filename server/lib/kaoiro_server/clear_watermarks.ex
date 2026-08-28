defmodule KaoiroServer.ClearWatermarks do
  @moduledoc """
  Restart-surviving per-agent **IA visibility watermark** (issue #109).
  `clear_history` alone records this cutoff by adopting the independently
  persisted `SessionStarts` record; session transitions never alter it. On
  subsequent history-merge paths, IA envelopes whose server-side
  order is `<= boundary_order` are hidden from `agent_id`'s
  transcript pane. Peer agents' panes are unaffected — their own
  boundary controls what they see — and the wrapper-host IA sidecar that
  owns the messages themselves is untouched (ADR-0051 D3-4: hiding is a
  per-pane display decision, never a deletion).

  Session transition identity belongs exclusively to `SessionStarts`.
  This store only loads existing 5/4/3/2-field DETS rows so previously
  hidden IA never reappears after the migration.

  **Ordering domain** (ふじ #109 M6 must-fix, 2026-07-23 + R5 must-fix
  same date): the order tuple is allocated by `KaoiroServer.IngressOrder`,
  the single serialized allocator both this store and the live IA
  ingress stamp (`WrapperChannel`) share. The tuple shape is `{us, seq}`
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
  target `session_id` from the historical transition that seeded this
  boundary. It is retained only for load compatibility; current transition
  idempotence and Codex lazy adoption live in `SessionStarts`.

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
  Records `order` (an ingress-order-domain tuple) as the agent's
  boundary, alongside `display_ts` (ISO-8601 UTC) for the audit trail.
  The sid is nil for current records because only `SessionStarts` owns
  transition identity. Older sid-bearing records remain readable.

  **Synchronous + fsync-gated** so any follow-up broadcast is safe
  against an in-flight crash (M7-a must-fix). Monotonically advances:
  a call with an `order` at or below the current entry is a no-op.
  """
  def record(agent_id, {us, seq} = order, display_ts, server \\ __MODULE__)
      when is_integer(us) and is_integer(seq) and is_binary(display_ts) do
    GenServer.call(server, {:record, agent_id, order, display_ts, nil})
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

  @doc """
  Two-mode hide check against one `all_filter_bounds/1` entry
  (ふじ R2 must-fix, 2026-07-23):

    - `{:order, tuple}` — post-M6 clear, compare server ingress order
      tuples (BEAM term ordering handles integers pairwise).
    - `{:iso, iso}` — legacy pre-M6 clear, compare the envelope's wire
      `ts` string against `iso` (ISO-8601 lex compare = time compare
      when both are UTC-normalized, matching the pre-M6 filter that
      shipped for this cutoff). An envelope with no / non-string ts
      falls through as "not hidden" (fail-open for display; the entry
      is still filtered by the pane's own watermark on the next
      post-M6 clear).

  Absent bound (`nil`) = never cleared → never hidden. Lives here rather
  than in a channel because ADR-0051 D3-1 puts the live projection read
  and the `replay_ia` ingress on the same contract — two copies of this
  compare would be exactly the live/replay behaviour split the ADR
  forbids.
  """
  def hidden?(bound, order, envelope)

  def hidden?({:order, {us, uniq} = watermark}, order, _envelope)
      when is_integer(us) and is_integer(uniq),
      do: order <= watermark

  def hidden?({:iso, iso}, _order, envelope) when is_binary(iso) do
    case Map.get(envelope, "ts") do
      ts when is_binary(ts) -> ts <= iso
      _ -> false
    end
  end

  def hidden?(_bound, _order, _envelope), do: false

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
    KaoiroServer.DetsStorePath.prepare_parent!(path)
    table = open_table(name, path)
    _ = File.chmod(path, 0o600)
    {:ok, %{table: table, watermarks: load_watermarks(table)}}
  end

  # A corrupt / unreadable DETS file must not crash-loop the supervisor.
  # Losing boundaries re-exposes at most a pre-clear IA slice a
  # single time; the next operator clear_history will seed a fresh
  # boundary. Same fallback pattern as PermissionModes /
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

             # Pre-M3 3-tuple record (post-M6, before SessionStarts was
             # split out): preserve its visibility tuple and retain a nil sid.
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
      KaoiroServer.DetsStorePath.default_path("clear_watermarks.dets")
  end
end
