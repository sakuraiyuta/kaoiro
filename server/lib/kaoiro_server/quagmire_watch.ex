defmodule KaoiroServer.QuagmireWatch do
  @moduledoc """
  Detects review quagmires and surfaces them to the operator (issue #273).

  Two conditions, both derived from state other modules already keep — this
  module stores no observation of its own beyond which conditions it has
  already reported:

    * **rally** — one agent group has exchanged `rally_turns` or more
      messages within `rally_window_ms`, counted ACROSS conversations by
      `ConversationStates.pair_rally/2`. A per-conversation count cannot see
      this: `max_turns` closes a conversation at 20 and the protocol then
      forces the peers onto a fresh id, so a long review loop necessarily
      spans several entries.

    * **stall** — a recipient has an unacknowledged delivery gap
      (`acked_seq < issued_seq`) older than `stall_ms`, read from
      `DeliveryStates`' own `pending_since`. Known limit, spec'd: the ledger
      is a watermark, and a wrapper process replacing its predecessor
      abandons the gap (`acked` moves to `issued`), so a stall is detected
      only while one wrapper generation persists.

  The edge-trigger memory is process-local and starts empty, so a restart
  (this process, or the whole server) re-announces every condition still
  standing. Accepted deliberately: the alternative is persisting
  operator-visible notice state, and a repeated advisory banner costs less
  than that. The sweep is guarded so an unavailable store does not become a
  restart in the first place.

  Notices are EDGE-triggered: one per condition per subject, when it first
  crosses, and again only after it has fallen back below. `notified_*` is
  rebuilt from the current over-threshold set each tick, so a subject that
  disappears (a GC'd tombstone, a deleted agent) drops out rather than
  accumulating.

  Detection only. The module never closes a conversation and never messages
  an agent: a false positive that stops a working loop costs far more than a
  missed notice. `:on_notice` is the one place its data crosses into
  KaoiroServerWeb, mirroring `ConversationStates`' `:on_auto_closed`.
  """

  use GenServer

  require Logger

  alias KaoiroServer.ConversationStates
  alias KaoiroServer.DeliveryStates

  # Fallbacks for a deployment that configures nothing. They must match
  # config.exs: a value that only lives here is one nobody reviews when the
  # shipped default is retuned, and stall_ms below 60 minutes fires under the
  # wrapper's own turn watchdog.
  @default_rally_turns 16
  @default_rally_window_ms 86_400_000
  @default_stall_ms 3_600_000
  @default_sweep_interval_ms 60_000

  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @doc """
  The validated settings this process is running with.
  """
  def settings(server \\ __MODULE__), do: GenServer.call(server, :settings)

  @doc """
  The same settings, read and validated straight from config without entering
  this process. Callers outside the detector use THIS: the values are fixed
  for the life of a boot, so a `GenServer.call` would buy nothing dynamic
  while making an advisory detector's liveness a hard dependency of whatever
  called it. The supervised process validates the same source at boot, so a
  value that would raise here has already failed the boot.
  """
  def configured_settings, do: load_settings(nil)

  @doc "Runs one detection pass synchronously. Tests use it instead of waiting."
  def sweep(server \\ __MODULE__), do: GenServer.call(server, :sweep)

  @impl true
  def init(opts) do
    settings = load_settings(Keyword.get(opts, :settings))

    state = %{
      settings: settings,
      on_notice: Keyword.get(opts, :on_notice, fn _payload -> :ok end),
      conversations: Keyword.get(opts, :conversations, ConversationStates),
      deliveries: Keyword.get(opts, :deliveries, DeliveryStates),
      now_wall: Keyword.get(opts, :now_wall, &DateTime.utc_now/0),
      notified_rally: MapSet.new(),
      notified_stall: MapSet.new()
    }

    schedule_sweep(settings.sweep_interval_ms)
    {:ok, state}
  end

  @impl true
  def handle_call(:settings, _from, state), do: {:reply, state.settings, state}

  def handle_call(:sweep, _from, state) do
    next = detect(state)
    {:reply, :ok, next}
  end

  @impl true
  def handle_info(:sweep, state) do
    next = detect(state)
    schedule_sweep(state.settings.sweep_interval_ms)
    {:noreply, next}
  end

  defp schedule_sweep(interval_ms), do: Process.send_after(self(), :sweep, interval_ms)

  defp detect(state) do
    state
    |> guarded(:rally, &detect_rally/1)
    |> guarded(:stall, &detect_stall/1)
  end

  # Each detector is fail-soft on its own store AND commits its own edge
  # memory. ConversationStates or DeliveryStates being slow or absent must not
  # empty that memory: crashing, or rolling the whole sweep back, re-announces
  # on the next tick every condition the operator has already seen -- including
  # the ones the unavailable store had nothing to do with.
  defp guarded(state, kind, detector) do
    detector.(state)
  catch
    :exit, reason ->
      Logger.warning("quagmire #{kind} sweep skipped: #{inspect(reason)}")
      state
  end

  defp detect_rally(state) do
    threshold = state.settings.rally_turns

    over =
      state.settings.rally_window_ms
      |> then(&ConversationStates.pair_rally(&1, state.conversations))
      |> Enum.filter(fn {_participants, tally} -> tally.turns >= threshold end)
      |> Map.new()

    subjects = over |> Map.keys() |> MapSet.new()

    for {participants, tally} <- over, not MapSet.member?(state.notified_rally, participants) do
      state.on_notice.(%{
        "kind" => "rally",
        "participants" => participants,
        "turns" => tally.turns,
        "conversations" => tally.conversations,
        "threshold" => threshold,
        "window_ms" => state.settings.rally_window_ms
      })
    end

    %{state | notified_rally: subjects}
  end

  defp detect_stall(state) do
    now = state.now_wall.()
    threshold = state.settings.stall_ms

    over =
      state.deliveries
      |> DeliveryStates.all()
      |> Enum.filter(fn {_agent_id, status} -> stalled?(status, now, threshold) end)
      |> Map.new()

    subjects = over |> Map.keys() |> MapSet.new()

    for {agent_id, status} <- over, not MapSet.member?(state.notified_stall, agent_id) do
      state.on_notice.(%{
        "kind" => "stall",
        "agent_id" => agent_id,
        "undelivered" => status.issued_seq - status.acked_seq,
        "pending_since" => status.pending_since,
        "threshold_ms" => threshold
      })
    end

    %{state | notified_stall: subjects}
  end

  # A malformed pending_since is not evidence of a stall. DeliveryStates
  # writes ISO8601 and validates on DETS load, so this only guards a value
  # that got past both.
  defp stalled?(
         %{issued_seq: issued, acked_seq: acked, pending_since: pending},
         now,
         threshold_ms
       )
       when is_binary(pending) and acked < issued do
    case DateTime.from_iso8601(pending) do
      {:ok, since, _offset} -> DateTime.diff(now, since, :millisecond) > threshold_ms
      _ -> false
    end
  end

  defp stalled?(_status, _now, _threshold_ms), do: false

  defp load_settings(nil) do
    cfg = Application.get_env(:kaoiro_server, :quagmire, [])

    validate(%{
      rally_turns: Keyword.get(cfg, :rally_turns, @default_rally_turns),
      rally_window_ms: Keyword.get(cfg, :rally_window_ms, @default_rally_window_ms),
      stall_ms: Keyword.get(cfg, :stall_ms, @default_stall_ms),
      sweep_interval_ms: Keyword.get(cfg, :sweep_interval_ms, @default_sweep_interval_ms)
    })
  end

  defp load_settings(settings) when is_map(settings), do: validate(settings)

  # Fails the boot rather than running a detector whose window reaches past
  # the data it reads: beyond tombstone_ttl_ms the entries are simply gone,
  # so the count would silently under-report instead of looking further back.
  defp validate(settings) do
    # Types FIRST, rally_window_ms included: it is handed to
    # ConversationStates.pair_rally/2, whose `is_integer` guard raises in the
    # CALLER. A float or negative that only failed the comparison below would
    # boot cleanly and then crash the sweep every tick AND every operator
    # list_conversations — an advisory detector taking down a core RPC.
    Enum.each([:rally_turns, :rally_window_ms, :stall_ms, :sweep_interval_ms], fn key ->
      value = Map.fetch!(settings, key)

      unless is_integer(value) and value > 0 do
        raise ArgumentError, "quagmire #{key} must be a positive integer, got #{inspect(value)}"
      end
    end)

    tombstone_ttl_ms = ConversationStates.configured_tombstone_ttl_ms()

    if settings.rally_window_ms > tombstone_ttl_ms do
      raise ArgumentError,
            "quagmire rally_window_ms (#{settings.rally_window_ms}) exceeds " <>
              "inter_agent tombstone_ttl_ms (#{tombstone_ttl_ms}); closed conversations " <>
              "are not retained that long, so the rally count would under-report"
    end

    settings
  end
end
