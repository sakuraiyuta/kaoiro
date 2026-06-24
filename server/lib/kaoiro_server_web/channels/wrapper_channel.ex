defmodule KaoiroServerWeb.WrapperChannel do
  @moduledoc """
  Ingests envelopes from one wrapper (topic `wrapper:<agent_id>`), stores
  the latest state, and fans them out to clients (`agents:lobby`). An
  envelope's `session_id` (once the wrapper reports one) also refreshes
  the agent's restart-surviving pointer (ADR-0014 F1, issue #49).

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
  alias KaoiroServer.SessionPointers
  alias KaoiroServerWeb.AgentId

  @frame_keys ~w(version agent_id ts type state)

  # Resource bound only; content/type refinement is Phase 1.5-4. Clients
  # must still treat all envelope strings as untrusted when rendering.
  @max_envelope_bytes 65_536

  @impl true
  def join("wrapper:" <> agent_id, _params, socket) do
    with :ok <- validate_agent_id(agent_id),
         :ok <- Auth.authorize_wrapper(agent_id, socket.assigns[:wrapper_token]),
         :ok <- reject_if_connected(agent_id) do
      # Drop the raw token once verified so it cannot leak via crash
      # logs / socket inspection.
      {:ok,
       socket
       |> assign(:agent_id, agent_id)
       |> assign(:wrapper_token, nil)}
    else
      {:error, reason} -> {:error, %{reason: to_string(reason)}}
    end
  end

  # Reject a second concurrent wrapper for an agent_id that already has a
  # live connection (ADR-0024 D5, reject-newcomer). The incumbent keeps the
  # slot, so a token-holding third party cannot adversarially evict a live
  # agent. A genuine reconnect is allowed once the old connection's terminate
  # has run (its owner pid is then dead); after an abrupt drop that is delayed
  # by the socket timeout window, during which the reconnect retries.
  defp reject_if_connected(agent_id) do
    if AgentStates.connected?(agent_id), do: {:error, :already_connected}, else: :ok
  end

  # Enforce the protocol.md agent_id charset at the join boundary (issue
  # #61). Checked before auth: the charset is public, so an early reject
  # leaks nothing a client cannot already derive.
  defp validate_agent_id(agent_id) do
    if AgentId.valid?(agent_id), do: :ok, else: {:error, :invalid_agent_id}
  end

  @impl true
  def handle_in("envelope", envelope, socket) do
    with :ok <- validate(envelope, socket.assigns.agent_id),
         :ok <- store(envelope) do
      record_session_pointer(envelope)
      # The full envelope (incl. operator-only log/result tool I/O) goes onto
      # agents:lobby unfiltered; role gating is per-subscriber in
      # AgentsChannel.handle_out. Invariant: ONLY AgentsChannel may subscribe
      # to this topic — any new subscriber MUST apply the same role gate
      # (#27, specs/threat-model.md).
      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "envelope", envelope)
      {:reply, :ok, socket}
    else
      # A reply before any state (append_log :noop) has no snapshot entry
      # to anchor it; drop the live broadcast too so "latest state is
      # authoritative" holds (history was already not retained). Ack the
      # wrapper — it did nothing wrong.
      :noop ->
        {:reply, :ok, socket}

      {:error, reason} when is_atom(reason) ->
        {:reply, {:error, %{reason: to_string(reason)}}, socket}

      {:error, reason} ->
        {:reply, {:error, %{reason: reason}}, socket}
    end
  end

  # log / result are reply transcript lines kept as history (ADR-0012);
  # state_change / permission_request refresh the latest state.
  defp store(%{"type" => type} = envelope) when type in ["log", "result"] do
    AgentStates.append_log(envelope)
  end

  defp store(envelope), do: AgentStates.put(envelope, owner: self())

  # Persist the agent's latest SDK session_id as a restart-surviving
  # pointer (ADR-0014 F1, issue #49). Only fires once the wrapper has
  # reported a real session_id; cwd rides along from ext when present.
  defp record_session_pointer(%{"agent_id" => agent_id, "session_id" => sid} = envelope)
       when is_binary(sid) and sid != "" do
    cwd =
      case envelope do
        %{"ext" => %{"cwd" => c}} when is_binary(c) -> c
        _ -> nil
      end

    SessionPointers.record(agent_id, sid, cwd)
  end

  defp record_session_pointer(_envelope), do: :ok

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
