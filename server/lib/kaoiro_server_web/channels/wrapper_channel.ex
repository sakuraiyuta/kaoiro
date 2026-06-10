defmodule KaoiroServerWeb.WrapperChannel do
  @moduledoc """
  Ingests envelopes from one wrapper (topic `wrapper:<agent_id>`), stores
  the latest state, and fans them out to clients (`agents:lobby`).

  Validation covers only the envelope v0 frame keys; per ADR-0010 the
  payload stays opaque to the server (agent-agnostic relay).
  """

  use Phoenix.Channel

  alias KaoiroServer.AgentStates

  @frame_keys ~w(version agent_id ts type state)

  # Resource bound only; content/type refinement is Phase 1.5-4. Clients
  # must still treat all envelope strings as untrusted when rendering.
  @max_envelope_bytes 65_536

  @impl true
  def join("wrapper:" <> agent_id, _params, socket) do
    {:ok, assign(socket, :agent_id, agent_id)}
  end

  @impl true
  def handle_in("envelope", envelope, socket) do
    with :ok <- validate(envelope, socket.assigns.agent_id),
         :ok <- AgentStates.put(envelope) do
      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "envelope", envelope)
      {:reply, :ok, socket}
    else
      {:error, reason} when is_atom(reason) ->
        {:reply, {:error, %{reason: to_string(reason)}}, socket}

      {:error, reason} ->
        {:reply, {:error, %{reason: reason}}, socket}
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
