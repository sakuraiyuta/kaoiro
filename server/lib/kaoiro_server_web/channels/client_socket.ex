defmodule KaoiroServerWeb.ClientSocket do
  @moduledoc """
  Socket for client connections (public protocol, ADR-0009: Channels only,
  vsn=2.0.0). Access control is the token + role stub (ADR-0011, the
  ADR-0005 whitelist made concrete) resolved to viewer/operator. The token
  is resolved, in order, from: a short-lived `ticket` param (the reload
  path — the SPA mints it from the httpOnly cookie via GET /session/ticket,
  ADR-0013), a `token` param (first load with `?token=`), or the session
  cookie if one rode the handshake. With no client tokens configured the
  connection is rejected (fail-closed, issue #28) — a misconfigured
  deployment is locked, not silently exposed as operator.
  """

  use Phoenix.Socket

  alias KaoiroServer.Auth

  # Matches the salt used by SessionController.ticket/2.
  @ws_ticket_salt "client_ws"
  @ws_ticket_max_age 30

  channel "agents:*", KaoiroServerWeb.AgentsChannel

  @impl true
  def connect(params, socket, connect_info) do
    token =
      ticket_token(socket, params["ticket"]) || params["token"] ||
        session_token(connect_info)

    case Auth.client_role(token) do
      {:ok, role} -> {:ok, assign(socket, :role, role)}
      {:error, _reason} -> :error
    end
  end

  # Verifies a short-lived WS ticket back to its token (ADR-0013), or nil
  # when absent/expired/forged — Vite cannot carry the cookie on a WS
  # upgrade, so the reload path authenticates with this ticket instead.
  defp ticket_token(_socket, nil), do: nil

  defp ticket_token(socket, ticket) do
    case Phoenix.Token.verify(socket, @ws_ticket_salt, ticket, max_age: @ws_ticket_max_age) do
      {:ok, token} -> token
      {:error, _reason} -> nil
    end
  end

  # The session cookie rides the handshake only for a same-origin connection
  # (prod); connect_info carries it when present, nil otherwise.
  defp session_token(%{session: %{} = session}), do: session["client_token"]
  defp session_token(_), do: nil

  @impl true
  def id(_socket), do: nil
end
