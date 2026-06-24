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
  `permission_decision`, and `interrupt` (issue #51) are accepted from
  operator clients only and relayed to the target wrapper topic without
  interpreting the content (agent-agnostic). No delivery guarantee — a
  relay to a disconnected wrapper is lost and the requester learns via
  timeout (ADR-0011). `clear_history` (operator-only, issue #48) drops
  the server-side reply log of past sessions and broadcasts
  `history_cleared` so every client re-filters its transcript; it touches
  only the in-memory ring buffer, never the wrapper's session logs.
  `delete_agent` (operator-only, issue #14) removes a `disconnected`
  agent's residual entry and broadcasts `agent_deleted` so every client
  drops it from the grid; it is rejected while the agent is still live.

  Host lifecycle (ADR-0023, issue #67): `spawn` / `stop` / `restart` /
  `enumerate_sessions` are operator-only and relay to the addressed
  `runner:<host_id>` without interpreting the payload (host/agent-agnostic,
  like the wrapper relay). `spawn` additionally rejects an `agent_id` that
  is already running (server-stage dedup, the runner-local lock being the
  second stage, issue #68). The runner's replies (`runner_sessions` /
  `spawn_result`) and host registration updates (`hosts`) ride
  `agents:lobby` but are operator-only in handle_out — host/session info
  must never reach a viewer (#27/ADR-0021, fail-closed).
  """

  use Phoenix.Channel

  require Logger

  alias KaoiroServer.AgentStates
  alias KaoiroServer.Auth
  alias KaoiroServer.HostRegistry
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
  intercept ["envelope", "history_cleared", "runner_sessions", "spawn_result", "hosts"]

  # Error reasons cleared for verbatim return to the client (issue #62).
  # Anything outside this set is a bug or a future internal value (a
  # tuple, an internal path, a stack fragment) and must not leak through
  # `to_string/1`; `safe_reason/1` logs it and returns "internal_error".
  @safe_reasons ~w(forbidden unknown_agent not_disconnected noop
                   payload_too_large missing_agent_id invalid_agent_id
                   already_running missing_host_id invalid_host_id
                   unknown_host unknown_persona invalid_persona
                   cwd_not_allowed invalid_cwd invalid_name)a

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

    # Reply-log history and the host set are operator-only; viewers stay at
    # the grid and never see host info (cwd allow-lists are sensitive, #46).
    if role == :operator do
      push(socket, "history", %{"agents" => AgentStates.histories()})
      push(socket, "hosts", %{"hosts" => HostRegistry.snapshot()})
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

  # Graceful stop of the current turn (issue #51, ADR-0020). Payload is
  # `{}` after agent_id is stripped — no per-event keys to validate; the
  # shared relay guards (operator, known agent, size cap) still apply.
  # Wrapper-side no-op when no turn is in flight (protocol.md A6).
  def handle_in("interrupt", payload, socket) do
    relay(socket, payload, "interrupt", [])
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
    relay_to_runner_guarded(socket, payload, "enumerate_sessions")
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

  # Operator-only removal of a disconnected agent's residual entry (issue
  # #14). AgentStates enforces the disconnected guard so a still-live
  # agent cannot be dropped from under its wrapper; on success broadcast
  # `agent_deleted` so every client removes it from the grid.
  def handle_in("delete_agent", payload, socket) do
    with :ok <- require_operator(socket),
         {:ok, agent_id} <- fetch_agent_id(payload),
         :ok <- AgentStates.delete(agent_id) do
      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "agent_deleted", %{
        "agent_id" => agent_id
      })

      {:reply, :ok, socket}
    else
      {:error, reason} -> {:reply, {:error, %{reason: safe_reason(reason)}}, socket}
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
    case HostRegistry.get(host_id) do
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
