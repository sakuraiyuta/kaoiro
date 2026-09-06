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
  round 1/2 must-fix B3) — so a forged, wrong-typed, or corrupted value
  can never reach an operator query; `append/5` itself is total over
  `kind`/`trigger`/`at` (any Elixir term), never crashing on a bad shape.

  `append/5` never raises OR BLOCKS the caller (must-fix B2, round 1/2):
  the write rides `GenServer.cast`, so a store that is down, mid-restart,
  or simply alive-but-slow to reply cannot stall a caller — notably
  `agents_channel.ex`'s session_reset flow, which appends between its
  broadcast and the runner reset instruction. `list_for_agent/2` is a
  read, not a diagnostic side effect, so it stays a bounded
  `GenServer.call` (default 5s timeout) with a `[]` fallback on failure.
  """

  use GenServer

  require Logger

  @wrapper_kinds ~w(
    compacting compact_boundary compact_failed resume_reserved resume_fired
    threshold_notice conversation_reset permission_applied permission_failed
  )
  @server_kinds ~w(
    disconnected reconnecting reconnected session_reset_started
    session_reset_completed
  )
  # `permission_requested` (issue #305, protocol.md "Permission lifecycle
  # audit") is deliberately NOT in `@wrapper_kinds`: the server "never
  # trusts a wrapper-produced permission_requested". It is valid for
  # `record_permission_event/5` (server-only call site,
  # `agents_channel.ex`'s `set_permission` handler) but must be rejected
  # at the wire-ingress layer even though it is a member of the same
  # `@valid_kinds` union `valid_kind?/1` checks — `valid_kind?/1` alone
  # cannot distinguish a call's ORIGIN, only whether the kind string is
  # ever legal, so `wrapper_channel.ex`'s `session_lifecycle` ingress
  # clause carries its own explicit reject for this one kind.
  @permission_kinds ~w(permission_requested permission_applied permission_failed)
  @valid_kinds MapSet.new(@wrapper_kinds ++ @server_kinds ++ @permission_kinds)

  # `trigger` only ever applies to compact_boundary (protocol.md).
  @valid_triggers MapSet.new(~w(request_compact sdk_auto manual))

  # `DateTime.utc_now() |> DateTime.to_iso8601()` is ~27 bytes (microsecond
  # precision); `new Date().toISOString()` on the wrapper side is 24. This
  # leaves headroom without accepting an arbitrarily large string ahead of
  # the ISO-8601 parse below.
  @max_at_bytes 40

  # Permission audit detail bounds (protocol.md "Permission lifecycle
  # audit"): "bounded identifiers/reasons: IDs at most 256 UTF-8 bytes,
  # reason at most 256 UTF-8 bytes, with no prompt, tool input,
  # credentials, or raw SDK error." The closed-key extraction in
  # `sanitize_permission_details/2` is what actually keeps unrelated
  # content out; these bounds catch an oversized but shape-valid value.
  @max_audit_id_bytes 256
  @max_audit_reason_bytes 256
  @audit_sandbox_values ~w(read-only workspace-write danger-full-access)
  @audit_approval_values ~w(untrusted on-request on-failure never)
  @audit_enforcement_values ~w(os mode advisory)
  @max_safe_revision 9_007_199_254_740_991

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
  is unreachable. Always returns `:ok`: recording is diagnostic only, so
  no caller branches on the result, and never blocks (see moduledoc).

  `kind`/`trigger`/`at` are intentionally UNGUARDED here beyond
  `valid_event?/3` itself (ふじ Stage B round 2 must-fix B3-残り,
  2026-08-31): an earlier `is_binary` guard on `trigger` made this
  function crash (`FunctionClauseError`) on a wrong-typed value instead of
  rejecting it as a whole event — the same "sanitize instead of reject"
  trap the wrapper-ingress fix (round 1 B3) closed at the channel layer,
  reopened one layer down. `valid_kind?/1`/`valid_trigger?/2`/`valid_at?/1`
  already start with their own `is_binary` check, so this function is now
  total: no argument shape can crash it.
  """
  def append(agent_id, kind, trigger, at, server \\ __MODULE__)
      when is_binary(agent_id) do
    if valid_event?(kind, trigger, at) do
      cast_append(server, agent_id, kind, trigger, at)
    else
      log_rejected(agent_id, kind, trigger, at)
    end

    :ok
  end

  @doc """
  Appends a permission-lifecycle event (`permission_requested` /
  `permission_applied` / `permission_failed`, issue #305, protocol.md
  "Permission lifecycle audit") with its typed `details`. Same
  never-raises/never-blocks contract as `append/5`. `trigger` does not
  apply to these kinds — `append/5` reserves it for `compact_boundary`
  alone — so this function omits the parameter entirely rather than
  accepting an always-nil placeholder at every call site.

  `details` is validated AND re-extracted into a canonical, closed-key
  map by `sanitize_permission_details/2` before storage — never stored
  verbatim — so an unrecognized extra field (a prompt, tool input, a raw
  SDK error) cannot ride through even if every required field also
  validates.
  """
  def record_permission_event(agent_id, kind, at, details, server \\ __MODULE__)
      when is_binary(agent_id) and kind in @permission_kinds do
    with true <- valid_kind?(kind) and valid_at?(at),
         {:ok, sanitized} <- sanitize_permission_details(kind, details) do
      cast_append(server, agent_id, kind, nil, at, sanitized)
    else
      _ -> log_rejected(agent_id, kind, nil, at)
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
  is a non-empty, bounded, actual ISO-8601 timestamp. Delegates to
  `valid_event?/4` with `details: nil` — every non-permission kind
  requires absent details (director ruling: "既存 event の validator は
  緩めない").
  """
  def valid_event?(kind, trigger, at), do: valid_event?(kind, trigger, at, nil)

  @doc """
  Same as `valid_event?/3`, additionally checking `details` against the
  kind's closed shape: `nil` for every non-permission kind, or a
  `sanitize_permission_details/2`-shaped map for the three permission
  kinds. Used both by `record_permission_event/5` (fresh ingestion) and
  boot-load re-validation of a previously-stored record.
  """
  def valid_event?(kind, trigger, at, details) do
    valid_kind?(kind) and valid_trigger?(kind, trigger) and valid_at?(at) and
      valid_details?(kind, details)
  end

  defp valid_details?(kind, nil) when kind not in @permission_kinds, do: true
  defp valid_details?(kind, _details) when kind not in @permission_kinds, do: false

  defp valid_details?(kind, details) do
    match?({:ok, _sanitized}, sanitize_permission_details(kind, details))
  end

  defp log_rejected(agent_id, kind, trigger, at) do
    Logger.warning(
      "session_lifecycle event rejected (kind=#{inspect(kind)} " <>
        "trigger=#{inspect(trigger)} at=#{inspect(at)} fails the " <>
        "protocol.md vocabulary); event dropped, agent_id=#{agent_id}"
    )
  end

  # ---- permission audit detail shapes (issue #305) -----------------------
  #
  # Closed-key extraction, not passthrough validation: each function
  # accepts ONLY the fields listed and rebuilds a fresh map from them, so
  # an extra key on the input (a prompt, tool input, a raw SDK error) is
  # silently absent from the output rather than merely "not checked for".

  defp sanitize_permission_details("permission_requested", details),
    do: sanitize_permission_requested(details)

  defp sanitize_permission_details("permission_applied", details),
    do: sanitize_permission_observation_details(details)

  defp sanitize_permission_details("permission_failed", details),
    do: sanitize_permission_failed(details)

  @permission_requested_keys ~w(revision requested actor previous)
  defp sanitize_permission_requested(
         %{
           "revision" => revision,
           "requested" => requested,
           "actor" => actor
         } = details
       )
       when map_size(details) <= 4 do
    with [] <- Map.keys(details) -- @permission_requested_keys,
         true <- valid_revision?(revision),
         {:ok, sanitized_requested} <- sanitize_requested(requested),
         {:ok, sanitized_actor} <- sanitize_actor(actor),
         {:ok, previous} <- sanitize_optional_previous(Map.get(details, "previous")) do
      {:ok,
       %{"revision" => revision, "requested" => sanitized_requested, "actor" => sanitized_actor}
       |> maybe_put_previous(previous)}
    else
      _ -> :error
    end
  end

  defp sanitize_permission_requested(_other), do: :error

  @permission_failed_keys ~w(revision requested reason execution_id rolled_back_to)
  defp sanitize_permission_failed(
         %{
           "revision" => revision,
           "requested" => requested,
           "reason" => reason
         } = details
       )
       when map_size(details) <= 5 do
    with [] <- Map.keys(details) -- @permission_failed_keys,
         true <- valid_revision?(revision),
         {:ok, sanitized_requested} <- sanitize_requested(requested),
         true <- valid_audit_reason?(reason),
         {:ok, execution_id} <- sanitize_optional_audit_id(Map.get(details, "execution_id")),
         {:ok, rolled_back_to} <-
           sanitize_optional_rolled_back_to(Map.get(details, "rolled_back_to")) do
      {:ok,
       %{"revision" => revision, "requested" => sanitized_requested, "reason" => reason}
       |> maybe_put_field("execution_id", execution_id)
       |> maybe_put_field("rolled_back_to", rolled_back_to)}
    else
      _ -> :error
    end
  end

  defp sanitize_permission_failed(_other), do: :error

  # `permission_applied`'s details ARE a `PermissionObservation` plus an
  # optional `previous` (also a `PermissionObservation`) — no separate
  # top-level fields of its own, so this delegates straight to the shared
  # observation sanitizer.
  defp sanitize_permission_observation_details(%{} = details) do
    with {:ok, observation} <- sanitize_observation_core(Map.delete(details, "previous")),
         {:ok, previous} <- sanitize_optional_previous(Map.get(details, "previous")) do
      {:ok, maybe_put_previous(observation, previous)}
    else
      _ -> :error
    end
  end

  defp sanitize_permission_observation_details(_other), do: :error

  defp sanitize_optional_previous(nil), do: {:ok, nil}
  defp sanitize_optional_previous(value), do: sanitize_observation_core(value)

  defp maybe_put_previous(map, nil), do: map
  defp maybe_put_previous(map, previous), do: Map.put(map, "previous", previous)

  @observation_keys ~w(revision requested execution_id session_id turn_id network_access permission)
  defp sanitize_observation_core(
         %{
           "revision" => revision,
           "requested" => requested,
           "execution_id" => execution_id,
           "session_id" => session_id,
           "turn_id" => turn_id,
           "network_access" => network_access,
           "permission" => permission
         } = details
       )
       when is_boolean(network_access) and map_size(details) <= 7 do
    with [] <- Map.keys(details) -- @observation_keys,
         true <- valid_revision?(revision),
         {:ok, sanitized_requested} <- sanitize_requested(requested),
         true <- valid_audit_id?(execution_id),
         true <- valid_audit_id?(session_id),
         true <- valid_audit_id?(turn_id),
         {:ok, sanitized_permission} <- sanitize_permission_axes(permission) do
      {:ok,
       %{
         "revision" => revision,
         "requested" => sanitized_requested,
         "execution_id" => execution_id,
         "session_id" => session_id,
         "turn_id" => turn_id,
         "network_access" => network_access,
         "permission" => sanitized_permission
       }}
    else
      _ -> :error
    end
  end

  defp sanitize_observation_core(_other), do: :error

  @permission_axes_keys ~w(sandbox approval enforcement)
  defp sanitize_permission_axes(%{"sandbox" => sandbox, "approval" => approval} = permission)
       when sandbox in @audit_sandbox_values and approval in @audit_approval_values and
              map_size(permission) <= 3 do
    with [] <- Map.keys(permission) -- @permission_axes_keys do
      sanitize_permission_axes_enforcement(sandbox, approval, permission)
    else
      _ -> :error
    end
  end

  defp sanitize_permission_axes(_other), do: :error

  defp sanitize_permission_axes_enforcement(sandbox, approval, permission) do
    case Map.get(permission, "enforcement") do
      nil ->
        {:ok, %{"sandbox" => sandbox, "approval" => approval}}

      enforcement when enforcement in @audit_enforcement_values ->
        {:ok, %{"sandbox" => sandbox, "approval" => approval, "enforcement" => enforcement}}

      _invalid ->
        :error
    end
  end

  defp sanitize_requested(%{"sandbox" => sandbox, "network_access" => network_access} = requested)
       when sandbox in @audit_sandbox_values and is_boolean(network_access) and
              map_size(requested) == 2 do
    {:ok, %{"sandbox" => sandbox, "network_access" => network_access}}
  end

  defp sanitize_requested(_other), do: :error

  defp sanitize_actor(%{"kind" => "user", "id" => id} = actor)
       when map_size(actor) == 2 do
    if valid_audit_id?(id), do: {:ok, %{"kind" => "user", "id" => id}}, else: :error
  end

  defp sanitize_actor(_other), do: :error

  defp sanitize_optional_audit_id(nil), do: {:ok, nil}

  defp sanitize_optional_audit_id(value),
    do: if(valid_audit_id?(value), do: {:ok, value}, else: :error)

  defp sanitize_optional_rolled_back_to(nil), do: {:ok, nil}
  defp sanitize_optional_rolled_back_to(value), do: sanitize_requested(value)

  defp maybe_put_field(map, _key, nil), do: map
  defp maybe_put_field(map, key, value), do: Map.put(map, key, value)

  defp valid_revision?(revision),
    do: is_integer(revision) and revision >= 0 and revision <= @max_safe_revision

  # `"client_socket:"` is `Auth.socket_id/1`/`oauth_socket_id/2`'s fixed
  # prefix (a credential fingerprint, issue #47) — rejecting it here closes
  # the READ side of issue #305 M1 (クロエ round 2): a `permission_requested`
  # record written by the pre-M1 code (actor.id = socket_id) would
  # otherwise still validate on boot-load / list_session_events and keep
  # surfacing the digest to operators after the WRITE side was fixed.
  # Applied to every audit id (execution_id/session_id/turn_id too, not
  # only actor.id) — none of those are ever wrapper/engine-supplied in
  # this shape, so the restriction only ever fires on the class this
  # closes.
  defp valid_audit_id?(value),
    do:
      is_binary(value) and value != "" and byte_size(value) <= @max_audit_id_bytes and
        not String.starts_with?(value, "client_socket:")

  defp valid_audit_reason?(value),
    do: is_binary(value) and value != "" and byte_size(value) <= @max_audit_reason_bytes

  @impl true
  def init({name, path, cap}) do
    KaoiroServer.DetsStorePath.prepare_parent!(path)
    table = open_table(name, path)
    _ = File.chmod(path, 0o600)
    {:ok, %{table: table, events: load_events(table, cap), cap: cap}}
  end

  @impl true
  def handle_cast({:append, agent_id, kind, trigger, at, details}, state) do
    event = %{kind: kind, trigger: trigger, at: at, details: details}
    existing = Map.get(state.events, agent_id, [])
    updated = Enum.take([event | existing], state.cap)

    case write_record(state.table, agent_id, updated) do
      :ok ->
        {:noreply, %{state | events: Map.put(state.events, agent_id, updated)}}

      {:error, reason} ->
        Logger.warning(
          "session_lifecycle event store write failed (#{inspect(reason)}); event dropped"
        )

        {:noreply, state}
    end
  end

  @impl true
  def handle_call({:list_for_agent, agent_id}, _from, state) do
    {:reply, Map.get(state.events, agent_id, []), state}
  end

  @impl true
  def terminate(_reason, state), do: :dets.close(state.table)

  # `GenServer.cast/2` never blocks or raises for the CALLER, regardless
  # of whether `server` is alive, mid-restart, or simply slow to process
  # its mailbox (ふじ Stage B round 2 must-fix B2-残り, 2026-08-31): a
  # bounded `GenServer.call` — round 1's fix — still stalls the caller for
  # up to its full timeout (measured 5,010ms) against a store that is
  # ALIVE but has not yet gotten to this message, which is exactly the
  # instrumentation-changes-the-observed-outcome failure the moduledoc
  # warns about. `cast/2` itself stays silent about a missing/dead name,
  # so `store_alive?/1` checks first purely to keep the round 1 log line;
  # the TOCTOU window between the check and the cast is harmless — a cast
  # to a name that dies in between is still just as silently dropped.
  defp cast_append(server, agent_id, kind, trigger, at, details \\ nil) do
    if store_alive?(server) do
      GenServer.cast(server, {:append, agent_id, kind, trigger, at, details})
    else
      Logger.warning(
        "SessionLifecycleEvents store unavailable (not running); event dropped, " <>
          "agent_id=#{agent_id}"
      )
    end
  end

  defp store_alive?(server) when is_pid(server), do: Process.alive?(server)
  defp store_alive?(server), do: Process.whereis(server) != nil

  # Bounded `GenServer.call` (default 5s timeout) that turns a dead store
  # into a logged no-op instead of an `exit` propagating to the caller — a
  # plain `rescue` cannot catch this: `GenServer.call` signals failure via
  # `exit/1`, not a raised exception (ふじ Stage B round 1 must-fix B2).
  # `list_for_agent/2`'s only remaining caller; `append/5` casts instead
  # (round 2 must-fix B2-残り, above) since a read tolerates staying
  # bounded where a diagnostic write must never block its caller at all.
  defp safe_call(server, msg, fallback) do
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

  # `Map.get/2` defaults `details` to `nil` for a record stored before
  # this field existed (migration compatibility) — absent and explicit
  # `nil` are the same value to a pre-existing non-permission event.
  defp valid_stored_event?(%{kind: kind, trigger: trigger, at: at} = event),
    do: valid_event?(kind, trigger, at, Map.get(event, :details))

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
