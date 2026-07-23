defmodule KaoiroServer.ClearWatermarks do
  @moduledoc """
  Restart-surviving per-agent clear watermark (issue #109). When operator
  `clear_history(agent_id)` succeeds, the server-ingress **order tuple**
  (matched to `KaoiroServer.InterAgentHistory`'s append-time
  `{system_time_microsecond, unique_integer_positive_monotonic}`) is
  stored here; on subsequent history-merge paths, IA envelopes whose
  server-side order is `<= watermark_order` are hidden from `agent_id`'s
  transcript pane. Peer agents' panes are unaffected — their own
  watermark controls what they see — and the shared `InterAgentHistory`
  DETS ledger itself is untouched.

  **Ordering domain** (ふじ #109 M6 must-fix, 2026-07-23): all comparisons
  run on the server-generated tuple. Neither wire ISO timestamps nor
  wrapper producer clocks feed the compare, so host-clock skew between
  the operator's clear and a wrapper's IA emit can no longer misclassify
  a message as "before" or "after" the cutoff. The tuple `{us, uniq}`
  gives strict monotonic total ordering per BEAM node — identical to
  what `InterAgentHistory.append/2` stamps at ingress.

  Storage: DETS with in-memory mirror. Writes are **synchronous +
  fsync-gated** (`GenServer.call` + `:dets.sync/1` before reply) — an
  operator's `clear_history` ack and the `history_cleared` broadcast
  that follows never fire ahead of disk persistence, so a crash inside
  the persist window cannot silently drop the cutoff (M7-a must-fix,
  same policy `KaoiroServer.TokenDenylist` adopted for #72 revocation).

  Record shape: `agent_id => {order_tuple, display_iso}` — the tuple
  drives filtering; the ISO string is a display-only audit stamp
  reported on the `history_cleared` broadcast so live dashboards can
  show "cleared at ..." without a separate lookup.
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
  clear watermark, alongside `display_ts` (ISO-8601 UTC) for the audit
  trail / broadcast payload. **Synchronous + fsync-gated** so the
  operator's `clear_history` ack and the `history_cleared` broadcast
  that follow are safe against an in-flight crash (M7-a must-fix).
  Monotonically advances: a call with an `order` at or below the
  current entry is a no-op — an out-of-order retry cannot re-expose IA
  the newer clear just hid.
  """
  def record(agent_id, {us, uniq} = order, display_ts, server \\ __MODULE__)
      when is_integer(us) and is_integer(uniq) and is_binary(display_ts) do
    GenServer.call(server, {:record, agent_id, order, display_ts})
  end

  @doc """
  Latest `{order_tuple, display_iso}` for the agent, or nil. Callers
  that only need the audit ts (broadcast payload, UI hint) use
  `get_display/2`; the filter path uses `get_order/2`.
  """
  def get(agent_id, server \\ __MODULE__) do
    GenServer.call(server, {:get, agent_id})
  end

  @doc "Latest order tuple for the agent, or nil (filter-path helper)."
  def get_order(agent_id, server \\ __MODULE__) do
    case get(agent_id, server) do
      {order, _display} -> order
      _ -> nil
    end
  end

  @doc "Latest display ISO ts for the agent, or nil (broadcast helper)."
  def get_display(agent_id, server \\ __MODULE__) do
    case get(agent_id, server) do
      {_order, display} -> display
      _ -> nil
    end
  end

  @doc "agent_id => order_tuple for every known clear (filter-path helper)."
  def all_orders(server \\ __MODULE__) do
    GenServer.call(server, :all_orders)
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
  # Losing watermarks re-exposes at most the pre-clear IA a single time;
  # the operator can re-clear if it matters. Same fallback pattern as
  # PermissionModes / SessionPointers.
  defp open_table(name, path) do
    case :dets.open_file(name, file: String.to_charlist(path)) do
      {:ok, ^name} ->
        name

      {:error, reason} ->
        Logger.warning("clear watermark store unreadable (#{inspect(reason)}); recreating")

        File.rm(path)
        {:ok, ^name} = :dets.open_file(name, file: String.to_charlist(path))
        name
    end
  end

  defp load_watermarks(table) do
    case :dets.foldl(
           fn
             # Current 3-tuple record: agent_id, order tuple, display ISO.
             {agent_id, {us, uniq}, display}, acc
             when is_integer(us) and is_integer(uniq) and is_binary(display) ->
               Map.put(acc, agent_id, {{us, uniq}, display})

             # Legacy 2-tuple record (pre-M6, ISO-only): promote by using
             # the display ISO as both the display AND a lower-bound order
             # synthesized from `{0, 0}`. Any subsequent clear moves the
             # order forward via the monotonic-advance rule, and any
             # subsequent IA gets a real ingress order that dominates the
             # synthetic `{0, 0}`, so no legacy entry can accidentally
             # dominate a new IA. The record is rewritten on the next
             # record/4 call.
             {agent_id, display}, acc when is_binary(display) ->
               Map.put(acc, agent_id, {{0, 0}, display})

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
  def handle_call({:record, agent_id, {us, uniq} = order, display}, _from, state) do
    # Monotonically advance: same-or-older order is a no-op. Compare on
    # the tuple (BEAM's term ordering handles integers pairwise), so
    # this cannot regress even if `us` clock skews across restarts —
    # the `uniq` half is per-node strict monotonic.
    current = Map.get(state.watermarks, agent_id)

    cond do
      match?({{^us, ^uniq}, _}, current) ->
        {:reply, :ok, state}

      is_tuple(current) and elem(current, 0) > order ->
        {:reply, :ok, state}

      true ->
        :ok = :dets.insert(state.table, {agent_id, order, display})
        # M7-a must-fix: fsync BEFORE reply so the operator's
        # `history_cleared` broadcast that follows this call cannot
        # outrun disk persistence.
        :ok = :dets.sync(state.table)

        {:reply, :ok,
         %{state | watermarks: Map.put(state.watermarks, agent_id, {order, display})}}
    end
  end

  def handle_call({:get, agent_id}, _from, state) do
    {:reply, Map.get(state.watermarks, agent_id), state}
  end

  def handle_call(:all, _from, state) do
    {:reply, state.watermarks, state}
  end

  def handle_call(:all_orders, _from, state) do
    orders = Map.new(state.watermarks, fn {id, {order, _display}} -> {id, order} end)
    {:reply, orders, state}
  end

  def handle_call(:all_displays, _from, state) do
    displays = Map.new(state.watermarks, fn {id, {_order, display}} -> {id, display} end)
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

  defp default_path do
    Application.get_env(:kaoiro_server, :clear_watermarks_path) ||
      Path.join(System.tmp_dir!(), "kaoiro_clear_watermarks.dets")
  end
end
