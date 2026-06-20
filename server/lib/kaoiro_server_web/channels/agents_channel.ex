defmodule KaoiroServerWeb.AgentsChannel do
  @moduledoc """
  Client-facing fan-out. After joining `agents:lobby` the channel pushes a
  `snapshot` event with the current agent_id => latest envelope map;
  `envelope` broadcasts follow as agents change state. Both are sanitized
  per role: viewers see a pending permission_request but not its tool
  input, which may carry secrets (specs/threat-model.md). The `ext`
  statusline meta (cwd, model, context, rate_limits) is operator-only on
  every non-operator envelope — cwd alone leaks the host's filesystem
  layout (issue #46).

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
  """

  use Phoenix.Channel

  alias KaoiroServer.AgentStates

  # Resource bound for an operator instruction; generous for prose,
  # far below the wrapper-side envelope cap.
  @max_instruction_bytes 65_536

  # Aggregate cap on the relayed payload (issue #26). Extra keys pass
  # through opaquely for forward-compat, so a per-key check is not enough;
  # this bounds the whole map. Sized above a max instruction (text alone
  # may reach @max_instruction_bytes) plus the decision/extra-key overhead.
  @max_relay_bytes 131_072

  intercept ["envelope"]

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
      Map.new(AgentStates.snapshot(), fn {id, envelope} ->
        {id, sanitize_for(role, envelope)}
      end)

    push(socket, "snapshot", %{"agents" => agents})

    # Reply-log history is operator-only; viewers stay at the grid.
    if role == :operator do
      push(socket, "history", %{"agents" => AgentStates.histories()})
    end

    {:noreply, socket}
  end

  @impl true
  def handle_out("envelope", %{"type" => type} = envelope, socket)
      when type in ["log", "result"] do
    # Reply lines are operator-only; viewers never receive them.
    if socket.assigns[:role] == :operator do
      push(socket, "envelope", envelope)
    end

    {:noreply, socket}
  end

  def handle_out("envelope", envelope, socket) do
    push(socket, "envelope", sanitize_for(socket.assigns[:role], envelope))
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
      {:error, reason} -> {:reply, {:error, %{reason: to_string(reason)}}, socket}
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
      {:error, reason} -> {:reply, {:error, %{reason: to_string(reason)}}, socket}
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
        {:reply, {:error, %{reason: to_string(reason)}}, socket}
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

  # Viewers must not see the tool input of a pending permission request
  # (it may embed secrets); the request itself stays visible so the
  # waiting_permission state still renders.
  defp sanitize_for(:operator, envelope), do: envelope

  # ext (statusline meta: cwd / model / context / rate_limits /
  # slash_commands) is operator-only by default (#46): cwd alone leaks the
  # host's filesystem layout. Drop it for EVERY non-operator envelope type,
  # not just state_change, so a future type carrying ext stays private
  # without another patch. Then drop a permission_request's tool input,
  # which may embed secrets (threat-model).
  defp sanitize_for(_role, envelope) do
    envelope
    |> Map.delete("ext")
    |> drop_tool_input()
  end

  defp drop_tool_input(%{"type" => "permission_request"} = envelope) do
    Map.update(envelope, "payload", %{}, &Map.drop(&1, ["input"]))
  end

  defp drop_tool_input(envelope), do: envelope

  defp require_operator(socket) do
    if socket.assigns[:role] == :operator, do: :ok, else: {:error, :forbidden}
  end

  defp fetch_agent_id(%{"agent_id" => agent_id} = _payload)
       when is_binary(agent_id) do
    # Known agents only: rejects typos early and keeps the wrapper topic
    # namespace from being probed blindly.
    if AgentStates.known?(agent_id) do
      {:ok, agent_id}
    else
      {:error, :unknown_agent}
    end
  end

  defp fetch_agent_id(_payload), do: {:error, :missing_agent_id}

  defp check_keys(payload, key_checks) do
    Enum.find_value(key_checks, :ok, fn {key, valid?} ->
      cond do
        not Map.has_key?(payload, key) -> {:error, "missing key: #{key}"}
        not valid?.(payload[key]) -> {:error, "invalid value: #{key}"}
        true -> nil
      end
    end)
  end

  defp valid_instruction_text?(text) do
    is_binary(text) and byte_size(text) <= @max_instruction_bytes
  end
end
