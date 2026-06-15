defmodule KaoiroServerWeb.ClientSocket do
  @moduledoc """
  Socket for client connections (public protocol, ADR-0009: Channels only,
  vsn=2.0.0). Access control is the token + role stub (ADR-0011, the
  ADR-0005 whitelist made concrete) resolved to viewer/operator. The token
  comes from the httpOnly session cookie (ADR-0013, primary) or the connect
  params (dev Vite fallback). With no client tokens configured the
  connection is rejected (fail-closed, issue #28) — a misconfigured
  deployment is locked, not silently exposed as operator.
  """

  use Phoenix.Socket

  alias KaoiroServer.Auth

  channel "agents:*", KaoiroServerWeb.AgentsChannel

  @impl true
  def connect(params, socket, connect_info) do
    token = session_token(connect_info) || params["token"]

    case Auth.client_role(token) do
      {:ok, role} -> {:ok, assign(socket, :role, role)}
      {:error, _reason} -> :error
    end
  end

  # The session cookie is the primary credential (ADR-0013); connect_info
  # carries it only when configured (endpoint connect_info: [session: ...])
  # and a valid cookie rode along the handshake — nil otherwise.
  defp session_token(%{session: %{} = session}), do: session["client_token"]
  defp session_token(_), do: nil

  @impl true
  def id(_socket), do: nil
end
