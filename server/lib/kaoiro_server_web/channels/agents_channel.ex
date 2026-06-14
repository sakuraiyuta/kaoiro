defmodule KaoiroServerWeb.AgentsChannel do
  @moduledoc """
  Client-facing fan-out. After joining `agents:lobby` the channel pushes a
  `snapshot` event with the current agent_id => latest envelope map;
  `envelope` broadcasts follow as agents change state. Both are sanitized
  per role: viewers see a pending permission_request but not its tool
  input, which may carry secrets (specs/threat-model.md).

  Operators additionally get a `history` push (the per-agent reply log)
  on join and the live `log` / `result` reply envelopes; viewers receive
  neither, since reply lines carry tool I/O that may hold secrets
  (ADR-0012, specs/threat-model.md).

  Inbound (Phase 3, specs/protocol.md): `instruction` and
  `permission_decision` are accepted from operator clients only and
  relayed to the target wrapper topic without interpreting the content
  (agent-agnostic). No delivery guarantee — a relay to a disconnected
  wrapper is lost and the requester learns via timeout (ADR-0011).
  """

  use Phoenix.Channel

  alias KaoiroServer.AgentStates

  # Resource bound for an operator instruction; generous for prose,
  # far below the wrapper-side envelope cap.
  @max_instruction_bytes 65_536

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

  # Relays `payload` (minus agent_id, which only addresses the wrapper
  # topic) after the operator/known-agent/shape checks shared by both
  # inbound events. Extra keys pass through opaquely (forward compat,
  # server stays agent-agnostic); the listed keys must be present and
  # well-typed so a malformed value is rejected at this boundary instead
  # of relying on the wrapper's guard.
  defp relay(socket, payload, event, key_checks) do
    with :ok <- require_operator(socket),
         {:ok, agent_id} <- fetch_agent_id(payload),
         :ok <- check_keys(payload, key_checks) do
      KaoiroServerWeb.Endpoint.broadcast(
        "wrapper:#{agent_id}",
        event,
        Map.delete(payload, "agent_id")
      )

      {:reply, :ok, socket}
    else
      {:error, reason} ->
        {:reply, {:error, %{reason: to_string(reason)}}, socket}
    end
  end

  # Viewers must not see the tool input of a pending permission request
  # (it may embed secrets); the request itself stays visible so the
  # waiting_permission state still renders.
  defp sanitize_for(:operator, envelope), do: envelope

  defp sanitize_for(_role, %{"type" => "permission_request"} = envelope) do
    Map.update(envelope, "payload", %{}, &Map.drop(&1, ["input"]))
  end

  defp sanitize_for(_role, envelope), do: envelope

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
