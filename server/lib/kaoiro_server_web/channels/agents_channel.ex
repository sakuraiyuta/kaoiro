defmodule KaoiroServerWeb.AgentsChannel do
  @moduledoc """
  Client-facing fan-out. After joining `agents:lobby` the channel pushes a
  `snapshot` event with the current agent_id => latest envelope map;
  `envelope` broadcasts follow as agents change state. Both are sanitized
  per role via an **allow-list** policy (ADR-0021): operators receive the
  full stream, viewers receive only what is explicitly cleared for them.
  Today that means `state_change` (with `ext` stripped) and `agent_deleted`;
  `permission_request` is rewritten to a synthetic `state_change` so the
  grid still tracks `waiting_permission` without leaking `tool_name` /
  `input` / `request_id`. Every other event/type is dropped for viewers
  (fail-closed for any future addition).

  Operators additionally get a `history` push (the per-agent reply log)
  on join and the live `log` / `result` reply envelopes; viewers receive
  neither, since reply lines carry tool I/O that may hold secrets
  (ADR-0012, specs/threat-model.md).

  `handle_out`'s role gate above reads `socket.assigns[:role]`, the
  role `ClientSocket.connect/3` resolved — a snapshot, not re-checked
  per envelope (the per-subscriber-per-envelope cost of doing so was
  weighed and rejected, issue #158/#170). `join/3` re-resolves that
  snapshot live once, right before completing the join: an allow-list
  change landing in the connect-to-join gap can otherwise race past
  `KaoiroServer.OAuthAllowlistWatcher`'s disconnect broadcast (issue
  #170 must-fix 2 — the transport's disconnect-topic subscription is
  not yet live at `connect/3` return time, but always is by `join/3`).
  A mismatch here refuses the join instead of proceeding, so a stale
  role never gets the operator-only `snapshot`/`history`/`hosts` push
  in the first place. The re-solved role, once fan-out is under way,
  goes stale again until something forces a reconnect — the watcher's
  ongoing per-identity disconnects (triggered by allow-list edits) and
  `current_role/1`'s per-operator-action re-resolution (#158) are what
  keep that window bounded, not this gate on its own.

  Inbound (Phase 3, specs/protocol.md): `instruction`,
  `permission_decision`, `interrupt` (issue #51), and `set_model` /
  `set_effort` (issue #54) are accepted from operator clients only and
  relayed to the target wrapper topic without interpreting the content
  (agent-agnostic). No delivery guarantee — a
  relay to a disconnected wrapper is lost and the requester learns via
  timeout (ADR-0011). `clear_history` (operator-only, issue #48) drops
  the server-side reply log of past sessions and broadcasts
  `history_cleared` so every client re-filters its transcript; it touches
  only the in-memory ring buffer, never the wrapper's session logs.
  `delete_agent` (operator-only, issue #14; extended by ADR-0030 D6)
  purges an offline agent from every server-side store — `AgentStates`
  (memory) + `AgentDirectory` / `SessionPointers` / `PermissionModes`
  (persistent) — and broadcasts `agent_deleted` so every client drops it
  from the grid. Accepts both AgentStates-known disconnected agents and
  directory-only entries whose AgentStates counterpart is absent (server
  restarted with only the DETS-persisted identity, or a restore that never
  succeeded); a still-live agent is rejected via the AgentStates
  disconnected guard so it cannot be dropped from under its wrapper.

  Host lifecycle (ADR-0023, issue #67): `spawn` / `stop` / `restart` /
  `enumerate_sessions` are operator-only and relay to the addressed
  `runner:<host_id>` without interpreting the payload (host/agent-agnostic,
  like the wrapper relay). `spawn` additionally rejects an `agent_id` that
  is already running (server-stage dedup, the runner-local lock being the
  second stage, issue #68). `enumerate_sessions` also resolves `cwd` from
  the agent's SessionPointer when the client omits it (detail-view path —
  the wrapper may not yet have reported ext.cwd), so the runner still
  receives the `{cwd}` shape it expects. `resume_session` swaps a live
  agent's active session to an operator-picked session_id (kill + relaunch
  inside the runner supervisor entry), or reuses the restore path for a
  disconnected one; the wire is server-authoritative — the client supplies
  only agent_id + session_id, cwd is preserved. The runner's replies
  (`runner_sessions` / `spawn_result`) and host registration updates
  (`hosts`) ride `agents:lobby` but are operator-only in handle_out —
  host/session info must never reach a viewer (#27/ADR-0021, fail-closed).

  `launch_defaults` (issue #88) is operator-only like the rest of the
  launch UI's requests but, unlike them, never touches the runner: it
  replies synchronously with a persona-scoped `%{persona_id => effort}`
  map computed by joining `AgentDirectory` and `SessionPointers` at read
  time (see `launch_defaults/0`), so LaunchDialog can default a persona's
  effort picker to whatever it last committed. No new persistent store —
  the 2026-07-23 scope decision on the issue found the two existing
  stores already carry everything needed.
  """

  use Phoenix.Channel

  require Logger

  alias KaoiroServer.AgentDirectory
  alias KaoiroServer.AgentActivity
  alias KaoiroServer.AgentStates
  alias KaoiroServer.Auth
  alias KaoiroServer.ClearWatermarks
  alias KaoiroServer.ConversationStates
  alias KaoiroServer.DeliveryStates
  alias KaoiroServer.HostRegistry
  alias KaoiroServer.PersonaAssets
  alias KaoiroServer.PlannedDisconnects
  alias KaoiroServer.QuagmireWatch
  alias KaoiroServer.SessionLifecycleEvents
  alias KaoiroServer.SessionPointers
  alias KaoiroServer.SessionResets
  alias KaoiroServer.TaskStates
  alias KaoiroServer.TokenDenylist
  alias KaoiroServer.TransportLimits
  alias KaoiroServer.Users
  alias KaoiroServerWeb.AgentId
  alias KaoiroServerWeb.ClientSocket
  alias KaoiroServerWeb.PeerConnectivity
  alias KaoiroServerWeb.SynthEnvelope

  # Resource bound for an operator instruction; generous for prose,
  # far below the wrapper-side envelope cap.
  @max_instruction_bytes 65_536

  # Aggregate cap on the relayed payload (issue #26). Extra keys pass
  # through opaquely for forward-compat, so a per-key check is not enough;
  # this bounds the whole map. Sized above a max instruction (text alone
  # may reach @max_instruction_bytes) plus the decision/extra-key overhead.
  @max_relay_bytes 131_072

  # Final per-pane display cap (ADR-0051 D6). Applies to the MERGED
  # transcript + IA projection, so the two sources cannot add up past it.
  @max_projection 200

  # All viewer-gated events go through handle_out. `agent_deleted` also
  # intercepts so its client frame is stamped by the same sole egress point
  # while preserving its existing delivery to both roles. The runner →
  # operator events (`runner_sessions` / `spawn_result` / `hosts`) carry
  # host/session info and are operator-only (ADR-0023, ADR-0021).
  intercept([
    "agent_deleted",
    "envelope",
    "history_cleared",
    "history_reset",
    "history_replay_complete",
    # Restored IA row addressed to ONE pane (ADR-0051 D3-3 追補). Operator-
    # only like every other transcript event; intercepted so handle_out can
    # gate it rather than letting it reach viewers who hold no reply log.
    "history_replay_envelope",
    "runner_sessions",
    "spawn_result",
    "hosts",
    # Engine-catalog probe outcome (Option E, ADR-0039). Operator-only
    # like the other runner→operator broadcasts on this topic; carries a
    # runner-scoped host_id + engine + request_id so the client can toast
    # the paired LaunchDialog refresh.
    "catalog_result",
    # Session-reset lifecycle broadcasts (ADR-0036 F7, phase-17 17-4).
    # previous_session_id / to_session_id are session identifiers that
    # ADR-0021 keeps operator-only; the intercept lets handle_out gate
    # them the same way runner_sessions / spawn_result / hosts are gated.
    "session_reset_started",
    "session_reset_completed",
    "session_reset_failed",
    # Recipient dispatch watermarks are an operator diagnostic (issue #247).
    # Keep live updates behind the same role gate as their join-time snapshot.
    "delivery_status",
    # Review-quagmire notice (issue #273). Names agent pairs and their
    # traffic volume, so it is operator-only like the diagnostics above.
    # Deliberately NOT a join snapshot frame: a joining operator reads the
    # current picture from list_conversations / delivery_snapshot, and this
    # event is edge-triggered rather than a state projection.
    "quagmire_notice",
    # Connected wrapper artifact identity is operator-only, like host build
    # identity; viewers do not receive package provenance.
    "wrapper_build_info",
    # Live directory refresh after a rename (issue #197 段階3, D16). The
    # join-time push (`handle_info(:after_join, ...)` above) was the only
    # producer of this event before rename existed, so it was never
    # broadcast and therefore never needed interception; a rename now
    # broadcasts it to every already-joined operator, and viewers must
    # not receive AgentDirectory contents (ADR-0030 D10) — same
    # operator-only gate as `history_cleared`.
    "directory"
  ])

  # Every server -> client event must leave through `push_versioned/3`.
  # Internal PubSub broadcasts deliberately do not carry a wire version:
  # that keeps the stamp's source of truth at the client boundary.
  @client_event_policy MapSet.new(~w(
    snapshot task_snapshot delivery_snapshot history hosts directory
    history_cleared history_reset history_replay_complete
    history_replay_envelope agent_deleted delivery_status quagmire_notice
    session_reset_started session_reset_completed session_reset_failed
    envelope spawn_result runner_sessions catalog_result wrapper_build_info
  ))

  @join_snapshot_events [
    {"snapshot", "agents"},
    {"task_snapshot", "tasks"},
    {"delivery_snapshot", "deliveries"}
  ]

  def client_event_policy, do: @client_event_policy

  def join_snapshot_events, do: Map.new(@join_snapshot_events)

  def validate_join_snapshot_frames(frames) when is_map(frames) do
    expected_events = MapSet.new(Enum.map(@join_snapshot_events, &elem(&1, 0)))
    actual_events = MapSet.new(Map.keys(frames))

    if MapSet.equal?(expected_events, actual_events) and
         Enum.all?(@join_snapshot_events, fn {event, key} ->
           is_map(frames[event]) and Map.has_key?(frames[event], key)
         end) do
      :ok
    else
      {:error, :snapshot_frame_key_mismatch}
    end
  end

  # Error reasons cleared for verbatim return to the client (issue #62).
  # Anything outside this set is a bug or a future internal value (a
  # tuple, an internal path, a stack fragment) and must not leak through
  # `to_string/1`; `safe_reason/1` logs it and returns "internal_error".
  @safe_reasons ~w(forbidden unknown_agent not_disconnected noop
                   payload_too_large missing_agent_id invalid_agent_id
                   already_running missing_host_id invalid_host_id
                   unknown_host unknown_persona invalid_persona
                   cwd_not_allowed invalid_cwd invalid_name no_session
                   missing_session_id invalid_session_id
                   unknown_upload invalid_engine engine_not_supported
                   agent_busy agent_not_owned unsupported_session_reset
                   session_reset_pending reserved_session_command
                   invalid_mode missing_user_id invalid_user_id
                   unknown_user revision_exhausted
                   missing_conversation_id conversation_closed
                   unknown_conversation_id invalid_approval)a

  # session_id charset — mirrors runner/src/sessions.ts SESSION_ID_PATTERN
  # (Claude Code's UUID-shaped JSONL filenames). Validated at this boundary so
  # a path-separator or dot injection cannot ride into the wrapper's
  # `--resume` arg or the F4 same-session lock via server → runner.
  # Roles that hold operator capabilities (ADR-0050 D2: admin > operator >
  # viewer). Every operator-vs-viewer gate in this module reads this list
  # instead of comparing to `:operator`, because the gates are spread over
  # a dozen sites — snapshot keys, six `handle_out` pushes, the inbound
  # `require_operator/1`, the envelope allow-list, and the reset guard.
  # Enumerating them one by one is how a new role silently loses half its
  # visibility: adding admin to `require_operator/1` alone would have let
  # an admin issue every operator command while receiving none of the
  # operator-only pushes. A module attribute (not a function) so it stays
  # usable in guards.
  @operator_capable_roles [:operator, :admin]

  @session_id_pattern ~r/^[A-Za-z0-9-]{1,128}$/

  # Display-name bound shared by `apply_custom_name/2` (spawn-time, #22)
  # and `validate_rename_name/1` (live rename, issue #197 段階3): both
  # enforce the SAME 64-grapheme-cluster / no-control-char rule, so the
  # rule lives in one place rather than two independently-typed regexes
  # that could drift. `String.length/1` counts grapheme clusters, not
  # UTF-16 code units or code points (matches the bound this repo's other
  # display_name validators use, e.g. `WrapperChannel.valid_display_name/1`,
  # issue #197 段階2 MF-1).
  @display_name_max_graphemes 64
  @display_name_control_char_pattern ~r/[\x00-\x1f\x7f]/

  @impl true
  def join("agents:lobby", _params, socket) do
    # Re-resolve live before completing the join (issue #170 must-fix 2,
    # ふじ 2026-08-05): connect/3 resolved a role that may have gone
    # stale in the window between connect and this join if the
    # allow-list changed in between and OAuthAllowlistWatcher's
    # disconnect broadcast raced the transport's socket-id subscription
    # (Phoenix.Socket.__init__/1 subscribes AFTER connect/3 returns, so
    # a broadcast fired in that gap is missed and never resent — the
    # watcher's checkpoint has already advanced past that diff). By the
    # time join/3 runs the subscription has always completed, so
    # current_role/1's disconnect here is never itself racy. A mismatch
    # refuses the join instead of proceeding to :after_join, which would
    # otherwise push the operator-only snapshot/history/hosts payload
    # under the stale role.
    if current_role(socket) == socket.assigns[:role] do
      # The PubSub subscription only becomes active once join/3 returns, so
      # a snapshot replied here could miss an envelope broadcast in between.
      # Pushing it from handle_info runs after the subscription is live; a
      # broadcast racing the snapshot is then delivered twice at worst
      # (idempotent: last write per agent_id wins), never lost.
      send(self(), :after_join)
      {:ok, socket}
    else
      {:error, %{reason: safe_reason(:forbidden)}}
    end
  end

  @impl true
  def handle_info(:after_join, socket) do
    role = socket.assigns[:role]

    agents =
      AgentStates.snapshot()
      |> Enum.flat_map(fn {id, envelope} ->
        case sanitize_envelope_for(role, envelope) do
          :drop -> []
          {:ok, sanitized} -> [{id, sanitized}]
        end
      end)
      |> Map.new()

    {agents, snapshot_incomplete?} = AgentStates.wire_projection(agents)

    # issue #180 (ADR-0048 F3): the active task set rides the dedicated
    # join-time task_snapshot frame. Operator-only (こはく決定 2026-08-09):
    # F5's progress meta (summary/last_tool_name) is content-bearing, the
    # issue's own goal is operator-facing, and ADR-0021 F2's fail-closed
    # default is "narrow unless asked" — an empty map for viewer, exactly
    # like every other role-gated field on this push, rather than a
    # separate `sanitize_envelope_for` clause per task (the existing
    # `:operator` / `:viewer` catch-alls in that function already gate
    # `type=task` correctly for the LIVE broadcast path;
    # see handle_out("envelope", ...) below — this key mirrors the same
    # policy for the snapshot path specifically).
    tasks = if role in @operator_capable_roles, do: TaskStates.snapshot(), else: %{}

    {deliveries, delivery_snapshot_incomplete?} =
      if role in @operator_capable_roles,
        do: DeliveryStates.wire_projection(),
        else: {%{}, false}

    agent_snapshot = %{"agents" => agents}

    agent_snapshot =
      if snapshot_incomplete?,
        do: Map.put(agent_snapshot, "snapshot_incomplete", true),
        else: agent_snapshot

    delivery_snapshot = %{"deliveries" => deliveries}

    delivery_snapshot =
      if delivery_snapshot_incomplete?,
        do: Map.put(delivery_snapshot, "snapshot_incomplete", true),
        else: delivery_snapshot

    snapshot_frames = %{
      "snapshot" => agent_snapshot,
      "task_snapshot" => %{"tasks" => tasks},
      "delivery_snapshot" => delivery_snapshot
    }

    :ok = validate_join_snapshot_frames(snapshot_frames)

    Enum.each(@join_snapshot_events, fn {event, _key} ->
      push_versioned(socket, event, Map.fetch!(snapshot_frames, event))
    end)

    # Reply-log history, host set, and the identity ledger are operator-only;
    # viewers stay at the grid and never see host info (cwd allow-lists are
    # sensitive, #46) or the offline-agent directory (ADR-0030 D10). The
    # directory carries persona (+ operator-picked custom name) so the client
    # can render offline agents' tiles for the restore UI (ADR-0030 D5).
    if role in @operator_capable_roles do
      # `clear_watermarks` (issue #109) rides the same push as a
      # display-only hint (agent_id => ISO ts) so a live dashboard can
      # show "cleared at ..." without a follow-up round trip. The
      # authoritative filter has already run server-side inside
      # `merged_histories/0` before this push — the client does NOT do
      # its own IA fanOut anymore (ふじ M6/M7 fix, 2026-07-23). Missing
      # key on a legacy client is ignored (additive, no protocol
      # version bump).
      #
      # `history_projection: "per-pane-v1"` (ふじ R3 must-fix, 2026-07-23)
      # is the wire marker that this payload has already been fanned out
      # to both sender and receiver panes per envelope. Old clients that
      # do their own fanOut recognize the marker's absence (legacy
      # servers) and keep fanning. New clients that see the marker skip
      # fanOut so they do not double-count the sender copy. Marker
      # values are additive — future projections bump the version tag,
      # never remove the field.
      #
      # `projection_epoch` (ADR-0051 D4) identifies THIS projection's
      # lifetime. A tab that reconnects across a server restart sees a
      # different value and discards the baseline it would otherwise
      # merge into — the ghost-log fix. Absent on a legacy server, where
      # the client keeps its old merge behaviour.
      push_versioned(socket, "history", history_payload())

      push_versioned(
        socket,
        "hosts",
        hosts_payload(HostRegistry.snapshot(PersonaAssets.all_personas()))
      )

      push_versioned(socket, "directory", directory_payload(AgentDirectory.all()))

      push_versioned(
        socket,
        "wrapper_build_info",
        wrapper_build_info_payload(KaoiroServer.WrapperBuildInfos.snapshot())
      )
    end

    {:noreply, socket}
  end

  @impl true
  def handle_out("envelope", envelope, socket) do
    case sanitize_envelope_for(socket.assigns[:role], envelope) do
      :drop -> :ok
      {:ok, sanitized} -> push_versioned(socket, "envelope", sanitized)
    end

    {:noreply, socket}
  end

  # Viewers hold no reply log, so a history_cleared broadcast has nothing
  # to act on; gate it to operator under the same allow-list discipline
  # (ADR-0021) instead of letting it leak the session_id pointer.
  @impl true
  def handle_out("history_cleared", payload, socket) do
    if socket.assigns[:role] in @operator_capable_roles do
      push_versioned(socket, "history_cleared", payload)
    end

    {:noreply, socket}
  end

  # Live directory refresh after a rename (issue #197 段階3, D16). Same
  # operator-only gate as the join-time push this event previously only
  # ever rode (`handle_info(:after_join, ...)` above) — a viewer must not
  # receive AgentDirectory contents (ADR-0030 D10).
  #
  # `payload` here is the RAW `persona_id` + `display_name` broadcast
  # `AgentDirectory.rename/3` sends (issue #219 D19) — join against the
  # CURRENT PersonaAssets manifest happens HERE, per subscriber, not at
  # broadcast time (see `agent_directory.ex`'s own broadcast comment for
  # why: this keeps `AgentDirectory` free of a PersonaAssets dependency
  # without reordering anything, since `handle_out` processes each
  # subscriber's mailbox in the same order the GenServer broadcast them
  # and never re-reads `AgentDirectory`). Uses the SAME
  # `join_directory_entries/1` the join-time push above uses, so a
  # reconnecting client sees an identical shape on both paths.
  @impl true
  def handle_out("directory", %{"entries" => raw_entries}, socket) do
    if socket.assigns[:role] in @operator_capable_roles do
      push_versioned(socket, "directory", directory_payload(raw_entries))
    end

    {:noreply, socket}
  end

  @impl true
  def handle_out("hosts", %{"hosts" => hosts}, socket) when is_map(hosts) do
    if socket.assigns[:role] in @operator_capable_roles do
      push_versioned(socket, "hosts", hosts_payload(hosts))
    end

    {:noreply, socket}
  end

  # Resume reconstruction reset (issue #50, ADR-0014 phase-2): viewers hold no
  # reply log, so gate it operator-only like history_cleared (ADR-0021). The
  # operator clears the agent's transcript before the replayed `log` lines
  # (themselves operator-only) rebuild it.
  @impl true
  def handle_out("history_reset", payload, socket) do
    if socket.assigns[:role] in @operator_capable_roles do
      push_versioned(socket, "history_reset", payload)
    end

    {:noreply, socket}
  end

  @impl true
  def handle_out("history_replay_complete", payload, socket) do
    if socket.assigns[:role] in @operator_capable_roles do
      push_versioned(socket, "history_replay_complete", payload)
    end

    {:noreply, socket}
  end

  # One restored inter-agent row, with the pane it belongs to (ADR-0051 D3-3
  # 追補 / ふじ 30-10 must-fix M2). Sent as its own event precisely so the
  # client does NOT re-fan it across `agent_id ∪ payload.to` the way an
  # ordinary `envelope` is fanned: the pane was decided server-side from the
  # replaying wrapper's channel assigns. Operator-only, like the reset and
  # completion boundaries that bracket it.
  @impl true
  def handle_out("history_replay_envelope", payload, socket) do
    if socket.assigns[:role] in @operator_capable_roles do
      push_versioned(socket, "history_replay_envelope", payload)
    end

    {:noreply, socket}
  end

  # This event intentionally has no role gate. Before it was intercepted it
  # reached viewers by Phoenix's default relay; preserving that behaviour is
  # outside this issue's policy scope, while the funnel owns its wire stamp.
  @impl true
  def handle_out("agent_deleted", payload, socket) do
    push_versioned(socket, "agent_deleted", payload)
    {:noreply, socket}
  end

  # Runner → operator events (ADR-0023). All three carry host-level info
  # (host_id, cwd, session metadata, cwd allow-lists) that is operator-only
  # under the allow-list discipline (ADR-0021): drop them for viewers
  # (fail-closed). Same gate shape as history_cleared.
  @impl true
  def handle_out(event, payload, socket)
      when event in [
             "runner_sessions",
             "spawn_result",
             "hosts",
             # Engine-catalog probe outcome (Option E, ADR-0039).
             # Operator-only like the other runner→operator broadcasts.
             "catalog_result",
             # Session-reset lifecycle broadcasts (ADR-0036 F7, phase-17
             # 17-4). Carry previous_session_id / to_session_id, which
             # ADR-0021 keeps operator-only — same allow-list shape as
             # runner_sessions et al.
             "session_reset_started",
             "session_reset_completed",
             "session_reset_failed",
             "delivery_status",
             "quagmire_notice",
             "wrapper_build_info"
           ] do
    if socket.assigns[:role] in @operator_capable_roles do
      push_versioned(socket, event, payload)
    end

    {:noreply, socket}
  end

  # ADR-0015 stage 2's only client-facing egress point (issue #270 MF-4).
  defp push_versioned(socket, event, payload) when is_map(payload) do
    unless MapSet.member?(@client_event_policy, event) do
      raise ArgumentError,
            "#{event} is not declared in @client_event_policy (ADR-0015 stage 2)"
    end

    push(socket, event, Map.put(payload, "version", "0"))
  end

  # Fail-closed SHAPE gate for every inbound JSON event (ふじ #218 レビュー
  # MF-1). `payload` is raw wire input: a client speaking the Phoenix
  # protocol directly can put any JSON term where the handlers all assume a
  # map, and map operations raise `BadMapError` / `FunctionClauseError` on a
  # scalar — crashing the channel process BEFORE any role gate runs.
  #
  # This is a CLASS, not one site: `Map.delete/2` in the relay normalize,
  # `payload["text"]` in `reject_reserved_session_command/1`, `Map.has_key?/2`
  # in `check_keys/2` all have it, and each is reached through a different
  # handler prologue. Rejecting the shape once, ahead of every clause, is
  # what closes it — patching the individual call sites leaves whichever
  # prologue the next handler happens to add.
  #
  # `missing_agent_id` keeps the closed reason vocabulary unchanged: it is
  # what `fetch_agent_id/1` already returns for this exact input, and what
  # the pre-#218 ordering replied. `attach_chunk` is excluded because its
  # payload is legitimately NOT a map (a `{:binary, data}` V2 frame); its
  # own clause below handles the valid shape and drops anything else.
  @impl true
  def handle_in(event, payload, socket)
      when event != "attach_chunk" and not is_map(payload) do
    {:reply, {:error, %{reason: safe_reason(:missing_agent_id)}}, socket}
  end

  def handle_in("instruction", payload, socket) do
    # One live resolution per handler, shared by the guard and the relay
    # (ふじ must-fix B on issue #158).
    role = current_role(socket)

    with :ok <- reject_reserved_session_command(payload),
         :ok <- guard_against_reset_pending(role, payload) do
      relay(
        socket,
        payload,
        "instruction",
        [{"text", &valid_instruction_text?/1}],
        role
      )
    else
      {:error, reason} ->
        {:reply, {:error, %{reason: safe_reason(reason)}}, socket}
    end
  end

  def handle_in("permission_decision", payload, socket) do
    relay(socket, payload, "permission_decision", [
      {"request_id", &is_binary/1},
      {"allow", &is_boolean/1}
    ])
  end

  # AskUserQuestion answer (issue #78, ADR-0027). Operator-only; the validated
  # answers relay opaquely to the wrapper, which returns them to the SDK as the
  # tool's structured answer. `cancelled` (deny) passes through opaquely.
  def handle_in("question_response", payload, socket) do
    relay(socket, payload, "question_response", [
      {"request_id", &is_binary/1},
      {"answers", &is_map/1}
    ])
  end

  # Graceful stop of the current turn (issue #51, ADR-0020). Payload is
  # `{}` after agent_id is stripped — no per-event keys to validate; the
  # shared relay guards (operator, known agent, size cap) still apply.
  # Wrapper-side no-op when no turn is in flight (protocol.md A6).
  def handle_in("interrupt", payload, socket) do
    relay(socket, payload, "interrupt", [])
  end

  # Model / effort switch for a running session (issue #54, ADR-0020).
  # Operator-only; the validated choice relays opaquely to the wrapper, which
  # applies it to subsequent turns via setModel / applyFlagSettings — the
  # server stays agent-agnostic and never interprets the value (protocol.md).
  def handle_in("set_model", payload, socket) do
    role = current_role(socket)

    with :ok <- guard_against_reset_pending(role, payload) do
      relay(socket, payload, "set_model", [{"model", &is_binary/1}], role)
    else
      {:error, reason} ->
        {:reply, {:error, %{reason: safe_reason(reason)}}, socket}
    end
  end

  def handle_in("set_effort", payload, socket) do
    role = current_role(socket)

    with :ok <- guard_against_reset_pending(role, payload) do
      relay(socket, payload, "set_effort", [{"effort", &is_binary/1}], role)
    else
      {:error, reason} ->
        {:reply, {:error, %{reason: safe_reason(reason)}}, socket}
    end
  end

  # Manual retry of the wrapper's supportedModels() catalog fetch (ADR-0037 F6,
  # phase-18-5). Operator-only; the request has no payload fields, so the topic
  # (agent_id) is the only addressing. The wrapper resets its retry counter and
  # kicks a fresh #refreshSupportedModels() attempt regardless of the earlier
  # cap state. Mirrors set_model / set_effort exactly (relay via require_operator,
  # reset-pending gate, unknown_agent from the relay helper).
  def handle_in("refresh_models", payload, socket) do
    role = current_role(socket)

    with :ok <- guard_against_reset_pending(role, payload) do
      relay(socket, payload, "refresh_models", [], role)
    else
      {:error, reason} ->
        {:reply, {:error, %{reason: safe_reason(reason)}}, socket}
    end
  end

  # LaunchDialog engine-catalog refresh (Option E, ADR-0039). Operator-only;
  # payload = %{"host_id" => ..., "engine" => ..., "request_id" => ...,
  # "force" => bool?}. Kept engine-neutral at this layer — the runner
  # decides which engines are live-probable and returns an
  # `unsupported_engine` EngineCatalogResult for the rest. That keeps the
  # server free of engine-specific logic (mirrors ADR-0023's host-agnostic
  # relay stance for spawn/stop/restart).
  def handle_in("refresh_engine_catalog", payload, socket) do
    relay_to_runner_guarded(socket, payload, "refresh_engine_catalog")
  end

  # permission_mode switch for a running session (issue #58). Operator-only;
  # the validated choice relays opaquely to the wrapper (which applies it via
  # query.setPermissionMode) AND persists into PermissionModes so the next
  # start restores the pick. Closed-enum gate keeps a malformed dashboard
  # payload from hitting the SDK.
  @permission_modes ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"]
  def handle_in("set_permission_mode", payload, socket) do
    is_known_mode = fn value -> is_binary(value) and value in @permission_modes end
    role = current_role(socket)

    with :ok <- guard_against_reset_pending(role, payload) do
      case relay(socket, payload, "set_permission_mode", [{"mode", is_known_mode}], role) do
        {:reply, :ok, _} = ok ->
          # Validation already passed; persist before returning so a quick
          # reconnect sees the new pick on its after_join push.
          KaoiroServer.PermissionModes.record(payload["agent_id"], payload["mode"])
          ok

        other ->
          other
      end
    else
      {:error, reason} ->
        {:reply, {:error, %{reason: safe_reason(reason)}}, socket}
    end
  end

  # Session-reset control (ADR-0036 F1/F7, phase-17 17-4). Operator-only
  # first-class control that swaps the current wrapper for a fresh one
  # under the same agent_id / persona / cwd / engine, re-applying the
  # phase-15 D8 last-effective snapshot. Server-side validation walks the
  # ADR-0036 F6 checks (operator role → known agent → mode vocabulary →
  # capability advertise → KaoiroState → dispatch-cooldown → duplicate
  # lock); `SessionResets.check_and_acquire/5` bundles the last four in
  # a single GenServer call so no TOCTOU window opens between them.
  # Success emits `session_reset_started` on `agents:lobby` and pushes
  # `reset_session` to `runner:<host_id>`; the runner's `session_reset_result`
  # closes the loop by re-entering `SessionResets.resolve/6`.
  @session_reset_modes ["new", "clear"]
  def handle_in("session_reset", payload, socket) do
    with :ok <- require_operator(socket, payload, "session_reset"),
         :ok <- check_relay_size(payload),
         {:ok, agent_id} <- fetch_agent_id(payload),
         {:ok, mode} <- fetch_reset_mode(payload),
         {:ok, envelope} <- fetch_agent_envelope(agent_id),
         :ok <- require_reset_capability(envelope, mode),
         {:ok, state} <- fetch_kaoiro_state(envelope),
         {:ok, request_id, prev_sid} <-
           SessionResets.check_and_acquire(
             agent_id,
             mode,
             state,
             Map.get(envelope, "session_id")
           ),
         :ok <- begin_planned_reset(agent_id, request_id) do
      KaoiroServerWeb.Endpoint.broadcast(
        "agents:lobby",
        "session_reset_started",
        started_payload(agent_id, mode, request_id, prev_sid, "operator")
      )

      # ADR-0055 phase-33 Stage B.
      SessionLifecycleEvents.append(
        agent_id,
        "session_reset_started",
        nil,
        DateTime.utc_now() |> DateTime.to_iso8601()
      )

      KaoiroServerWeb.Endpoint.broadcast(
        "runner:#{host_id_of(agent_id)}",
        "reset_session",
        %{
          "version" => "0",
          "agent_id" => agent_id,
          "mode" => mode,
          "request_id" => request_id
        }
        |> maybe_put_previous_session_id(prev_sid)
        # ADR-0014 F1 追補 (resume-privilege-restoration, 藤 D2): the
        # runner uses this snapshot to reapply the last-effective
        # privilege axes to the fresh wrapper. Absent = no-op on the
        # runner side (engine defaults).
        |> maybe_put_resume_snapshot(agent_id)
      )

      {:reply, :ok, socket}
    else
      {:error, reason} ->
        {:reply, {:error, %{reason: safe_reason(reason)}}, socket}
    end
  end

  # File-upload wire (file-upload spec / ADR-0025). All three handlers are
  # operator-only and relay to `wrapper:<agent_id>` without inspecting the
  # bytes (server stays agent-agnostic). attach_open registers a per-socket
  # upload_id -> agent_id route so attach_chunk (whose binary header carries
  # only upload_id, not agent_id) can be relayed back to the owning wrapper;
  # attach_close clears the route. Routes live in socket.assigns and die with
  # the operator session — the wrapper's TTL reclaims any orphan bytes.
  def handle_in("attach_open", payload, socket) do
    with :ok <- require_operator(socket, payload, "attach_open", "relaying"),
         relayed = wrapper_relay_payload(payload),
         :ok <- check_relay_size(relayed),
         {:ok, agent_id} <- fetch_agent_id(payload),
         :ok <-
           check_keys(payload, [
             {"upload_id", &is_binary/1},
             {"filename", &is_binary/1},
             {"mime", &is_binary/1},
             {"size", &is_integer/1},
             {"chunks", &is_integer/1}
           ]) do
      KaoiroServerWeb.Endpoint.broadcast("wrapper:#{agent_id}", "attach_open", relayed)
      {:reply, :ok, register_upload_route(socket, payload["upload_id"], agent_id)}
    else
      {:error, reason} ->
        {:reply, {:error, %{reason: safe_reason(reason)}}, socket}
    end
  end

  # V2 binary frame: the wire-spec payload arrives wrapped in `{:binary,
  # data}` (Phoenix.Socket.V2.JSONSerializer.decode_binary/1). Drop silently
  # on any failure — binary frames have no JSON reply path, and a chunk
  # without a prior open is a client bug not worth surfacing.
  #
  # ADR-0015 carve-out (issue #218): the ONLY inbound client event that
  # gates on `require_operator_role/1` instead of the version-welded
  # `require_operator/4`. `payload` here is `{:binary, data}` — a fixed
  # length-prefixed header plus raw bytes, with no JSON object to hold a
  # `version` key. Stamping one would need a wire change (a protocol
  # version bump), which #218 rules out of scope; running the check anyway
  # would warn "(absent)" on every chunk of every upload. Recorded as a
  # permanent exception in `docs/specs/protocol.md`.
  def handle_in("attach_chunk", {:binary, data}, socket) when is_binary(data) do
    with :ok <- require_operator_role(socket),
         {:ok, upload_id} <- parse_chunk_upload_id(data),
         {:ok, agent_id} <- lookup_upload_route(socket, upload_id) do
      KaoiroServerWeb.Endpoint.broadcast(
        "wrapper:#{agent_id}",
        "attach_chunk",
        {:binary, data}
      )

      {:noreply, socket}
    else
      {:error, _reason} -> {:noreply, socket}
    end
  end

  # The shape gate above deliberately skips `attach_chunk` (its payload is a
  # `{:binary, data}` tuple, not a map), so this clause closes the same class
  # for it: anything that is not the valid binary frame is dropped rather
  # than left to raise `FunctionClauseError` with no clause to match. Silent
  # like the branch above — a binary frame has no JSON reply path.
  def handle_in("attach_chunk", _payload, socket), do: {:noreply, socket}

  def handle_in("attach_close", payload, socket) do
    with :ok <- require_operator(socket, payload, "attach_close", "relaying"),
         relayed = wrapper_relay_payload(payload),
         :ok <- check_relay_size(relayed),
         {:ok, _payload_agent_id} <- fetch_agent_id(payload),
         :ok <- check_keys(payload, [{"upload_id", &is_binary/1}]),
         {:ok, routed_agent_id} <-
           lookup_upload_route(socket, payload["upload_id"]) do
      # Route via the table, not payload.agent_id: the route table is the
      # source of truth for upload_id -> agent_id (registered at attach_open),
      # symmetric with attach_chunk (whose binary header carries no agent_id).
      # A mismatched payload agent_id is ignored at routing time; the
      # fetch_agent_id check still gates structural validity / known-agent.
      KaoiroServerWeb.Endpoint.broadcast(
        "wrapper:#{routed_agent_id}",
        "attach_close",
        relayed
      )

      {:reply, :ok, clear_upload_route(socket, payload["upload_id"])}
    else
      {:error, reason} ->
        {:reply, {:error, %{reason: safe_reason(reason)}}, socket}
    end
  end

  # Host lifecycle control (ADR-0023, issue #67). Each is operator-only and
  # relays to the addressed `runner:<host_id>` without interpreting the
  # payload (host/agent-agnostic, mirrors the wrapper relay). The runner
  # acts and reports back via `spawn_result` / `runner_sessions`.
  # Operator launch request (案A, ADR-0024). The client sends only
  # host_id + persona (id) + cwd + optional initial_prompt/resume_session_id;
  # the server resolves the persona against the host's declared set, checks
  # cwd against the host allow-list (T1), allocates a fresh instance agent_id
  # under the host namespace, and mints the per-agent token. server_url is
  # supplied by the runner. The allocated agent_id is returned so the UI can
  # correlate the eventual spawn_result.
  def handle_in("spawn", payload, socket) do
    with :ok <- require_operator(socket, payload, "spawn"),
         {:ok, host_id} <- fetch_host_id(payload),
         {:ok, host} <- fetch_host(host_id),
         {:ok, persona} <- resolve_persona(host, payload),
         {:ok, display_name} <- resolve_spawn_display_name(persona, payload),
         {:ok, cwd} <- fetch_allowed_cwd(host, payload),
         {:ok, engine} <- fetch_allowed_engine(host, payload),
         :ok <- validate_antigravity_approval(engine, payload),
         {:ok, agent_id} <- allocate_agent_id(host_id),
         request_id <- generate_transition_id(),
         {:ok, spawn_payload} <-
           build_spawn_payload(
             agent_id,
             persona,
             display_name,
             cwd,
             engine,
             Map.put(payload, "request_id", request_id)
           ),
         :ok <-
           AgentActivity.begin_transition(
             agent_id,
             request_id,
             :spawn,
             DateTime.utc_now() |> DateTime.to_iso8601()
           ) do
      # Persist the identity so operator-driven restore keeps working after
      # a server restart when AgentStates is empty (ADR-0030 D2 / D3).
      # issue #219 D19: only `persona["id"]` (the stable reference) and
      # `display_name` are persisted — canonical persona data is never
      # stored here anymore.
      #
      # Ordered BEFORE the spawn broadcast (issue #219 D22):
      # `AgentDirectory.record/4` is now a synchronous call specifically so
      # this ordering closes the race where a wrapper joins immediately
      # after launch and its after-join `persona_sync`/`display_name_sync`
      # push reads a not-yet-committed entry as `nil` — see `record/4`'s
      # own doc.
      AgentDirectory.record(agent_id, persona["id"], display_name)
      KaoiroServerWeb.Endpoint.broadcast("runner:#{host_id}", "spawn", spawn_payload)
      # Seed the cwd now so restore works even if the wrapper never reports a
      # statusline cwd (#22, ADR-0014): the real session_id arrives later and
      # is preserved alongside this cwd (SessionPointers keeps non-nil fields).
      SessionPointers.record(agent_id, nil, cwd, engine || "claude-code")
      {:reply, {:ok, %{"agent_id" => agent_id}}, socket}
    else
      {:error, reason} -> {:reply, {:error, %{reason: safe_reason(reason)}}, socket}
    end
  end

  def handle_in("stop", payload, socket) do
    relay_lifecycle_to_runner(socket, payload, "stop")
  end

  def handle_in("restart", payload, socket) do
    relay_lifecycle_to_runner(socket, payload, "restart")
  end

  def handle_in("enumerate_sessions", payload, socket) do
    # `cwd` may be omitted when the client only knows an `agent_id` (detail
    # view: the wrapper may not yet have reported ext.cwd, but the server
    # holds a SessionPointer seeded at spawn time). Resolve it here so the
    # runner still receives the `{host_id, cwd}` shape it expects.
    with :ok <- require_operator(socket, payload, "enumerate_sessions", "relaying"),
         {:ok, host_id} <- fetch_host_id(payload),
         {:ok, host} <- fetch_host(host_id),
         {:ok, _engine} <- fetch_allowed_engine(host, payload),
         {:ok, enriched} <- resolve_enumerate_cwd(payload) do
      relay_to_runner(socket, enriched, host_id, "enumerate_sessions")
    else
      {:error, reason} -> {:reply, {:error, %{reason: safe_reason(reason)}}, socket}
    end
  end

  # LaunchDialog persona-scoped effort default (issue #88). Operator-only;
  # unlike enumerate_sessions/spawn this never touches the runner — it is a
  # pure read-time join of AgentDirectory (agent_id -> persona) and
  # SessionPointers (agent_id -> snapshot + effort_revision), computed and
  # replied synchronously like `spawn`'s agent_id allocation. No new store
  # (2026-07-23 scope decision on the issue). See `launch_defaults/0` for
  # the selection order and `SessionPointers.record_snapshot/2` for how
  # effort_revision advances.
  def handle_in("launch_defaults", payload, socket) do
    with :ok <- require_operator(socket, payload, "launch_defaults") do
      {:reply, {:ok, %{"defaults" => launch_defaults()}}, socket}
    else
      {:error, reason} -> {:reply, {:error, %{reason: safe_reason(reason)}}, socket}
    end
  end

  # Operator-facing conversation list (issue #276, decided 2026-08-29).
  # Pure read-time query, like launch_defaults just above: no wrapper
  # relay, no new store, no live push — ConversationStates already holds
  # everything needed. `require_operator` (operator-capable roles: admin
  # > operator, ADR-0050 D2) is the ONE seam this decision asks to keep
  # isolated so #189's future per-pair permission model can replace it
  # here without touching the view.
  def handle_in("list_conversations", payload, socket) do
    with :ok <- require_operator(socket, payload, "list_conversations") do
      {:reply, {:ok, conversations_payload()}, socket}
    else
      {:error, reason} -> {:reply, {:error, %{reason: safe_reason(reason)}}, socket}
    end
  end

  # Operator-facing session_lifecycle timeline pull query (ADR-0055).
  # `fetch_lifecycle_query_agent_id/1` validates FORMAT ONLY (no existence
  # check), deliberately looser than `fetch_agent_id/1` /
  # `fetch_restorable_agent_id/1` elsewhere in this file: neither helper's
  # "known" definition survives `delete_agent` (its
  # `purge_agent_records/1` does not touch `SessionLifecycleEvents`), so
  # gating on either would make a deleted agent's still-persisted history
  # permanently unqueryable — defeating the audit/debugging purpose this
  # query exists for. An unknown/never-existed agent_id returns
  # `events: []`, matching `list_for_agent/2`'s own graceful semantics.
  def handle_in("list_session_events", payload, socket) do
    with :ok <- require_operator(socket, payload, "list_session_events"),
         {:ok, agent_id} <- fetch_lifecycle_query_agent_id(payload) do
      events =
        for event <- SessionLifecycleEvents.list_for_agent(agent_id) do
          %{"kind" => event.kind, "trigger" => event.trigger, "at" => event.at}
        end

      {:reply, {:ok, session_events_payload(events)}, socket}
    else
      {:error, reason} -> {:reply, {:error, %{reason: safe_reason(reason)}}, socket}
    end
  end

  # Operator manual close (issue #276 decision): rides the SAME tombstone +
  # conversation_closed notification every hard-limit/GC closure already
  # uses — ConversationStates.close_by_operator/1 performs only the state
  # transition and returns the participant set; delivering the notice is
  # this handler's job, exactly mirroring how a hard-limit closure notifies
  # from record_message/6's return value rather than from inside the
  # GenServer. Same admin gate seam as list_conversations. Idempotent: a
  # second close on an already-closed cid returns conversation_closed
  # rather than sending a duplicate notice or crashing.
  def handle_in("close_conversation", payload, socket) do
    with :ok <- require_operator(socket, payload, "close_conversation"),
         {:ok, cid} <- fetch_conversation_id(payload) do
      case ConversationStates.close_by_operator(cid) do
        {:ok, agent_ids} ->
          SynthEnvelope.deliver_conversation_closed(cid, agent_ids, :operator_closed)
          {:reply, :ok, socket}

        {:error, reason} ->
          {:reply, {:error, %{reason: safe_reason(reason)}}, socket}
      end
    else
      {:error, reason} -> {:reply, {:error, %{reason: safe_reason(reason)}}, socket}
    end
  end

  # Operator-only restore (#22, ADR-0014「復帰」): bring a disconnected agent
  # back under its SAME agent_id by re-spawning with resume. The server holds
  # everything needed: the SessionPointer (session_id + cwd, restart-surviving)
  # and the last persona (incl. any custom name) from its state entry. The host
  # is derived from the agent_id (`<host>.<rand>`, ADR-0024 D3). Reuses the
  # spawn → runner path, so the runner is unchanged (it does the T3 existence
  # check + F4 lock). Reviving the same agent_id keeps the face / mood / tile.
  #
  # Two branches based on the SessionPointer's session_id (phase-25, ADR-0030
  # D8 追補 / ADR-0014 F1 追補 fresh-restore):
  # - **binary session_id (通常 resume)**: build_restore_payload stamps
  #   `resume_session_id` and the runner takes the resume path (T3 existence
  #   check under cwd + F4 same-session lock).
  # - **nil session_id (fresh-restore)**: `/clear` detach (ADR-0036 F3 追補)
  #   や未発話 session (ADR-0014 Q-A4) で pointer が session_id を持たない
  #   ケース。build_restore_payload は `resume_session_id` を omit し
  #   `apply_resume_snapshot: true` を stamp、runner は fresh 分岐で
  #   applyResumeSnapshot を発火して同 model / effort / engine / permission
  #   設定の fresh session を立ち上げる (T3 / F4 対象外 — session file を
  #   読まないし session id lock も存在しない)。
  def handle_in("restore", payload, socket) do
    with :ok <- require_operator(socket, payload, "restore"),
         {:ok, agent_id} <- fetch_restorable_agent_id(payload),
         :ok <- require_disconnected(agent_id),
         {:ok, persona, display_name} <- agent_persona(agent_id),
         {:ok, session_id, cwd, engine} <- session_pointer(agent_id),
         {:ok, host} <- fetch_host(host_id_of(agent_id)),
         {:ok, engine} <- fetch_allowed_engine(host, %{"engine" => engine}),
         request_id <- generate_transition_id(),
         {:ok, spawn_payload} <-
           build_restore_payload(
             agent_id,
             persona,
             display_name,
             cwd,
             session_id,
             engine,
             request_id
           ),
         :ok <-
           AgentActivity.begin_transition(
             agent_id,
             request_id,
             :restore,
             DateTime.utc_now() |> DateTime.to_iso8601()
           ) do
      invalidate_projection_for_resume(agent_id, session_id)

      KaoiroServerWeb.Endpoint.broadcast(
        "runner:#{host_id_of(agent_id)}",
        "spawn",
        spawn_payload
      )

      {:reply, :ok, socket}
    else
      {:error, reason} -> {:reply, {:error, %{reason: safe_reason(reason)}}, socket}
    end
  end

  # Operator-only resume-swap (ADR-0014): retarget an agent's active session
  # to an operator-picked session_id under its bound cwd, without changing
  # agent_id or cwd. Live agent goes through the runner's `switch_session`
  # (kill + relaunch inside the supervisor entry, F4 lock transferred). A
  # disconnected agent reuses the restore path — same wire, same D5 checks —
  # with the payload session_id in place of the SessionPointer's latest.
  def handle_in("resume_session", payload, socket) do
    role = current_role(socket)

    with :ok <- require_operator(role, payload, "resume_session"),
         :ok <- guard_against_reset_pending(role, payload),
         {:ok, agent_id} <- fetch_restorable_agent_id(payload),
         {:ok, session_id} <- fetch_resume_session_id(payload) do
      if live_agent?(agent_id) do
        # Live-agent switch_session (ADR-0014 F1 追補, phase-15 D8): pipe the
        # agent's stored snapshot through so the swapped-in wrapper stamps
        # ext.resume_snapshot / ext.resume_drift on its first state_change.
        # Without this the relaunched wrapper would retain the original
        # spawn-time snapshot (post-review Finding 2).
        request_id = generate_transition_id()

        switch_payload =
          %{
            "version" => "0",
            "agent_id" => agent_id,
            "resume_session_id" => session_id,
            "request_id" => request_id
          }
          |> maybe_put_resume_snapshot(agent_id)

        case begin_planned_switch(agent_id, request_id) do
          :ok ->
            invalidate_projection_for_resume(agent_id, session_id)

            KaoiroServerWeb.Endpoint.broadcast(
              "runner:#{host_id_of(agent_id)}",
              "switch_session",
              switch_payload
            )

            {:reply, :ok, socket}

          {:error, reason} ->
            {:reply, {:error, %{reason: safe_reason(reason)}}, socket}
        end
      else
        resume_disconnected(agent_id, session_id, socket)
      end
    else
      {:error, reason} -> {:reply, {:error, %{reason: safe_reason(reason)}}, socket}
    end
  end

  # Operator-only purge of an agent's past-session reply log (issue #48).
  # On success, broadcast `history_cleared` with the surviving session_id
  # so every client re-filters its local transcript; viewers hold no reply
  # log and treat it as a no-op. `:noop` (unknown agent / current session
  # not known yet) is surfaced as an error so the operator UI can tell.
  #
  # #109: transition paths write SessionStarts only; this operator action
  # alone copies the known current-session start into ClearWatermarks.
  # Missing starts intentionally leave IA visibility unchanged rather than
  # using a clear-time fallback that could hide current-session IA.
  def handle_in("clear_history", payload, socket) do
    with :ok <- require_operator(socket, payload, "clear_history"),
         {:ok, agent_id} <- fetch_agent_id(payload),
         {:ok, session_id} <- AgentStates.current_session_id(agent_id),
         {:ok, ^session_id} <- AgentStates.clear_other_sessions(agent_id, session_id, []),
         display <- adopt_session_start_watermark(agent_id) do
      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "history_cleared", %{
        "agent_id" => agent_id,
        "session_id" => session_id,
        "clear_watermark" => display
      })

      {:reply, :ok, socket}
    else
      :noop -> {:reply, {:error, %{reason: "no_current_session"}}, socket}
      {:error, reason} -> {:reply, {:error, %{reason: safe_reason(reason)}}, socket}
    end
  end

  # Operator-only removal of an agent from every server-side store (issue
  # #14, extended by ADR-0030 D6 for directory-only entries). Accepts both
  # AgentStates-known agents (disconnected only — enforced by AgentStates.delete
  # so a still-live agent cannot be dropped from under its wrapper) AND
  # directory-only entries whose AgentStates counterpart is absent (server
  # restarted with only the DETS-persisted identity, or a restore that never
  # succeeded). On success, broadcast `agent_deleted` so every client removes
  # it from the grid; the persistent stores are also purged so a subsequent
  # server restart does not resurrect the entry.
  def handle_in("delete_agent", payload, socket) do
    with :ok <- require_operator(socket, payload, "delete_agent"),
         {:ok, agent_id} <- fetch_restorable_agent_id(payload),
         # ふじ R1 must-fix (2026-07-23): require disconnected BEFORE any
         # mutation. The previous ordering ran TokenDenylist.revoke + the
         # `revoked` broadcast first, then discovered live-ness inside
         # purge_agent_records via AgentStates.delete → the operator saw a
         # not_disconnected error while the token was already permanently
         # revoked and the wrapper had been kicked. Non-mutating pre-check
         # returns the same error without side-effects.
         :ok <- require_disconnected(agent_id),
         :ok <- purge_agent_records(agent_id) do
      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "agent_deleted", %{
        "agent_id" => agent_id
      })

      {:reply, :ok, socket}
    else
      {:error, reason} -> {:reply, {:error, %{reason: safe_reason(reason)}}, socket}
    end
  end

  # Operator-only explicit revoke of an agent's wrapper token (issue #72,
  # additive to ADR-0024). Adds `agent_id` to the persistent
  # `TokenDenylist` so `Auth.authorize_wrapper/2` rejects future joins
  # under that id, and broadcasts a `revoked` event on the agent's
  # wrapper topic so a currently-connected wrapper is force-dropped
  # rather than left holding a valid channel until it happens to
  # reconnect. Accepts a live OR disconnected agent (unlike
  # `delete_agent`) — an active compromise is exactly the case a live
  # revoke needs to cut off. `fetch_restorable_agent_id/1` gates the
  # same anti-probe check as `restore` (charset + directory/AgentStates
  # existence).
  def handle_in("revoke_wrapper_token", payload, socket) do
    with :ok <- require_operator(socket, payload, "revoke_wrapper_token"),
         {:ok, agent_id} <- fetch_restorable_agent_id(payload) do
      revoked_at = DateTime.utc_now() |> DateTime.to_iso8601()
      TokenDenylist.revoke(agent_id, revoked_at)

      KaoiroServerWeb.Endpoint.broadcast(
        "wrapper:#{agent_id}",
        "revoked",
        %{"version" => "0", "reason" => "operator_revoke", "revoked_at" => revoked_at}
      )

      {:reply, {:ok, %{"revoked_at" => revoked_at}}, socket}
    else
      {:error, reason} -> {:reply, {:error, %{reason: safe_reason(reason)}}, socket}
    end
  end

  # Operator-only live rename of an agent's display name (issue #197
  # 段階3, D12 — operator-only until #198 per マスター決裁 2026-08-09 #4).
  # `fetch_restorable_agent_id/1` accepts live OR disconnected agents,
  # same as `revoke_wrapper_token` — a disconnected agent still has a
  # valid rename target (the wrapper simply has nothing to relay to
  # until it reconnects, D14 acceptance 4: the ack's guarantee stops at
  # the authoritative store commit, wrapper convergence is eventual).
  #
  # `AgentDirectory.rename/2` is the single authoritative write
  # (D12/D15) — it does not depend on the relay below succeeding. The
  # relay is best-effort, mirroring every other server → wrapper push on
  # this topic (`set_model` et al., protocol.md #54): a disconnected
  # wrapper simply misses it and converges later via the after-join
  # `persona_sync` push (`wrapper_channel.ex`, D14 acceptance 1).
  #
  # The TOCTOU window formerly documented here — `fetch_restorable_agent_id/1`
  # (via `restorable_agent?/1`'s `AgentStates.known?/1 or AgentDirectory.get/1
  # != nil` check) accepting an agent_id while `AgentDirectory.rename/3`'s own
  # lookup still saw `:not_found` — is now structurally closed for the
  # ordinary spawn path (issue #219 D22 corollary, クロエ実測検証): the
  # spawn handler's `AgentDirectory.record/4` call is a SYNCHRONOUS
  # `GenServer.call`, committed strictly BEFORE the `spawn` broadcast to the
  # runner. The runner only launches the wrapper process — the earliest
  # point any envelope, and therefore any `AgentStates.known?/1` truth, could
  # exist — in response to that broadcast. So by the time `AgentStates.known?/1`
  # can ever become true for a freshly-spawned agent, `AgentDirectory.get/1`
  # is already non-nil; `restorable_agent?/1` accepts such an agent_id via
  # the `AgentDirectory` branch well before the `AgentStates` branch is even
  # reachable, and `AgentDirectory.rename/3`'s lookup reads the SAME,
  # already-populated ledger. `delete_agent`'s `purge_agent_records` keeps
  # its own separate, still-real check-then-act gap against `AgentStates` —
  # that one is unaffected by this change and is not what this comment is
  # about.
  def handle_in("rename_agent", payload, socket) do
    with :ok <- require_operator(socket, payload, "rename_agent"),
         {:ok, agent_id} <- fetch_restorable_agent_id(payload),
         {:ok, display_name} <- validate_rename_name(payload) do
      case AgentDirectory.rename(agent_id, display_name) do
        {:ok, %{display_name: display_name, revision: revision}} ->
          # issue #219 D22: DUAL-EMIT, both at the SAME revision. Old
          # wrapper builds only understand `persona_sync` (`name` key) —
          # they MUST keep receiving it during the compatibility window;
          # this is not an optional legacy shim, D22 rejected dropping it
          # outright (self-hosted/same-build deploy is not a guarantee
          # server and every wrapper process restart atomically). New
          # wrapper builds understand BOTH `persona_sync` and
          # `display_name_sync` as display_name mutations and apply
          # whichever arrives FIRST via the same revision guard (D15) —
          # the second is then a no-op, never a rollback. Removing
          # `persona_sync` is an explicit follow-up (D22 — not this
          # issue).
          #
          # ADR-0015: every server -> wrapper message needs the flat
          # version stamp — this is ADR-0015's own requirement, NOT
          # derived from sibling messages on this topic. The stamp
          # matches the after-join `persona_sync` / `display_name_sync`
          # pushes (`wrapper_channel.ex`), same `{"version" => "0", ...}`
          # shape regardless of producer.
          KaoiroServerWeb.Endpoint.broadcast(
            "wrapper:#{agent_id}",
            "persona_sync",
            %{"version" => "0", "name" => display_name, "revision" => revision}
          )

          KaoiroServerWeb.Endpoint.broadcast(
            "wrapper:#{agent_id}",
            "display_name_sync",
            %{"version" => "0", "display_name" => display_name, "revision" => revision}
          )

          # D16: the `directory` refresh for already-joined operators
          # (join-time-only before this — see the `intercept` list
          # comment) is broadcast by `AgentDirectory.rename/2` ITSELF,
          # synchronously inside the same serialized call that performs
          # the write (issue #197 段階3, ふじ MF-3 レビュー指摘) — NOT
          # from here. Broadcasting a separately-read `AgentDirectory.all/1`
          # snapshot from this (caller) process, after the write already
          # completed, left a window where two concurrent renames could
          # race each other's SNAPSHOT + BROADCAST pair independently of
          # their (correctly serialized) writes, letting a stale snapshot
          # win the broadcast race and revert an already-joined
          # dashboard's directory copy.
          #
          # Reply vocabulary is `display_name` (issue #219 D23) — no
          # `persona` key; the operator's own dashboard reads the reply
          # directly, so there is no legacy client to keep compatible on
          # this leg.
          {:reply, {:ok, %{"display_name" => display_name, "revision" => revision}}, socket}

        {:error, :not_found} ->
          {:reply, {:error, %{reason: safe_reason(:unknown_agent)}}, socket}

        # Wire-domain ceiling reached (issue #197 段階3, ふじ MF-5
        # レビュー指摘) — see `AgentDirectory.rename/3`'s own doc.
        {:error, :revision_exhausted} ->
          {:reply, {:error, %{reason: safe_reason(:revision_exhausted)}}, socket}
      end
    else
      {:error, reason} -> {:reply, {:error, %{reason: safe_reason(reason)}}, socket}
    end
  end

  # Operator-facing user list (issue #207). Pull-only, same shape as
  # `list_conversations` (issue #276) just above — a management view the
  # dashboard fetches on demand (opening SettingsDrawer), not something
  # every join needs, so no `:after_join` snapshot push and no new store.
  #
  # `Users.all_with_role/1`'s shape (id/kind/display_name/role) already
  # matches the allow-list issue #207 independently settled on for THIS
  # operator-facing disclosure, so this handler reuses that
  # IMPLEMENTATION (director-approved: "既存 public_entry_with_role/3 の
  # 形と一致したため実装を再利用する") — but reusing the implementation
  # is not the same guarantee as reusing the DECISION. That decision (4
  # fields cross this boundary) was still made independently of
  # ADR-0021 F6-8's separate, agent-facing allow-list (F6-1), and
  # `public_entry_with_role/3` is `Users`' own internal helper — it
  # could grow a field for a DIFFERENT consumer (e.g. F6-8's
  # `directory_request` path) without this handler's own channel test
  # noticing, because Elixir's map pattern match only asserts the named
  # keys are present and does not reject extras (measured: adding a
  # `source` key to `public_entry_with_role/3`'s return left the full
  # channel test suite green). So this handler re-projects into its OWN
  # literal 4-field map (`project_user_entry/1` below) rather than
  # forwarding `Users.all_with_role/1`'s result verbatim, closing this
  # boundary by STRUCTURE rather than by convention alone.
  def handle_in("list_users", payload, socket) do
    with :ok <- require_operator(socket, payload, "list_users") do
      users = Enum.map(Users.all_with_role(), &project_user_entry/1)
      {:reply, {:ok, %{"users" => users}}, socket}
    else
      {:error, reason} -> {:reply, {:error, %{reason: safe_reason(reason)}}, socket}
    end
  end

  # Operator-only live rename of a user's display name (issue #197 段階3,
  # D13 — operator-only, any existing user, no self-service distinction
  # per director's Q1 判定). No wrapper relay and no live broadcast: the
  # dashboard re-fetches via `list_users` (issue #207) after a rename
  # completes, the same refresh-on-mutation contract `close_conversation`
  # (issue #276) uses for `list_conversations` — and the agent-facing
  # `directory_request` `users` projection (`WrapperChannel`) reads
  # `Users` fresh on every call too, so there is nothing today that a
  # live push would reach beyond what those two pulls already cover.
  def handle_in("rename_user", payload, socket) do
    with :ok <- require_operator(socket, payload, "rename_user"),
         {:ok, user_id} <- fetch_user_id(payload),
         {:ok, display_name} <- validate_rename_name(payload) do
      case Users.rename(user_id, display_name) do
        {:ok, entry} ->
          {:reply, {:ok, entry}, socket}

        {:error, :not_found} ->
          {:reply, {:error, %{reason: safe_reason(:unknown_user)}}, socket}
      end
    else
      {:error, reason} -> {:reply, {:error, %{reason: safe_reason(reason)}}, socket}
    end
  end

  # Removes the agent from every server-side store, in the order the
  # ふじ #72 M3 must-fix requires:
  #
  #   1. eligibility (require_disconnected — the caller in
  #      handle_in("delete_agent") already gated this, and we re-check
  #      here as a serialization point so a reconnect racing past the
  #      upstream check cannot slip into the revoke+broadcast batch;
  #      ふじ R1 must-fix, 2026-07-23)
  #   2. token revoke + fsync (TokenDenylist.revoke — synchronous +
  #      DETS sync) BEFORE anything else, so a crash between reply and
  #      finish cannot leave a still-valid token behind
  #   3. live cut-off: broadcast `revoked` on `wrapper:<id>` so any
  #      channel that raced in between step 2 and step 4 is closed
  #      (issue #72: without this, a live channel that joined after
  #      revoke but before AgentStates.delete would keep pushing
  #      envelopes until the wrapper reconnects)
  #   4. finally, purge every other store (AgentStates + DETS ledgers).
  #      Any of these failing after revoke is safe — the token stays
  #      revoked and an operator retry finishes the cleanup.
  # The clear boundary must be the known beginning of the current session,
  # never "now": falling back to now can hide an IA emitted in the current
  # session. A missing start therefore leaves IA visible and emits a warning;
  # non-IA history still receives the normal session_id sweep (#109).
  defp adopt_session_start_watermark(agent_id) do
    case KaoiroServer.SessionStarts.get(agent_id) do
      {{_us, _seq} = order, display, _sid} ->
        :ok = ClearWatermarks.record(agent_id, order, display)
        display

      nil ->
        Logger.warning(
          "clear_history: no current session start for #{inspect(agent_id)}; IA visibility unchanged"
        )

        ClearWatermarks.get_display(agent_id) || ""
    end
  end

  defp purge_agent_records(agent_id) do
    with :ok <- require_disconnected(agent_id) do
      do_purge_agent_records(agent_id)
    end
  end

  defp do_purge_agent_records(agent_id) do
    # Step 2: token revoke + fsync — synchronous ClearWatermarks / DETS
    # semantics also make `TokenDenylist.revoke/3` block on `:dets.sync`.
    revoked_at = DateTime.utc_now() |> DateTime.to_iso8601()
    :ok = TokenDenylist.revoke(agent_id, revoked_at)

    # Step 3: broadcast revoke so any channel that grabbed a socket in
    # the split-second between step 2 and step 4 is force-closed. Same
    # topic the operator `revoke_wrapper_token` handler uses, same
    # `handle_out("revoked", …)` shutdown.
    KaoiroServerWeb.Endpoint.broadcast(
      "wrapper:#{agent_id}",
      "revoked",
      %{"version" => "0", "reason" => "agent_deleted", "revoked_at" => revoked_at}
    )

    # Step 4: purge every other store (order among them is unimportant —
    # they are all idempotent and independent).
    with :ok <- delete_live_if_present(agent_id) do
      AgentDirectory.delete(agent_id)
      SessionPointers.delete(agent_id)
      KaoiroServer.PermissionModes.delete(agent_id)
      # ADR-0051 D3-5: no IA ledger to purge any more. The deleted
      # agent's own pane goes with its AgentStates entry; a peer's pane
      # keeps its copies, which is that peer's display and its own
      # sidecar's to restore. Host-local artifacts (engine transcript, IA
      # sidecar) are never touched from here — same residency rule
      # ADR-0030 states for the transcript.
      # phase-17 17-4: clear any dangling reset lock + dispatch cooldown
      # so a respawn under the same agent_id does not inherit stale state.
      SessionResets.delete(agent_id)
      _ = PeerConnectivity.delete(agent_id)
      AgentActivity.delete(agent_id)
      # issue #109: purge the clear watermark too, so an agent respawned
      # under the same agent_id starts fresh (no lingering hide-past
      # filter from a prior operator).
      ClearWatermarks.delete(agent_id)
      KaoiroServer.SessionStarts.delete(agent_id)
      KaoiroServer.DeliveryStates.delete(agent_id)
      :ok
    end
  end

  # The operator-facing transcript projection (ADR-0051 D3-1 / D6).
  #
  # Both inputs are volatile per-agent projections rebuilt from the
  # wrapper host's composite SSOT after a restart, so this function no
  # longer reads any durable IA ledger:
  #   1. `AgentStates.histories/0` — transcript lines (log / result /
  #      boundary markers), already keyed by pane.
  #   2. `AgentStates.ia_projection/0` — IA per pane WITH its server
  #      ingress stamp. Sender and receiver copies were written under one
  #      stamp at accept time (or restored under it by `replay_ia`), so
  #      there is no client- or server-side fanOut left to do here.
  #
  # Per pane, IA whose stamp is `<= watermark(pane)` is dropped. Both
  # sender-view and receiver-view filters run in the same ordering domain
  # the watermark was recorded in, so a wrapper's producer clock skew
  # cannot misclassify a cutoff crossing (ふじ #109 M6, ADR-0051 D3-4).
  # Peer transcripts stay untouched — hiding an entry in one pane by that
  # pane's watermark says nothing about the other pane.
  #
  # The merged result is sorted chronologically by wire `{ts, seq}`
  # (display ordering, same key `compareTranscriptEnvelopes` uses on the
  # client) and THEN capped to the newest @max_projection envelopes.
  # ADR-0051 D6: the cap belongs to the final projection, not to each
  # source, so transcript 200 + IA 200 cannot show as 400.
  defp merged_histories do
    # ふじ R2 must-fix (2026-07-23): `all_filter_bounds` returns tagged
    # bounds — `{:order, tuple}` for post-M6 clears, `{:iso, iso}` for
    # legacy pre-M6 entries. The ISO branch preserves the pre-M6 wire-ts
    # filter until the next real clear promotes the entry.
    watermark_bounds = ClearWatermarks.all_filter_bounds()
    ia_by_pane = visible_ia_by_pane(watermark_bounds)

    AgentStates.histories()
    |> Map.merge(ia_by_pane, fn _agent_id, transcript, ia -> transcript ++ ia end)
    |> Map.new(fn {agent_id, entries} ->
      sorted =
        Enum.sort_by(entries, fn envelope ->
          {Map.get(envelope, "ts", ""), Map.get(envelope, "seq", 0)}
        end)

      {agent_id, cap_newest(sorted, @max_projection)}
    end)
  end

  # Drops per pane the IA hidden by that pane's clear watermark. Watermark
  # absent (nil) = never cleared, keep the entry.
  defp visible_ia_by_pane(watermark_bounds) do
    AgentStates.ia_projection()
    |> Enum.flat_map(fn {pane_agent_id, entries} ->
      bound = Map.get(watermark_bounds, pane_agent_id)

      kept =
        for {stamp, envelope} <- entries,
            not ClearWatermarks.hidden?(bound, stamp, envelope),
            do: envelope

      if kept == [], do: [], else: [{pane_agent_id, kept}]
    end)
    |> Map.new()
  end

  defp cap_newest(entries, max) when length(entries) <= max, do: entries
  defp cap_newest(entries, max), do: Enum.slice(entries, -max..-1//1)

  defp history_payload do
    static = %{
      "agents" => %{},
      "clear_watermarks" => %{},
      "history_projection" => "per-pane-v1",
      "projection_epoch" => AgentStates.projection_epoch(),
      "history_incomplete" => true
    }

    histories = merged_histories()

    budget = TransportLimits.push_payload_budget("agents:lobby", "history", static)

    {projected_histories, histories_incomplete?, history_bytes} =
      TransportLimits.bounded_map_of_newest_suffixes(histories, budget)

    with_histories = Map.put(static, "agents", projected_histories)
    watermarks = ClearWatermarks.all_displays()

    {projected_watermarks, watermarks_incomplete?, _watermark_bytes} =
      TransportLimits.bounded_map_with_ledger(watermarks, budget - history_bytes)

    incomplete? =
      histories_incomplete? or
        watermarks_incomplete?

    with_histories
    |> Map.put("clear_watermarks", projected_watermarks)
    |> maybe_drop_incomplete("history_incomplete", incomplete?)
  end

  defp hosts_payload(hosts) when is_map(hosts) do
    bounded_push_map_payload("hosts", "hosts", hosts, "hosts_incomplete")
  end

  defp directory_payload(entries) do
    entries = join_directory_entries(entries)
    bounded_push_map_payload("directory", "entries", entries, "directory_incomplete")
  end

  defp wrapper_build_info_payload(builds) when is_map(builds) do
    bounded_push_map_payload("wrapper_build_info", "builds", builds, "build_info_incomplete")
  end

  defp conversations_payload do
    conversations =
      annotate_rally(ConversationStates.list_for_operator())
      |> Enum.sort_by(
        fn conversation ->
          {Map.get(conversation, "started_at", ""), Map.get(conversation, "conversation_id", "")}
        end,
        :desc
      )

    bounded_reply_list_payload(
      "conversations",
      conversations,
      "conversations_incomplete"
    )
  end

  defp session_events_payload(events) do
    bounded_reply_list_payload("events", events, "events_incomplete")
  end

  defp bounded_push_map_payload(event, key, entries, marker) do
    static = %{key => %{}, marker => true}
    projected = bounded_push_map(event, entries, static)

    static
    |> Map.put(key, projected)
    |> maybe_drop_incomplete(marker, map_size(projected) < map_size(entries))
  end

  defp bounded_push_map(event, entries, static) do
    budget = TransportLimits.push_payload_budget("agents:lobby", event, static)

    entries
    |> Enum.sort_by(fn {entry_key, _value} -> entry_key end)
    |> TransportLimits.bounded_map(budget)
  end

  defp bounded_reply_list_payload(key, entries, marker) do
    static = %{key => [], marker => true}
    budget = TransportLimits.reply_payload_budget("agents:lobby", static)
    projected = TransportLimits.bounded_list(entries, budget)

    static
    |> Map.put(key, projected)
    |> maybe_drop_incomplete(marker, length(projected) < length(entries))
  end

  defp maybe_drop_incomplete(payload, marker, false), do: Map.delete(payload, marker)
  defp maybe_drop_incomplete(payload, _marker, true), do: payload

  defp delete_live_if_present(agent_id) do
    if AgentStates.known?(agent_id) do
      AgentStates.delete(agent_id)
    else
      :ok
    end
  end

  # Relays `payload` (minus agent_id, which only addresses the wrapper
  # topic) after the operator/known-agent/shape checks shared by both
  # inbound events. Extra keys pass through opaquely (forward compat,
  # server stays agent-agnostic); the listed keys must be present and
  # well-typed so a malformed value is rejected at this boundary instead
  # of relying on the wrapper's guard.
  defp relay(socket, payload, event, key_checks),
    do: relay(socket, payload, event, key_checks, current_role(socket))

  # The wrapper-bound shape of an inbound client payload (issue #218).
  #
  # `agent_id` only addresses the `wrapper:<id>` topic, so it is dropped on
  # the way through — the wrapper already knows which agent it is.
  #
  # `version` is STAMPED here rather than passed through from the client,
  # mirroring `relay_to_runner/4` (issue #182) on the other outbound leg.
  # The stamp normalizes the hop; it does not authenticate the client,
  # whose declared value was already warned about at the operator gate
  # (`require_operator/4`). Stamping server-side is what makes the
  # wrapper's ADR-0015 guarantee independent of which dashboard build the
  # operator happens to be running — an old client that omits the field
  # still produces a versioned server -> wrapper message.
  #
  # Callers run `check_relay_size/1` on the RESULT, never on the inbound
  # payload, so the cap bounds what actually reaches the wrapper process
  # (issue #26) including this stamp.
  #
  # `payload` is guaranteed to be a map here: the shape gate at the top of
  # `handle_in/3` rejects every non-map inbound payload before any clause
  # runs (ふじ #218 レビュー MF-1). Kept inside each caller's `with`, after
  # the role gate, so the ordering reads the same as the pre-#218 code.
  defp wrapper_relay_payload(payload) do
    payload
    |> Map.delete("agent_id")
    |> Map.put("version", "0")
  end

  defp relay(socket, payload, event, key_checks, role) do
    with :ok <- require_operator(role, payload, event, "relaying"),
         relayed = wrapper_relay_payload(payload),
         :ok <- check_relay_size(relayed),
         {:ok, agent_id} <- fetch_agent_id(payload),
         :ok <- check_keys(payload, key_checks) do
      KaoiroServerWeb.Endpoint.broadcast("wrapper:#{agent_id}", event, relayed)
      {:reply, :ok, socket}
    else
      {:error, reason} ->
        {:reply, {:error, %{reason: safe_reason(reason)}}, socket}
    end
  end

  # The shared operator + host_id + size guards for stop / restart /
  # enumerate_sessions (spawn adds its own dedup, so it does not use this).
  defp relay_to_runner_guarded(socket, payload, event) do
    with :ok <- require_operator(socket, payload, event, "relaying"),
         {:ok, host_id} <- fetch_host_id(payload) do
      relay_to_runner(socket, payload, host_id, event)
    else
      {:error, reason} -> {:reply, {:error, %{reason: safe_reason(reason)}}, socket}
    end
  end

  # Planned lifecycle controls need the same opaque relay compatibility as
  # the generic helper above, but restart additionally receives a server-
  # allocated correlation id before the runner sees it. The intent CAS runs
  # only after role/host/size guards have passed and immediately before the
  # broadcast, so a rejected command never opens a planned-send window.
  defp relay_lifecycle_to_runner(socket, payload, event) when event in ["stop", "restart"] do
    with :ok <- require_operator(socket, payload, event, "relaying"),
         {:ok, host_id} <- fetch_host_id(payload),
         {:ok, agent_id} <- fetch_lifecycle_agent_id(payload),
         :ok <- require_host_owns_agent(host_id, agent_id) do
      {relayed, transition} = lifecycle_relay_payload(payload, event)

      with :ok <- check_relay_size(relayed),
           :ok <- reserve_lifecycle_intent(relayed, transition) do
        KaoiroServerWeb.Endpoint.broadcast("runner:#{host_id}", event, relayed)
        {:reply, :ok, socket}
      else
        {:error, reason} -> {:reply, {:error, %{reason: safe_reason(reason)}}, socket}
      end
    else
      {:error, reason} -> {:reply, {:error, %{reason: safe_reason(reason)}}, socket}
    end
  end

  defp lifecycle_relay_payload(payload, "restart") do
    transition_id = generate_transition_id()

    relayed =
      payload
      |> Map.delete("host_id")
      |> Map.put("version", "0")
      |> Map.put("request_id", transition_id)

    {relayed, {:restart, transition_id}}
  end

  defp lifecycle_relay_payload(payload, "stop") do
    relayed =
      payload
      |> Map.delete("host_id")
      |> Map.put("version", "0")

    {relayed, :stop}
  end

  defp reserve_lifecycle_intent(%{"agent_id" => agent_id}, :stop)
       when is_binary(agent_id) do
    _ = PeerConnectivity.stop(agent_id)
    :ok
  end

  defp reserve_lifecycle_intent(
         %{"agent_id" => agent_id},
         {:restart, transition_id}
       )
       when is_binary(agent_id) do
    cond do
      PlannedDisconnects.active?(agent_id) ->
        {:error, :agent_busy}

      live_agent?(agent_id) ->
        PlannedDisconnects.begin(agent_id, transition_id, :restart)

      true ->
        # Preserve the pre-#266 opaque relay for unknown/already-disconnected
        # entries. There is no outgoing live wrapper to classify, so opening
        # a planned downtime window would only bounce messages needlessly.
        :ok
    end
  end

  defp fetch_lifecycle_agent_id(%{"agent_id" => agent_id}) when is_binary(agent_id) do
    if AgentId.valid?(agent_id), do: {:ok, agent_id}, else: {:error, :invalid_agent_id}
  end

  defp fetch_lifecycle_agent_id(_payload), do: {:error, :missing_agent_id}

  defp require_host_owns_agent(host_id, agent_id) do
    if AgentId.host_id_from(agent_id) == host_id, do: :ok, else: {:error, :agent_not_owned}
  end

  # Relays `payload` (minus host_id, which only addresses the runner topic)
  # to `runner:<host_id>` without interpreting the contents (ADR-0023,
  # server stays host/agent-agnostic). The whole map is size-bounded so an
  # oversized opaque blob cannot reach the runner process (issue #26).
  #
  # `version` is stamped here rather than left to the client (ADR-0015): the
  # messages on this path (stop / restart / enumerate_sessions /
  # refresh_engine_catalog) are the only runner-bound ones the server does
  # not build itself, so without this they would reach the runner unversioned.
  # The stamp NORMALIZES the outbound hop, it does not authenticate the
  # client: anything but "0" — including an ABSENT version — is warned about
  # first. Warn-then-accept is ADR-0015's rule for a receiver.
  #
  # Absent used to be silent, because the dashboard omitted the field and
  # warning would have logged on every operator click. #182 closed that: the
  # dashboard now stamps these payloads, so a missing version means an
  # unversioned client, which is exactly what ADR-0015 asks to surface. The
  # runner runs the same check on delivery (#181), so both hops now agree.
  #
  # The WARN half of the check no longer lives here (issue #218): it is
  # welded to the operator gate in `require_operator/4`, which every caller
  # of this helper has already passed. This function keeps the NORMALIZE
  # half, which has no equivalent on the inbound side.
  defp relay_to_runner(socket, payload, host_id, event) do
    relayed =
      payload
      |> Map.delete("host_id")
      |> Map.put("version", "0")

    case check_relay_size(relayed) do
      :ok ->
        KaoiroServerWeb.Endpoint.broadcast("runner:#{host_id}", event, relayed)
        {:reply, :ok, socket}

      {:error, reason} ->
        {:reply, {:error, %{reason: safe_reason(reason)}}, socket}
    end
  end

  # ADR-0015's receiver rule for the client -> server hop: only an exact
  # match is normal, anything else (including an ABSENT field) warns, and
  # the message is processed either way. The sole caller is
  # `require_operator/4`, which welds this to the operator gate — see its
  # own doc for why the two are bound together (issue #218).
  #
  # `action` names what happens to the request AFTER acceptance, so the log
  # line reads correctly for both a pass-through (`relay/5`,
  # `relay_to_runner/4` — "relaying") and a directly-answered request like
  # `launch_defaults` (issue #88, "accepting" — nothing is relayed anywhere).
  defp warn_on_version_mismatch(%{"version" => "0"}, _event, _action), do: :ok

  # The inspect is bounded because `version` is unvalidated client input and
  # the size guard has not run yet (issue #26's concern applies to the log
  # sink too, not just the runner process).
  defp warn_on_version_mismatch(%{"version" => version}, event, action) do
    warn_relayed_version(event, inspect(version, printable_limit: 64, limit: 8), action)
  end

  defp warn_on_version_mismatch(_payload, event, action) do
    warn_relayed_version(event, "(absent)", action)
  end

  defp warn_relayed_version(event, declared, action) do
    Logger.warning(
      "#{event}: client declared protocol version #{declared}; " <>
        "#{action} as \"0\" (ADR-0015 best-effort accept)"
    )
  end

  defp fetch_host(host_id) do
    # get_public so the resolver sees the same persona set the operator UI
    # received via the `hosts` push (HostRegistry.snapshot/2), computed from
    # the host's policy against the server-authoritative persona pool
    # (ADR-0031). Reading raw `get/2` here would surface only the policy,
    # not the resolved id list the operator's LaunchDialog picked from.
    case HostRegistry.get_public(host_id, PersonaAssets.all_personas()) do
      nil -> {:error, :unknown_host}
      host -> {:ok, host}
    end
  end

  # Joins each directory entry's `persona_id` against the CURRENT
  # PersonaAssets manifest (issue #219 D19) — `AgentDirectory` itself
  # never stores canonical data, only the stable reference, so every
  # reader resolves fresh here instead of trusting a snapshot. Used by
  # BOTH the join-time push (`handle_info(:after_join, ...)`) and the
  # live `handle_out("directory", ...)` intercept, so the two paths
  # produce the IDENTICAL wire shape — a client that reconnects mid-
  # session must not see the payload shape change between its initial
  # push and the next live update (issue #219 spec-gate, クロエ指摘).
  #
  # `persona` is `%{"id"=>, "name"=>, "sprite_set"=>}` when the pack
  # still resolves, or just `%{"id"=>}` (canonical fields OMITTED, never
  # a stale/guessed value) when it does not — issue #219 D21's "typed
  # unresolved". `display_name` is always present; it is the field
  # `AgentDirectory` actually owns and never depends on pack state.
  defp join_directory_entries(entries) do
    Map.new(entries, fn {agent_id, entry} -> {agent_id, join_directory_entry(entry)} end)
  end

  defp join_directory_entry(%{
         persona_id: persona_id,
         display_name: display_name,
         last_seen: last_seen
       }) do
    persona =
      case PersonaAssets.get_persona(persona_id) do
        nil -> %{"id" => persona_id}
        canonical -> canonical
      end

    %{"persona" => persona, "display_name" => display_name, "last_seen" => last_seen}
  end

  # Resolve the operator-chosen persona id to the host's declared persona
  # object: the wrapper gets only what the host registered, never arbitrary
  # client-supplied persona fields (server-authoritative, 案A).
  defp resolve_persona(%{personas: personas}, %{"persona" => persona_id})
       when is_binary(persona_id) do
    case Enum.find(personas, fn persona -> persona["id"] == persona_id end) do
      nil -> {:error, :unknown_persona}
      persona -> {:ok, persona}
    end
  end

  defp resolve_persona(_host, _payload), do: {:error, :invalid_persona}

  # issue #219 D23: accepts EITHER "display_name" (new wire key) or the
  # legacy "name" key (compatibility period — old client / wrapper
  # builds may still send it) but REJECTS outright when both are present
  # and disagree, rather than silently preferring one. Returns
  # `{:ok, value}` (binary, from whichever single key was present, or
  # both when they agree), `{:ok, nil}` (neither key present), or
  # `{:error, :invalid_name}` (a present key is non-binary — including a
  # JSON `null`, see MF-3 below — or both keys present and conflicting).
  #
  # MF-3 (issue #219, クロエ実測検証): a PRESENT key whose value is
  # `null` must classify as "present but invalid", not "absent" — a
  # `Map.get/2` read cannot tell the two apart (both return `nil`), which
  # let `{"display_name" => null}` alone fall through to the `{:ok, nil}`
  # canonical-fallback branch, and `{"display_name" => null, "name" =>
  # "X"}` fall through to accepting the legacy `"X"` — both silently
  # contradicting this function's own documented "present non-binary key
  # -> invalid_name" contract above. `Map.fetch/2` classifies presence
  # FIRST, independent of the value, so a present `null` is `{:present,
  # nil}` and correctly fails every `is_binary` guard below regardless of
  # the sibling key.
  defp extract_name_field(payload) do
    case {field_presence(payload, "display_name"), field_presence(payload, "name")} do
      {:absent, :absent} ->
        {:ok, nil}

      {{:present, same}, {:present, same}} when is_binary(same) ->
        {:ok, same}

      {{:present, new}, :absent} when is_binary(new) ->
        {:ok, new}

      {:absent, {:present, old}} when is_binary(old) ->
        {:ok, old}

      _ ->
        {:error, :invalid_name}
    end
  end

  # `{:present, value}` when `key` is a member of `payload` (even with a
  # `nil`/`null` value) or `:absent` otherwise — distinguishes "key not
  # sent" from "key sent as null", which `Map.get/2` alone cannot (MF-3).
  defp field_presence(payload, key) do
    case Map.fetch(payload, key) do
      {:ok, value} -> {:present, value}
      :error -> :absent
    end
  end

  # Shared length / control-char validation both spawn-time custom
  # naming and live rename apply — same rule `WrapperChannel.valid_display_name/1`
  # and `PersonaAssets`' pack `name` field (issue #219 D24) enforce.
  defp valid_display_name_value?(trimmed) do
    String.length(trimmed) <= @display_name_max_graphemes and
      not String.match?(trimmed, @display_name_control_char_pattern)
  end

  # Optional per-instance INITIAL display_name (#22, revised issue #219
  # D19/D20/D23): seeds a newly-spawned agent's `display_name`. Absent or
  # blank = fall back to the persona's own canonical name (created-time
  # persistence, D20 — this is the ONLY place a blank/absent value gets a
  # fallback). Unlike the pre-#219 `apply_custom_name/2` this REPLACES,
  # `persona` itself is never mutated — the whole point of issue #219 is
  # that a custom name is instance state, not a rewrite of the pack's
  # canonical name.
  defp resolve_spawn_display_name(persona, payload) do
    case extract_name_field(payload) do
      {:ok, nil} ->
        {:ok, persona["name"]}

      {:ok, name} ->
        trimmed = String.trim(name)

        cond do
          trimmed == "" -> {:ok, persona["name"]}
          not valid_display_name_value?(trimmed) -> {:error, :invalid_name}
          true -> {:ok, trimmed}
        end

      {:error, :invalid_name} = error ->
        error
    end
  end

  # Live-rename name validation (issue #197 段階3, D12/D13, revised issue
  # #219 D23; shared by `rename_agent` and `rename_user`). Unlike
  # `resolve_spawn_display_name/2` above, a blank/absent name has no
  # sensible "keep the existing name" default here — a rename request IS
  # the operator's request to CHANGE the name, so blank is rejected
  # rather than silently ignored.
  defp validate_rename_name(payload) do
    case extract_name_field(payload) do
      {:ok, nil} ->
        {:error, :invalid_name}

      {:ok, name} ->
        trimmed = String.trim(name)

        cond do
          trimmed == "" -> {:error, :invalid_name}
          not valid_display_name_value?(trimmed) -> {:error, :invalid_name}
          true -> {:ok, trimmed}
        end

      {:error, :invalid_name} = error ->
        error
    end
  end

  # cwd must be one the host declared spawnable (T1, threat-model). The runner
  # re-checks against its own allow-list; this server-side check gives a clear
  # rejection and keeps a non-allowed cwd off the wire.
  defp fetch_allowed_cwd(%{cwd_allowlist: allowlist}, %{"cwd" => cwd})
       when is_binary(cwd) do
    if cwd in allowlist, do: {:ok, cwd}, else: {:error, :cwd_not_allowed}
  end

  defp fetch_allowed_cwd(_host, _payload), do: {:error, :invalid_cwd}

  # Allocate a unique instance agent_id under the host namespace (ADR-0024
  # D3: `<host>.<rand>`). The random suffix makes collisions negligible; still
  # reject rather than clobber a live agent on the off chance of a clash.
  defp allocate_agent_id(host_id) do
    suffix = Base.url_encode64(:crypto.strong_rand_bytes(9), padding: false)
    agent_id = host_id <> "." <> suffix

    cond do
      not AgentId.valid?(agent_id) -> {:error, :invalid_host_id}
      live_agent?(agent_id) -> {:error, :already_running}
      true -> {:ok, agent_id}
    end
  end

  defp live_agent?(agent_id) do
    case AgentStates.snapshot()[agent_id] do
      %{"state" => state} when state != "disconnected" -> true
      _ -> false
    end
  end

  # Build the runner spawn payload (案A, ADR-0024): the server fills agent_id
  # and mints the per-agent token; server_url is supplied by the runner.
  # initial_prompt / resume_session_id pass through only when well-typed. The
  # whole map is size-bounded so an oversized initial_prompt cannot reach the
  # runner process.
  #
  # `persona` is the canonical pack data (id/name/sprite_set) — unchanged
  # shape, ADR-0029 F9 unqualified again (issue #219 D19). `display_name`
  # is a NEW top-level field, independent of `persona`: the wrapper seeds
  # its own instance state from it (issue #219 D19/D23) instead of
  # reading a custom name out of `persona["name"]`.
  defp build_spawn_payload(agent_id, persona, display_name, cwd, engine, payload) do
    spawn_payload =
      %{
        "version" => "0",
        "agent_id" => agent_id,
        "persona" => persona,
        "display_name" => display_name,
        "cwd" => cwd,
        "token" => Auth.mint_wrapper_token(agent_id)
      }
      |> maybe_put_string("initial_prompt", payload["initial_prompt"])
      |> maybe_put_string("resume_session_id", payload["resume_session_id"])
      |> maybe_put_string("request_id", payload["request_id"])
      |> maybe_put_engine(engine)
      # Launch-time picks (ADR-0032 F4bc / ADR-0033 F3, ADR-0057 F4c):
      # free-form model / effort strings (value sets belong to the engine
      # catalog) plus the codex/antigravity sandbox axis, its network
      # toggle, and the antigravity-only approval axis; the runner
      # re-validates all of them.
      |> maybe_put_string("model", payload["model"])
      |> maybe_put_string("effort", payload["effort"])
      |> maybe_put_sandbox(payload["sandbox"])
      |> maybe_put_boolean("network_access", payload["network_access"])
      |> maybe_put_approval(payload["approval"])
      # Claude-only launch permission mode (ADR-0033 F4 追補, phase-15 D2 /
      # task 15-12). Priority "explicit spawn wins over the persisted
      # store": when present we ALSO record it into PermissionModes here so
      # the store agrees with the operator's latest intent and a later
      # after_join push reinforces (not overwrites) the SpawnMessage value.
      # Restore paths (build_restore_payload) omit this field and fall
      # through to the store's persisted value naturally.
      |> maybe_put_permission_mode(payload["permission_mode"])
      |> record_permission_mode_if_present(agent_id, payload["permission_mode"])

    # Note: resume_snapshot is NOT piped here even for the resume-with-fresh-
    # agent_id path (spawn with resume_session_id). By construction the
    # freshly allocated agent_id has no SessionPointer yet (record fires on
    # the state_change ingest AFTER this broadcast), so a lookup would always
    # return nil. Snapshots ride on the restore / resume_disconnected paths
    # (build_restore_payload) and on switch_session, where the agent_id is
    # pre-existing (see maybe_put_resume_snapshot/2 below).
    case check_relay_size(spawn_payload) do
      :ok -> {:ok, spawn_payload}
      {:error, reason} -> {:error, reason}
    end
  end

  defp maybe_put_engine(map, nil), do: map
  defp maybe_put_engine(map, engine), do: Map.put(map, "engine", engine)

  # Resume snapshot (ADR-0014 F1 追補, phase-15 D8): relayed only on paths
  # that carry a PRE-EXISTING agent_id whose SessionPointer already stores
  # the last effective settings. Callers: build_restore_payload (restore /
  # resume_disconnected) and the switch_session broadcast (live-agent
  # resume). Fresh spawn (build_spawn_payload) is deliberately excluded
  # because a fresh agent has no pointer yet — its snapshot would always
  # look up as nil.
  defp maybe_put_resume_snapshot(map, agent_id) do
    case SessionPointers.get(agent_id) do
      %{snapshot: snapshot} when is_map(snapshot) ->
        Map.put(map, "resume_snapshot", snapshot)

      _ ->
        map
    end
  end

  @sandbox_values ["read-only", "workspace-write", "danger-full-access"]
  defp maybe_put_sandbox(map, value) when value in @sandbox_values,
    do: Map.put(map, "sandbox", value)

  defp maybe_put_sandbox(map, _value), do: map

  # Antigravity-only launch approval axis (ADR-0057 F4c). Same closed-enum
  # gate shape as maybe_put_sandbox; deliberately excludes "on-failure" —
  # this engine rejects it at spawn (Stage A offers only these three
  # values in LaunchDialog).
  @approval_values ["untrusted", "on-request", "never"]
  defp maybe_put_approval(map, value) when value in @approval_values,
    do: Map.put(map, "approval", value)

  defp maybe_put_approval(map, _value), do: map

  # Rejects a present-but-invalid approval for antigravity BEFORE agent_id
  # allocation / broadcast (ふじ round 2 MF-R2-4): silently dropping it (the
  # old `maybe_put_approval` behaviour, still applied here as a defensive
  # gate) let a malformed spawn request launch anyway with the runner's
  # `on-request` default, which is not what the operator asked for. Absent
  # is fine (the runner default applies); any other engine's approval is
  # untouched — this axis is antigravity-only.
  #
  # `Map.fetch/2`, not `payload["approval"]` (ふじ round 3 MF-R3-3): a plain
  # map access returns nil for BOTH an absent key and an explicit
  # `"approval" => nil` (JSON `null`), so the key-absent branch used to also
  # swallow an explicit null — it then fell through `maybe_put_approval`'s
  # drop clause and launched with the runner's on-request default instead of
  # being rejected. `Map.fetch/2` distinguishes the two: only a genuinely
  # absent key is :ok; a present nil is now an invalid value like any other.
  defp validate_antigravity_approval("antigravity", payload) do
    case Map.fetch(payload, "approval") do
      :error -> :ok
      {:ok, value} when value in @approval_values -> :ok
      {:ok, _invalid} -> {:error, :invalid_approval}
    end
  end

  defp validate_antigravity_approval(_engine, _payload), do: :ok

  # ADR-0033 F4 追補 (phase-15 D2 / task 15-12). Same closed-enum gate as
  # @permission_modes above so a malformed spawn payload never reaches the
  # runner. Absent / malformed = silent drop (the store push covers the
  # continuation case).
  defp maybe_put_permission_mode(map, value) when value in @permission_modes,
    do: Map.put(map, "permission_mode", value)

  defp maybe_put_permission_mode(map, _value), do: map

  # Fire-and-forget: persist the explicit spawn-time pick into the same
  # store the after_join push reads from. Same closed-enum gate as
  # maybe_put_permission_mode so an invalid value neither reaches the
  # store nor the runner. Pass-through returns the map unchanged so the
  # pipeline stays composable.
  defp record_permission_mode_if_present(map, agent_id, value)
       when value in @permission_modes do
    KaoiroServer.PermissionModes.record(agent_id, value)
    map
  end

  defp record_permission_mode_if_present(map, _agent_id, _value), do: map

  defp maybe_put_boolean(map, key, value) when is_boolean(value),
    do: Map.put(map, key, value)

  defp maybe_put_boolean(map, _key, _value), do: map

  # engine must be one the host declared in its capabilities (ADR-0032
  # F4a, ADR-0057 F1). Absent = nil (the runner defaults to claude-code),
  # so an old dashboard keeps working; an unknown or undeclared value is
  # rejected rather than silently launching the wrong engine.
  @engine_values ["claude-code", "codex", "antigravity"]
  defp fetch_allowed_engine(host, payload) do
    case payload["engine"] do
      nil ->
        {:ok, nil}

      engine when engine in @engine_values ->
        if engine in Map.get(host, :capabilities, []) do
          {:ok, engine}
        else
          {:error, :engine_not_supported}
        end

      _ ->
        {:error, :invalid_engine}
    end
  end

  defp maybe_put_string(map, key, value) when is_binary(value) and value != "",
    do: Map.put(map, key, value)

  defp maybe_put_string(map, _key, _value), do: map

  # Non-mutating "is this agent-id currently owned by a live wrapper?"
  # gate. Used by:
  #   - restore (ADR-0014 F4 server-side owner fencing, the early-reject
  #     first stage before the runner-local lock; D5 二重接続 prevention)
  #   - delete_agent (ふじ R1 must-fix, 2026-07-23) — pre-checked upstream
  #     in `handle_in` AND re-checked inside `purge_agent_records` as a
  #     serialization point, so a reconnect racing past the upstream check
  #     cannot slip into the revoke+broadcast batch. Directory-only
  #     entries (AgentStates never knew them, or they were already purged)
  #     pass — an operator can delete a stale identity whose wrapper is
  #     gone.
  defp require_disconnected(agent_id) do
    if live_agent?(agent_id), do: {:error, :not_disconnected}, else: :ok
  end

  # The agent's canonical persona + display_name from the restart-
  # surviving identity ledger (ADR-0030 D3, revised issue #219 D19/D21);
  # restore re-spawns with both so the revived agent keeps its identity
  # even after a server restart cleared AgentStates. The canonical
  # persona is freshly joined against `PersonaAssets` here — NOT trusted
  # from a stored snapshot (`AgentDirectory` only ever persists
  # `persona_id`) — and restore fail-closes (`{:error, :unknown_persona}`)
  # when it no longer resolves: a pack that has since been removed from
  # the ingest dir is not spawnable (ADR-0029 F3), and issue #219 D21
  # explicitly rejects guessing a canonical from the ledger's old
  # evidence to route around that.
  defp agent_persona(agent_id) do
    case AgentDirectory.get(agent_id) do
      %{persona_id: persona_id, display_name: display_name} ->
        case PersonaAssets.get_persona(persona_id) do
          nil -> {:error, :unknown_persona}
          persona -> {:ok, persona, display_name}
        end

      nil ->
        {:error, :unknown_agent}
    end
  end

  # LaunchDialog persona-scoped effort default (issue #88): a pure
  # AgentDirectory x SessionPointers read-time join, `persona_id => effort`.
  # Every agent_id known to AgentDirectory is grouped by its persona id; per
  # persona, `pick_effort/1` (ふじ 2026-08-05 spec) applies the selection
  # order below. Personas with no usable candidate are omitted entirely
  # (LaunchDialog falls back to the model's own default_effort for those).
  defp launch_defaults do
    compute_launch_defaults(AgentDirectory.all(), SessionPointers.all())
  end

  # issue #273: each row also carries the rally its participants have run up
  # ACROSS conversations, and whether that crosses the threshold. The verdict
  # is computed here rather than shipping the threshold for the client to
  # compare, so one place owns what "quagmire" means. Purely additive keys on
  # an unchanged reply shape — an older client ignores them. Thresholds are
  # read from config directly rather than through the detector process: they
  # are fixed for the life of a boot, so calling into an advisory GenServer
  # would buy nothing dynamic while letting its liveness take down this RPC.
  defp annotate_rally(rows) do
    settings = QuagmireWatch.configured_settings()
    rally = ConversationStates.pair_rally(settings.rally_window_ms)

    Enum.map(rows, fn row ->
      tally = Map.get(rally, Map.fetch!(row, "participants"), %{turns: 0, conversations: 0})

      row
      |> Map.put("rally_turns", tally.turns)
      |> Map.put("rally_conversations", tally.conversations)
      |> Map.put("quagmire", tally.turns >= settings.rally_turns)
    end)
  end

  @doc """
  Pure join/selection core of `launch_defaults` (issue #88), split out from
  the GenServer-backed `AgentDirectory.all/0` / `SessionPointers.all/0`
  reads so the selection rules are directly testable against hand-built
  `directory` / `pointers` maps — in particular the legacy
  (`effort_revision: nil` with a valid effort) branches. The current write
  API cannot CONSTRUCT that combination directly (any commit through
  `SessionPointers.record_snapshot/2` that lands a valid effort always
  assigns a revision), but it IS production-reachable: every pointer
  persisted before this feature shipped is exactly a nil-revision row with
  whatever valid effort it last held, and stays that way until its agent's
  next snapshot commit lazily migrates it (ふじ review 2026-08-05). Public
  for the testability reason above, not because callers outside this
  module are expected to use it (mirrors `safe_reason/1` in this same
  module).
  """
  def compute_launch_defaults(directory, pointers) do
    directory
    |> Enum.reduce(%{}, fn {agent_id, entry}, acc ->
      case launch_default_candidate(entry, Map.get(pointers, agent_id)) do
        {persona_id, revision, effort} ->
          Map.update(acc, persona_id, [{revision, effort}], &[{revision, effort} | &1])

        :skip ->
          acc
      end
    end)
    |> Map.new(fn {persona_id, candidates} -> {persona_id, pick_effort(candidates)} end)
    |> Enum.reject(fn {_persona_id, effort} -> is_nil(effort) end)
    |> Map.new()
  end

  # malformed/空 effort は defensive に skip する (ふじ指摘): the write-side
  # sanitizer in SessionPointers only guards commits made through
  # record_snapshot/2, not whatever a pre-#88 legacy DETS row already holds,
  # so this read-time join re-validates rather than trusting stored content.
  defp launch_default_candidate(%{persona_id: persona_id}, pointer)
       when is_binary(persona_id) do
    effort = pointer && get_in(pointer, [:snapshot, "effort"])

    if is_binary(effort) and effort != "" do
      {persona_id, pointer[:effort_revision], effort}
    else
      :skip
    end
  end

  defp launch_default_candidate(_entry, _pointer), do: :skip

  # Selection order (ふじ, issue #88, 2026-08-05):
  #   1. any candidate carries an effort_revision -> the highest-revision one
  #   2. no revision anywhere, exactly one candidate -> that effort
  #   3. no revision anywhere, several candidates that all agree -> that value
  #   4. no revision anywhere, several candidates that disagree -> nil (no
  #      preference; LaunchDialog falls back to the model's default_effort)
  defp pick_effort(candidates) do
    {revisioned, unrevisioned} = Enum.split_with(candidates, fn {rev, _} -> not is_nil(rev) end)

    cond do
      revisioned != [] ->
        revisioned |> Enum.max_by(fn {rev, _} -> rev end) |> elem(1)

      match?([_], unrevisioned) ->
        unrevisioned |> hd() |> elem(1)

      unrevisioned != [] ->
        case unrevisioned |> Enum.map(&elem(&1, 1)) |> Enum.uniq() do
          [only] -> only
          _multiple -> nil
        end

      true ->
        nil
    end
  end

  # The restart-surviving resume pointer. cwd is mandatory (the runner
  # resumes / relaunches under it and enforces the T1 allow-list). session_id
  # may be nil when the pointer was left in a `/clear`-detached (ADR-0036 F4)
  # or never-reported state (未発話, ADR-0014 Q-A4); the fresh-restore path
  # (phase-25, ADR-0030 D8 追補) accepts that case and asks the runner to
  # relaunch with snapshot re-applied. A binary session_id still drives the
  # ordinary resume path with T3 existence check in the runner.
  defp session_pointer(agent_id) do
    case SessionPointers.get(agent_id) do
      %{session_id: sid, cwd: cwd} = pointer
      when (is_binary(sid) or is_nil(sid)) and is_binary(cwd) ->
        # engine may be nil on pre-engine pointers; the runner then defaults
        # to claude-code, matching what those agents were (ADR-0032 F4a).
        {:ok, sid, cwd, Map.get(pointer, :engine)}

      _ ->
        {:error, :no_session}
    end
  end

  # SSOT for the `<host_id>.<rand>` (ADR-0024 D3) inverse is
  # `AgentId.host_id_from/1`; local delegate keeps the call sites here
  # concise. Never re-implement this via a prefix match — see the
  # runner_channel guard note (nested-prefix spoof).
  defp host_id_of(agent_id), do: AgentId.host_id_from(agent_id)

  # Disconnected branch of resume_session: same wire as restore (spawn +
  # resume_session_id to `runner:<host_id>`) but with the operator-picked
  # session_id, not the SessionPointer's latest. The pointer is still
  # consulted for cwd — a pointer that never recorded one blocks with
  # :no_session, matching restore's semantics.
  # ADR-0051 D2 追補 — hydration invalidation.
  #
  # `hydrated` means "the server's projection matches what the wrapper
  # would replay", and that stops being true exactly when an operator
  # points the wrapper at a DIFFERENT session: the pane still shows the
  # session being left. Forcing `unhydrated` here makes the next join
  # return `replay_required: true`, so the resumed transcript rebuilds the
  # pane the way the pre-ADR-0051 unconditional startup replay did.
  #
  # The three cases NOT invalidated, and why:
  #  - `/new` / `/clear`: ADR-0036 F3 already defines their display
  #    outcome (keep the log + boundary marker / marker only). A replay's
  #    `history_reset` would wipe exactly that.
  #  - fresh-restore (a restore with no resume target): a brand-new
  #    session, same "keep the display" shape as `/new`.
  #  - crash-restart (the runner relaunching a wrapper on its own, no
  #    server-side transition): same session continuing, so the projection
  #    is already correct — replaying would only cost a visible flicker.
  defp invalidate_projection_for_resume(agent_id, session_id) when is_binary(session_id) do
    AgentStates.invalidate_hydration(agent_id)
  end

  defp invalidate_projection_for_resume(_agent_id, _session_id), do: :ok

  defp resume_disconnected(agent_id, session_id, socket) do
    with {:ok, persona, display_name} <- agent_persona(agent_id),
         {:ok, _sid, cwd, engine} <- session_pointer(agent_id),
         {:ok, host} <- fetch_host(host_id_of(agent_id)),
         {:ok, engine} <- fetch_allowed_engine(host, %{"engine" => engine}),
         request_id <- generate_transition_id(),
         {:ok, spawn_payload} <-
           build_restore_payload(
             agent_id,
             persona,
             display_name,
             cwd,
             session_id,
             engine,
             request_id
           ),
         :ok <-
           AgentActivity.begin_transition(
             agent_id,
             request_id,
             :restore,
             DateTime.utc_now() |> DateTime.to_iso8601()
           ) do
      invalidate_projection_for_resume(agent_id, session_id)

      KaoiroServerWeb.Endpoint.broadcast(
        "runner:#{host_id_of(agent_id)}",
        "spawn",
        spawn_payload
      )

      {:reply, :ok, socket}
    else
      {:error, reason} -> {:reply, {:error, %{reason: safe_reason(reason)}}, socket}
    end
  end

  # Resolves the cwd for `enumerate_sessions`. Explicit cwd wins (LaunchDialog
  # supplies it); otherwise fall back to the agent_id's SessionPointer, seeded
  # at spawn time — a live agent whose wrapper has not yet reported ext.cwd
  # still enumerates. Missing both is `invalid_cwd`; unknown pointer is
  # `no_session` (same reason atom the restore path uses).
  defp resolve_enumerate_cwd(%{"cwd" => cwd} = payload)
       when is_binary(cwd) and cwd != "" do
    {:ok, payload}
  end

  defp resolve_enumerate_cwd(%{"agent_id" => agent_id} = payload)
       when is_binary(agent_id) do
    case SessionPointers.get(agent_id) do
      %{cwd: cwd} when is_binary(cwd) and cwd != "" ->
        {:ok, Map.put(payload, "cwd", cwd)}

      _ ->
        {:error, :no_session}
    end
  end

  defp resolve_enumerate_cwd(_payload), do: {:error, :invalid_cwd}

  defp fetch_resume_session_id(%{"session_id" => sid}) when is_binary(sid) do
    if Regex.match?(@session_id_pattern, sid),
      do: {:ok, sid},
      else: {:error, :invalid_session_id}
  end

  defp fetch_resume_session_id(_payload), do: {:error, :missing_session_id}

  defp generate_transition_id do
    "at_" <> Base.url_encode64(:crypto.strong_rand_bytes(16), padding: false)
  end

  # session_id nil = fresh-restore (phase-25, ADR-0030 D8 追補): the pointer
  # lost its session_id via detach (/clear) or never received one (未発話).
  # Omit resume_session_id and stamp apply_resume_snapshot=true so the runner
  # takes the fresh-spawn + snapshot re-apply branch. resume_snapshot itself
  # rides through the shared maybe_put_resume_snapshot pipe (nil-snapshot
  # pointer degrades safely to engine defaults, fail-soft).
  defp build_restore_payload(agent_id, persona, display_name, cwd, session_id, engine, request_id) do
    spawn_payload =
      %{
        "version" => "0",
        "agent_id" => agent_id,
        "persona" => persona,
        "display_name" => display_name,
        "cwd" => cwd,
        "token" => Auth.mint_wrapper_token(agent_id)
      }
      |> maybe_put_engine(engine)
      |> maybe_put_resume_session_id(session_id)
      |> maybe_put_string("request_id", request_id)
      |> maybe_put_resume_snapshot(agent_id)

    case check_relay_size(spawn_payload) do
      :ok -> {:ok, spawn_payload}
      {:error, reason} -> {:error, reason}
    end
  end

  defp maybe_put_resume_session_id(map, sid) when is_binary(sid),
    do: Map.put(map, "resume_session_id", sid)

  defp maybe_put_resume_session_id(map, nil),
    do: Map.put(map, "apply_resume_snapshot", true)

  # Bounds the whole relayed map, not just the whitelisted keys, so an
  # oversized blob in an opaque extra key cannot reach the wrapper process
  # (issue #26). The server→wrapper push is not covered by the wrapper's
  # inbound @max_envelope_bytes guard.
  defp check_relay_size(payload) do
    if :erlang.external_size(payload) <= @max_relay_bytes do
      :ok
    else
      {:error, :payload_too_large}
    end
  end

  # File-upload route table (file-upload spec / ADR-0025): per-operator-socket
  # upload_id -> agent_id mapping so attach_chunk (whose binary header has
  # only upload_id) can be relayed. The table lives in socket.assigns and
  # dies with the operator session; orphan bytes in the wrapper's
  # pending_uploads are reclaimed by its TTL (phase-1).
  defp register_upload_route(socket, upload_id, agent_id) do
    routes = Map.put(socket.assigns[:upload_routes] || %{}, upload_id, agent_id)
    assign(socket, :upload_routes, routes)
  end

  defp lookup_upload_route(socket, upload_id) do
    case Map.get(socket.assigns[:upload_routes] || %{}, upload_id) do
      nil -> {:error, :unknown_upload}
      agent_id -> {:ok, agent_id}
    end
  end

  defp clear_upload_route(socket, upload_id) do
    routes = Map.delete(socket.assigns[:upload_routes] || %{}, upload_id)
    assign(socket, :upload_routes, routes)
  end

  # Parses the upload_id prefix from an attach_chunk binary payload (file-upload
  # spec): `<u32 upload_id_len BE><upload_id utf8><u32 chunk_index><bytes>`.
  # Only the upload_id is needed server-side for routing; the rest passes
  # through opaquely.
  defp parse_chunk_upload_id(<<id_len::big-32, rest::binary>>)
       when byte_size(rest) >= id_len + 4 do
    <<upload_id::binary-size(^id_len), _::binary>> = rest
    {:ok, upload_id}
  end

  defp parse_chunk_upload_id(_), do: {:error, :invalid_chunk_header}

  # Allow-list per role (ADR-0021). Returning `:drop` means the envelope
  # is omitted entirely (broadcast skipped, removed from snapshot); any
  # new envelope type defaults to dropped for viewers until a `:viewer`
  # clause explicitly opts it in (fail-closed).
  # admin is 全可視 and MUST NOT be hideable (ADR-0050 D2), so it passes
  # here exactly as operator does. When per-pair permissions (issue #199)
  # start narrowing what an OPERATOR receives, admin must be split back
  # out of this clause rather than narrowed along with it.
  defp sanitize_envelope_for(role, envelope) when role in @operator_capable_roles,
    do: {:ok, envelope}

  # state_change is the viewer's only direct grid signal; `ext` carries
  # cwd / model / context / rate_limits / slash_commands and any future
  # additions, all operator-only.
  defp sanitize_envelope_for(:viewer, %{"type" => "state_change"} = envelope) do
    {:ok, Map.delete(envelope, "ext")}
  end

  # `permission_request` carries request_id / tool_name / input — all
  # operator-only — but the wrapper also overwrites the snapshot slot, so
  # dropping it outright would erase the agent from the viewer's grid.
  # Rewrite it as a minimal synthetic state_change so `waiting_permission`
  # still renders without leaking any payload field.
  defp sanitize_envelope_for(:viewer, %{"type" => "permission_request"} = envelope) do
    {:ok,
     envelope
     |> Map.put("type", "state_change")
     |> Map.put("state", "waiting_permission")
     |> Map.put("payload", %{})
     |> Map.delete("ext")}
  end

  # `question_request` carries the AskUserQuestion questions (operator-only,
  # ADR-0027) and likewise overwrites the snapshot slot, so it is rewritten to
  # a synthetic state_change — the viewer grid still shows `waiting_question`
  # without leaking the question text or options.
  defp sanitize_envelope_for(:viewer, %{"type" => "question_request"} = envelope) do
    {:ok,
     envelope
     |> Map.put("type", "state_change")
     |> Map.put("state", "waiting_question")
     |> Map.put("payload", %{})
     |> Map.delete("ext")}
  end

  # `session_boundary` marker (ADR-0036 F3, phase-17 17-7). Keep the
  # visual "boundary exists" cue (mode / state / ts / persona), but drop
  # the operator-only correlation IDs (`request_id`, `previous_session_id`,
  # `to_session_id`) — viewers must not learn session identifiers even
  # cosmetically.
  defp sanitize_envelope_for(:viewer, %{"type" => "session_boundary"} = envelope) do
    payload = Map.get(envelope, "payload") || %{}
    safe_payload = Map.take(payload, ["mode"])

    {:ok,
     envelope
     |> Map.put("payload", safe_payload)
     |> Map.delete("ext")}
  end

  # inter_agent_message is operator-only by spec (protocol-inter-agent);
  # listed explicitly for symmetry with the other typed clauses, even though
  # the fail-closed catch-all below would already drop it.
  defp sanitize_envelope_for(:viewer, %{"type" => "inter_agent_message"}), do: :drop

  defp sanitize_envelope_for(:viewer, _envelope), do: :drop

  @doc """
  `list_users`' projection, pulled out to a pure function (public, same
  testability precedent as `safe_reason/1` just below) so its "strips
  anything beyond these 4 keys" property is provable independently of
  whatever shape `Users.all_with_role/1` CURRENTLY happens to return.
  When this projection lived inline in the `list_users` handler, a
  channel-test mutation that fed `public_entry_with_role/3` an extra
  `source` key DID catch the leak — but only because feeding `Users` was
  the only way to exercise the handler at all; removing the projection
  itself while `Users` still returned exactly 4 keys left every test
  green, since there was nothing FOR the projection to strip. Testing
  this function directly, with a hand-built 5-key input, makes "the
  projection strips extras" hold regardless of `Users`' current shape.
  """
  def project_user_entry(%{id: id, kind: kind, display_name: name, role: role}) do
    %{id: id, kind: kind, display_name: name, role: role}
  end

  @doc """
  Allow-lists the client-facing reason (issue #62). Known atoms round-trip
  as their string and the channel-built key-validation tuples format to
  their stable text; anything else (a future AgentStates tuple, internal
  path, or stack fragment) is logged in full server-side and collapsed to
  a generic token so internal detail never reaches a client. Public for
  direct unit testing of the catch-all.
  """
  def safe_reason(reason) when reason in @safe_reasons, do: to_string(reason)
  def safe_reason({:missing_key, key}) when is_binary(key), do: "missing key: #{key}"

  def safe_reason({:invalid_value, key}) when is_binary(key),
    do: "invalid value: #{key}"

  def safe_reason(reason) do
    Logger.warning("agents_channel: unmapped error reason #{inspect(reason)}")
    "internal_error"
  end

  # The role in the assigns is a CONNECT-TIME snapshot, so an allow-list
  # demotion (ADR-0042) would leave a socket that is already open acting
  # as operator until it happens to reconnect — the dashboard slides its
  # cookie only every 12 h, so the refresh path alone is far too slow to
  # be the enforcement point (issue #158). Resolve from the credential
  # instead, which reads the allow-list / token list live.
  # Takes either the socket (resolve here) or an already-resolved role, so
  # a handler that gates twice — reset-pending guard + relay — resolves
  # once and both decisions come from the same authority (ふじ must-fix B
  # on issue #158). Resolving per call would let a role change land
  # between the two and fire a second disconnect broadcast.
  defp require_operator_role(%Phoenix.Socket{} = socket),
    do: require_operator_role(current_role(socket))

  # The name still says `operator` because it gates the operator-only
  # inbound set (~22 types, docs/specs/auth-and-authz.md) and that set is
  # what its call sites mean; admin passes as a superset (ADR-0050 D2).
  # Anything not in the list stays fail-closed.
  defp require_operator_role(role) when role in @operator_capable_roles, do: :ok
  defp require_operator_role(_role), do: {:error, :forbidden}

  # The operator gate with ADR-0015's receiver check WELDED to it (issue
  # #218). Every inbound client message passes this, so binding the two
  # together is what keeps the version gap from reopening: a new handler
  # cannot gate on operator role without also running the version check.
  #
  # That arrangement is the point. Before #218 the check was an INDEPENDENT
  # line each handler had to remember, and the same omission became a
  # must-fix twice (`launch_defaults` in #88, `rename_agent` / `rename_user`
  # in #197 段階3) under the same wrong premise — "this message is not
  # relayed to the runner, so it needs no version". ADR-0015 covers all
  # three parties and draws no such exception.
  #
  # Ordering is deliberate: the version check runs only AFTER the role check
  # passes, so a viewer cannot drive log output by pushing a bogus version.
  # The handlers that already carried the check placed it the same way.
  #
  # `action` names what happens to the request after acceptance, matching
  # `warn_on_version_mismatch/3`'s own vocabulary — "relaying" for the
  # pass-through helpers, the default "accepting" for a request the server
  # answers itself.
  defp require_operator(socket_or_role, payload, event, action \\ "accepting") do
    with :ok <- require_operator_role(socket_or_role) do
      warn_on_version_mismatch(payload, event, action)
    end
  end

  # A resolved role that no longer matches the snapshot also invalidates
  # everything else this socket derives from the snapshot — above all the
  # operator-only fan-out in handle_out, which cannot afford a live lookup
  # per envelope per subscriber. Dropping the socket (the issue #47
  # revocation path) makes the client reconnect and rebuild all of it from
  # a fresh connect, and gets the UI off the operator controls it can no
  # longer use.
  defp current_role(socket) do
    snapshot = socket.assigns[:role]
    socket_id = socket.assigns[:socket_id]

    case ClientSocket.role_for(socket.assigns[:credential]) do
      ^snapshot ->
        snapshot

      resolved ->
        if is_binary(socket_id) do
          KaoiroServerWeb.Endpoint.broadcast(socket_id, "disconnect", %{})
        end

        resolved
    end
  end

  # `list_session_events` (ADR-0055): format-only, no existence check —
  # see that handler's comment for why `fetch_agent_id/1` /
  # `fetch_restorable_agent_id/1` are the wrong fit here. A separate small
  # helper rather than reusing `fetch_lifecycle_agent_id/1` above
  # (planned-lifecycle intent, an unrelated feature with its own reason to
  # stay format-only): coupling two features to one private helper risks
  # a future change to one silently changing the other's contract.
  defp fetch_lifecycle_query_agent_id(%{"agent_id" => agent_id}) when is_binary(agent_id) do
    if AgentId.valid?(agent_id), do: {:ok, agent_id}, else: {:error, :invalid_agent_id}
  end

  defp fetch_lifecycle_query_agent_id(_payload), do: {:error, :missing_agent_id}

  defp fetch_agent_id(%{"agent_id" => agent_id} = _payload)
       when is_binary(agent_id) do
    # Enforce the protocol.md charset (issue #61) before the known? check;
    # then known agents only, which rejects typos early and keeps the
    # wrapper topic namespace from being probed blindly.
    cond do
      not AgentId.valid?(agent_id) -> {:error, :invalid_agent_id}
      not AgentStates.known?(agent_id) -> {:error, :unknown_agent}
      true -> {:ok, agent_id}
    end
  end

  defp fetch_agent_id(_payload), do: {:error, :missing_agent_id}

  # issue #276: no charset/existence check like fetch_agent_id above —
  # conversation_id is a wrapper-allocated UUID with no server-side format
  # contract (ConversationStates itself treats it as an opaque key), and
  # ConversationStates.close_by_operator/1 already answers "unknown" via
  # its own :unknown_conversation_id, so duplicating that lookup here
  # would just be a second source of truth for the same answer.
  defp fetch_conversation_id(%{"conversation_id" => cid})
       when is_binary(cid) and cid != "" do
    {:ok, cid}
  end

  defp fetch_conversation_id(_payload), do: {:error, :missing_conversation_id}

  # Same shape as fetch_agent_id/1 but also accepts agents present in the
  # restart-surviving AgentDirectory (ADR-0030) — restore / resume_session
  # must work even when AgentStates is empty after a server restart. The
  # anti-probe purpose of the known? gate is still served: only spawned
  # agents (ever recorded in AgentDirectory) are accepted.
  defp fetch_restorable_agent_id(%{"agent_id" => agent_id})
       when is_binary(agent_id) do
    cond do
      not AgentId.valid?(agent_id) -> {:error, :invalid_agent_id}
      not restorable_agent?(agent_id) -> {:error, :unknown_agent}
      true -> {:ok, agent_id}
    end
  end

  defp fetch_restorable_agent_id(_payload), do: {:error, :missing_agent_id}

  defp restorable_agent?(agent_id) do
    AgentStates.known?(agent_id) or AgentDirectory.get(agent_id) != nil
  end

  # user_id shape check for `rename_user` (issue #197 段階3, D13).
  # `AgentId.valid?/1` is reused rather than a new pattern: ADR-0050 D1
  # puts agent_id and user_id in the SAME id space (`[A-Za-z0-9._-]`,
  # issue #61). Unlike `fetch_agent_id/1`, this does NOT also check
  # existence — `Users.rename/2` already returns `{:error, :not_found}`
  # for an unknown user_id, so a second existence read here would be
  # redundant rather than protective.
  defp fetch_user_id(%{"user_id" => user_id}) when is_binary(user_id) do
    if AgentId.valid?(user_id), do: {:ok, user_id}, else: {:error, :invalid_user_id}
  end

  defp fetch_user_id(_payload), do: {:error, :missing_user_id}

  # host_id addresses the runner topic; enforce the protocol.md charset
  # (shared with agent_id, topic-safe) before broadcasting so a compromised
  # operator cannot inject a topic-breaking id. Unlike agent_id there is no
  # known? gate: a host_id may be addressed before its registry entry
  # arrives, and an unknown host's broadcast simply has no subscriber (the
  # operator learns via the absent spawn_result, ADR-0011 no-guarantee).
  defp fetch_host_id(%{"host_id" => host_id}) when is_binary(host_id) do
    if AgentId.valid?(host_id), do: {:ok, host_id}, else: {:error, :invalid_host_id}
  end

  defp fetch_host_id(_payload), do: {:error, :missing_host_id}

  # Returns structured reasons (not pre-formatted strings) so the
  # client-facing text is produced by safe_reason/1 alone (issue #62);
  # `key` is one of the channel's compile-time whitelisted keys, never
  # client input.
  defp check_keys(payload, key_checks) do
    Enum.find_value(key_checks, :ok, fn {key, valid?} ->
      cond do
        not Map.has_key?(payload, key) -> {:error, {:missing_key, key}}
        not valid?.(payload[key]) -> {:error, {:invalid_value, key}}
        true -> nil
      end
    end)
  end

  defp valid_instruction_text?(text) do
    is_binary(text) and byte_size(text) <= @max_instruction_bytes
  end

  # Reserved-command defensive reject (ADR-0036 F1, phase-17 17-4).
  # Old / external clients that never learned the `session_reset` control
  # can still send an exact `/new` or `/clear` as normal text; loud-reject
  # here so it never reaches the wrapper as an instruction. The strict
  # exact-match (trim + no attachments) mirrors the dashboard's intercept
  # rule so a legitimate `/new hello` prompt or `/new` with an attached
  # file falls through as an ordinary instruction.
  @reserved_session_commands ["/new", "/clear"]
  defp reject_reserved_session_command(payload) do
    text = payload["text"]
    attachments = payload["attachment_ids"] || []

    cond do
      not is_binary(text) ->
        :ok

      attachments != [] ->
        :ok

      String.trim(text) in @reserved_session_commands ->
        {:error, :reserved_session_command}

      true ->
        :ok
    end
  end

  # ADR-0036 F6, phase-17 17-4: instruction / model / effort / permission
  # switches are refused while a reset is pending so a completing reset
  # cannot land on top of a mid-turn edit. The stamp of `last_dispatch`
  # inside `SessionResets.guard_instruction/1` also gates the reverse
  # race (a reset arriving right after we hand this instruction off).
  #
  # Viewer-side calls are no-ops: they would be rejected downstream by
  # `require_operator/1` inside relay/5, but that reject happens AFTER
  # the guard. Stamping `last_dispatch` here would let a viewer poison
  # the operator's dispatch-cooldown window and delay a legitimate
  # reset. Bounce viewers before the stamp so the cooldown only reflects
  # accepted operator dispatches.
  #
  # The role is the one the handler resolved live, NOT the connect-time
  # assign (ふじ must-fix B on issue #158): reading the snapshot here let
  # a demoted socket stamp the cooldown before its relay was refused, and
  # let a promoted one skip the guard the relay would then honour.
  #
  # A missing agent_id passes through; the normal `fetch_agent_id/1`
  # inside relay/5 surfaces the correct error.
  # admin is guarded too, not exempted: this is a RESTRICTION rather than
  # a capability, and an admin instruction landing mid-reset causes the
  # same inconsistency the guard exists to prevent (ADR-0050 D2 grants
  # admin full authority, not the right to bypass ordering guarantees).
  defp guard_against_reset_pending(role, %{"agent_id" => agent_id})
       when role in @operator_capable_roles and is_binary(agent_id),
       do: SessionResets.guard_instruction(agent_id)

  defp guard_against_reset_pending(_role, _payload), do: :ok

  defp fetch_reset_mode(%{"mode" => mode}) when mode in @session_reset_modes,
    do: {:ok, mode}

  defp fetch_reset_mode(_payload), do: {:error, :invalid_mode}

  defp begin_planned_reset(agent_id, request_id) do
    case PlannedDisconnects.begin(agent_id, request_id, :reset) do
      :ok ->
        :ok

      {:error, :agent_busy} = error ->
        # The reset lock owns request-id allocation, so its atomic acquire
        # necessarily precedes the cross-lifecycle intent CAS. A competing
        # command that won the latter race means this reset was never relayed;
        # cancel exactly its lock before returning the established
        # `agent_busy` lifecycle vocabulary.
        _ = SessionResets.cancel(agent_id, request_id)
        error
    end
  end

  defp begin_planned_switch(agent_id, request_id) do
    case PlannedDisconnects.begin(agent_id, request_id, :switch_session) do
      :ok ->
        try do
          :ok =
            AgentActivity.begin_transition(
              agent_id,
              request_id,
              :restore,
              DateTime.utc_now() |> DateTime.to_iso8601()
            )
        rescue
          exception ->
            _ = PeerConnectivity.abort_setup(agent_id, request_id)
            reraise exception, __STACKTRACE__
        catch
          kind, reason ->
            _ = PeerConnectivity.abort_setup(agent_id, request_id)
            :erlang.raise(kind, reason, __STACKTRACE__)
        end

      {:error, _reason} = error ->
        error
    end
  end

  # Latest envelope for the agent; the caller has already run
  # `fetch_agent_id/1` (known? check), so a missing entry is a race with
  # AgentStates and is surfaced as `unknown_agent` too.
  defp fetch_agent_envelope(agent_id) do
    case AgentStates.snapshot()[agent_id] do
      envelope when is_map(envelope) -> {:ok, envelope}
      _ -> {:error, :unknown_agent}
    end
  end

  defp fetch_kaoiro_state(%{"state" => state}) when is_binary(state),
    do: {:ok, state}

  # A wrapper envelope without a `state` field would be a malformed
  # server snapshot (state_change is protocol-required to have one).
  # Fail-closed to `agent_busy` so a reset never proceeds under an
  # unreadable posture.
  defp fetch_kaoiro_state(_envelope), do: {:error, :agent_busy}

  # ADR-0036 F5: capability=false OR advertisement invalid (supports=true
  # + missing/empty modes) OR the requested mode is not enumerated =
  # unsupported. The dashboard-side judge fails the same way, so the two
  # gates agree on when the command is disabled.
  defp require_reset_capability(envelope, mode) do
    caps = envelope |> Map.get("ext", %{}) |> Map.get("session_capabilities")

    with true <- is_map(caps),
         true <- Map.get(caps, "supports_session_reset") == true,
         modes when is_list(modes) and modes != [] <-
           Map.get(caps, "session_reset_modes"),
         true <- mode in modes do
      :ok
    else
      _ -> {:error, :unsupported_session_reset}
    end
  end

  # phase-17 17-5 (must-1): the runner's rollback branch needs the
  # session_id that was current AT LOCK ACQUIRE TIME, not the one baked
  # into ParsedSpawn at spawn/switch. A long-lived agent whose session
  # was switched mid-run would otherwise roll back to a stale id.
  # `prev_sid` here is the AgentStates snapshot's session_id — read in
  # the same envelope that already fed require_reset_capability /
  # kaoiro_state, so it is the freshest value we can supply. When the
  # wrapper has not reported one yet (fresh spawn edge), the payload
  # simply omits the field and the runner has no rollback target.
  defp maybe_put_previous_session_id(payload, sid) when is_binary(sid),
    do: Map.put(payload, "previous_session_id", sid)

  defp maybe_put_previous_session_id(payload, _sid), do: payload

  defp started_payload(agent_id, mode, request_id, previous_session_id, origin) do
    # `previous_session_id` is optional in the protocol type — omit the
    # key entirely when nil so the wire payload matches
    # `SessionResetStarted { previous_session_id?: string }` instead of
    # sending `previous_session_id: null` (review advisory).
    %{
      "request_id" => request_id,
      "agent_id" => agent_id,
      "mode" => mode,
      "origin" => origin
    }
    |> maybe_put_previous_session_id(previous_session_id)
  end
end
