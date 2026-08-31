defmodule KaoiroServer.SessionLifecycleEvents do
  @moduledoc """
  Restart-surviving per-agent timeline of `session_lifecycle` events
  (ADR-0055, phase-33 Stage B): wrapper-observed compaction/resume/threshold
  transitions merged with server-known disconnect/reconnect/session_reset.
  Recording only — appending here never notifies peers.

  One DETS record per agent, holding that agent's WHOLE event list (newest
  first), capped at `SESSION_LIFECYCLE_MAX_EVENTS_PER_AGENT` (default
  10,000) with the oldest entries discarded first — the same
  prepend-and-truncate shape `KaoiroServer.AgentStates` uses for its
  in-memory `@max_history`, made durable. Chosen over one DETS record per
  event: `session_lifecycle` events are low-frequency (compaction/reset,
  minutes-to-hours apart), so rewriting the whole capped list on every
  append is cheap, and it avoids a second index for eviction.

  `kind`/`trigger`/`at` are validated against the closed vocabulary in
  `docs/specs/protocol.md` at every entry point — wrapper ingress, direct
  server-side `append/5` calls, and durable load at boot (ふじ Stage B
  round 1 must-fix B3) — so a forged or corrupted value can never reach an
  operator query. `append/5` and `list_for_agent/2` never raise or block
  the caller on a store outage (must-fix B2): the store may be mid-restart
  while `agents_channel.ex`'s session_reset flow appends between its
  broadcast and the runner reset instruction, and that instruction must
  still fire.
  """

  use GenServer

  require Logger

  @wrapper_kinds ~w(
    compacting compact_boundary compact_failed resume_reserved resume_fired
    threshold_notice conversation_reset
  )
  @server_kinds ~w(
    disconnected reconnecting reconnected session_reset_started
    session_reset_completed
  )
  @valid_kinds MapSet.new(@wrapper_kinds ++ @server_kinds)

  # `trigger` only ever applies to compact_boundary (protocol.md).
  @valid_triggers MapSet.new(~w(request_compact sdk_auto manual))

  # `DateTime.utc_now() |> DateTime.to_iso8601()` is ~27 bytes (microsecond
  # precision); `new Date().toISOString()` on the wrapper side is 24. This
  # leaves headroom without accepting an arbitrarily large string ahead of
  # the ISO-8601 parse below.
  @max_at_bytes 40

  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    path = Keyword.get(opts, :path, default_path())
    cap = Keyword.get(opts, :cap, default_cap())

    # ふじ Stage B round 1 must-fix B6: 0 silently erases every append
    # (`Enum.take(list, 0)` == `[]`), and a negative cap inverts
    # `Enum.take/2`'s selection to the OLDEST entries — both are semantic
    # traps, not values worth "handling", so reject them before init.
    unless is_integer(cap) and cap > 0 do
      raise ArgumentError,
            "SessionLifecycleEvents cap must be a positive integer, got #{inspect(cap)}"
    end

    GenServer.start_link(__MODULE__, {name, path, cap}, name: name)
  end

  @doc """
  Appends one event to `agent_id`'s timeline, or no-ops it — silently, but
  logged — when `kind`/`trigger`/`at` fails `valid_event?/3` or the store
  is unreachable/times out. Always returns `:ok`: recording is diagnostic
  only, so no caller branches on the result.
  """
  def append(agent_id, kind, trigger, at, server \\ __MODULE__)
      when is_binary(agent_id) and is_binary(kind) and
             (is_nil(trigger) or is_binary(trigger)) and is_binary(at) do
    if valid_event?(kind, trigger, at) do
      safe_call(server, {:append, agent_id, kind, trigger, at})
    else
      Logger.warning(
        "session_lifecycle event rejected (kind=#{inspect(kind)} " <>
          "trigger=#{inspect(trigger)} at=#{inspect(at)} fails the " <>
          "protocol.md vocabulary); event dropped, agent_id=#{agent_id}"
      )
    end

    :ok
  end

  @doc """
  Returns `agent_id`'s events, newest first, or `[]` if none recorded —
  including when the store is unreachable/times out (must-fix B2).
  """
  def list_for_agent(agent_id, server \\ __MODULE__) when is_binary(agent_id) do
    safe_call(server, {:list_for_agent, agent_id}, [])
  end

  @doc """
  `true` when `kind`/`trigger`/`at` matches the closed `session_lifecycle`
  vocabulary in `docs/specs/protocol.md`: `kind` is one of the enumerated
  wrapper- or server-produced values, `trigger` is non-nil only for
  `compact_boundary` and then one of its three enumerated values, and `at`
  is a non-empty, bounded, actual ISO-8601 timestamp.
  """
  def valid_event?(kind, trigger, at) do
    valid_kind?(kind) and valid_trigger?(kind, trigger) and valid_at?(at)
  end

  @impl true
  def init({name, path, cap}) do
    KaoiroServer.DetsStorePath.prepare_parent!(path)
    table = open_table(name, path)
    _ = File.chmod(path, 0o600)
    {:ok, %{table: table, events: load_events(table, cap), cap: cap}}
  end

  @impl true
  def handle_call({:append, agent_id, kind, trigger, at}, _from, state) do
    event = %{kind: kind, trigger: trigger, at: at}
    existing = Map.get(state.events, agent_id, [])
    updated = Enum.take([event | existing], state.cap)

    case write_record(state.table, agent_id, updated) do
      :ok ->
        {:reply, :ok, %{state | events: Map.put(state.events, agent_id, updated)}}

      {:error, reason} ->
        Logger.warning(
          "session_lifecycle event store write failed (#{inspect(reason)}); event dropped"
        )

        {:reply, :ok, state}
    end
  end

  def handle_call({:list_for_agent, agent_id}, _from, state) do
    {:reply, Map.get(state.events, agent_id, []), state}
  end

  @impl true
  def terminate(_reason, state), do: :dets.close(state.table)

  # Bounded `GenServer.call` (default 5s timeout) that turns a dead/slow
  # store into a logged no-op instead of an `exit` propagating to the
  # caller — a plain `rescue` cannot catch this: `GenServer.call` signals
  # failure via `exit/1`, not a raised exception (ふじ Stage B round 1
  # must-fix B2).
  defp safe_call(server, msg, fallback \\ :ok) do
    GenServer.call(server, msg)
  catch
    :exit, reason ->
      Logger.warning("SessionLifecycleEvents store unavailable (#{inspect(reason)})")
      fallback
  end

  # Truncates and re-validates every stored record against the CURRENT cap
  # and CURRENT vocabulary, and durably rewrites any record that shrank
  # (must-fix B3 durable re-validation + B6 durable discard) — otherwise a
  # cap lowered then raised again would resurrect entries this boot never
  # re-wrote to disk, and a legacy/hand-edited row could reach an operator
  # query unvalidated. Writes happen in a separate pass AFTER `:dets.foldl`
  # completes: mutating the table mid-fold has undefined traversal
  # guarantees (`:dets` docs).
  defp load_events(table, cap) do
    case :dets.foldl(
           fn
             {agent_id, events}, acc when is_binary(agent_id) and is_list(events) ->
               capped = events |> Enum.filter(&valid_stored_event?/1) |> Enum.take(cap)
               Map.put(acc, agent_id, {capped, capped != events})

             _, acc ->
               acc
           end,
           %{},
           table
         ) do
      raw when is_map(raw) ->
        Enum.reduce(raw, %{}, fn {agent_id, {capped, changed}}, events ->
          if changed, do: write_record(table, agent_id, capped)
          Map.put(events, agent_id, capped)
        end)

      {:error, _} ->
        %{}
    end
  end

  defp valid_stored_event?(%{kind: kind, trigger: trigger, at: at}),
    do: valid_event?(kind, trigger, at)

  defp valid_stored_event?(_), do: false

  defp valid_kind?(kind), do: is_binary(kind) and MapSet.member?(@valid_kinds, kind)

  defp valid_trigger?(_kind, nil), do: true

  defp valid_trigger?("compact_boundary", trigger),
    do: is_binary(trigger) and MapSet.member?(@valid_triggers, trigger)

  defp valid_trigger?(_kind, _trigger), do: false

  defp valid_at?(at) do
    is_binary(at) and at != "" and byte_size(at) <= @max_at_bytes and
      match?({:ok, _, _}, DateTime.from_iso8601(at))
  end

  defp write_record(table, agent_id, events) do
    with :ok <- :dets.insert(table, {agent_id, events}),
         :ok <- :dets.sync(table) do
      :ok
    end
  end

  defp open_table(name, path) do
    case :dets.open_file(name, file: String.to_charlist(path)) do
      {:ok, ^name} ->
        name

      {:error, reason} ->
        Logger.warning(
          "session lifecycle event store unreadable (#{inspect(reason)}); recreating"
        )

        File.rm(path)
        {:ok, ^name} = :dets.open_file(name, file: String.to_charlist(path))
        name
    end
  end

  defp default_path do
    Application.get_env(:kaoiro_server, :session_lifecycle_events_path) ||
      KaoiroServer.DetsStorePath.default_path("session_lifecycle_events.dets")
  end

  # Single scalar, so a bare Application env key is enough (unlike
  # ConversationStates.load_limits/0's grouped :inter_agent keyword list,
  # which covers five related values) — same "read with a default" shape,
  # a smaller container.
  defp default_cap do
    Application.get_env(:kaoiro_server, :session_lifecycle_max_events_per_agent, 10_000)
  end
end
