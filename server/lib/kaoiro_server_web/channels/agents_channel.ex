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
  (memory) + `AgentDirectory` / `SessionPointers` / `PermissionModes` /
  `InterAgentHistory`
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
  """

  use Phoenix.Channel

  require Logger

  alias KaoiroServer.AgentDirectory
  alias KaoiroServer.AgentStates
  alias KaoiroServer.Auth
  alias KaoiroServer.ClearWatermarks
  alias KaoiroServer.HostRegistry
  alias KaoiroServer.InterAgentHistory
  alias KaoiroServer.PersonaAssets
  alias KaoiroServer.SessionPointers
  alias KaoiroServer.SessionResets
  alias KaoiroServer.TokenDenylist
  alias KaoiroServerWeb.AgentId

  # Resource bound for an operator instruction; generous for prose,
  # far below the wrapper-side envelope cap.
  @max_instruction_bytes 65_536

  # Aggregate cap on the relayed payload (issue #26). Extra keys pass
  # through opaquely for forward-compat, so a per-key check is not enough;
  # this bounds the whole map. Sized above a max instruction (text alone
  # may reach @max_instruction_bytes) plus the decision/extra-key overhead.
  @max_relay_bytes 131_072

  # All viewer-gated events go through handle_out. `agent_deleted` is the
  # only fan-out event that always reaches both roles, so it stays out of
  # the intercept list to skip the per-socket round trip. The runner →
  # operator events (`runner_sessions` / `spawn_result` / `hosts`) carry
  # host/session info and are operator-only (ADR-0023, ADR-0021).
  intercept [
    "envelope",
    "history_cleared",
    "history_reset",
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
    "session_reset_failed"
  ]

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
                   agent_busy unsupported_session_reset
                   session_reset_pending reserved_session_command
                   invalid_mode)a

  # session_id charset — mirrors runner/src/sessions.ts SESSION_ID_PATTERN
  # (Claude Code's UUID-shaped JSONL filenames). Validated at this boundary so
  # a path-separator or dot injection cannot ride into the wrapper's
  # `--resume` arg or the F4 same-session lock via server → runner.
  @session_id_pattern ~r/^[A-Za-z0-9-]{1,128}$/

  @impl true
  def join("agents:lobby", _params, socket) do
    # The PubSub subscription only becomes active once join/3 returns, so a
    # snapshot replied here could miss an envelope broadcast in between.
    # Pushing it from handle_info runs after the subscription is live; a
    # broadcast racing the snapshot is then delivered twice at worst
    # (idempotent: last write per agent_id wins), never lost.
    send(self(), :after_join)
    {:ok, socket}
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

    push(socket, "snapshot", %{"agents" => agents})

    # Reply-log history, host set, and the identity ledger are operator-only;
    # viewers stay at the grid and never see host info (cwd allow-lists are
    # sensitive, #46) or the offline-agent directory (ADR-0030 D10). The
    # directory carries persona (+ operator-picked custom name) so the client
    # can render offline agents' tiles for the restore UI (ADR-0030 D5).
    if role == :operator do
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
      push(socket, "history", %{
        "agents" => merged_histories(),
        "clear_watermarks" => ClearWatermarks.all_displays(),
        "history_projection" => "per-pane-v1"
      })

      push(socket, "hosts", %{"hosts" => HostRegistry.snapshot(PersonaAssets.all_personas())})
      push(socket, "directory", %{"entries" => AgentDirectory.all()})
    end

    {:noreply, socket}
  end

  @impl true
  def handle_out("envelope", envelope, socket) do
    case sanitize_envelope_for(socket.assigns[:role], envelope) do
      :drop -> :ok
      {:ok, sanitized} -> push(socket, "envelope", sanitized)
    end

    {:noreply, socket}
  end

  # Viewers hold no reply log, so a history_cleared broadcast has nothing
  # to act on; gate it to operator under the same allow-list discipline
  # (ADR-0021) instead of letting it leak the session_id pointer.
  @impl true
  def handle_out("history_cleared", payload, socket) do
    if socket.assigns[:role] == :operator do
      push(socket, "history_cleared", payload)
    end

    {:noreply, socket}
  end

  # Resume reconstruction reset (issue #50, ADR-0014 phase-2): viewers hold no
  # reply log, so gate it operator-only like history_cleared (ADR-0021). The
  # operator clears the agent's transcript before the replayed `log` lines
  # (themselves operator-only) rebuild it.
  @impl true
  def handle_out("history_reset", payload, socket) do
    if socket.assigns[:role] == :operator do
      push(socket, "history_reset", payload)
    end

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
             "session_reset_failed"
           ] do
    if socket.assigns[:role] == :operator do
      push(socket, event, payload)
    end

    {:noreply, socket}
  end

  @impl true
  def handle_in("instruction", payload, socket) do
    with :ok <- reject_reserved_session_command(payload),
         :ok <- guard_against_reset_pending(socket, payload) do
      relay(socket, payload, "instruction", [
        {"text", &valid_instruction_text?/1}
      ])
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
    with :ok <- guard_against_reset_pending(socket, payload) do
      relay(socket, payload, "set_model", [{"model", &is_binary/1}])
    else
      {:error, reason} ->
        {:reply, {:error, %{reason: safe_reason(reason)}}, socket}
    end
  end

  def handle_in("set_effort", payload, socket) do
    with :ok <- guard_against_reset_pending(socket, payload) do
      relay(socket, payload, "set_effort", [{"effort", &is_binary/1}])
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
    with :ok <- guard_against_reset_pending(socket, payload) do
      relay(socket, payload, "refresh_models", [])
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

    with :ok <- guard_against_reset_pending(socket, payload) do
      case relay(socket, payload, "set_permission_mode", [{"mode", is_known_mode}]) do
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
    with :ok <- require_operator(socket),
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
           ) do
      KaoiroServerWeb.Endpoint.broadcast(
        "agents:lobby",
        "session_reset_started",
        started_payload(agent_id, mode, request_id, prev_sid)
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
    with :ok <- require_operator(socket),
         :ok <- check_relay_size(payload),
         {:ok, agent_id} <- fetch_agent_id(payload),
         :ok <-
           check_keys(payload, [
             {"upload_id", &is_binary/1},
             {"filename", &is_binary/1},
             {"mime", &is_binary/1},
             {"size", &is_integer/1},
             {"chunks", &is_integer/1}
           ]) do
      relayed = Map.delete(payload, "agent_id")
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
  def handle_in("attach_chunk", {:binary, data}, socket) when is_binary(data) do
    with :ok <- require_operator(socket),
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

  def handle_in("attach_close", payload, socket) do
    with :ok <- require_operator(socket),
         :ok <- check_relay_size(payload),
         {:ok, _payload_agent_id} <- fetch_agent_id(payload),
         :ok <- check_keys(payload, [{"upload_id", &is_binary/1}]),
         {:ok, routed_agent_id} <-
           lookup_upload_route(socket, payload["upload_id"]) do
      # Route via the table, not payload.agent_id: the route table is the
      # source of truth for upload_id -> agent_id (registered at attach_open),
      # symmetric with attach_chunk (whose binary header carries no agent_id).
      # A mismatched payload agent_id is ignored at routing time; the
      # fetch_agent_id check still gates structural validity / known-agent.
      relayed = Map.delete(payload, "agent_id")

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
    with :ok <- require_operator(socket),
         {:ok, host_id} <- fetch_host_id(payload),
         {:ok, host} <- fetch_host(host_id),
         {:ok, persona} <- resolve_persona(host, payload),
         {:ok, persona} <- apply_custom_name(persona, payload),
         {:ok, cwd} <- fetch_allowed_cwd(host, payload),
         {:ok, engine} <- fetch_allowed_engine(host, payload),
         {:ok, agent_id} <- allocate_agent_id(host_id),
         {:ok, spawn_payload} <-
           build_spawn_payload(agent_id, persona, cwd, engine, payload) do
      KaoiroServerWeb.Endpoint.broadcast("runner:#{host_id}", "spawn", spawn_payload)
      # Seed the cwd now so restore works even if the wrapper never reports a
      # statusline cwd (#22, ADR-0014): the real session_id arrives later and
      # is preserved alongside this cwd (SessionPointers keeps non-nil fields).
      SessionPointers.record(agent_id, nil, cwd, engine || "claude-code")
      # Persist the identity so operator-driven restore keeps working after
      # a server restart when AgentStates is empty (ADR-0030 D2 / D3).
      AgentDirectory.record(agent_id, persona)
      {:reply, {:ok, %{"agent_id" => agent_id}}, socket}
    else
      {:error, reason} -> {:reply, {:error, %{reason: safe_reason(reason)}}, socket}
    end
  end

  def handle_in("stop", payload, socket) do
    relay_to_runner_guarded(socket, payload, "stop")
  end

  def handle_in("restart", payload, socket) do
    relay_to_runner_guarded(socket, payload, "restart")
  end

  def handle_in("enumerate_sessions", payload, socket) do
    # `cwd` may be omitted when the client only knows an `agent_id` (detail
    # view: the wrapper may not yet have reported ext.cwd, but the server
    # holds a SessionPointer seeded at spawn time). Resolve it here so the
    # runner still receives the `{host_id, cwd}` shape it expects.
    with :ok <- require_operator(socket),
         {:ok, host_id} <- fetch_host_id(payload),
         {:ok, host} <- fetch_host(host_id),
         {:ok, _engine} <- fetch_allowed_engine(host, payload),
         {:ok, enriched} <- resolve_enumerate_cwd(payload) do
      relay_to_runner(socket, enriched, host_id, "enumerate_sessions")
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
    with :ok <- require_operator(socket),
         {:ok, agent_id} <- fetch_restorable_agent_id(payload),
         :ok <- require_disconnected(agent_id),
         {:ok, persona} <- agent_persona(agent_id),
         {:ok, session_id, cwd, engine} <- session_pointer(agent_id),
         {:ok, host} <- fetch_host(host_id_of(agent_id)),
         {:ok, engine} <- fetch_allowed_engine(host, %{"engine" => engine}),
         {:ok, spawn_payload} <-
           build_restore_payload(agent_id, persona, cwd, session_id, engine) do
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
    with :ok <- require_operator(socket),
         :ok <- guard_against_reset_pending(socket, payload),
         {:ok, agent_id} <- fetch_restorable_agent_id(payload),
         {:ok, session_id} <- fetch_resume_session_id(payload) do
      if live_agent?(agent_id) do
        # Live-agent switch_session (ADR-0014 F1 追補, phase-15 D8): pipe the
        # agent's stored snapshot through so the swapped-in wrapper stamps
        # ext.resume_snapshot / ext.resume_drift on its first state_change.
        # Without this the relaunched wrapper would retain the original
        # spawn-time snapshot (post-review Finding 2).
        switch_payload =
          %{
            "version" => "0",
            "agent_id" => agent_id,
            "resume_session_id" => session_id
          }
          |> maybe_put_resume_snapshot(agent_id)

        KaoiroServerWeb.Endpoint.broadcast(
          "runner:#{host_id_of(agent_id)}",
          "switch_session",
          switch_payload
        )

        {:reply, :ok, socket}
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
  def handle_in("clear_history", payload, socket) do
    with :ok <- require_operator(socket),
         {:ok, agent_id} <- fetch_agent_id(payload),
         {:ok, session_id} <- AgentStates.clear_other_sessions(agent_id) do
      # Watermark this clear on the SAME single serialized allocator
      # every IA `InterAgentHistory.append/2` uses (ふじ R5 must-fix,
      # 2026-07-23 — replaces the pre-R5 inline
      # `{System.system_time(:microsecond),
      # System.unique_integer([:positive, :monotonic])}` pair whose
      # `unique_integer` half reset per-BEAM and whose wall clock could
      # rollback). The ISO string goes on the broadcast as display-only
      # audit hint. `record/4` is synchronous + fsync-gated (M7-a) and
      # `IngressOrder.allocate/0` is likewise fsync-gated, so neither
      # the broadcast nor the watermark can outrun disk persistence.
      order = KaoiroServer.IngressOrder.allocate()
      display = DateTime.utc_now() |> DateTime.to_iso8601()
      :ok = ClearWatermarks.record(agent_id, order, display)

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
    with :ok <- require_operator(socket),
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
    with :ok <- require_operator(socket),
         {:ok, agent_id} <- fetch_restorable_agent_id(payload) do
      revoked_at = DateTime.utc_now() |> DateTime.to_iso8601()
      TokenDenylist.revoke(agent_id, revoked_at)

      KaoiroServerWeb.Endpoint.broadcast(
        "wrapper:#{agent_id}",
        "revoked",
        %{"reason" => "operator_revoke", "revoked_at" => revoked_at}
      )

      {:reply, {:ok, %{"revoked_at" => revoked_at}}, socket}
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
      %{"reason" => "agent_deleted", "revoked_at" => revoked_at}
    )

    # Step 4: purge every other store (order among them is unimportant —
    # they are all idempotent and independent).
    with :ok <- delete_live_if_present(agent_id) do
      AgentDirectory.delete(agent_id)
      SessionPointers.delete(agent_id)
      KaoiroServer.PermissionModes.delete(agent_id)
      InterAgentHistory.delete_agent(agent_id)
      # phase-17 17-4: clear any dangling reset lock + dispatch cooldown
      # so a respawn under the same agent_id does not inherit stale state.
      SessionResets.delete(agent_id)
      # issue #109: purge the clear watermark too, so an agent respawned
      # under the same agent_id starts fresh (no lingering hide-past
      # filter from a prior operator).
      ClearWatermarks.delete(agent_id)
      :ok
    end
  end

  # Ordinary log/result/boundary history remains memory-only and is
  # rebuilt from SDK JSONL. Structured IA cannot be rebuilt, so DETS is
  # authoritative for that type. Drop volatile IA before merging to
  # avoid live-run doubles.
  #
  # Server-authoritative per-pane projection (ふじ #109 M6/M7 must-fix,
  # 2026-07-23):
  #   1. Load durable IA WITH its server-ingress order tuple, then
  #      fan it out to both the sender's key AND the receiver's key —
  #      the client no longer does its own fanOut on the history push
  #      (it still fans a LIVE IA to both panes; that path stays in
  #      onEnvelope for real-time delivery latency).
  #   2. Per pane, drop IA whose order tuple is `<= watermark(pane)`.
  #      Both sender-view and receiver-view filters run in the same
  #      ordering domain the watermark was recorded in, so a wrapper's
  #      producer clock skew cannot misclassify a cutoff crossing.
  #   3. Merge with the volatile non-IA histories, sort chronologically
  #      by wire `{ts, seq}` (display ordering, same key
  #      `compareTranscriptEnvelopes` uses on the client).
  #
  # Peer transcripts stay untouched — dropping an entry from receiver's
  # pane by receiver's watermark does not touch what sender's pane
  # shows (the same envelope is filtered per pane by that pane's own
  # cutoff, so the "peer 側 表示にも影響なし" contract holds).
  defp merged_histories do
    volatile_without_ia =
      AgentStates.histories()
      |> Enum.flat_map(fn {agent_id, entries} ->
        kept = Enum.reject(entries, &(Map.get(&1, "type") == "inter_agent_message"))
        if kept == [], do: [], else: [{agent_id, kept}]
      end)
      |> Map.new()

    # ふじ R2 must-fix (2026-07-23): `all_filter_bounds` returns tagged
    # bounds — `{:order, tuple}` for post-M6 clears, `{:iso, iso}` for
    # legacy pre-M6 entries. The ISO branch preserves the pre-M6 wire-ts
    # filter until the next real clear promotes the entry.
    watermark_bounds = ClearWatermarks.all_filter_bounds()
    durable_by_pane = pre_fanout_and_filter(watermark_bounds)

    volatile_without_ia
    |> Map.merge(durable_by_pane, fn _agent_id, volatile, durable ->
      volatile ++ durable
    end)
    |> Map.new(fn {agent_id, entries} ->
      sorted =
        Enum.sort_by(entries, fn envelope ->
          {Map.get(envelope, "ts", ""), Map.get(envelope, "seq", 0)}
        end)

      {agent_id, sorted}
    end)
  end

  # Pre-fanOut IA envelopes to sender AND receiver panes, then drop
  # entries whose server order tuple is `<= watermark(pane)`. Watermark
  # absent (nil) = never cleared, keep the entry (regression pin for
  # the pre-M6 default behaviour). Envelopes whose payload has no `"to"`
  # (server-synthesized skeletons) are only visible in the sender's
  # pane, matching the wrapper-side fanOut policy.
  defp pre_fanout_and_filter(watermark_bounds) do
    InterAgentHistory.all_with_order()
    |> Enum.reduce(%{}, fn {sender_id, entries}, acc ->
      Enum.reduce(entries, acc, fn {order, envelope}, acc2 ->
        acc2
        |> maybe_add_to_pane(sender_id, order, envelope, watermark_bounds)
        |> maybe_fanout_to_receiver(order, envelope, watermark_bounds, sender_id)
      end)
    end)
  end

  # Adds `envelope` to `pane_agent_id`'s bucket unless the pane's
  # watermark bound hides it.
  defp maybe_add_to_pane(acc, pane_agent_id, order, envelope, watermark_bounds) do
    if hidden_by?(watermark_bounds, pane_agent_id, order, envelope) do
      acc
    else
      Map.update(acc, pane_agent_id, [envelope], fn existing -> existing ++ [envelope] end)
    end
  end

  # If the envelope has a valid receiver id that is NOT the same as the
  # sender, add it to the receiver's pane too (subject to that pane's
  # watermark).
  defp maybe_fanout_to_receiver(acc, order, envelope, watermark_bounds, sender_id) do
    case get_in(envelope, ["payload", "to"]) do
      to when is_binary(to) and to != "" and to != sender_id ->
        maybe_add_to_pane(acc, to, order, envelope, watermark_bounds)

      _ ->
        acc
    end
  end

  # Two-mode hide check (ふじ R2 must-fix, 2026-07-23):
  #   - `{:order, tuple}` — post-M6 clear, compare server ingress order
  #     tuples (BEAM term ordering handles integers pairwise).
  #   - `{:iso, iso}` — legacy pre-M6 clear, compare the envelope's wire
  #     `ts` string against `iso` (ISO-8601 lex compare = time compare
  #     when both are UTC-normalized, matching the pre-M6 filter that
  #     shipped for this cutoff). An envelope with no / non-string ts
  #     falls through as "not hidden" (fail-open for display; the entry
  #     is still filtered by the receiver's own watermark on the next
  #     post-M6 clear).
  # Absent watermark = never cleared → never hidden.
  defp hidden_by?(watermark_bounds, agent_id, order, envelope) do
    case Map.get(watermark_bounds, agent_id) do
      {:order, {us, uniq} = watermark} when is_integer(us) and is_integer(uniq) ->
        order <= watermark

      {:iso, iso} when is_binary(iso) ->
        case Map.get(envelope, "ts") do
          ts when is_binary(ts) -> ts <= iso
          _ -> false
        end

      _ ->
        false
    end
  end

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
  defp relay(socket, payload, event, key_checks) do
    relayed = Map.delete(payload, "agent_id")

    with :ok <- require_operator(socket),
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
    with :ok <- require_operator(socket),
         {:ok, host_id} <- fetch_host_id(payload) do
      relay_to_runner(socket, payload, host_id, event)
    else
      {:error, reason} -> {:reply, {:error, %{reason: safe_reason(reason)}}, socket}
    end
  end

  # Relays `payload` (minus host_id, which only addresses the runner topic)
  # to `runner:<host_id>` without interpreting the contents (ADR-0023,
  # server stays host/agent-agnostic). The whole map is size-bounded so an
  # oversized opaque blob cannot reach the runner process (issue #26).
  defp relay_to_runner(socket, payload, host_id, event) do
    relayed = Map.delete(payload, "host_id")

    case check_relay_size(relayed) do
      :ok ->
        KaoiroServerWeb.Endpoint.broadcast("runner:#{host_id}", event, relayed)
        {:reply, :ok, socket}

      {:error, reason} ->
        {:reply, {:error, %{reason: safe_reason(reason)}}, socket}
    end
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

  # Optional per-instance display name (#22): overrides persona.name for this
  # agent only (agent_id and persona.id are untouched, so identity / sprites /
  # mood are unaffected). Absent or blank = keep the persona name. Bounded
  # length and no control chars so it cannot break the grid layout; the client
  # escapes it on render. The override rides the persona into the wrapper
  # config, so no runner/wrapper change is needed.
  defp apply_custom_name(persona, %{"name" => name}) when is_binary(name) do
    trimmed = String.trim(name)

    cond do
      trimmed == "" -> {:ok, persona}
      String.length(trimmed) > 64 -> {:error, :invalid_name}
      String.match?(trimmed, ~r/[\x00-\x1f\x7f]/) -> {:error, :invalid_name}
      true -> {:ok, Map.put(persona, "name", trimmed)}
    end
  end

  defp apply_custom_name(persona, _payload), do: {:ok, persona}

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
  defp build_spawn_payload(agent_id, persona, cwd, engine, payload) do
    spawn_payload =
      %{
        "version" => "0",
        "agent_id" => agent_id,
        "persona" => persona,
        "cwd" => cwd,
        "token" => Auth.mint_wrapper_token(agent_id)
      }
      |> maybe_put_string("initial_prompt", payload["initial_prompt"])
      |> maybe_put_string("resume_session_id", payload["resume_session_id"])
      |> maybe_put_engine(engine)
      # Launch-time picks (ADR-0032 F4bc / ADR-0033 F3): free-form model /
      # effort strings (value sets belong to the engine catalog) plus the
      # codex sandbox axis and its network toggle; the runner re-validates.
      |> maybe_put_string("model", payload["model"])
      |> maybe_put_string("effort", payload["effort"])
      |> maybe_put_sandbox(payload["sandbox"])
      |> maybe_put_boolean("network_access", payload["network_access"])
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
  # F4a). Absent = nil (the runner defaults to claude-code), so an old
  # dashboard keeps working; an unknown or undeclared value is rejected
  # rather than silently launching the wrong engine.
  @engine_values ["claude-code", "codex"]
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

  # The agent's persona (incl. any custom name) from the restart-surviving
  # identity ledger (ADR-0030 D3); restore re-spawns with it so the revived
  # agent keeps its identity even after a server restart cleared AgentStates.
  defp agent_persona(agent_id) do
    case AgentDirectory.get(agent_id) do
      %{persona: persona} when is_map(persona) -> {:ok, persona}
      _ -> {:error, :unknown_agent}
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
  defp resume_disconnected(agent_id, session_id, socket) do
    with {:ok, persona} <- agent_persona(agent_id),
         {:ok, _sid, cwd, engine} <- session_pointer(agent_id),
         {:ok, host} <- fetch_host(host_id_of(agent_id)),
         {:ok, engine} <- fetch_allowed_engine(host, %{"engine" => engine}),
         {:ok, spawn_payload} <-
           build_restore_payload(agent_id, persona, cwd, session_id, engine) do
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

  # session_id nil = fresh-restore (phase-25, ADR-0030 D8 追補): the pointer
  # lost its session_id via detach (/clear) or never received one (未発話).
  # Omit resume_session_id and stamp apply_resume_snapshot=true so the runner
  # takes the fresh-spawn + snapshot re-apply branch. resume_snapshot itself
  # rides through the shared maybe_put_resume_snapshot pipe (nil-snapshot
  # pointer degrades safely to engine defaults, fail-soft).
  defp build_restore_payload(agent_id, persona, cwd, session_id, engine) do
    spawn_payload =
      %{
        "version" => "0",
        "agent_id" => agent_id,
        "persona" => persona,
        "cwd" => cwd,
        "token" => Auth.mint_wrapper_token(agent_id)
      }
      |> maybe_put_engine(engine)
      |> maybe_put_resume_session_id(session_id)
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
  defp sanitize_envelope_for(:operator, envelope), do: {:ok, envelope}

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

  defp require_operator(socket) do
    if socket.assigns[:role] == :operator, do: :ok, else: {:error, :forbidden}
  end

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
  # `require_operator/1` inside relay/4, but that reject happens AFTER
  # the guard. Stamping `last_dispatch` here would let a viewer poison
  # the operator's dispatch-cooldown window and delay a legitimate
  # reset. Bounce viewers before the stamp so the cooldown only reflects
  # accepted operator dispatches.
  #
  # A missing agent_id passes through; the normal `fetch_agent_id/1`
  # inside relay/4 surfaces the correct error.
  defp guard_against_reset_pending(socket, %{"agent_id" => agent_id})
       when is_binary(agent_id) do
    if socket.assigns[:role] == :operator do
      SessionResets.guard_instruction(agent_id)
    else
      :ok
    end
  end

  defp guard_against_reset_pending(_socket, _payload), do: :ok

  defp fetch_reset_mode(%{"mode" => mode}) when mode in @session_reset_modes,
    do: {:ok, mode}

  defp fetch_reset_mode(_payload), do: {:error, :invalid_mode}

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

  defp started_payload(agent_id, mode, request_id, previous_session_id) do
    # `previous_session_id` is optional in the protocol type — omit the
    # key entirely when nil so the wire payload matches
    # `SessionResetStarted { previous_session_id?: string }` instead of
    # sending `previous_session_id: null` (review advisory).
    %{
      "request_id" => request_id,
      "agent_id" => agent_id,
      "mode" => mode
    }
    |> maybe_put_previous_session_id(previous_session_id)
  end
end
