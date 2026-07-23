defmodule KaoiroServer.IngressOrder do
  @moduledoc """
  Serialized, restart-durable allocator for the single server-side
  ordering domain that stamps every `inter_agent_message` at
  `InterAgentHistory.append/2` AND every session-transition boundary
  in `ClearWatermarks` (Trigger 1: SessionResets.confirm_connection
  for /new・/clear, Trigger 2: wrapper_channel external switch —
  実機検収 2, 2026-07-23; operator UI `clear_history` no longer
  advances). Both must share one allocator so a wall-clock rollback
  or a VM restart cannot let an IA slip past a session boundary (or
  vice versa) — the exact concern ふじ R5 must-fix (2026-07-23)
  flagged with the pre-R5 `{System.system_time(:microsecond),
  System.unique_integer([:positive, :monotonic])}` inline pair, whose
  `unique_integer` half resets to an undefined offset on every BEAM
  start and whose `system_time` half is a wall clock that can go
  backwards.

  Emits tuples `{us, seq}` where:
    - `us` is the clock reading clamped to at least the last emitted
      `us` — a wall-clock rollback cannot lower it.
    - `seq` is a persistent counter that increments when `us` did not
      advance past `last_us` and resets to 0 when it did — the
      Hybrid-Logical-Clock-lite trick that keeps strict monotonicity
      per BEAM node without requiring a distributed lower bound.

  State `{last_us, last_seq}` is persisted to DETS + `:dets.sync/1`
  before the reply, so the server's `session_boundary_advanced`
  broadcast (or the wrapper's IA `:ok` reply) can never fire ahead
  of disk persistence. On boot, `init/1` reads the persisted pair AND scans
  `InterAgentHistory.all_with_order/1` + `ClearWatermarks.all_orders/1`
  for the pairwise-max tuple seen — so an allocator-DETS wipe cannot
  regress below live-consumer state. Pairwise-max means `{same_us,
  large_uniq_from_pre_R5_records}` seeds `last_seq = large_uniq + 1`,
  never `0` — a pin test enforces this.

  `start_link/1` accepts `:clock` (0-arg fn → integer µs) so tests can
  drive a deterministic clock and pin wall-clock rollback recovery.
  Production uses `&System.system_time(:microsecond)/0`.
  """

  use GenServer

  require Logger

  @default_clock_fun {System, :system_time, [:microsecond]}

  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    path = Keyword.get(opts, :path, default_path())
    clock = Keyword.get(opts, :clock, &default_clock/0)
    seed_from = Keyword.get(opts, :seed_from, [])
    GenServer.start_link(__MODULE__, {name, path, clock, seed_from}, name: name)
  end

  @doc """
  Allocates a fresh ingress order tuple `{us, seq}`. Synchronous +
  fsync-gated: DETS holds the pair before this returns, so any caller
  broadcast (operator ack, wrapper ack) is safe against a crash between
  reply and disk.
  """
  def allocate(server \\ __MODULE__) do
    GenServer.call(server, :allocate)
  end

  @doc "Current `{last_us, last_seq}` pair (debug / test helper)."
  def peek(server \\ __MODULE__) do
    GenServer.call(server, :peek)
  end

  @impl true
  def init({name, path, clock, seed_from}) do
    path |> Path.dirname() |> File.mkdir_p!()
    table = open_table(name, path)
    _ = File.chmod(path, 0o600)
    persisted = load_persisted(table)
    seen_max = max_from_seed_sources(seed_from)
    initial = pairwise_max(persisted, seen_max) || {0, 0}
    {:ok, %{table: table, last: initial, clock: clock}}
  end

  @impl true
  def handle_call(:allocate, _from, %{last: {last_us, last_seq}, clock: clock} = state) do
    now = clock.()

    next =
      if now > last_us do
        {now, 0}
      else
        {last_us, last_seq + 1}
      end

    :ok = :dets.insert(state.table, {:last, next})
    :ok = :dets.sync(state.table)
    {:reply, next, %{state | last: next}}
  end

  def handle_call(:peek, _from, state) do
    {:reply, state.last, state}
  end

  @impl true
  def terminate(_reason, state) do
    :dets.close(state.table)
  end

  # Same corrupt-file recovery pattern as PermissionModes / ClearWatermarks
  # — losing the persisted last-order at worst re-uses one ingress slot
  # (the seed_max branch caps it below), which is safe because both
  # consumers guard against equality via `>` (append: fresh key; clear:
  # monotonic-advance no-op).
  defp open_table(name, path) do
    case :dets.open_file(name, file: String.to_charlist(path)) do
      {:ok, ^name} ->
        name

      {:error, reason} ->
        Logger.warning("ingress order store unreadable (#{inspect(reason)}); recreating")
        File.rm(path)
        {:ok, ^name} = :dets.open_file(name, file: String.to_charlist(path))
        name
    end
  end

  defp load_persisted(table) do
    case :dets.lookup(table, :last) do
      [{:last, {us, seq}}] when is_integer(us) and is_integer(seq) -> {us, seq}
      _ -> nil
    end
  end

  # Each seed source is a 0-arg fn returning a map `%{key => tuple}` or
  # an enumerable of tuples. We fold them all through pairwise_max/2.
  # Production supervisor wires `InterAgentHistory.all_with_order/0` and
  # `ClearWatermarks.all_orders/0`; tests can pass literal fns.
  defp max_from_seed_sources(sources) do
    Enum.reduce(sources, nil, fn source, acc ->
      pairwise_max(acc, source_max(source))
    end)
  end

  defp source_max(fun) when is_function(fun, 0) do
    fun.() |> collect_tuples() |> Enum.reduce(nil, &pairwise_max/2)
  end

  defp source_max(_), do: nil

  # Handles both %{id => tuple} maps (ClearWatermarks.all_orders) and
  # %{id => [{tuple, envelope}, ...]} maps (InterAgentHistory.all_with_order).
  defp collect_tuples(nil), do: []

  defp collect_tuples(%{} = map) do
    Enum.flat_map(map, fn
      {_, {us, seq}} when is_integer(us) and is_integer(seq) -> [{us, seq}]
      {_, list} when is_list(list) -> Enum.flat_map(list, &tuples_of/1)
      _ -> []
    end)
  end

  defp collect_tuples(list) when is_list(list), do: Enum.flat_map(list, &tuples_of/1)

  defp tuples_of({{us, seq}, _envelope}) when is_integer(us) and is_integer(seq),
    do: [{us, seq}]

  defp tuples_of({us, seq}) when is_integer(us) and is_integer(seq), do: [{us, seq}]
  defp tuples_of(_), do: []

  # BEAM's term ordering gives strict pairwise integer compare for
  # 2-tuples, which is what we want here: `{same_us, larger_seq}` beats
  # `{same_us, smaller_seq}`, and any `{larger_us, _}` beats any
  # `{smaller_us, _}`. Kept explicit so intent stays obvious.
  defp pairwise_max(nil, other), do: other
  defp pairwise_max(a, nil), do: a
  defp pairwise_max(a, b) when a >= b, do: a
  defp pairwise_max(_a, b), do: b

  defp default_clock do
    {mod, fun, args} = @default_clock_fun
    apply(mod, fun, args)
  end

  defp default_path do
    Application.get_env(:kaoiro_server, :ingress_order_path) ||
      Path.join(System.tmp_dir!(), "kaoiro_ingress_order.dets")
  end
end
