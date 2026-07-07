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
  """

  use Phoenix.Channel

  require Logger

  alias KaoiroServer.AgentDirectory
  alias KaoiroServer.AgentStates
  alias KaoiroServer.Auth
  alias KaoiroServer.HostRegistry
  alias KaoiroServer.PersonaAssets
  alias KaoiroServer.SessionPointers
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
    "hosts"
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
                   unknown_upload)a

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
      push(socket, "history", %{"agents" => AgentStates.histories()})
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
      when event in ["runner_sessions", "spawn_result", "hosts"] do
    if socket.assigns[:role] == :operator do
      push(socket, event, payload)
    end

    {:noreply, socket}
  end

  @impl true
  def handle_in("instruction", payload, socket) do
    relay(socket, payload, "instruction", [
      {"text", &valid_instruction_text?/1}
    ])
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
    relay(socket, payload, "set_model", [{"model", &is_binary/1}])
  end

  def handle_in("set_effort", payload, socket) do
    relay(socket, payload, "set_effort", [{"effort", &is_binary/1}])
  end

  # permission_mode switch for a running session (issue #58). Operator-only;
  # the validated choice relays opaquely to the wrapper (which applies it via
  # query.setPermissionMode) AND persists into PermissionModes so the next
  # start restores the pick. Closed-enum gate keeps a malformed dashboard
  # payload from hitting the SDK.
  @permission_modes ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"]
  def handle_in("set_permission_mode", payload, socket) do
    is_known_mode = fn value -> is_binary(value) and value in @permission_modes end

    case relay(socket, payload, "set_permission_mode", [{"mode", is_known_mode}]) do
      {:reply, :ok, _} = ok ->
        # Validation already passed; persist before returning so a quick
        # reconnect sees the new pick on its after_join push.
        KaoiroServer.PermissionModes.record(payload["agent_id"], payload["mode"])
        ok

      other ->
        other
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
         {:ok, agent_id} <- allocate_agent_id(host_id),
         {:ok, spawn_payload} <- build_spawn_payload(agent_id, persona, cwd, payload) do
      KaoiroServerWeb.Endpoint.broadcast("runner:#{host_id}", "spawn", spawn_payload)
      # Seed the cwd now so restore works even if the wrapper never reports a
      # statusline cwd (#22, ADR-0014): the real session_id arrives later and
      # is preserved alongside this cwd (SessionPointers keeps non-nil fields).
      SessionPointers.record(agent_id, nil, cwd)
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
  def handle_in("restore", payload, socket) do
    with :ok <- require_operator(socket),
         {:ok, agent_id} <- fetch_restorable_agent_id(payload),
         :ok <- require_disconnected(agent_id),
         {:ok, persona} <- agent_persona(agent_id),
         {:ok, session_id, cwd} <- session_pointer(agent_id),
         {:ok, spawn_payload} <-
           build_restore_payload(agent_id, persona, cwd, session_id) do
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
         {:ok, agent_id} <- fetch_restorable_agent_id(payload),
         {:ok, session_id} <- fetch_resume_session_id(payload) do
      if live_agent?(agent_id) do
        KaoiroServerWeb.Endpoint.broadcast(
          "runner:#{host_id_of(agent_id)}",
          "switch_session",
          %{
            "version" => "0",
            "agent_id" => agent_id,
            "resume_session_id" => session_id
          }
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
      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "history_cleared", %{
        "agent_id" => agent_id,
        "session_id" => session_id
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
         :ok <- purge_agent_records(agent_id) do
      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "agent_deleted", %{
        "agent_id" => agent_id
      })

      {:reply, :ok, socket}
    else
      {:error, reason} -> {:reply, {:error, %{reason: safe_reason(reason)}}, socket}
    end
  end

  # Removes the agent from every server-side store. AgentStates.delete keeps
  # the disconnected guard (a live agent cannot be dropped); a directory-only
  # entry skips that step (never in AgentStates) and still purges the DETS
  # ledgers. AgentDirectory / SessionPointers / PermissionModes deletes are
  # idempotent, so a stale pointer for an already-vanished AgentStates entry
  # still yields :ok — a single delete request cleans up everything.
  defp purge_agent_records(agent_id) do
    with :ok <- delete_live_if_present(agent_id) do
      AgentDirectory.delete(agent_id)
      SessionPointers.delete(agent_id)
      KaoiroServer.PermissionModes.delete(agent_id)
      :ok
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
  defp build_spawn_payload(agent_id, persona, cwd, payload) do
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

    case check_relay_size(spawn_payload) do
      :ok -> {:ok, spawn_payload}
      {:error, reason} -> {:error, reason}
    end
  end

  defp maybe_put_string(map, key, value) when is_binary(value) and value != "",
    do: Map.put(map, key, value)

  defp maybe_put_string(map, _key, _value), do: map

  # Restore is only for a disconnected agent (ADR-0014 F4: server-side owner
  # fencing, the early-reject first stage before the runner-local lock). A live
  # agent must not be re-spawned under its own agent_id (D5 二重接続).
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

  # The restart-surviving resume pointer. Both session_id AND cwd must be known
  # (the runner resumes under cwd and verifies the session exists there, T3); a
  # pointer that never recorded a cwd cannot be restored.
  defp session_pointer(agent_id) do
    case SessionPointers.get(agent_id) do
      %{session_id: sid, cwd: cwd} when is_binary(sid) and is_binary(cwd) ->
        {:ok, sid, cwd}

      _ ->
        {:error, :no_session}
    end
  end

  # host_id is the agent_id minus its last `.segment` — the server allocated it
  # as `<host_id>.<rand>` with a dot-free suffix (ADR-0024 D3), so the host is
  # everything before the last dot.
  defp host_id_of(agent_id) do
    case String.split(agent_id, ".") do
      parts when length(parts) > 1 -> parts |> Enum.drop(-1) |> Enum.join(".")
      _ -> agent_id
    end
  end

  # Disconnected branch of resume_session: same wire as restore (spawn +
  # resume_session_id to `runner:<host_id>`) but with the operator-picked
  # session_id, not the SessionPointer's latest. The pointer is still
  # consulted for cwd — a pointer that never recorded one blocks with
  # :no_session, matching restore's semantics.
  defp resume_disconnected(agent_id, session_id, socket) do
    with {:ok, persona} <- agent_persona(agent_id),
         {:ok, _sid, cwd} <- session_pointer(agent_id),
         {:ok, spawn_payload} <-
           build_restore_payload(agent_id, persona, cwd, session_id) do
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

  defp build_restore_payload(agent_id, persona, cwd, session_id) do
    spawn_payload = %{
      "version" => "0",
      "agent_id" => agent_id,
      "persona" => persona,
      "cwd" => cwd,
      "token" => Auth.mint_wrapper_token(agent_id),
      "resume_session_id" => session_id
    }

    case check_relay_size(spawn_payload) do
      :ok -> {:ok, spawn_payload}
      {:error, reason} -> {:error, reason}
    end
  end

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
end
