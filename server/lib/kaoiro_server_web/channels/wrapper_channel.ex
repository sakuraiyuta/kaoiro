defmodule KaoiroServerWeb.WrapperChannel do
  @moduledoc """
  Ingests envelopes from one wrapper (topic `wrapper:<agent_id>`), stores
  the latest state, and fans them out to clients (`agents:lobby`).

  Validation covers only the envelope v0 frame keys; per ADR-0010 the
  payload stays opaque to the server (agent-agnostic relay). Joins are
  gated by the per-agent_id token list (ADR-0011); on terminate the
  server derives a `disconnected` envelope (specs/protocol.md). Server →
  wrapper pushes (`instruction` / `permission_decision`) arrive via
  Endpoint.broadcast on this topic and need no handler here.
  """

  use Phoenix.Channel

  alias KaoiroServer.AgentStates
  alias KaoiroServer.Auth

  @frame_keys ~w(version agent_id ts type state)

  # Resource bound only; content/type refinement is Phase 1.5-4. Clients
  # must still treat all envelope strings as untrusted when rendering.
  @max_envelope_bytes 65_536

  @impl true
  def join("wrapper:" <> agent_id, _params, socket) do
    case Auth.authorize_wrapper(agent_id, socket.assigns[:wrapper_token]) do
      :ok ->
        # Drop the raw token once verified so it cannot leak via crash
        # logs / socket inspection.
        {:ok,
         socket
         |> assign(:agent_id, agent_id)
         |> assign(:wrapper_token, nil)}

      {:error, reason} ->
        {:error, %{reason: to_string(reason)}}
    end
  end

  @impl true
  def handle_in("envelope", envelope, socket) do
    with :ok <- validate(envelope, socket.assigns.agent_id),
         :ok <- store(envelope) do
      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "envelope", envelope)
      {:reply, :ok, socket}
    else
      {:error, reason} when is_atom(reason) ->
        {:reply, {:error, %{reason: to_string(reason)}}, socket}

      {:error, reason} ->
        {:reply, {:error, %{reason: reason}}, socket}
    end
  end

  # log / result are reply transcript lines kept as history (ADR-0012);
  # state_change / permission_request refresh the latest state. A reply
  # arriving before any state (append_log :noop) is still broadcast live.
  defp store(%{"type" => type} = envelope) when type in ["log", "result"] do
    case AgentStates.append_log(envelope) do
      :noop -> :ok
      other -> other
    end
  end

  defp store(envelope), do: AgentStates.put(envelope, owner: self())

  @impl true
  def terminate(_reason, socket) do
    # Server-derived disconnected (specs/protocol.md). AgentStates only
    # applies it while this channel still owns the entry, so a stale
    # terminate after a reconnect cannot clobber the new state.
    ts = DateTime.utc_now() |> DateTime.to_iso8601()

    case AgentStates.disconnect(socket.assigns.agent_id, self(), ts) do
      {:ok, envelope} ->
        KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "envelope", envelope)

      :noop ->
        :ok
    end
  end

  defp validate(envelope, agent_id) when is_map(envelope) do
    cond do
      missing = Enum.find(@frame_keys, &(not Map.has_key?(envelope, &1))) ->
        {:error, "missing key: #{missing}"}

      envelope["agent_id"] != agent_id ->
        {:error, "agent_id does not match topic"}

      :erlang.external_size(envelope) > @max_envelope_bytes ->
        {:error, "envelope too large"}

      true ->
        :ok
    end
  end

  defp validate(_envelope, _agent_id), do: {:error, "envelope must be an object"}
end
